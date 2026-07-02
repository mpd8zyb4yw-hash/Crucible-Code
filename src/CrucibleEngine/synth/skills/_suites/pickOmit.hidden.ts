// HIDDEN adversarial suite — pick/omit object keys.
// Run via `npx tsx __audit__/pickOmit.hidden.ts` inside the scratch project.
import { pick, omit } from '../src/pickOmit'

let failures = 0
function eq(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b) }
function check(name: string, got: unknown, want: unknown) {
  const ok = eq(got, want)
  console.log(`  ${ok ? 'PASS' : 'FAIL'} — ${name}`)
  if (!ok) { console.log(`       got:  ${JSON.stringify(got)}`); console.log(`       want: ${JSON.stringify(want)}`); failures++ }
}

const obj = { a: 1, b: 2, c: 3, d: 4 }

// pick
check('pick two keys',           pick(obj, ['a', 'c']),           { a: 1, c: 3 })
check('pick all keys',           pick(obj, ['a','b','c','d']),     obj)
check('pick empty list',         pick(obj, []),                    {})
check('pick one key',            pick(obj, ['b']),                 { b: 2 })
check('pick non-existent key',   pick({x:1} as any, ['y' as any]), {})
check('pick preserves value type', pick({n:42,s:'hi'}, ['s']),    { s: 'hi' })
check('pick does not mutate src', (() => { pick(obj,['a']); return obj })(), obj)

// omit
check('omit one key',            omit(obj, ['b']),                 { a: 1, c: 3, d: 4 })
check('omit two keys',           omit(obj, ['a', 'd']),            { b: 2, c: 3 })
check('omit all keys',           omit(obj, ['a','b','c','d']),     {})
check('omit empty list',         omit(obj, []),                    obj)
check('omit does not mutate src', (() => { omit(obj,['a']); return obj })(), obj)
check('omit preserves rest',     omit({x:1,y:2,z:3}, ['y']),      { x: 1, z: 3 })

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
