// ═══════════════════════════════════════════════════════════════════════════════
// STACK HEAD-TO-HEAD — the measurement that has never been taken.
// ═══════════════════════════════════════════════════════════════════════════════
//
// This repo contains TWO independent implementations of the same propose→verify doctrine:
//
//   LIVE  `server.ts → agent/synthDriver.ts → synth/universal.ts` (`synthesizeUniversal`).
//         This is what a user request actually reaches.
//   DEAD  `reasoning/solve.ts` (`solveCodeTask`). Measured 2026-08-02 by `npm run audit:reach`
//         to have NO transitive path from `server.ts`.
//
// ~167 commits and every capability number from 2026-07-19 onward (ladder, carve probe, rung
// census, hard-set scorecard) measured the DEAD stack. Nobody has ever run the two on the same
// input, because until now they were never both invoked from one process. So the question that
// decides whether to WIRE `reasoning/` in or DELETE it — "is it actually better?" — has no
// evidence behind it in either direction.
//
// ─── WHAT IS COMPARED, AND WHY IT IS NOT A FAIR FIGHT BY CONSTRUCTION ──────────
// The two stacks take different inputs, and flattening that away would fake the comparison:
//   • `solveCodeTask` is HANDED structured acceptance cases. It knows exactly what to satisfy.
//   • `synthesizeUniversal` is handed a natural-language spec and must DERIVE its own tests
//     (`derive.ts`, `goalExampleOracle.ts`) before it can verify anything.
// The same worked examples are given to both — as `cases` to one and as `Examples:` lines to the
// other — which is as close to parity as the two interfaces allow. The live stack is still doing
// strictly more work (deriving the oracle it will be judged by), and that asymmetry is REAL: it
// is what production actually does on a user request. Read the result as "which stack solves a
// user's task", not "which search algorithm is stronger".
//
// ─── THE STANDARD: CERTIFIED vs GENERALISES ────────────────────────────────────
// Both arms are scored the way the rung census scored rungs, and for the same reason — on
// 2026-08-02c, 5 of 12 helpers that certified against their own examples were NOT the intended
// function. So:
//   CERTIFIED    the arm itself reports success (its own oracle accepted).
//   GENERALISES  that source ALSO passes HELD-OUT witnesses it never saw. This is the real score.
// A stack that certifies often and generalises rarely is overfitting its own oracle, which is
// exactly the failure the census was built to catch.
//
// ─── TRAPS THIS HARNESS DISARMS ────────────────────────────────────────────────
//  1. DISTILLATION / MEMORISATION. `synthesizeUniversal` distills solved tasks into pure-code
//     primitives, so a second draw of the same task can hit the catalog at ZERO model calls and
//     score as a win. That is a measurement of the cache, not the engine. `distill: false` here,
//     and `CRUCIBLE_NO_DISTILL=1` is set for the process.
//  2. WRONG HEAD. A misconfigured head returns EMPTY completions and reads as a capability
//     ceiling. Preflighted below; aborts rather than scoring zeros.
//  3. ONE-DRAW CONCLUSIONS. Both arms print a Wilson interval. At N=3 a bare fraction licenses
//     almost nothing, and two results were retracted in this repo for exactly that.
//
// Run: npm run stack:h2h        (H2H_RUNS=n, H2H_TASK=name to restrict)
// ═══════════════════════════════════════════════════════════════════════════════

process.env.CRUCIBLE_NO_DISTILL = '1'   // set BEFORE any engine import reads it

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { fmComplete, headModelName } from './agent/fmReact'
import { solveCodeTask } from './reasoning/solve'
import { verifyCode, type CodeAcceptance, type CodeCase } from './reasoning/codeVerifier'
import { synthesizeUniversal } from './synth/universal'

interface Task {
  name: string
  entry: string
  /** Difficulty band, for reading the table — not used by either arm. */
  band: 'easy' | 'rung' | 'hard'
  goal: string
  /** Worked examples. Given to DEAD as `cases`, and rendered into LIVE's spec text. */
  cases: CodeCase[]
  /** Never shown to either arm. The actual score. */
  witnesses: CodeCase[]
  /** Module path the live stack writes to; it extracts this from the spec text. */
  modulePath: string
}

