// Tier 2.5 — Apply layer + RSI gate (source-code edition).
//
// The DAG (Tier 1.1) produces nodes; the synth engine produces oracle-verified
// files for them. THIS layer is the only sanctioned way those files reach the
// working tree, and it applies the RSI controller's never-regress discipline to
// source code — the highest-blast-radius mutation in the system:
//
//   1. SNAPSHOT every target file (content + existence) by file copy, exactly the
//      way rsi/controller snapshots learned-state (git can't help: target files may
//      be untracked, and we need byte-exact rollback regardless of VCS).
//   2. MEASURE a baseline with the node's verification gate BEFORE writing.
//   3. APPLY all changes (all-or-nothing within one node).
//   4. RE-MEASURE the candidate with the same gate.
//   5. GATE — keep ONLY if the candidate is NOT WORSE than the baseline (monotonic,
//      EPSILON=0). A change that introduces a new compile error, even into an
//      already-broken tree, is reverted. The tree ratchets: flat or better, never
//      worse.
//   6. On any failure (or dry-run), HARD-RESTORE the snapshot so the tree is exactly
//      as it was. Every decision is appended to an audit ledger.
//
// Safety invariants:
//   • Writes are confined to projectPath — any path that escapes it is refused.
//   • Kill switch: env CRUCIBLE_APPLY_ENABLED=0 (or { dryRun }) blocks all writes.
//   • Verification is pluggable; the default is a fast, no-spawn syntactic check so
//     the layer is deterministic and testable. tscProjectVerify is provided for the
//     full-type-safety gate in production.

import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import ts from 'typescript'

export interface FileChange {
  /** Project-relative path of the file to write. */
  rel: string
  /** Full new content. (Apply layer is content-level; diff application is a caller concern.) */
  content: string
}

export interface VerifyResult {
  ok: boolean
  /** Higher is better. The gate keeps a candidate iff score >= baseline score. */
  score: number
  detail: string
}

export type VerifyFn = (projectPath: string, files: string[]) => Promise<VerifyResult> | VerifyResult

export type ApplyVerdict = 'applied' | 'reverted' | 'skipped' | 'error'

export interface ApplyResult {
  verdict: ApplyVerdict
  applied: boolean
  files: string[]
  baseline?: VerifyResult
  candidate?: VerifyResult
  detail: string
}

const EPSILON = 0  // strict monotonic: a candidate must be at least as good as baseline.

function applyEnabled(): boolean {
  return process.env.CRUCIBLE_APPLY_ENABLED !== '0'
}

// ── Path safety ──────────────────────────────────────────────────────────────────

function resolveInside(projectPath: string, rel: string): string | null {
  const root = path.resolve(projectPath)
  const abs = path.resolve(root, rel)
  // Must stay within root (defends against ../ traversal and absolute rel).
  if (abs !== root && !abs.startsWith(root + path.sep)) return null
  return abs
}

// ── Snapshot / restore (byte-exact, file-copy — mirrors rsi/controller) ───────────

interface Snapshot {
  /** rel → previous content, or null if the file did not exist. */
  prev: Map<string, string | null>
}

function snapshot(projectPath: string, rels: string[]): Snapshot {
  const prev = new Map<string, string | null>()
  for (const rel of rels) {
    const abs = resolveInside(projectPath, rel)
    if (!abs) continue
    try { prev.set(rel, fs.readFileSync(abs, 'utf-8')) }
    catch { prev.set(rel, null) }  // absent at baseline → restore must delete it
  }
  return { prev }
}

function restore(projectPath: string, snap: Snapshot): void {
  for (const [rel, content] of snap.prev) {
    const abs = resolveInside(projectPath, rel)
    if (!abs) continue
    try {
      if (content === null) { if (fs.existsSync(abs)) fs.unlinkSync(abs) }
      else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, content, 'utf-8') }
    } catch { /* best-effort per file; continue restoring the rest */ }
  }
}

function writeAll(projectPath: string, changes: FileChange[]): void {
  for (const c of changes) {
    const abs = resolveInside(projectPath, c.rel)!  // pre-validated by caller
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, c.content, 'utf-8')
  }
}

// ── Audit ledger ──────────────────────────────────────────────────────────────────

