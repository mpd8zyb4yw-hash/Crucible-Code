// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.
// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — fractionAdd.
// Run: npx tsx __audit__/fractionAdd.hidden.ts   (imports ../src/fractionAdd)
import { addFractions } from '../src/fractionAdd'
import type { Fraction } from '../src/fractionAdd'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}
const eq = (a: Fraction, b: Fraction): boolean => a[0] === b[0] && a[1] === b[1]

check('halves plus thirds', eq(addFractions([1, 2], [1, 3]), [5, 6]))
check('reduces to lowest terms', eq(addFractions([1, 4], [1, 4]), [1, 2]))
check('whole number result', eq(addFractions([1, 2], [1, 2]), [1, 1]))
check('zero normalizes', eq(addFractions([1, 3], [-1, 3]), [0, 1]))
check('zero plus zero', eq(addFractions([0, 5], [0, 7]), [0, 1]))
check('negative numerator input', eq(addFractions([-1, 2], [1, 3]), [-1, 6]))
check('negative denominator normalized', eq(addFractions([1, -2], [0, 1]), [-1, 2]))
check('both negative cancels', eq(addFractions([1, -2], [-1, 2]), [-1, 1]))
check('double negative is positive', eq(addFractions([-1, -2], [0, 1]), [1, 2]))
check('result denominator always positive', addFractions([1, -3], [1, -6])[1] > 0)
check('large coprime denominators', eq(addFractions([1, 97], [1, 89]), [186, 8633]))
check('inputs not mutated', (() => {
  const a: Fraction = [2, 4]
  addFractions(a, [1, 2])
  return a[0] === 2 && a[1] === 4
})())
const throwsRange = (fn: () => void): boolean => {
  try { fn(); return false } catch (e) { return e instanceof RangeError }
}
const throwsType = (fn: () => void): boolean => {
  try { fn(); return false } catch (e) { return e instanceof TypeError }
}
check('zero denominator throws RangeError', throwsRange(() => addFractions([1, 0], [1, 2])))
check('float entry throws TypeError', throwsType(() => addFractions([1.5, 2], [1, 2])))
check('NaN entry throws TypeError', throwsType(() => addFractions([NaN, 2], [1, 2])))

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
