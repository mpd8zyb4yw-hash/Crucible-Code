// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.
// HIDDEN adversarial suite for a NOVEL task (edit-distance DP, 0%-by-sampling) — editDistance.
// Run: npx tsx __audit__/editDistance.hidden.ts   (imports ../src/editDistance)
import { editDistance } from '../src/editDistance'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

check('classic kitten/sitting', editDistance('kitten', 'sitting') === 3)
check('overlapping flaw/lawn', editDistance('flaw', 'lawn') === 2)
check('empty to three', editDistance('', 'abc') === 3)
check('three to empty', editDistance('abc', '') === 3)
check('identical is zero', editDistance('abc', 'abc') === 0)
check('sunday/saturday', editDistance('sunday', 'saturday') === 3)
check('both empty', editDistance('', '') === 0)
check('single insertion', editDistance('cat', 'cats') === 1)
check('single deletion', editDistance('cats', 'cat') === 1)
check('single substitution', editDistance('cat', 'cot') === 1)
check('symmetric', editDistance('intention', 'execution') === editDistance('execution', 'intention'))
check('intention/execution value', editDistance('intention', 'execution') === 5)
check('prefix', editDistance('abcdef', 'abc') === 3)
check('full replace', editDistance('abc', 'xyz') === 3)
check('repeated chars', editDistance('aaa', 'aa') === 1)
check('transposition costs two', editDistance('ab', 'ba') === 2)
check('long common middle', editDistance('sunny', 'snowy') === 3)
check('case sensitive', editDistance('Abc', 'abc') === 1)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
