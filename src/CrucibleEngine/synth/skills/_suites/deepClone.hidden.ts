// HIDDEN adversarial suite — deep clone.
// Run via `npx tsx __audit__/deepClone.hidden.ts` inside the scratch project.
import { deepClone } from '../src/deepClone'

let failures = 0
function eq(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b) }
function check(name: string, got: unknown, want: unknown) {
  const ok = eq(got, want)
  console.log(`  ${ok ? 'PASS' : 'FAIL'} — ${name}`)
  if (!ok) { console.log(`       got:  ${JSON.stringify(got)}`); console.log(`       want: ${JSON.stringify(want)}`); failures++ }
}

// Basic correctness
check('null',             deepClone(null),          null)
check('number',           deepClone(42),            42)
check('string',           deepClone('hi'),          'hi')
check('boolean',          deepClone(true),          true)
check('shallow object',   deepClone({a:1,b:2}),     {a:1,b:2})
check('nested object',    deepClone({a:{b:{c:3}}}), {a:{b:{c:3}}})
check('array',            deepClone([1,2,3]),        [1,2,3])
check('nested array',     deepClone([[1,2],[3,4]]),  [[1,2],[3,4]])
check('mixed',            deepClone({a:[1,{b:2}]}), {a:[1,{b:2}]})

// Isolation (mutations don't leak)
const src = { x: [1, 2, 3] }
const cloned = deepClone(src)
cloned.x.push(99)
check('mutation isolation array', src.x.length, 3)

const src2 = { nested: { val: 1 } }
const cloned2 = deepClone(src2)
cloned2.nested.val = 99
check('mutation isolation nested object', src2.nested.val, 1)

const arr = [{ n: 1 }, { n: 2 }]
const clonedArr = deepClone(arr)
clonedArr[0].n = 99
check('mutation isolation array of objects', arr[0].n, 1)

// Edge cases
check('empty object',     deepClone({}),            {})
check('empty array',      deepClone([]),             [])
check('undefined',        deepClone(undefined as any), undefined)
check('zero',             deepClone(0),             0)
check('empty string',     deepClone(''),            '')

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
