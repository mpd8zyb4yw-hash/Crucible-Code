// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.
// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — matrixRotate.
// Run: npx tsx __audit__/matrixRotate.hidden.ts   (imports ../src/matrixRotate)
import { rotate90 } from '../src/matrixRotate'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

check('2x2 rotation', eq(rotate90([[1, 2], [3, 4]]), [[3, 1], [4, 2]]))
check('3x3 rotation', eq(rotate90([[1, 2, 3], [4, 5, 6], [7, 8, 9]]), [[7, 4, 1], [8, 5, 2], [9, 6, 3]]))
check('1xN becomes Nx1', eq(rotate90([[1, 2, 3]]), [[1], [2], [3]]))
check('Nx1 becomes 1xN reversed', eq(rotate90([[1], [2], [3]]), [[3, 2, 1]]))
check('2x3 becomes 3x2', eq(rotate90([[1, 2, 3], [4, 5, 6]]), [[4, 1], [5, 2], [6, 3]]))
check('single cell', eq(rotate90([[7]]), [[7]]))
check('empty matrix', eq(rotate90([]), []))
check('rows of zero length', eq(rotate90([[], []]), []))
check('four rotations restore square', (() => {
  const m = [[1, 2], [3, 4]]
  return eq(rotate90(rotate90(rotate90(rotate90(m)))), m)
})())
check('strings preserved', eq(rotate90([['a', 'b'], ['c', 'd']]), [['c', 'a'], ['d', 'b']]))
check('input not mutated', (() => {
  const m = [[1, 2], [3, 4]]
  rotate90(m)
  return eq(m, [[1, 2], [3, 4]])
})())
check('outer array not aliased', (() => {
  const m = [[1, 2], [3, 4]]
  const r = rotate90(m)
  r[0][0] = 99
  return m[1][0] === 3
})())
let threw = false
try { rotate90([[1, 2], [3]]) } catch (e) { threw = e instanceof RangeError }
check('ragged input throws RangeError', threw)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