const TASKS: Task[] = [
  {
    name: 'editDistance',
    entry: 'editDistance',
    band: 'easy',
    goal:
      'Write editDistance(a: string, b: string): number returning the Levenshtein edit distance — ' +
      'the minimum number of single-character insertions, deletions or substitutions needed to ' +
      'turn `a` into `b`.',
    modulePath: 'src/editDistance.ts',
    cases: [
      { args: ['kitten', 'sitting'], expected: 3 },
      { args: ['cat', 'cot'], expected: 1 },
      { args: ['', 'abc'], expected: 3 },
      { args: ['flaw', 'lawn'], expected: 2 },
    ],
    witnesses: [
      { args: ['', ''], expected: 0 },
      { args: ['abc', 'abc'], expected: 0 },
      { args: ['abc', ''], expected: 3 },
      { args: ['a', 'b'], expected: 1 },
      { args: ['sunday', 'saturday'], expected: 3 },
      { args: ['intention', 'execution'], expected: 5 },
    ],
  },
  {
    // Carried over from the rung census / hand-carve probe so the DEAD arm's number here is
    // comparable to the 8/12-vs-3/30 history rather than a fresh restatement.
    name: 'nextUnquotedComma',
    entry: 'nextUnquotedComma',
    band: 'rung',
    goal:
      'Write nextUnquotedComma(line: string, from: number): number returning the index of the ' +
      'first comma at or after position `from` that is NOT inside a double-quoted section, or ' +
      '-1 if there is no such comma. Scan forward one character at a time keeping a boolean ' +
      '"inside quotes" flag that flips on every double-quote character; a comma counts only ' +
      'while that flag is false.',
    modulePath: 'src/nextUnquotedComma.ts',
    cases: [
      { args: ['a,b', 0], expected: 1 },
      { args: ['a', 0], expected: -1 },
      { args: ['a,,b', 2], expected: 2 },
      { args: ['"x,y",z', 0], expected: 5 },
      { args: ['"he said ""hi""",z', 0], expected: 16 },
      { args: ['a,b', 2], expected: -1 },
    ],
    witnesses: [
      { args: [',a', 0], expected: 0 },
      { args: ['abc', 9], expected: -1 },
      { args: ['', 0], expected: -1 },
      { args: ['"ab",c', 0], expected: 4 },
      { args: ['a,"b,c",d', 2], expected: 7 },
      { args: ['a,b,c', 2], expected: 3 },
      { args: ['a,,b', 0], expected: 1 },
      { args: ['a,,b', 3], expected: -1 },
      { args: ['"x,y",z', 6], expected: -1 },
    ],
  },
  {
    // The whole hard task the DEAD stack scores 0/12 on end to end. Included because a carve's
    // rungs being reachable says nothing about the task being solvable, and because this is the
    // shape a user would actually ask for.
    name: 'csvSelect',
    entry: 'csvSelect',
    band: 'hard',
    goal:
      'Write csvSelect(csv: string, index: number): string[] returning the value at column ' +
      '`index` (0-based) of every line. Lines are separated by newlines and fields by commas. ' +
      'A field may be wrapped in double quotes, in which case commas inside it are literal text ' +
      'and a doubled double-quote is one literal double-quote character; the wrapping quotes are ' +
      'not part of the value. No field contains a newline. A line with too few fields yields the ' +
      'empty string.',
    modulePath: 'src/csvSelect.ts',
    cases: [
      { args: ['a,b\nc,d', 0], expected: ['a', 'c'] },
      { args: ['a,b\nc,d', 1], expected: ['b', 'd'] },
      { args: ['"x,y",z', 0], expected: ['x,y'] },
      { args: ['"he said ""hi""",z', 0], expected: ['he said "hi"'] },
      { args: ['a\nb,c', 1], expected: ['', 'c'] },
    ],
    witnesses: [
      { args: ['a', 0], expected: ['a'] },
      { args: ['a,b', 5], expected: [''] },
      { args: ['"a,b",c\nd,e', 0], expected: ['a,b', 'd'] },
      { args: ['x,y,z', 2], expected: ['z'] },
      { args: ['"",a', 0], expected: [''] },
      { args: ['a,b\n', 0], expected: ['a', ''] },
    ],
  },
]

