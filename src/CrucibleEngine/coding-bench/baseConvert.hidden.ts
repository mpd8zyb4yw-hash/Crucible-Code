// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.
// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — baseConvert.
// Run: npx tsx __audit__/baseConvert.hidden.ts   (imports ../src/baseConvert)
import { convertBase } from '../src/baseConvert'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

check('binary to decimal', convertBase('1010', 2, 10) === '10')
check('decimal to hex', convertBase('255', 10, 16) === 'ff')
check('hex to binary', convertBase('ff', 16, 2) === '11111111')
check('uppercase input accepted', convertBase('FF', 16, 10) === '255')
check('output is lowercase', convertBase('255', 10, 36) === '73')
check('identity same base', convertBase('12345', 10, 10) === '12345')
check('zero in any base', convertBase('0', 2, 36) === '0')
check('negative zero collapses', convertBase('-0', 10, 2) === '0')
check('leading zeros ignored', convertBase('007', 10, 2) === '111')
check('negative preserved', convertBase('-255', 10, 16) === '-ff')
check('base 36 digits', convertBase('z', 36, 10) === '35')
const big = '123456789012345678901234567890123456789'
check('beyond MAX_SAFE_INTEGER round trip', convertBase(convertBase(big, 10, 16), 16, 10) === big)
check('long binary round trip', (() => {
  const b = '1' + '0'.repeat(100)
  return convertBase(convertBase(b, 2, 36), 36, 2) === b
})())
const throwsRange = (fn: () => void): boolean => {
  try { fn(); return false } catch (e) { return e instanceof RangeError }
}
check('base 1 throws', throwsRange(() => convertBase('1', 1, 10)))
check('base 37 throws', throwsRange(() => convertBase('1', 10, 37)))
check('digit invalid for base throws', throwsRange(() => convertBase('2', 2, 10)))
check('letter beyond base throws', throwsRange(() => convertBase('g', 16, 10)))
check('empty digits throws', throwsRange(() => convertBase('', 10, 2)))
check('bare minus throws', throwsRange(() => convertBase('-', 10, 2)))

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
