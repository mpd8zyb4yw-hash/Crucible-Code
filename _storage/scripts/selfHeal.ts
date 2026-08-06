// Self-healing build pipeline (invoked by launch.sh).
//
// Reads a failing `npm run build` output, parses the tsc errors into structured
// records, and tries to heal each errored file using the SAME proven primitives the
// rest of Crucible is built on:
//
//   • synthesizeUniversal (synth/universal.ts) — proposes a corrected file from a
//     spec = { file content + error + semantic-index context }. No paid model: it
//     uses the pure-code cascade then the on-device FM, degrading to "no patch"
//     when nothing verifies (e.g. the FM daemon is down).
//   • applyVerified + syntacticVerify (apply/applyLayer.ts) — the never-regress gate:
//     a patch that makes the file syntactically worse is auto-reverted. The real
//     type-level confirmation is the build re-run between attempts.
//
// Invariants (mirrored from the spec):
//   • applyVerified/syntacticVerify gates every patch — never land a regression.
//   • A given error fingerprint is attempted at most ONCE per session; on repeat the
//     file is marked needs-human and skipped, healing continues on other files.
//   • Files outside the project root are never touched (applyVerified path-guards).
//   • Attempt-level never-regress: if total error count rises, stop and report.
//
// The core is dependency-injected (runSelfHeal) so it is unit-testable without
// running a real build or the FM; main() wires the real primitives.

import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { synthesizeUniversal } from '../src/CrucibleEngine/synth/universal'
import { applyVerified, syntacticVerify, type FileChange } from '../src/CrucibleEngine/apply/applyLayer'
import { fingerprint } from '../src/CrucibleEngine/agent/verify'
import { ensureSemanticIndex, summarizeFile, type SemanticIndex } from '../src/CrucibleEngine/state/semanticIndex'

const MAX_ATTEMPTS = 3

// ── Error parsing ────────────────────────────────────────────────────────────────

export interface TscError { file: string; line: number; col: number; code: string; message: string; raw: string }
export interface FileErrors { file: string; errors: TscError[] }

// tsc -b emits:  path/to/file.tsx(123,45): error TS1234: message
const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/

export function parseTscErrors(output: string): TscError[] {
  const out: TscError[] = []
  for (const raw of output.split('\n')) {
    const m = raw.match(TSC_LINE)
    if (!m) continue
    out.push({ file: m[1].trim(), line: +m[2], col: +m[3], code: m[4], message: m[5].trim(), raw: raw.trim() })
  }
  return out
}

export function groupByFile(errors: TscError[]): FileErrors[] {
  const by = new Map<string, TscError[]>()
  for (const e of errors) (by.get(e.file) ?? by.set(e.file, []).get(e.file)!).push(e)
  return [...by.entries()].map(([file, errors]) => ({ file, errors }))
}

/** Stable per-file signature: which errors, independent of churn elsewhere. */
export function fileFingerprint(fe: FileErrors): string {
  return fingerprint(fe.errors.map(e => `${e.code} ${e.message}`).join('\n'))
}

// ── Injectable core ──────────────────────────────────────────────────────────────

export interface HealDeps {
  /** Run the build; return clean flag + combined stdout/stderr. */
  runBuild: () => { ok: boolean; out: string }
  /** Produce a candidate change set for an errored file, or null if none. */
  heal: (root: string, fe: FileErrors) => Promise<FileChange[] | null>
  /** Apply a change set through the never-regress gate; return verdict. */
  apply: (root: string, changes: FileChange[]) => Promise<{ verdict: string; detail: string }>
  /** Append one structured record to the heal log. */
  log: (entry: Record<string, unknown>) => void
  /** Build output from the initial (piped) build, used for attempt 1. */
  initialOutput?: string
}

export interface HealReport {
  healed: boolean
  attempts: number
  needsHuman: Array<{ file: string; reason: string }>
  remaining: TscError[]
  regressed: boolean
}

export async function runSelfHeal(root: string, deps: HealDeps, maxAttempts = MAX_ATTEMPTS): Promise<HealReport> {
  const attemptedFp = new Set<string>()
  const needsHuman = new Map<string, string>()
  let prevCount = Infinity
  let regressed = false
  let attemptsRun = 0

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptsRun = attempt
    // Attempt 1 reuses the piped build output; later attempts re-run the build.
    const useInitial = attempt === 1 && deps.initialOutput !== undefined
    const build = useInitial ? { ok: parseTscErrors(deps.initialOutput!).length === 0, out: deps.initialOutput! } : deps.runBuild()
    const errors = parseTscErrors(build.out)

    if (build.ok || errors.length === 0) {
      return { healed: true, attempts: attempt, needsHuman: dump(needsHuman), remaining: [], regressed: false }
    }

    // Attempt-level never-regress: a rising error count means a patch made things
    // globally worse (cross-file type errors syntacticVerify can't see). Stop.
    if (errors.length > prevCount) {
      regressed = true
      deps.log({ ts: Date.now(), event: 'regression_halt', errorCount: errors.length, prev: prevCount })
      return { healed: false, attempts: attempt, needsHuman: dump(needsHuman), remaining: errors, regressed }
    }
    prevCount = errors.length

    // Pick fixable files: not already needs-human, fingerprint not seen before.
    const fixable: FileErrors[] = []
    for (const fe of groupByFile(errors)) {
      if (needsHuman.has(fe.file)) continue
      const fp = fileFingerprint(fe)
      if (attemptedFp.has(fp)) { needsHuman.set(fe.file, 'repeated error fingerprint — needs human'); continue }
      fixable.push(fe)
    }
    if (!fixable.length) break  // nothing new to try this session

    for (const fe of fixable) {
      const fp = fileFingerprint(fe)
      attemptedFp.add(fp)  // attempt at most once per session, even if it fails
      const base = { ts: Date.now(), attempt, file: fe.file, errors: fe.errors.map(e => e.raw) }

      let patch: FileChange[] | null = null
      try { patch = await deps.heal(root, fe) } catch (e) { patch = null; deps.log({ ...base, event: 'heal_error', error: String(e).slice(0, 200) }) }

      if (!patch || !patch.length) {
        needsHuman.set(fe.file, 'no patch produced (synth could not verify a fix)')
        deps.log({ ...base, event: 'heal', patchApplied: false, success: false, reason: 'no-patch' })
        continue
      }

      const ap = await deps.apply(root, patch)
      const applied = ap.verdict === 'applied'
      if (!applied) needsHuman.set(fe.file, `patch rejected by never-regress gate: ${ap.detail}`)
      deps.log({ ...base, event: 'heal', patchApplied: applied, verdict: ap.verdict, detail: ap.detail, success: applied })
    }
  }

  // Final confirmation build.
  const final = deps.runBuild()
  const remaining = parseTscErrors(final.out)
  return { healed: final.ok, attempts: attemptsRun, needsHuman: dump(needsHuman), remaining, regressed }
}

