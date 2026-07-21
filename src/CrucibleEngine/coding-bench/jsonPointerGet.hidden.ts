// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.
// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — jsonPointerGet.
// Run: npx tsx __audit__/jsonPointerGet.hidden.ts   (imports ../src/jsonPointerGet)
import { getPointer } from '../src/jsonPointerGet'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

const doc = {
  foo: ['bar', 'baz'],
  '': 0,
  'a/b': 1,
  'c%d': 2,
  'e^f': 3,
  'm~n': 8,
  nested: { deep: { value: 42 } },
}

check('empty pointer is whole doc', getPointer(doc, '') === doc)
check('object property', getPointer(doc, '/nested') === doc.nested)
check('deep chain', getPointer(doc, '/nested/deep/value') === 42)
check('array by index', getPointer(doc, '/foo/0') === 'bar')
check('array second element', getPointer(doc, '/foo/1') === 'baz')
check('escaped slash ~1', getPointer(doc, '/a~1b') === 1)
check('escaped tilde ~0', getPointer(doc, '/m~0n') === 8)
check('empty-string key via "/"', getPointer(doc, '/') === 0)
check('percent in key untouched', getPointer(doc, '/c%d') === 2)
check('missing key is undefined', getPointer(doc, '/nope') === undefined)
check('missing deep path is undefined', getPointer(doc, '/nested/ghost/x') === undefined)
check('array index out of range undefined', getPointer(doc, '/foo/5') === undefined)
check('leading-zero index rejected', getPointer(doc, '/foo/01') === undefined)
check('negative index rejected', getPointer(doc, '/foo/-1') === undefined)
check('non-numeric token on array rejected', getPointer(doc, '/foo/bar') === undefined)
check('index through primitive undefined', getPointer(doc, '/foo/0/x') === undefined)
let threw = false
try { getPointer(doc, 'foo') } catch (e) { threw = e instanceof SyntaxError }
check('missing leading slash throws SyntaxError', threw)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
