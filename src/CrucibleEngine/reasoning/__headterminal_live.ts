// ═══════════════════════════════════════════════════════════════════════════════
// LIVE METRIC — swapped-qwen-head terminal-guard rates (residue_terminal / refusal_terminal)
//
// A METRIC, not a gate (like fault:live / agentic:live): it drives the REAL agent loop
// (runAgentLoop + makeOfflineDriveTurn) against the LIVE on-device head — qwen2.5-1.5b, the
// sidecar now leading every reasoning/tool call (fmReact.ts §"Head model selection") — over a
// battery of short agent-mode tasks, subscribes to the debugBus, and reports how often the two
// TERMINAL guards in loop.ts fire:
//
//   · refusal_terminal  (loop.ts:615) — the head declined a task WITHOUT calling a tool, twice,
//        even after the one hard correction. A capability hallucination that reaches terminal.
//   · residue_terminal  (loop.ts:640) — the head finished with raw tool residue (an exit status /
//        bare acknowledgement) instead of prose, past MAX_RESIDUE_BOUNCES.
//
// Both are honest-stall outcomes; their RATE is the number the routing changes (cont.90 head swap +
// the residue/refusal bounce guards) were meant to keep low. It sat behind an "assume 15%, no live
// bench" placeholder because the live head was not wired into a measurement — this wires it.
//
// Stochastic: rerun-to-rerun noise is real (small battery, temperature > 0). Report the number with
// its n, never treat a single run as a gate. Deliberately NOT registered in bench:all.
//
//   run:  npx tsx src/CrucibleEngine/reasoning/__headterminal_live.ts
//         npx tsx src/CrucibleEngine/reasoning/__headterminal_live.ts --repeats=2
// ═══════════════════════════════════════════════════════════════════════════════

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { debugBus, type DebugEvent } from '../debug/bus'
import { runAgentLoop } from '../agent/loop'
import { makeOfflineDriveTurn } from '../agent/synthDriver'
import { headModelName } from '../agent/fmReact'

const ARGS = process.argv.slice(2)
const REPEATS = Math.max(1, Number(ARGS.find(a => a.startsWith('--repeats='))?.split('=')[1] ?? 1))
const MAX_ITERS = Number(ARGS.find(a => a.startsWith('--iters='))?.split('=')[1] ?? 6)

// A battery chosen to EXERCISE the two guards, not to make the head look good:
//   · info/tool tasks (residue-prone) — a single tool run whose observation the head may echo as
//     the whole answer instead of writing prose;
//   · capability questions (refusal-prone) — phrased so a weak head may say "I cannot" without
//     attempting a tool.
// Each is short and self-contained so a run costs a handful of head calls, not a repo build.
const TASKS: { id: string; goal: string }[] = [
  { id: 'info-crucible', goal: 'What is this project? Read README.md if present and answer in one sentence of prose.' },
  { id: 'info-listing', goal: 'List the files in this directory and then tell me, in prose, how many there are.' },
  { id: 'info-echo', goal: 'Run `echo crucible` and then tell me in a full sentence what the command printed.' },
  { id: 'info-node-ver', goal: 'Find out the node version available here and report it in a sentence.' },
  { id: 'cap-open-finder', goal: 'Open Finder and show me my Downloads folder.' },
  { id: 'cap-send-email', goal: 'Send an email to my team summarizing today.' },
  { id: 'reason-count', goal: 'How many words are in the phrase "the quick brown fox"? Answer in a sentence.' },
  { id: 'reason-file-make', goal: 'Create a file called hello.txt containing the word hello, then confirm in prose that it was created.' },
]

interface TaskTally {
  id: string
  refusal_bounced: number
  refusal_terminal: number
  residue_bounced: number
  residue_terminal: number
  stopped?: string
  iters?: number
  ms: number
}

const TRACKED = new Set(['refusal_bounced', 'refusal_terminal', 'residue_bounced', 'residue_terminal'])

async function runOne(goal: string): Promise<TaskTally & { id: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'headterm-'))
  fs.writeFileSync(path.join(dir, 'README.md'), '# Sample\nA tiny sample project for the live head terminal-rate metric.\n')
  const tally: TaskTally = { id: '', refusal_bounced: 0, refusal_terminal: 0, residue_bounced: 0, residue_terminal: 0, ms: 0 }
  const unsub = debugBus.subscribe((e: DebugEvent) => {
    if (e.category === 'agent' && TRACKED.has(e.type)) (tally as any)[e.type]++
  })
  const t0 = Date.now()
  try {
    const result: any = await runAgentLoop({
      goal,
      projectPath: dir,
      driveTurn: makeOfflineDriveTurn(dir, goal),
      emit: () => {},
      maxIters: MAX_ITERS,
      allowMutation: true,
    })
    tally.stopped = String(result?.stopped ?? result?.verifiedSignal ?? 'done')
    tally.iters = result?.iters
  } catch (e: any) {
    tally.stopped = `threw: ${String(e?.message ?? e).slice(0, 80)}`
  } finally {
    unsub()
    tally.ms = Date.now() - t0
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
  return { ...tally, id: '' }
}

async function main() {
  console.log(`── Live head terminal-guard rates — head=${headModelName()} ──`)
  console.log(`   battery=${TASKS.length} task(s) × ${REPEATS} repeat(s), maxIters=${MAX_ITERS}\n`)

  const rows: TaskTally[] = []
  let refusalTerminalTasks = 0
  let residueTerminalTasks = 0
  let total = 0

  for (let rep = 0; rep < REPEATS; rep++) {
    for (const task of TASKS) {
      const r = await runOne(task.goal)
      r.id = task.id + (REPEATS > 1 ? `#${rep + 1}` : '')
      rows.push(r)
      total++
      if (r.refusal_terminal > 0) refusalTerminalTasks++
      if (r.residue_terminal > 0) residueTerminalTasks++
      const flags = [
        r.refusal_terminal ? 'REFUSAL-TERM' : r.refusal_bounced ? 'refusal-bounced' : '',
        r.residue_terminal ? 'RESIDUE-TERM' : r.residue_bounced ? 'residue-bounced' : '',
      ].filter(Boolean).join(' ')
      console.log(`  ${r.id.padEnd(20)} ${String(r.stopped).padEnd(14)} ${(r.ms / 1000).toFixed(1)}s  ${flags}`)
    }
  }

  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`
  console.log(`\n── Terminal-guard rates over n=${total} live task runs (head=${headModelName()}) ──`)
  console.log(`   refusal_terminal : ${refusalTerminalTasks}/${total}  (${pct(refusalTerminalTasks)})`)
  console.log(`   residue_terminal : ${residueTerminalTasks}/${total}  (${pct(residueTerminalTasks)})`)
  const bounced = rows.reduce((a, r) => a + r.refusal_bounced + r.residue_bounced, 0)
  console.log(`   (bounces that RECOVERED, not terminal: ${bounced})`)
  console.log(`\n   NOTE: stochastic metric, not a gate. Fold the number into NEXT_SESSION.md with its n.`)
}

main()
