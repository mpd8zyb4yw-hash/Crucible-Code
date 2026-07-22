// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.
// HIDDEN adversarial suite for a NOVEL task (precedence-without-parens) — basicCalculator.
// Run: npx tsx __audit__/basicCalculator.hidden.ts   (imports ../src/basicCalculator)
import { basicCalculator } from '../src/basicCalculator'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

check('precedence: mul before add', basicCalculator('3+2*2') === 7)
check('single division truncates', basicCalculator(' 3/2 ') === 1)
check('precedence: div before add', basicCalculator('3+5 / 2') === 5)
check('precedence: mul before sub', basicCalculator('14-3*2') === 8)
check('two products summed', basicCalculator('2*3+4*5') === 26)
check('bare integer', basicCalculator('100') === 100)
check('chained multiply', basicCalculator('2*3*4') === 24)
check('division truncates toward zero', basicCalculator('10/3') === 3)
check('subtraction is left-associative', basicCalculator('7-2-1') === 4)
check('long addition chain', basicCalculator('1+2+3+4') === 10)
check('zero product then add', basicCalculator('0*5+3') === 3)
check('surrounding spaces ignored', basicCalculator('  42  ') === 42)
check('same-precedence div and mul left-to-right', basicCalculator('6/2*3') === 9)
check('mixed precedence with div', basicCalculator('2+3*4-6/2') === 11)
check('subtraction can go negative', basicCalculator('3-5') === -2)
check('chained division left-to-right', basicCalculator('8/2/2') === 2)
check('multi-digit operands', basicCalculator('12*12+1') === 145)
check('interior spaces ignored', basicCalculator('1 0 + 5') === 15)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
