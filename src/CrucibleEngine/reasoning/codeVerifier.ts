// ═══════════════════════════════════════════════════════════════════════════════
// VGR — execution-grounded code verifier
// ═══════════════════════════════════════════════════════════════════════════════
//
// The GROUND TRUTH for code is EXECUTION, not the model's opinion of its own code.
// This verifier writes the candidate to a sandboxed temp module, runs it against the
// spec's acceptance cases in a fresh node process, and reports:
//
//   • pass  — every case produced the expected value
//   • score — -(#failing cases) - syntaxPenalty : a monotone hill to climb
//   • signals — HIGH-INFORMATION feedback: for each failing case the ACTUAL vs
//     expected value (or the thrown stack), plus any syntax/load error. This is the
//     signal that lets a weak proposer converge in a handful of calls.
//
// No model is consulted here. This file is pure determinism.
// ═══════════════════════════════════════════════════════════════════════════════

import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { build, transform } from 'esbuild'
import type { Candidate, TaskSpec, Verdict } from './types'

export interface CodeCase {
  /** Positional arguments applied to the entry function. */
  args: unknown[]
  /** Expected return value (deep-equal compared). */
  expected: unknown
  /** Optional label for feedback readability. */
  name?: string
  /** Which exported function this case targets. Defaults to the acceptance `entry`. */
  entry?: string
}

export interface CodeAcceptance {
  /** Primary exported function the candidate must define (default target for untagged cases). */
  entry: string
  /** All exported functions the candidate must define (multi-function specs). Defaults to [entry]. */
  entries?: string[]
  cases: CodeCase[]
  /** Per-run execution timeout (ms). */
  timeoutMs?: number
  [k: string]: unknown
}

interface CaseOutcome {
  ok: boolean
  name: string
  actual?: unknown
  error?: string
  expected: unknown
}

/**
 * Verify a candidate JS/TS source string (an ES module exporting `entry`) by executing
 * it against the acceptance cases. Deterministic ground truth. Never trusts the model.
 */
export async function verifyCode(candidate: Candidate<string>, spec: TaskSpec): Promise<Verdict> {
  const acc = spec.acceptance as unknown as CodeAcceptance
  const src = candidate.value
  const timeoutMs = acc.timeoutMs ?? 5000
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgr-'))
  const modPath = path.join(dir, 'candidate.mjs')
  const runPath = path.join(dir, 'run.mjs')

  try {
    // The model naturally emits TypeScript (type annotations, `satisfies`, enums…). Node
    // cannot execute that, so a raw run would fail EVERY candidate at load time regardless
    // of correctness. Transpile TS→JS first (types stripped) so EXECUTION tests behavior,
    // not syntax. A genuine syntax error still surfaces here as a load error (rich signal).
    let js = src
    try {
      const out = await transform(src, { loader: 'ts', format: 'esm', target: 'node18' })
      js = out.code
    } catch (e: any) {
      const msg = (e?.errors?.[0]?.text ?? e?.message ?? 'syntax error') as string
      return { pass: false, score: -1000, signals: [`syntax error (does not compile): ${String(msg).slice(0, 200)}`] }
    }
    fs.writeFileSync(modPath, js, 'utf-8')
    fs.writeFileSync(runPath, RUNNER(acc.entry, acc.cases), 'utf-8')

    const out = await new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
      execFile('node', [runPath], { cwd: dir, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => resolve({ code: err ? (err as any).code ?? 1 : 0, stdout, stderr }))
    })

    // A crash before the harness could emit its JSON line = load/syntax/import error.
    // That's maximally-informative feedback: hand the proposer the raw stderr.
    let parsed: { outcomes: CaseOutcome[] } | null = null
    const line = out.stdout.split('\n').reverse().find(l => l.trim().startsWith('{"outcomes"'))
    if (line) { try { parsed = JSON.parse(line) } catch { /* fall through */ } }

    if (!parsed) {
      const reason = firstError(out.stderr) || 'candidate failed to load or run (no result emitted)'
      return { pass: false, score: -1000, signals: [`load/runtime error: ${reason}`] }
    }

    const outcomes = parsed.outcomes
    const failing = outcomes.filter(o => !o.ok)
    if (failing.length === 0) {
      return { pass: true, score: 0, signals: [`all ${outcomes.length} case(s) passed`] }
    }

    // Rich per-case feedback — the actual value vs expected, or the thrown error.
    const signals = failing.slice(0, 6).map(o =>
      o.error
        ? `case ${o.name} threw: ${o.error}`
        : `case ${o.name} → got ${fmt(o.actual)}, expected ${fmt(o.expected)}`)
    if (failing.length > 6) signals.push(`…and ${failing.length - 6} more failing case(s)`)

    return { pass: false, score: -failing.length, signals }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
}

