// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.
// HIDDEN adversarial suite for a NOVEL task (min-coins DP; greedy is provably wrong) — coinChange.
// Run: npx tsx __audit__/coinChange.hidden.ts   (imports ../src/coinChange)
import { coinChange } from '../src/coinChange'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

check('canonical 11 from 1,2,5', coinChange([1, 2, 5], 11) === 3)
check('impossible amount', coinChange([2], 3) === -1)
check('zero amount is zero coins', coinChange([1], 0) === 0)
check('empty coins nonzero amount', coinChange([], 7) === -1)
check('empty coins zero amount', coinChange([], 0) === 0)
check('exact single coin', coinChange([7], 7) === 1)
check('greedy trap prefers two coins', coinChange([1, 5, 6, 9], 11) === 2)
check('classic greedy-fails set', coinChange([1, 3, 4], 6) === 2)
check('all ones', coinChange([1], 5) === 5)
check('large mixed', coinChange([2, 5, 10], 27) === 4)
check('denomination larger than amount ignored', coinChange([5, 10], 3) === -1)
check('reuse same coin', coinChange([3], 9) === 3)
check('unordered coins', coinChange([25, 10, 5, 1], 30) === 2)
check('hard 6249', coinChange([186, 419, 83, 408], 6249) === 20)
check('prime amount', coinChange([2, 3], 7) === 3)
check('single ok exact', coinChange([2, 5], 10) === 2)
check('cannot make odd from evens', coinChange([2, 4], 7) === -1)
check('minimal for 6 from 1,3,4', coinChange([1, 3, 4], 6) === 2)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
