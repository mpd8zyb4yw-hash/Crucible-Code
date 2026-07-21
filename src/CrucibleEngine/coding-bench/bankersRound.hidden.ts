// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.
// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — bankersRound.
// Run: npx tsx __audit__/bankersRound.hidden.ts   (imports ../src/bankersRound)
import { bankersRound } from '../src/bankersRound'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

check('half to even down', bankersRound(2.5, 0) === 2)
check('half to even up', bankersRound(3.5, 0) === 4)
check('half at zero', bankersRound(0.5, 0) === 0)
check('half at one point five', bankersRound(1.5, 0) === 2)
check('non-half rounds normally up', bankersRound(2.6, 0) === 3)
check('non-half rounds normally down', bankersRound(2.4, 0) === 2)
check('negative mirrors positive half', bankersRound(-2.5, 0) === -2)
check('negative non-half', bankersRound(-2.6, 0) === -3)
check('two decimals half to even', bankersRound(0.125, 2) === 0.12)
check('two decimals half to even up', bankersRound(0.135, 2) === 0.14)
check('two decimals normal', bankersRound(0.126, 2) === 0.13)
check('integer passthrough', bankersRound(7, 0) === 7)
check('already at precision', bankersRound(1.23, 2) === 1.23)
check('float-true: 9.95 is below the half', bankersRound(9.95, 1) === 9.9)
check('carry across digits', bankersRound(9.96, 1) === 10)
check('zero stays zero', bankersRound(0, 2) === 0)
const throwsRange = (fn: () => void): boolean => {
  try { fn(); return false } catch (e) { return e instanceof RangeError }
}
const throwsType = (fn: () => void): boolean => {
  try { fn(); return false } catch (e) { return e instanceof TypeError }
}
check('negative decimals throws', throwsRange(() => bankersRound(1, -1)))
check('fractional decimals throws', throwsRange(() => bankersRound(1, 1.5)))
check('NaN throws TypeError', throwsType(() => bankersRound(NaN, 0)))
check('Infinity throws TypeError', throwsType(() => bankersRound(Infinity, 0)))

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
