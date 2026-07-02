// Adversarial suite for deepEqual / isEqual.
import { deepEqual, isEqual } from '../src/module'
let f = 0
const ok = (b: boolean, msg: string) => { if (!b) { console.error('FAIL', msg); f++ } }
ok(deepEqual(1, 1), 'primitives equal')
ok(!deepEqual(1, 2), 'primitives not equal')
ok(deepEqual({ a: 1, b: [2, 3] }, { a: 1, b: [2, 3] }), 'nested objects')
ok(!deepEqual({ a: 1 }, { a: 2 }), 'nested mismatch')
ok(deepEqual([1,[2,3]], [1,[2,3]]), 'nested arrays')
ok(!deepEqual([1,2], [1,2,3]), 'array length mismatch')
ok(deepEqual(null, null), 'null equals null')
ok(!deepEqual(null, {}), 'null vs object')
ok(!deepEqual({a:1,b:2},{a:1}), 'extra key mismatch')
ok(deepEqual({},{}) , 'empty objects')
ok(isEqual({ x: 1 }, { x: 1 }), 'alias works')
console.log(f === 0 ? 'ALL PASS' : `${f} FAILURE(S)`); process.exit(f === 0 ? 0 : 1)
