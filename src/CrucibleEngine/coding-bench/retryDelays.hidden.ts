// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.
// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — retryDelays.
// Run: npx tsx __audit__/retryDelays.hidden.ts   (imports ../src/retryDelays)
import { retryDelays } from '../src/retryDelays'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}
const eq = (a: number[], b: number[]): boolean => JSON.stringify(a) === JSON.stringify(b)

check('doubling sequence', eq(retryDelays(4, 100, 10000, 2), [100, 200, 400, 800]))
check('cap applies', eq(retryDelays(5, 100, 500, 2), [100, 200, 400, 500, 500]))
check('cap exact from then on', eq(retryDelays(6, 1, 4, 2), [1, 2, 4, 4, 4, 4]))
check('factor 1 is constant', eq(retryDelays(3, 250, 1000, 1), [250, 250, 250]))
check('zero attempts empty', eq(retryDelays(0, 100, 1000, 2), []))
check('single attempt is base', eq(retryDelays(1, 7, 100, 3), [7]))
check('fractional factor allowed above 1', eq(retryDelays(3, 100, 1000, 1.5), [100, 150, 225]))
check('recurrence pins iterated multiplication, not Math.pow',
  eq(retryDelays(6, 1, 10, 1.1), [1, 1.1, 1.2100000000000002, 1.3310000000000004, 1.4641000000000006, 1.6105100000000008]))
check('cap equal to base collapses', eq(retryDelays(3, 100, 100, 2), [100, 100, 100]))
check('deterministic across calls', eq(retryDelays(4, 100, 10000, 2), retryDelays(4, 100, 10000, 2)))
const throws = (fn: () => void): boolean => {
  try { fn(); return false } catch (e) { return e instanceof RangeError }
}
check('negative attempts throws', throws(() => retryDelays(-1, 100, 1000, 2)))
check('fractional attempts throws', throws(() => retryDelays(1.5, 100, 1000, 2)))
check('zero base throws', throws(() => retryDelays(3, 0, 1000, 2)))
check('cap below base throws', throws(() => retryDelays(3, 100, 50, 2)))
check('factor below 1 throws', throws(() => retryDelays(3, 100, 1000, 0.5)))

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