/** Render a task as the natural-language spec the LIVE stack consumes. */
function specFor(t: Task): string {
  const ex = t.cases
    .map(c => `${t.entry}(${(c.args ?? []).map(a => JSON.stringify(a)).join(', ')}) === ${JSON.stringify(c.expected)}`)
    .join('\n')
  return `Implement the following at ${t.modulePath}.\n${t.goal}\nExamples:\n${ex}`
}

/** Run one source against the held-out witnesses. Identical judge for both arms. */
async function generalises(t: Task, source: string): Promise<{ ok: boolean; failed: string[] }> {
  const verdict = await verifyCode(
    { value: source, fingerprint: `h2h:${t.name}` },
    { goal: t.name, domain: 'code', acceptance: { entry: t.entry, cases: t.witnesses } satisfies CodeAcceptance as unknown as Record<string, unknown> },
  )
  return { ok: verdict.pass, failed: (verdict.signals ?? []).filter(s => /^case /.test(s)) }
}

const s = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

function wilson(k: number, n: number): [number, number] {
  if (!n) return [0, 0]
  const z = 1.96, p = k / n, d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)]
}
const pct = (x: number): string => `${(x * 100).toFixed(0)}%`

async function preflight(): Promise<void> {
  const name = headModelName()
  console.log(`# head: ${name}`)
  if (/apple/i.test(name)) {
    console.error(`ABORT: head is '${name}', not the local GGUF. Export CRUCIBLE_BONSAI_BIN/MODEL or LOCAL_INFERENCE_URL.`)
    process.exit(1)
  }
  const t0 = Date.now()
  const text = await fmComplete([{ role: 'user', content: 'Write a JS function add(a,b) that returns a+b. Code only.' }], { maxTokens: 64 })
  if (!text.trim()) {
    console.error(`ABORT: head returned an EMPTY completion (${Date.now() - t0}ms) — a misconfigured head scores as a capability ceiling.`)
    process.exit(1)
  }
  console.log(`# head preflight ok (${text.trim().length} chars in ${Date.now() - t0}ms)\n`)
}

interface ArmScore { arm: 'dead' | 'live'; task: string; runs: number; certified: number; generalised: number; calls: number[]; walls: number[]; fails: Set<string> }

async function drawDead(t: Task, wallMs: number): Promise<{ source: string | null; calls: number }> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), wallMs)
  try {
    const res = await solveCodeTask(
      { goal: t.goal, entry: t.entry, cases: t.cases },
      { globalModelCalls: 24, maxEpochs: 6, wallClockMs: wallMs, signal: ac.signal } as never,
    )
    return { source: res.status === 'solved' && res.solution ? res.solution.value : null, calls: res.modelCalls ?? 0 }
  } finally { clearTimeout(timer) }
}

async function drawLive(t: Task): Promise<{ source: string | null; calls: number }> {
  const r = await synthesizeUniversal(specFor(t), { distill: false, maxFmRounds: 6, modulePath: t.modulePath })
  const hit = r.files?.find(f => f.path === t.modulePath) ?? r.files?.[0]
  return { source: r.verified && hit ? hit.content : null, calls: r.fmCalls ?? 0 }
}

