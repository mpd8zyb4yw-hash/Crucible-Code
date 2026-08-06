// ============================================================================
// Committed bench for src/server/latency.ts — per-model latency tracking extracted
// from server.ts. Proves: percentile nearest-rank + empty-safety, the rolling
// window drops oldest beyond N, and the report computes avg/p50/p95 per model.
// Run: npx tsx src/server/__latency_bench.ts
// ============================================================================
import { LatencyTracker, percentile } from './latency'

const checks: Array<{ name: string; pass: boolean }> = []
const ok = (name: string, pass: boolean) => checks.push({ name, pass })

ok('percentile: nearest-rank on a sorted array', percentile([10, 20, 30, 40], 0.5) === 30 && percentile([10, 20, 30, 40], 0.95) === 40)
ok('percentile: empty array → 0', percentile([], 0.5) === 0)

const t = new LatencyTracker(50)
for (const v of [100, 200, 300]) t.record('m1', v)
const r = t.report()
ok('report computes avg/p50/p95/samples per model',
  r['m1'].samples === 3 && r['m1'].avg === 200 && r['m1'].p50 === 200 && r['m1'].p95 === 300)

const w = new LatencyTracker(3)
for (const v of [1, 2, 3, 4, 5]) w.record('m', v) // window 3 → keeps [3,4,5]
ok('rolling window keeps only the last N samples', w.report()['m'].samples === 3 && w.report()['m'].avg === 4)

ok('an untracked model is absent from the report; empty tracker → {}',
  new LatencyTracker().report()['nope'] === undefined && Object.keys(new LatencyTracker().report()).length === 0)

const multi = new LatencyTracker()
multi.record('a', 10); multi.record('b', 20)
ok('models are tracked independently', multi.report()['a'].avg === 10 && multi.report()['b'].avg === 20)

const pass = checks.filter(c => c.pass).length
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'} — ${c.name}`)
console.log(`\n${pass}/${checks.length} passed`)
if (pass !== checks.length) process.exit(1)
