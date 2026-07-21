// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.
// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — intervalSubtract.
// Run: npx tsx __audit__/intervalSubtract.hidden.ts   (imports ../src/intervalSubtract)
import { subtractIntervals } from '../src/intervalSubtract'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}
const eq = (a: Array<[number, number]>, b: Array<[number, number]>): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

check('no removal returns base', eq(subtractIntervals([[1, 5]], []), [[1, 5]]))
check('hole in the middle', eq(subtractIntervals([[1, 10]], [[4, 6]]), [[1, 3], [7, 10]]))
check('trim left edge', eq(subtractIntervals([[1, 10]], [[1, 3]]), [[4, 10]]))
check('trim right edge', eq(subtractIntervals([[1, 10]], [[8, 10]]), [[1, 7]]))
check('full cover removes interval', eq(subtractIntervals([[2, 4]], [[1, 5]]), []))
check('exact cover removes interval', eq(subtractIntervals([[2, 4]], [[2, 4]]), []))
check('single point removed', eq(subtractIntervals([[1, 3]], [[2, 2]]), [[1, 1], [3, 3]]))
check('multiple holes', eq(subtractIntervals([[1, 10]], [[2, 3], [5, 6]]), [[1, 1], [4, 4], [7, 10]]))
check('removal spanning two bases', eq(subtractIntervals([[1, 3], [6, 9]], [[2, 7]]), [[1, 1], [8, 9]]))
check('disjoint removal ignored', eq(subtractIntervals([[1, 3]], [[10, 20]]), [[1, 3]]))
check('unsorted overlapping inputs', eq(subtractIntervals([[6, 9], [1, 3]], [[7, 8], [2, 2]]), [[1, 1], [3, 3], [6, 6], [9, 9]]))
check('empty base', eq(subtractIntervals([], [[1, 2]]), []))
check('negative coordinates', eq(subtractIntervals([[-10, -1]], [[-5, -3]]), [[-10, -6], [-2, -1]]))
let threw = false
try { subtractIntervals([[1, 2]], [[5, 4]]) } catch (e) { threw = e instanceof RangeError }
check('inverted remove interval throws', threw)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
