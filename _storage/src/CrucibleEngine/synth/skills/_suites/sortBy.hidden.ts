import { sortBy, orderBy } from '../src/module'
let f = 0
const ok = (b: boolean, msg: string) => { if (!b) { console.error('FAIL', msg); f++ } }
const arr = [{ name: 'b', age: 3 }, { name: 'a', age: 1 }, { name: 'c', age: 2 }]
const byName = sortBy(arr, 'name')
ok(byName[0].name === 'a' && byName[2].name === 'c', 'sort by name asc')
ok(sortBy(arr, 'age', 'desc')[0].age === 3, 'sort by age desc')
ok(sortBy([3,1,2], (x:number) => x).join() === '1,2,3', 'sort by function')
const multi = orderBy([{a:1,b:2},{a:1,b:1},{a:2,b:3}], [{key:'a'},{key:'b',dir:'desc'}])
ok(multi[0].b === 2 && multi[1].b === 1, 'multi-key order')
ok(arr.length === 3, 'original not mutated')
ok(sortBy([], 'name').length === 0, 'empty array')
ok(sortBy([{x:null},{x:1}], 'x')[0].x === 1, 'null sorts last')
console.log(f === 0 ? 'ALL PASS' : `${f} FAILURE(S)`); process.exit(f === 0 ? 0 : 1)
