// ═══════════════════════════════════════════════════════════════════════════════
// Phase 0 — TRUE-RATE measurement of the agentic repo path (cont.80).
// Run:  npm run agentic:live            (requires the FM daemon on :11435)
//       npm run agentic:live -- --noop  (control only; no model needed)
//       npm run agentic:live -- --only=clamp-upper-bound
// ═══════════════════════════════════════════════════════════════════════════════
//
// This is a METRIC, not a gate. It exists because the agentic path is the last major path never
// audited the cont.79h way ("read the artifact, not the verdict"). Every parity % we have quoted
// rests on it, and reading verify.ts showed two accept-side holes:
//
//   · verify.ts:112 — no runnable check → {passed:true, unverified:true}. loop.ts:584/589 branch
//     only on `!v.passed`, so `unverified` is emitted to telemetry and accepted as success.
//   · verify.ts:151 — `npm test` green proves the PRE-EXISTING suite still passes. Nothing ties
//     the green to the request, so a NO-OP edit passes.
//
// ── The two halves ────────────────────────────────────────────────────────────
//
// NO-OP CONTROL (deterministic, no model): materialize each repo, make a change that provably does
// nothing, and ask the REAL production verifier. Every `passed:true` here is a hole in the gate,
// proven without the FM's variance in the way. If this half reports passes, the gate cannot
// distinguish work from no work, and every live number below is an upper bound on capability.
//
// LIVE HALF: run the real loop with the production wiring, then classify against the rubric —
// a pass requires the change to be PRESENT, EXERCISED, SUITE-GREEN and OBJECTIVELY CORRECT.
// Passing the visible test and having the capability are not the same thing; we measure the latter.
//
//   reported  · what the agent/gate SAID (this is the number that was being trusted)
//   NOOP      · reported pass, but nothing changed in the target file
//   BLIND     · reported pass with signal 'none' — the unverified branch; nothing was checked
//   UNEXERCISED · change present, but the project check never reaches the changed lines
//   WRONG     · change present + exercised + suite green, but the hidden spec fails
//   TRUE      · all mechanical checks pass → then a human reads the artifact against readRubric
//
// The hidden spec is authored from the goal text alone and written in only AFTER the run, so the
// agent can neither read nor satisfy it by construction. It is the objective-correctness oracle.
//
// Artifacts for every task land in the run directory and are meant to be READ. A green line here
// is a claim about a gate, never a claim about capability.

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync, execSync } from 'child_process'
import { TASKS, targetsOf, primaryTarget, type AgenticTask } from './__agentic_corpus'
import { makeVerifier } from './verify'
import { runAgentLoop } from './loop'
import { makeOfflineDriveTurn } from './synthDriver'
import type { ToolCtx } from '../tools/protocol'

const ARGS = process.argv.slice(2)
// --only accepts a comma-separated list so a whole tier can be run as one batch
// (`--only=a,b,c`); a single id is the degenerate case.
const ONLY_IDS = ARGS.find(a => a.startsWith('--only='))?.split('=')[1]?.split(',').map(s => s.trim()).filter(Boolean)
const ONLY = ONLY_IDS?.length ? ONLY_IDS : null
const NOOP_ONLY = ARGS.includes('--noop')
const MAX_ITERS = Number(ARGS.find(a => a.startsWith('--iters='))?.split('=')[1] ?? 24)

// Artifacts live under .crucible/agentic-runs/<pid>, NOT os.tmpdir(): tmpdir runs were reaped
// between sessions, so every "read the artifact" follow-up (cont.98's 5 TRUE tier-1 reads, the
// cont.99 runaway-output diagnosis) found nothing to read. Keep the last RUN_KEEP runs. (cont.100)
const RUNS_DIR = path.join(process.cwd(), '.crucible', 'agentic-runs')
const RUN_ROOT = path.join(RUNS_DIR, `${process.pid}`)
const RUN_KEEP = 10

function pruneOldRuns() {
  try {
    const keep = fs.readdirSync(RUNS_DIR)
      .map(n => ({ n, t: fs.statSync(path.join(RUNS_DIR, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t).slice(RUN_KEEP)
    for (const { n } of keep) fs.rmSync(path.join(RUNS_DIR, n), { recursive: true, force: true })
  } catch { /* best-effort */ }
}

// ── tree helpers ──────────────────────────────────────────────────────────────

/** The repo root, whose node_modules every scratch repo borrows (hermetic + offline: no install). */
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

function materialize(task: AgenticTask, dir: string) {
  for (const [rel, body] of Object.entries(task.files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body)
  }
  // Symlink rather than install — `tsx` resolves from here, and oracle.ts does the same thing
  // when it stages a candidate, so this matches the shape the real path already expects.
  const nm = path.join(dir, 'node_modules')
  if (!fs.existsSync(nm)) {
    try { fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), nm, 'dir') } catch { /* best-effort */ }
  }
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const SKIP = new Set(['node_modules', '.git', '.crucible', '__cov__'])
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue
      const abs = path.join(d, e.name)
      if (e.isDirectory()) walk(abs)
      else { try { out[path.relative(dir, abs)] = fs.readFileSync(abs, 'utf-8') } catch { /* skip */ } }
    }
  }
  walk(dir)
  return out
}