function dump(m: Map<string, string>): Array<{ file: string; reason: string }> {
  return [...m.entries()].map(([file, reason]) => ({ file, reason }))
}

// ── Real primitive wiring ─────────────────────────────────────────────────────────

function realRunBuild(root: string): { ok: boolean; out: string } {
  try {
    const out = execSync('npm run build', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, out }
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string }
    return { ok: false, out: `${err.stdout ?? ''}\n${err.stderr ?? ''}` }
  }
}

function buildHealSpec(root: string, fe: FileErrors, index: SemanticIndex | null): string | null {
  const abs = path.join(root, fe.file)
  let content: string
  try { content = fs.readFileSync(abs, 'utf-8') } catch { return null }
  const ctx = index ? summarizeFile(index, fe.file) : ''
  return [
    `Fix the TypeScript error(s) in ${fe.file}. Return the COMPLETE corrected file content — do not change unrelated logic.`,
    'Errors:',
    ...fe.errors.map(e => `  ${fe.file}(${e.line},${e.col}): ${e.code}: ${e.message}`),
    ctx ? `Repo context:\n${ctx}` : '',
    `Current content of ${fe.file}:`,
    content,
  ].filter(Boolean).join('\n')
}

function realHeal(index: SemanticIndex | null) {
  return async (root: string, fe: FileErrors): Promise<FileChange[] | null> => {
    const spec = buildHealSpec(root, fe, index)
    if (!spec) return null
    // acceptGateAOnly: a "fix this error" spec has no derivable behavioral test, so a
    // tsc-passing candidate is acceptable; applyVerified + the build re-run are the gate.
    const res = await synthesizeUniversal(spec, { projectPath: root, modulePath: fe.file, acceptGateAOnly: true })
    if (!res.files?.length) return null
    return res.files.map(f => ({ rel: f.path, content: f.content }))
  }
}

async function realApply(root: string, changes: FileChange[]): Promise<{ verdict: string; detail: string }> {
  const r = await applyVerified(root, changes, { verify: syntacticVerify })
  return { verdict: r.verdict, detail: r.detail }
}

function makeLogger(root: string) {
  const file = path.join(root, '.crucible', 'heal-log.jsonl')
  return (entry: Record<string, unknown>) => {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(entry) + '\n') } catch { /* best-effort */ }
  }
}

async function main(): Promise<void> {
  const root = process.cwd()
  let initialOutput: string | undefined
  try { if (!process.stdin.isTTY) initialOutput = fs.readFileSync(0, 'utf-8') } catch { /* no pipe */ }

  let index: SemanticIndex | null = null
  try { index = ensureSemanticIndex(root) } catch { index = null }

  const log = makeLogger(root)
  log({ ts: Date.now(), event: 'session_start', initialErrors: initialOutput ? parseTscErrors(initialOutput).length : null })

  const report = await runSelfHeal(root, {
    runBuild: () => realRunBuild(root),
    heal: realHeal(index),
    apply: realApply,
    log,
    initialOutput,
  })

  log({ ts: Date.now(), event: 'session_end', healed: report.healed, attempts: report.attempts, needsHuman: report.needsHuman, remaining: report.remaining.length, regressed: report.regressed })

  if (report.healed) {
    console.log(`✅ Self-heal succeeded in ${report.attempts} attempt(s).`)
    process.exit(0)
  }

  // Clear, human-readable failure report.
  console.error('\n❌ Self-heal could not produce a clean build.')
  if (report.regressed) console.error('   Halted: a patch increased the total error count (regression guard).')
  if (report.needsHuman.length) {
    console.error('   Files needing human attention:')
    for (const n of report.needsHuman) console.error(`     • ${n.file} — ${n.reason}`)
  }
  if (report.remaining.length) {
    console.error(`   Remaining ${report.remaining.length} error(s):`)
    for (const e of report.remaining.slice(0, 20)) console.error(`     ${e.raw}`)
  }
  console.error('   Full log: .crucible/heal-log.jsonl\n')
  process.exit(1)
}

// Run only when invoked directly (so tests can import the core without executing).
if (process.argv[1] && process.argv[1].endsWith('selfHeal.ts')) {
  main().catch(err => { console.error('selfHeal fatal:', err); process.exit(1) })
}
