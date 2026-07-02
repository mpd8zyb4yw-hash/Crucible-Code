// HIDDEN adversarial suite for a NOVEL task (no matching primitive in the synth library) —
// Levenshtein edit distance. Proof target for the universal code-reasoning engine: the
// engine must REASON a correct implementation it doesn't already have, verified here.
// Run: npx tsx __audit__/levenshtein.hidden.ts   (imports ../src/levenshtein)
import { editDistance } from '../src/levenshtein'

let failures = 0
function check(name: string, cond: boolean) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} — ${name}`)
  if (!cond) failures++
}

check('identical strings = 0', editDistance('kitten', 'kitten') === 0)
check('empty vs empty = 0', editDistance('', '') === 0)
check('empty vs n = n (all insertions)', editDistance('', 'abc') === 3)
check('n vs empty = n (all deletions)', editDistance('abc', '') === 3)
check('single substitution', editDistance('cat', 'cot') === 1)
check('single insertion', editDistance('cat', 'cart') === 1)
check('single deletion', editDistance('cart', 'cat') === 1)
check('classic kitten→sitting = 3', editDistance('kitten', 'sitting') === 3)
check('classic flaw→lawn = 2', editDistance('flaw', 'lawn') === 2)
check('symmetric', editDistance('sunday', 'saturday') === editDistance('saturday', 'sunday'))
check('saturday↔sunday = 3', editDistance('sunday', 'saturday') === 3)
check('full replace', editDistance('abc', 'xyz') === 3)

console.log(`\n  ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
