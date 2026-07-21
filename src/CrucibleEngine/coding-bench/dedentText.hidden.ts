// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.
// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — dedentText.
// Run: npx tsx __audit__/dedentText.hidden.ts   (imports ../src/dedentText)
import { dedent } from '../src/dedentText'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

check('uniform indent stripped', dedent('  a\n  b') === 'a\nb')
check('relative indent preserved', dedent('  a\n    b') === 'a\n  b')
check('min across lines wins', dedent('    a\n  b') === '  a\nb')
check('no indent unchanged', dedent('a\nb') === 'a\nb')
check('blank line becomes empty', dedent('  a\n\n  b') === 'a\n\nb')
check('whitespace-only line becomes empty', dedent('  a\n   \n  b') === 'a\n\nb')
check('blank lines do not affect the minimum', dedent('    a\n \n    b') === 'a\n\nb')
check('tabs count as one char each', dedent('\ta\n\tb') === 'a\nb')
check('mixed tab/space by count', dedent('\t a\n  b') === 'a\nb')
check('line count preserved', dedent('  a\n\n  b').split('\n').length === 3)
check('all-blank input becomes empties', dedent('  \n \n') === '\n\n')
check('empty string stays empty', dedent('') === '')
check('single line', dedent('   x') === 'x')

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