/** One file in a multi-file candidate: a project-relative path and its TS/JS source. */
export interface CandidateFile {
  /** Project-relative module path, e.g. 'src/math.ts' or 'index.ts'. */
  path: string
  /** Full TS/JS source of the file (may import sibling files by relative path). */
  source: string
}

/**
 * Verify a MULTI-FILE candidate by BUNDLING the files (esbuild resolves cross-file
 * `import { x } from './sibling'` edges, strips TS types) into one runnable module, then
 * executing the acceptance cases against the resulting exports — the same execution-is-
 * ground-truth contract as verifyCode, extended across a real import graph.
 *
 * The runner imports a synthetic barrel that `export *`s every candidate file, so a case
 * targeting any exported function in any file resolves. A bundle/compile failure (bad
 * import path, type error, missing export) surfaces as a high-signal load error the
 * proposer can act on. No model is consulted. Pure determinism.
 */
export async function verifyMultiFileCode(
  files: CandidateFile[],
  acc: CodeAcceptance,
): Promise<Verdict> {
  const timeoutMs = acc.timeoutMs ?? 5000
  if (!files.length) return { pass: false, score: -1000, signals: ['no files in candidate'] }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgr-mf-'))
  try {
    // Write every file at its declared relative path (nested dirs created as needed).
    const written: string[] = []
    for (const f of files) {
      const rel = f.path.replace(/^\.\//, '')
      const abs = path.join(dir, rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, f.source, 'utf-8')
      written.push(rel)
    }
    // Barrel re-exports every file so any target export is visible to the runner, no matter
    // which file defines it. Import specifiers drop the extension (esbuild resolves .ts/.js).
    const barrel = written.map(rel => `export * from './${rel.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '')}'`).join('\n')
    const barrelPath = path.join(dir, '__barrel.ts')
    fs.writeFileSync(barrelPath, barrel, 'utf-8')

    const runSrcPath = path.join(dir, '__run.ts')
    fs.writeFileSync(runSrcPath, MULTI_RUNNER(acc.entry, acc.cases), 'utf-8')

    // Bundle the runner (which imports the barrel) into a single self-contained mjs. This is
    // where cross-file imports are resolved and TS is stripped; a broken graph fails here.
    const bundlePath = path.join(dir, '__bundle.mjs')
    try {
      await build({
        entryPoints: [runSrcPath], bundle: true, format: 'esm', platform: 'node',
        target: 'node18', outfile: bundlePath, logLevel: 'silent', absWorkingDir: dir,
      })
    } catch (e: any) {
      const msg = (e?.errors?.[0]?.text ?? e?.message ?? 'bundle error') as string
      return { pass: false, score: -1000, signals: [`bundle/compile error (cross-file graph does not build): ${String(msg).slice(0, 220)}`] }
    }

    const out = await new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
      execFile('node', [bundlePath], { cwd: dir, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => resolve({ code: err ? (err as any).code ?? 1 : 0, stdout, stderr }))
    })

    let parsed: { outcomes: CaseOutcome[] } | null = null
    const line = out.stdout.split('\n').reverse().find(l => l.trim().startsWith('{"outcomes"'))
    if (line) { try { parsed = JSON.parse(line) } catch { /* fall through */ } }
    if (!parsed) {
      const reason = firstError(out.stderr) || 'multi-file candidate failed to load or run (no result emitted)'
      return { pass: false, score: -1000, signals: [`load/runtime error: ${reason}`] }
    }

    const failing = parsed.outcomes.filter(o => !o.ok)
    if (failing.length === 0) {
      return { pass: true, score: 0, signals: [`all ${parsed.outcomes.length} case(s) passed across ${files.length} file(s)`] }
    }
    const signals = failing.slice(0, 6).map(o =>
      o.error ? `case ${o.name} threw: ${o.error}` : `case ${o.name} → got ${fmt(o.actual)}, expected ${fmt(o.expected)}`)
    if (failing.length > 6) signals.push(`…and ${failing.length - 6} more failing case(s)`)
    return { pass: false, score: -failing.length, signals }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
}

// Same execution contract as RUNNER, but imports the synthetic barrel (which re-exports
// every candidate file) so cases resolve against the whole module graph, not one file.
function MULTI_RUNNER(entry: string, cases: CodeCase[]): string {
  return `import * as mod from './__barrel.ts'
const CASES = ${JSON.stringify(cases)};
const DEFAULT_ENTRY = ${JSON.stringify(entry)};
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
const outcomes = [];
for (let i = 0; i < CASES.length; i++) {
  const c = CASES[i];
  const target = c.entry ?? DEFAULT_ENTRY;
  const fn = mod[target] ?? (target === DEFAULT_ENTRY ? mod.default : undefined);
  const name = c.name ?? (target + ' #' + i);
  if (typeof fn !== 'function') {
    outcomes.push({ ok: false, name, error: 'no exported function ' + target, expected: 'function' });
    continue;
  }
  try {
    const actual = fn(...(c.args ?? []));
    const resolved = actual && typeof actual.then === 'function' ? await actual : actual;
    outcomes.push({ ok: eq(resolved, c.expected), name, actual: resolved, expected: c.expected });
  } catch (e) {
    outcomes.push({ ok: false, name, error: String(e && e.message ? e.message : e), expected: c.expected });
  }
}
process.stdout.write('\\n' + JSON.stringify({ outcomes }) + '\\n');
`
}

function fmt(v: unknown): string {
  try { const s = JSON.stringify(v); return s.length > 120 ? s.slice(0, 117) + '…' : s }
  catch { return String(v) }
}

function firstError(stderr: string): string {
  const m = stderr.split('\n').map(l => l.trim()).find(l =>
    /Error|error TS|SyntaxError|ReferenceError|TypeError/.test(l))
  return (m ?? stderr.trim().split('\n')[0] ?? '').slice(0, 240)
}

// The runner is written to disk and executed in a fresh process. It imports the candidate
// module and applies each case to ITS target function (case.entry, else the primary entry),
// so a multi-function module is verified across all its exports in one run.
function RUNNER(entry: string, cases: CodeCase[]): string {
  return `import * as mod from './candidate.mjs'
const CASES = ${JSON.stringify(cases)};
const DEFAULT_ENTRY = ${JSON.stringify(entry)};
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
const outcomes = [];
for (let i = 0; i < CASES.length; i++) {
  const c = CASES[i];
  const target = c.entry ?? DEFAULT_ENTRY;
  const fn = mod[target] ?? (target === DEFAULT_ENTRY ? mod.default : undefined);
  const name = c.name ?? (target + ' #' + i);
  if (typeof fn !== 'function') {
    outcomes.push({ ok: false, name, error: 'no exported function ' + target, expected: 'function' });
    continue;
  }
  try {
    const actual = fn(...(c.args ?? []));
    const resolved = actual && typeof actual.then === 'function' ? await actual : actual;
    outcomes.push({ ok: eq(resolved, c.expected), name, actual: resolved, expected: c.expected });
  } catch (e) {
    outcomes.push({ ok: false, name, error: String(e && e.message ? e.message : e), expected: c.expected });
  }
}
process.stdout.write('\\n' + JSON.stringify({ outcomes }) + '\\n');
`
}
