// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.
// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — intervalMerge.
// Run: npx tsx __audit__/intervalMerge.hidden.ts   (imports ../src/intervalMerge)
import { mergeIntervals } from '../src/intervalMerge'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}
const eq = (a: Array<[number, number]>, b: Array<[number, number]>): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

check('disjoint stay disjoint', eq(mergeIntervals([[1, 2], [5, 6]]), [[1, 2], [5, 6]]))
check('overlap merges', eq(mergeIntervals([[1, 4], [3, 6]]), [[1, 6]]))
check('adjacent integers merge', eq(mergeIntervals([[1, 2], [3, 4]]), [[1, 4]]))
check('gap of one does not merge', eq(mergeIntervals([[1, 2], [4, 5]]), [[1, 2], [4, 5]]))
check('unsorted input handled', eq(mergeIntervals([[5, 6], [1, 2], [2, 4]]), [[1, 6]]))
check('containment collapses', eq(mergeIntervals([[1, 10], [2, 3]]), [[1, 10]]))
check('duplicate intervals', eq(mergeIntervals([[1, 2], [1, 2]]), [[1, 2]]))
check('point intervals', eq(mergeIntervals([[3, 3], [1, 1], [2, 2]]), [[1, 3]]))
check('negative coordinates', eq(mergeIntervals([[-5, -3], [-4, 0]]), [[-5, 0]]))
check('empty input', eq(mergeIntervals([]), []))
const input: Array<[number, number]> = [[3, 4], [1, 2]]
mergeIntervals(input)
check('input array not mutated', input[0][0] === 3 && input[1][0] === 1)
let threw = false
try { mergeIntervals([[2, 1]]) } catch (e) { threw = e instanceof RangeError }
check('inverted interval throws RangeError', threw)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
