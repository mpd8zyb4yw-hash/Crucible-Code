import { partition, partitionBy } from '../src/module'
let f = 0
const ok = (b: boolean, msg: string) => { if (!b) { console.error('FAIL', msg); f++ } }
const [evens, odds] = partition([1,2,3,4,5], (x:number) => x % 2 === 0)
ok(evens.join() === '2,4', 'evens')
ok(odds.join() === '1,3,5', 'odds')
const [pass, fail] = partition([] as number[], () => true)
ok(pass.length === 0 && fail.length === 0, 'empty')
const [all, none] = partition([1,2,3], () => true)
ok(all.length === 3 && none.length === 0, 'all match')
const m = partitionBy([{t:'a',v:1},{t:'b',v:2},{t:'a',v:3}], (x:{t:string}) => x.t)
ok(m.get('a')!.length === 2 && m.get('b')!.length === 1, 'partitionBy')
console.log(f === 0 ? 'ALL PASS' : `${f} FAILURE(S)`); process.exit(f === 0 ? 0 : 1)