async function main(): Promise<void> {
  await preflight()

  const runs = Math.max(1, Number(process.env.H2H_RUNS || 3))
  const wallMs = Math.max(10_000, Number(process.env.H2H_WALL_MS || 120_000))
  const only = process.env.H2H_TASK
  const selected = TASKS.filter(t => !only || t.name === only)
  if (!selected.length) { console.error(`no task matches H2H_TASK=${only}`); process.exit(1) }

  const out = process.env.H2H_OUT ?? join(process.cwd(), 'scratchpad-bench', 'stack-h2h.jsonl')
  mkdirSync(dirname(out), { recursive: true })

  console.log(`# STACK HEAD-TO-HEAD — ${selected.length} task(s) x ${runs} draw(s) x 2 arms, ${s(wallMs)} wall per dead-arm draw`)
  console.log(`# DEAD = reasoning/solveCodeTask (no live path from server.ts)`)
  console.log(`# LIVE = synth/synthesizeUniversal (what a user request reaches)`)
  console.log(`# distillation DISABLED both sides — a catalog hit is a cache measurement, not an engine one\n`)

  const scores: ArmScore[] = []
  for (const t of selected) {
    for (const arm of ['dead', 'live'] as const) {
      const sc: ArmScore = { arm, task: t.name, runs, certified: 0, generalised: 0, calls: [], walls: [], fails: new Set() }
      console.log(`── ${t.name} [${t.band}]  arm=${arm.toUpperCase()}`)
      for (let i = 0; i < runs; i++) {
        const t0 = Date.now()
        let source: string | null = null, calls = 0, err = ''
        try {
          const r = arm === 'dead' ? await drawDead(t, wallMs) : await drawLive(t)
          source = r.source; calls = r.calls
        } catch (e: unknown) { err = String((e as Error)?.message ?? e).slice(0, 80) }
        const wall = Date.now() - t0
        sc.calls.push(calls); sc.walls.push(wall)
        let mark = err ? `threw: ${err}` : 'no certified source'
        if (source) {
          sc.certified++
          const g = await generalises(t, source)
          if (g.ok) { sc.generalised++; mark = 'CERTIFIED + GENERALISES' }
          else {
            mark = `CERTIFIED but OVERFIT (fails ${g.failed.length}/${t.witnesses.length} held out)`
            for (const f of g.failed) sc.fails.add(f.slice(0, 120))
          }
        }
        console.log(`     draw ${String(i + 1).padStart(2)}/${runs}  ${String(calls).padStart(3)}c ${s(wall).padStart(8)}  ${mark}`)
      }
      const [lo, hi] = wilson(sc.generalised, sc.runs)
      console.log(`   → certified ${sc.certified}/${sc.runs}, GENERALISES ${sc.generalised}/${sc.runs} (95% CI ${pct(lo)}-${pct(hi)})`)
      for (const f of [...sc.fails].slice(0, 3)) console.log(`     held-out failure: ${f}`)
      console.log('')
      scores.push(sc)
      appendFileSync(out, JSON.stringify({ stackH2H: true, ...sc, fails: [...sc.fails].slice(0, 4) }) + '\n')
    }
  }

  console.log('\n# ── HEAD TO HEAD (GENERALISES — the held-out score) ───────────────────')
  console.log('  task                band    DEAD (reasoning)   LIVE (synth)')
  for (const t of selected) {
    const d = scores.find(x => x.task === t.name && x.arm === 'dead')
    const l = scores.find(x => x.task === t.name && x.arm === 'live')
    if (!d || !l) continue
    console.log(`  ${t.name.padEnd(20)}${t.band.padEnd(8)}${`${d.generalised}/${d.runs}`.padEnd(19)}${l.generalised}/${l.runs}`)
  }

  const dead = scores.filter(x => x.arm === 'dead').reduce((a, b) => a + b.generalised, 0)
  const liveN = scores.filter(x => x.arm === 'live').reduce((a, b) => a + b.generalised, 0)
  const total = selected.length * runs
  console.log(`\n  TOTAL   DEAD ${dead}/${total}   LIVE ${liveN}/${total}`)
  console.log('\n# ── WHAT THIS LICENSES ────────────────────────────────────────────────')
  if (dead > liveN) {
    console.log('  The disconnected stack is BETTER. Wiring it into synthDriver.ts is justified work,')
    console.log('  and the capability numbers from 2026-07-19 onward describe something worth shipping.')
  } else if (liveN > dead) {
    console.log('  The LIVE stack is at least as good. Wiring `reasoning/` in is NOT justified by this')
    console.log('  evidence — the case for retiring it, and for measuring `synth/` instead, is stronger.')
  } else {
    console.log('  A tie on this sample. A tie does NOT justify wiring: `reasoning/` costs ~14k LOC of')
    console.log('  engine plus ~10.7k LOC of harness to keep, and equal capability is not a reason to pay it.')
  }
  console.log(`  Sample is ${runs} draw(s)/arm/task — read the intervals above, not the totals.`)
  console.log(JSON.stringify({ stackH2HSummary: true, runs, scores: scores.map(x => ({ ...x, fails: [...x.fails].slice(0, 3) })) }))
}

main().catch(e => { console.error('head-to-head failed:', e?.stack ?? e); process.exit(1) })
