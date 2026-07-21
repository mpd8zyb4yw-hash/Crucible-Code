// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.
// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — slidingWindowMax.
// Run: npx tsx __audit__/slidingWindowMax.hidden.ts   (imports ../src/slidingWindowMax)
import { slidingWindowMax } from '../src/slidingWindowMax'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}
const eq = (a: number[], b: number[]): boolean => JSON.stringify(a) === JSON.stringify(b)

check('classic case', eq(slidingWindowMax([1, 3, -1, -3, 5, 3, 6, 7], 3), [3, 3, 5, 5, 6, 7]))
check('k=1 is identity copy', eq(slidingWindowMax([4, 2, 9], 1), [4, 2, 9]))
check('k=n single max', eq(slidingWindowMax([4, 2, 9, 1], 4), [9]))
check('descending input', eq(slidingWindowMax([9, 7, 5, 3], 2), [9, 7, 5]))
check('ascending input', eq(slidingWindowMax([1, 2, 3, 4], 2), [2, 3, 4]))
check('all equal values', eq(slidingWindowMax([5, 5, 5], 2), [5, 5]))
check('duplicates of max inside window', eq(slidingWindowMax([2, 5, 5, 2], 2), [5, 5, 5]))
check('negatives', eq(slidingWindowMax([-4, -2, -9], 2), [-2, -2]))
check('single element k=1', eq(slidingWindowMax([7], 1), [7]))
const n = 300000
const big: number[] = new Array(n)
for (let i = 0; i < n; i++) big[i] = (i * 2654435761) % 1000003
const res = slidingWindowMax(big, 5000)
check('large input completes (O(n) required)', res.length === n - 5000 + 1)
let spot = true
for (let w = 0; w < 3; w++) {
  const start = w * 100000
  let m = -1
  for (let i = start; i < start + 5000; i++) m = Math.max(m, big[i])
  if (res[start] !== m) spot = false
}
check('spot-check large windows against rescan', spot)
let threwBig = false
try { slidingWindowMax([1, 2], 3) } catch (e) { threwBig = e instanceof RangeError }
check('k beyond length throws', threwBig)
let threwZero = false
try { slidingWindowMax([1, 2], 0) } catch (e) { threwZero = e instanceof RangeError }
check('k=0 throws', threwZero)
let threwEmpty = false
try { slidingWindowMax([], 1) } catch (e) { threwEmpty = e instanceof RangeError }
check('empty input throws', threwEmpty)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
