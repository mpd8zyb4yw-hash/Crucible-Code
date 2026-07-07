// Offline, pure bench for telemetry.ts — run with `npx tsx src/CrucibleEngine/localModels/__telemetry_bench.ts`.
// Verifies stat aggregation (calls/wins/errors/avg latency/win rate) without touching any
// model, server, or the real .crucible/ dir (points HOME/CWD-derived path at a scratch dir).

import fs from 'fs'
import os from 'os'
import path from 'path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-bench-'))
process.chdir(scratch)

const { recordOutcome, markWin, getStats, resetStats } = await import('./telemetry')

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exitCode = 1
  } else {
    console.log(`ok — ${msg}`)
  }
}

resetStats()
assert(getStats().length === 0, 'starts empty')

recordOutcome({ modelId: 'a', latencyMs: 100, confidence: 0.8, won: false, errored: false })
recordOutcome({ modelId: 'a', latencyMs: 200, confidence: 0.9, won: false, errored: false })
markWin('a')
recordOutcome({ modelId: 'b', latencyMs: 50, confidence: 0, won: false, errored: true })

const stats = getStats()
const a = stats.find(s => s.modelId === 'a')!
const b = stats.find(s => s.modelId === 'b')!

assert(a.calls === 2, 'model a recorded 2 calls')
assert(a.wins === 1, 'model a recorded 1 win')
assert(a.avgLatencyMs === 150, 'model a avg latency is (100+200)/2')
assert(a.winRate === 0.5, 'model a win rate is 1/2')
assert(b.calls === 1 && b.errors === 1, 'model b recorded 1 call, 1 error')
assert(b.winRate === 0, 'model b never won')

resetStats()
assert(getStats().length === 0, 'reset clears stats')

fs.rmSync(scratch, { recursive: true, force: true })
if (process.exitCode) {
  console.error('__telemetry_bench: FAILED')
} else {
  console.log('__telemetry_bench: ALL GREEN')
}
