// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.
// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — templateExpand.
// Run: npx tsx __audit__/templateExpand.hidden.ts   (imports ../src/templateExpand)
import { expand } from '../src/templateExpand'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}
function throws(name: string, fn: () => void, ctor: Function) {
  let caught: unknown = null
  try { fn() } catch (e) { caught = e }
  check(name, caught instanceof ctor)
}

check('simple replacement', expand('Hello {name}', { name: 'Ada' }) === 'Hello Ada')
check('nested dot path', expand('{a.b.c}', { a: { b: { c: 42 } } }) === '42')
check('missing path kept verbatim', expand('x {a.z} y', { a: {} }) === 'x {a.z} y')
check('undefined value kept verbatim', expand('{k}', { k: undefined }) === '{k}')
check('null renders as "null"', expand('{k}', { k: null }) === 'null')
check('boolean renders', expand('{k}', { k: false }) === 'false')
check('array index via dot', expand('{items.1}', { items: ['a', 'b'] }) === 'b')
check('escaped brace is literal', expand('\\{name}', { name: 'Ada' }) === '{name}')
check('escaped backslash', expand('\\\\{name}', { name: 'Ada' }) === '\\Ada')
// Escape handling at the tail boundary — kills off-by-one on the escape look-ahead guard
// (i + 1 -> i + 2): an escaped char that is the final char must still be emitted unescaped.
check('escaped char at end of template', expand('x\\a', {}) === 'xa')
// A lone trailing backslash has no next char to escape, so it is literal output — kills
// plus->minus on the same guard (i + 1 -> i - 1, which would read template[-1] === undefined).
check('lone trailing backslash is literal', expand('a\\', {}) === 'a\\')
// Empty placeholder {} with an empty-string property key must still be verbatim — kills
// and->or on the initial ok guard (parts.length > 0 && inner.trim() !== ''): under || the
// empty inner would resolve ctx[''] and emit its value instead of leaving {} in place.
check('empty placeholder ignores empty-string key', expand('{}', { '': 'X' }) === '{}')
check('unterminated brace is literal', expand('a {oops', { oops: 1 }) === 'a {oops')
check('adjacent placeholders', expand('{a}{b}', { a: 1, b: 2 }) === '12')
check('empty template', expand('', {}) === '')
throws('null ctx throws TypeError', () => expand('x', null as unknown as object), TypeError)
throws('string ctx throws TypeError', () => expand('x', 's' as unknown as object), TypeError)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
