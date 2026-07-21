// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.
// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — deepEqualCyc.
// Run: npx tsx __audit__/deepEqualCyc.hidden.ts   (imports ../src/deepEqualCyc)
import { deepEqual } from '../src/deepEqualCyc'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

check('primitive equal', deepEqual(1, 1) && deepEqual('a', 'a'))
check('primitive unequal', !deepEqual(1, 2) && !deepEqual('a', 'b'))
check('NaN equals NaN', deepEqual(NaN, NaN))
check('plus and minus zero equal', deepEqual(0, -0))
check('null only equals null', deepEqual(null, null) && !deepEqual(null, undefined) && !deepEqual(null, {}))
check('nested objects equal', deepEqual({ a: { b: [1, 2] } }, { a: { b: [1, 2] } }))
check('key order irrelevant', deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }))
check('missing key unequal', !deepEqual({ a: 1 }, { a: 1, b: undefined }))
check('array length mismatch', !deepEqual([1, 2], [1, 2, 3]))
check('array vs object never equal', !deepEqual([], {}))
check('nested difference found', !deepEqual({ a: { b: 1 } }, { a: { b: 2 } }))
check('dates by timestamp', deepEqual(new Date(1000), new Date(1000)) && !deepEqual(new Date(1000), new Date(2000)))
check('date vs number unequal', !deepEqual(new Date(0), 0))
check('sibling references are not cycles', (() => {
  const shared = { v: 1 }
  return deepEqual({ x: shared, y: shared }, { x: { v: 1 }, y: { v: 1 } })
})())
check('repeated non-cyclic subtree ok', (() => {
  const sub = [1, 2]
  return deepEqual([sub, sub], [[1, 2], [1, 2]])
})())
let threw = false
try {
  const a: Record<string, unknown> = {}; a.self = a
  const b: Record<string, unknown> = {}; b.self = b
  deepEqual(a, b)
} catch (e) { threw = e instanceof TypeError }
check('cycle throws TypeError instead of hanging', threw)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
