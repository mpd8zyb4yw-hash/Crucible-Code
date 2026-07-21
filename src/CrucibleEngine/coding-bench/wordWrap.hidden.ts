// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.
// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — wordWrap.
// Run: npx tsx __audit__/wordWrap.hidden.ts   (imports ../src/wordWrap)
import { wrap } from '../src/wordWrap'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}
function throws(name: string, fn: () => void) {
  let caught: unknown = null
  try { fn() } catch (e) { caught = e }
  check(name, caught instanceof RangeError)
}

check('no wrap needed', wrap('ab cd', 10) === 'ab cd')
check('simple wrap', wrap('aa bb cc', 5) === 'aa bb\ncc')
check('exact fit boundary', wrap('aaa bb', 6) === 'aaa bb')
check('one over boundary wraps', wrap('aaa bbb', 6) === 'aaa\nbbb')
check('overlong word hard-split', wrap('abcdefgh', 3) === 'abc\ndef\ngh')
check('overlong word mid-text', wrap('x abcdefg y', 3) === 'x\nabc\ndef\ng y')
check('overlong word never fills the remainder', wrap('xx abcde', 4) === 'xx\nabcd\ne')
check('spaces collapse', wrap('a    b', 10) === 'a b')
check('leading/trailing spaces dropped', wrap('  a b  ', 10) === 'a b')
check('existing newlines are hard breaks', wrap('ab\ncd', 10) === 'ab\ncd')
check('empty input line preserved', wrap('ab\n\ncd', 10) === 'ab\n\ncd')
check('width 1 splits everything', wrap('ab c', 1) === 'a\nb\nc')
check('empty string stays empty', wrap('', 5) === '')
check('lines never exceed width', wrap('the quick brown fox jumps', 7).split('\n').every(l => l.length <= 7))
throws('width 0 throws RangeError', () => wrap('x', 0))
throws('fractional width throws RangeError', () => wrap('x', 2.5))

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