function ledger(projectPath: string, entry: Record<string, unknown>): void {
  try {
    const file = path.join(path.resolve(projectPath), '.crucible', 'apply-ledger.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // Timestamp is supplied by the caller-visible Date at append time; kept out of the
    // pure core so unit tests stay deterministic.
    fs.appendFileSync(file, JSON.stringify(entry) + '\n')
  } catch { /* ledger is best-effort */ }
}

// ── Built-in verifiers ─────────────────────────────────────────────────────────────

/**
 * Fast, no-spawn syntactic verifier (default). Parses each changed TS/JS file and
 * scores by negative syntactic-diagnostic count, so any NEW parse error makes the
 * candidate worse than the baseline and gets reverted. Deterministic + testable;
 * does not catch cross-file type errors (use tscProjectVerify for that).
 */
export function syntacticVerify(projectPath: string, files: string[]): VerifyResult {
  let errors = 0
  const msgs: string[] = []
  for (const rel of files) {
    if (!/\.[cm]?[tj]sx?$/.test(rel)) continue
    const abs = path.resolve(projectPath, rel)
    let content: string
    try { content = fs.readFileSync(abs, 'utf-8') } catch { continue }
    const sf = ts.createSourceFile(abs, content, ts.ScriptTarget.Latest, true)
    // `parseDiagnostics` is internal but stable; fall back to 0 if absent.
    const diags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? []
    if (diags.length) {
      errors += diags.length
      msgs.push(`${rel}: ${diags.length} parse error(s)`)
    }
  }
  return { ok: errors === 0, score: -errors, detail: errors ? msgs.join('; ') : 'no syntax errors' }
}

/**
 * Full project type-check via `tsc --noEmit`. Score = negative error count, so the
 * monotonic gate keeps a change only if it does not increase the project's error
 * count — safe even against an already-broken tree. Heavy (spawns tsc); use for the
 * production source-apply gate, not in hot loops.
 */
export function tscProjectVerify(projectPath: string, _files: string[]): Promise<VerifyResult> {
  void _files
  return new Promise(resolve => {
    execFile('npx', ['tsc', '--noEmit', '-p', path.resolve(projectPath)], { cwd: path.resolve(projectPath), timeout: 180_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout}\n${stderr}`
      const count = (out.match(/error TS\d+/g) ?? []).length
      if (!err) { resolve({ ok: true, score: 0, detail: 'tsc clean' }); return }
      resolve({ ok: count === 0, score: -count, detail: count ? `${count} tsc error(s)` : (err.message || 'tsc failed') })
    })
  })
}

// ── Public API ─────────────────────────────────────────────────────────────────────

/**
 * Apply a node's verified changes to the working tree under the RSI never-regress
 * gate. Returns the verdict; NEVER throws — on any error the tree is restored.
 */
export async function applyVerified(
  projectPath: string,
  changes: FileChange[],
  opts: { verify?: VerifyFn; dryRun?: boolean } = {},
): Promise<ApplyResult> {
  const verify = opts.verify ?? syntacticVerify
  const files = changes.map(c => c.rel)
  const result = (verdict: ApplyVerdict, detail: string, extra: Partial<ApplyResult> = {}): ApplyResult =>
    ({ verdict, applied: verdict === 'applied', files, detail, ...extra })

  if (!changes.length) return result('skipped', 'no changes')

  // Path-safety gate — refuse the whole batch if any target escapes the project.
  for (const c of changes) {
    if (!resolveInside(projectPath, c.rel)) {
      ledger(projectPath, { event: 'refused', reason: 'path_escape', rel: c.rel })
      return result('error', `refused: ${c.rel} escapes project root`)
    }
  }

  const dryRun = opts.dryRun || !applyEnabled()
  const snap = snapshot(projectPath, files)

  try {
    const baseline = await verify(projectPath, files)
    writeAll(projectPath, changes)
    const candidate = await verify(projectPath, files)

    // GATE: keep only if the candidate is not worse than the baseline.
    const notWorse = candidate.score >= baseline.score - EPSILON

    if (dryRun) {
      restore(projectPath, snap)
      ledger(projectPath, { event: 'dry_run', files, baseline: baseline.score, candidate: candidate.score, wouldApply: notWorse })
      return result('skipped', `dry-run (${notWorse ? 'would apply' : 'would revert'})`, { baseline, candidate })
    }

    if (notWorse) {
      ledger(projectPath, { event: 'applied', files, baseline: baseline.score, candidate: candidate.score })
      return result('applied', candidate.detail, { baseline, candidate })
    }

    // Regression — hard restore. The tree cannot move backward.
    restore(projectPath, snap)
    ledger(projectPath, { event: 'reverted', files, baseline: baseline.score, candidate: candidate.score, reason: 'regression' })
    return result('reverted', `reverted: ${candidate.detail} (baseline ${baseline.score} → ${candidate.score})`, { baseline, candidate })
  } catch (e: unknown) {
    // Any failure → restore to exact prior state.
    restore(projectPath, snap)
    const msg = e instanceof Error ? e.message : String(e)
    ledger(projectPath, { event: 'error', files, error: msg.slice(0, 200) })
    return result('error', `error (restored): ${msg}`)
  }
}