/** Run a command in the tree. Never throws — the exit code IS the signal. */
function run(cmd: string, dir: string, env: NodeJS.ProcessEnv = {}): { ok: boolean; out: string } {
  try {
    const out = execSync(cmd, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000, env: { ...process.env, ...env } })
    return { ok: true, out }
  } catch (e: any) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` || String(e.message ?? e) }
  }
}

// ── changed-line detection (the NOOP and UNEXERCISED signals) ─────────────────

/** LCS line diff → the 1-indexed line numbers that are NEW/CHANGED in `after`. */
function changedLines(before: string, after: string): number[] {
  const a = before.split('\n'), b = after.split('\n')
  const n = a.length, m = b.length
  // LCS table (corpus files are tiny; O(n*m) is free here).
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: number[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else { out.push(j + 1); j++ }
  }
  while (j < m) { out.push(j + 1); j++ }
  return out
}

/** Byte offset range [start,end) of each 1-indexed line. */
function lineOffsets(src: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let off = 0
  for (const line of src.split('\n')) {
    out.push([off, off + line.length])
    off += line.length + 1
  }
  return out
}

/**
 * Did the project's own check EXECUTE the changed lines? Uses V8's coverage (NODE_V8_COVERAGE),
 * so it is language-native and needs no instrumentation of the tree.
 *
 * This is the exact signal Phase 1's change-exercising invariant would enforce, measured here
 * first so Phase 1 is built on a number rather than a hunch.
 */
function exercised(dir: string, relFile: string, lines: number[], testCmd: string): { ran: boolean; covered: number; total: number } {
  if (!lines.length) return { ran: false, covered: 0, total: 0 }
  const covDir = path.join(dir, '__cov__')
  fs.rmSync(covDir, { recursive: true, force: true })
  fs.mkdirSync(covDir, { recursive: true })
  run(testCmd, dir, { NODE_V8_COVERAGE: covDir })

  const abs = path.resolve(dir, relFile)
  let src = ''
  try { src = fs.readFileSync(abs, 'utf-8') } catch { return { ran: false, covered: 0, total: lines.length } }
  const offs = lineOffsets(src)

  // Merge every covered byte-range V8 reported for this file.
  const hits: Array<[number, number]> = []
  let sawFile = false
  let files: string[] = []
  try { files = fs.readdirSync(covDir) } catch { return { ran: false, covered: 0, total: lines.length } }
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    let j: any
    try { j = JSON.parse(fs.readFileSync(path.join(covDir, f), 'utf-8')) } catch { continue }
    for (const script of j.result ?? []) {
      let p: string
      try { p = script.url?.startsWith('file://') ? new URL(script.url).pathname : script.url } catch { continue }
      if (!p || path.resolve(p) !== abs) continue
      sawFile = true
      for (const fn of script.functions ?? [])
        for (const r of fn.ranges ?? [])
          if (r.count > 0) hits.push([r.startOffset, r.endOffset])
    }
  }
  if (!sawFile) return { ran: false, covered: 0, total: lines.length }

  let covered = 0
  for (const ln of lines) {
    const [s, e] = offs[ln - 1] ?? [0, 0]
    if (e <= s) continue                                    // blank line — not a coverage target
    if (hits.some(([hs, he]) => hs <= s && he >= e)) covered++
  }
  const meaningful = lines.filter(ln => {
    const t = (src.split('\n')[ln - 1] ?? '').trim()
    return t && !t.startsWith('//') && t !== '}' && t !== '{'
  }).length
  return { ran: true, covered, total: Math.max(meaningful, 1) }
}

// ── the hidden-spec oracle ────────────────────────────────────────────────────

/** Write the hidden spec in AFTER the run and execute it. The agent never saw this. */
function hiddenVerdict(dir: string, task: AgenticTask): { pass: boolean; out: string } {
  const p = path.join(dir, '__hidden_spec.ts')
  fs.writeFileSync(p, task.hidden)
  const tsx = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
  const r = run(`${JSON.stringify(tsx)} ${JSON.stringify(p)}`, dir)
  fs.rmSync(p, { force: true })
  return { pass: r.ok && /HIDDEN OK/.test(r.out), out: r.out.trim().slice(0, 800) }
}

// ══ NO-OP CONTROL ═════════════════════════════════════════════════════════════
//
// No model. Materialize the repo, make a provably inert edit, ask the production verifier.
// A `passed:true` here means the gate cannot tell work from no work.

async function noopControl(): Promise<{ holes: number; total: number; rows: string[] }> {
  const rows: string[] = []
  let holes = 0, total = 0
  for (const task of TASKS) {
    if (ONLY && !ONLY.includes(task.id)) continue
    const dir = path.join(RUN_ROOT, 'noop', task.id)
    fs.mkdirSync(dir, { recursive: true })
    materialize(task, dir)

    // The no-op: append a comment to the file the change was supposed to land in.
    // Semantically identical to doing nothing at all.
    for (const t of targetsOf(task)) {
      fs.appendFileSync(path.join(dir, t), '\n// (agent looked at this file and changed nothing)\n')
    }

    const ctx = { projectPath: dir, emit: () => {}, allowMutation: true,
      budget: { remainingTokens: 10_000 } } as unknown as ToolCtx
    const claim = 'I reviewed the code and it looks correct already.'

    // Single-step wiring — server.ts:3654 threads the goal, so exampleGate is live.
    const v = await makeVerifier({ goal: task.goal }).verify(claim, ctx)
    // Multi-step wiring — server.ts:3550 builds makeVerifier({ command }) with NO goal, so
    // exampleGate returns null on its first line and the path falls to the unverified branch.
    // Measured separately because it is the wiring most real repo work actually runs under.
    const vMulti = await makeVerifier({}).verify(claim, ctx)

    const h = hiddenVerdict(dir, task)

    total++
    const hole = v.passed && !h.pass       // gate says yes, capability says no
    if (hole) holes++
    rows.push(`  ${hole ? 'HOLE' : 'ok  '} ${task.id.padEnd(26)} single-step=${v.passed ? 'PASS' : 'fail'}` +
      `${v.unverified ? '(unverified)' : ''} ${String(v.signal).padEnd(5)} | multi-step=${vMulti.passed ? 'PASS' : 'fail'}` +
      `${vMulti.unverified ? '(unverified)' : ''} ${String(vMulti.signal).padEnd(5)} | capability=${h.pass ? 'yes' : 'NO'}`)
  }
  return { holes, total, rows }
}

// ══ LIVE HALF ═════════════════════════════════════════════════════════════════

interface Outcome {
  id: string
  reported: 'pass' | 'fail'
  status: string
  klass: 'TRUE' | 'NOOP' | 'BLIND' | 'UNEXERCISED' | 'WRONG' | 'HONEST_FAIL' | 'CRASH'
  signal: string
  unverified: boolean
  changedFiles: string[]
  cov: string
  hidden: string
  dir: string
}

async function liveTask(task: AgenticTask): Promise<Outcome> {
  const dir = path.join(RUN_ROOT, 'live', task.id)
  fs.mkdirSync(dir, { recursive: true })
  materialize(task, dir)
  const before = snapshot(dir)

  const base: Outcome = {
    id: task.id, reported: 'fail', status: '', klass: 'CRASH', signal: '', unverified: false,
    changedFiles: [], cov: '-', hidden: '-', dir,
  }

  // Production wiring, strict on-device: this is what server.ts:3654 builds for a single-step
  // coding task (goal threaded → exampleGate live; hardenFinal on).
  const verifier = makeVerifier({ goal: task.goal })
  const events: Array<Record<string, unknown>> = []
  let result: any
  try {
    result = await runAgentLoop({
      goal: task.goal,
      projectPath: dir,
      driveTurn: makeOfflineDriveTurn(dir, task.goal),
      emit: (e) => events.push(e),
      verify: verifier.verify,
      hardenFinal: true,
      maxIters: MAX_ITERS,
      allowMutation: true,
    })
  } catch (e: any) {
    fs.writeFileSync(path.join(dir, '__events.json'), JSON.stringify(events, null, 2))
    return { ...base, status: `threw: ${String(e?.message ?? e).slice(0, 160)}` }
  }

  // Forensics — a verdict you cannot read is a verdict you cannot trust (cont.79h). Dump the
  // whole event stream and the loop's own summary next to the tree, ALWAYS, pass or fail.
  fs.writeFileSync(path.join(dir, '__events.json'), JSON.stringify(events, null, 2))
  fs.writeFileSync(path.join(dir, '__result.json'), JSON.stringify({
    ok: result?.ok, stopped: result?.stopped, verifiedSignal: result?.verifiedSignal,
    finalText: result?.finalText, iters: result?.iters, toolCallCount: result?.toolCallCount,
    eventTypes: [...new Set(events.map(e => String(e.type)))],
  }, null, 2))

  const after = snapshot(dir)
  const lastVerify = [...events].reverse().find(e => e.type === 'verify') as any
  const signal = String(lastVerify?.signal ?? 'none')
  const unverified = Boolean(lastVerify?.unverified)
  // The loop's OWN success condition — AgentLoopResult is {ok, stopped}, and `stopped:'final'`
  // with ok:true is what server.ts treats as a completed task. (An earlier cut of this harness
  // read a nonexistent `result.status`, scoring every run a fail regardless of the work done —
  // caught only by reading an artifact whose hidden spec was green behind a reported fail.)
  const reported: 'pass' | 'fail' = result?.ok && result?.stopped === 'final' ? 'pass' : 'fail'

  const changedFiles = Object.keys(after).filter(f => after[f] !== before[f] && !f.startsWith('__cov__'))
  // Substantive change is computed PER TARGET. On the multi-file tier every coupled file
  // must move: editing 1 of 4 is a partial refactor, and crediting it is the inflation this
  // corpus exists to catch. `substantive` therefore carries the PRIMARY file's changed lines
  // (that is what coverage instruments), but a miss in ANY target forces NOOP below.
  const changedIn = (f: string): number[] => {
    const a = before[f] ?? '', b = after[f] ?? ''
    return changedLines(a, b).filter(ln => {
      const t = (b.split('\n')[ln - 1] ?? '').trim()
      // A comment-only / whitespace-only edit is a no-op in substance.
      return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
  }
  const targets = targetsOf(task)
  const untouched = targets.filter(f => changedIn(f).length === 0)
  const substantive = changedIn(primaryTarget(task))

  const h = hiddenVerdict(dir, task)
  const hasTest = Boolean((() => { try { return JSON.parse(after['package.json']).scripts?.test } catch { return null } })())
  const ex = hasTest && substantive.length
    ? exercised(dir, primaryTarget(task), substantive, 'npm test --silent')
    : { ran: false, covered: 0, total: substantive.length }

  const out: Outcome = {
    ...base, reported, signal, unverified, changedFiles,
    status: `${result?.ok ? 'ok' : 'notok'}/${result?.stopped ?? '?'}`,
    cov: ex.ran ? `${ex.covered}/${ex.total}` : (hasTest ? 'not-run' : 'no-suite'),
    hidden: h.pass ? 'OK' : h.out.split('\n').find(l => /FAIL|Error|AssertionError|must/.test(l))?.slice(0, 120) ?? 'fail',
  }

  if (reported === 'fail') return { ...out, klass: 'HONEST_FAIL' }
  // A partial refactor is a no-op with extra steps: the coupled files it skipped are exactly
  // the ones that make the change real, and the hidden spec probes the top of that chain.
  if (untouched.length) {
    return { ...out, klass: 'NOOP',
      status: `${out.status} [untouched: ${untouched.join(', ')}]` }
  }
  if (!substantive.length) return { ...out, klass: 'NOOP' }
  if (unverified || signal === 'none') return { ...out, klass: 'BLIND' }
  if (ex.ran && ex.covered === 0) return { ...out, klass: 'UNEXERCISED' }
  if (!h.pass) return { ...out, klass: 'WRONG' }
  return { ...out, klass: 'TRUE' }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(RUN_ROOT, { recursive: true })
  pruneOldRuns()
  console.log(`Phase 0 — agentic path true-rate measurement`)
  console.log(`artifacts: ${RUN_ROOT}\n`)

  // Sanity: every corpus repo must START green, or the trap isn't a trap.
  console.log('── corpus sanity (every repo must start green) ──')
  let sane = true
  for (const task of TASKS) {
    if (ONLY && !ONLY.includes(task.id)) continue
    const dir = path.join(RUN_ROOT, 'sanity', task.id)
    fs.mkdirSync(dir, { recursive: true })
    materialize(task, dir)
    let ok = true, note = 'no suite (control for the unverified branch)'
    try {
      if (JSON.parse(task.files['package.json']).scripts?.test) {
        const r = run('npm test --silent', dir)
        ok = r.ok; note = ok ? 'starts green' : `STARTS RED: ${r.out.slice(0, 120)}`
      }
    } catch { /* no pkg */ }
    // The hidden spec must FAIL on the untouched repo — else it proves nothing.
    const h = hiddenVerdict(dir, task)
    const trap = !h.pass
    if (!ok || !trap) sane = false
    console.log(`  ${ok && trap ? 'ok  ' : 'BAD '} ${task.id.padEnd(26)} ${note}; hidden-spec-fails-before=${trap ? 'yes' : 'NO — VACUOUS'}`)
  }
  if (!sane) { console.log('\nCorpus is not sound — fix before trusting any number below.'); process.exit(1) }

  console.log('\n── NO-OP CONTROL (no model; does the gate tell work from no work?) ──')
  const noop = await noopControl()
  noop.rows.forEach(r => console.log(r))
  console.log(`\n  gate accepted a provable no-op on ${noop.holes}/${noop.total} tasks`)
  if (NOOP_ONLY) { console.log(`\nartifacts: ${RUN_ROOT}`); return }

  console.log('\n── LIVE (real loop, strict on-device, production wiring) ──')
  const outcomes: Outcome[] = []
  for (const task of TASKS) {
    if (ONLY && !ONLY.includes(task.id)) continue
    process.stdout.write(`  ${task.id.padEnd(26)} … `)
    const t0 = Date.now()
    const o = await liveTask(task)
    outcomes.push(o)
    console.log(`${o.klass.padEnd(11)} reported=${o.reported} signal=${o.signal.padEnd(7)} ` +
      `cov=${o.cov.padEnd(8)} hidden=${o.hidden === 'OK' ? 'OK' : 'fail'} ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  }

  const n = outcomes.length
  const by = (k: Outcome['klass']) => outcomes.filter(o => o.klass === k).length
  const reportedPass = outcomes.filter(o => o.reported === 'pass').length
  const truePass = by('TRUE')

  console.log(`\n═══ RESULT (n=${n}) ═══`)
  console.log(`  REPORTED pass : ${reportedPass}/${n}   ← the number that was being trusted`)
  console.log(`  TRUE pass     : ${truePass}/${n}   ← present + exercised + green + hidden-spec correct`)
  console.log(`\n  of the reported passes:`)
  console.log(`    NOOP        ${by('NOOP')}   nothing changed in the target file`)
  console.log(`    BLIND       ${by('BLIND')}   accepted with signal 'none' (verify.ts:112 — nothing checked)`)
  console.log(`    UNEXERCISED ${by('UNEXERCISED')}   changed lines never executed by the project check`)
  console.log(`    WRONG       ${by('WRONG')}   green + exercised, but the capability is absent`)
  console.log(`    TRUE        ${by('TRUE')}`)
  console.log(`  honest fails  ${by('HONEST_FAIL')}   ·  crashes ${by('CRASH')}`)

  const inflation = reportedPass - truePass
  console.log(`\n  GATE INFLATION: ${inflation} of ${reportedPass} reported passes are not real ` +
    `(${reportedPass ? Math.round((inflation / reportedPass) * 100) : 0}%)`)

  // No silent caps (doctrine): say what this run did NOT measure, or a reader will assume it did.
  const covRan = outcomes.filter(o => /^\d+\/\d+$/.test(o.cov)).length
  if (covRan === 0) {
    console.log(`\n  ⚠ EXERCISED was NOT measured on any task (cov=not-run everywhere). The suite runs`)
    console.log(`    through tsx, whose transpiled output does not map back to the .ts source in V8's`)
    console.log(`    coverage URLs. So UNEXERCISED is currently undetectable and TRUE means`)
    console.log(`    present + green + hidden-spec-correct ONLY. Do not read TRUE as "exercised".`)
  }
  console.log(`\n  ⚠ TRUE is a MECHANICAL verdict. The hidden spec is only as strong as its worst probe`)
  console.log(`    — one live TRUE (validate-email-domain) shipped \`includes('@') && includes('.')\`,`)
  console.log(`    which a read rejects and the spec passed by luck. Read every artifact below.`)

  // Every TRUE must still be READ against its rubric — a mechanical pass is not a verdict.
  const trues = outcomes.filter(o => o.klass === 'TRUE')
  if (trues.length) {
    console.log(`\n  READ THESE — mechanical TRUE is not a verdict (cont.79h):`)
    for (const o of trues) {
      const t = TASKS.find(x => x.id === o.id)!
      console.log(`    ${o.id}: ${targetsOf(t).map(f => path.join(o.dir, f)).join('\n      ')}`)
      console.log(`      rubric: ${t.readRubric}`)
    }
  }
  console.log(`\nartifacts: ${RUN_ROOT}`)
}

main().catch(e => { console.error('harness crashed:', e); process.exit(1) })
