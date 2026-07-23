// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.
// HIDDEN adversarial suite for a NOVEL task (postfix/stack, 0%-by-sampling) — evalRPN.
// Run: npx tsx __audit__/evalRPN.hidden.ts   (imports ../src/evalRPN)
import { evalRPN } from '../src/evalRPN'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

check('add then multiply', evalRPN(['2', '1', '+', '3', '*']) === 9)
check('nested with division', evalRPN(['4', '13', '5', '/', '+']) === 6)
check('division truncates toward zero on negatives', evalRPN(['6', '-4', '/']) === -1)
check('single number passthrough', evalRPN(['-7']) === -7)
check('subtract then multiply', evalRPN(['10', '2', '-', '3', '*']) === 24)
check('operand order for subtraction', evalRPN(['10', '3', '-']) === 7)
check('operand order for division', evalRPN(['20', '4', '/']) === 5)
check('chained subtraction', evalRPN(['5', '1', '2', '-', '-']) === 6)
check('negative operands', evalRPN(['-3', '-2', '*']) === 6)
check('truncates toward zero positive', evalRPN(['7', '2', '/']) === 3)
check('longer expression', evalRPN(['15', '7', '1', '1', '+', '-', '/', '3', '*']) === 9)
check('multi-digit', evalRPN(['100', '50', '-']) === 50)
check('add negatives', evalRPN(['-5', '3', '+']) === -2)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
