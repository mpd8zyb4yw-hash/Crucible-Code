// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.
// HIDDEN adversarial suite for a NOVEL task (shunting-yard / parenthesised precedence) — calculatorWithParens.
// Run: npx tsx __audit__/calculatorWithParens.hidden.ts   (imports ../src/calculatorWithParens)
import { calculatorWithParens } from '../src/calculatorWithParens'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

check('parens override add-before-mul', calculatorWithParens('(3+2)*2') === 10)
check('parens on the right', calculatorWithParens('2*(3+4)') === 14)
check('two parenthesised groups', calculatorWithParens('(1+2)*(3+4)') === 21)
check('precedence still holds without parens', calculatorWithParens('3+2*2') === 7)
check('redundant nested parens', calculatorWithParens('((2+3))*2') === 10)
check('bare integer', calculatorWithParens('100') === 100)
check('deeply nested', calculatorWithParens('2*(3+4*(5-1))') === 38)
check('spaces ignored', calculatorWithParens('( 3 + 5 ) / 2') === 4)
check('division truncates toward zero after group', calculatorWithParens('(10)/3') === 3)
check('left-associative subtraction inside parens', calculatorWithParens('(7-2-1)') === 4)
check('parens change division grouping', calculatorWithParens('8/(2*2)') === 2)
check('same expr without parens differs', calculatorWithParens('8/2*2') === 8)
check('leading group then mul', calculatorWithParens('(2+3)*(4)') === 20)
check('nested subtraction goes through zero', calculatorWithParens('(2-(3+1))') === -2)
check('multi-digit inside group', calculatorWithParens('(12+8)/5') === 4)
check('chain of groups left-to-right', calculatorWithParens('(6/2)*(3-1)') === 6)
check('no parens mixed precedence', calculatorWithParens('2+3*4-6/2') === 11)
check('group forces early subtraction', calculatorWithParens('10-(2+3)') === 5)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
