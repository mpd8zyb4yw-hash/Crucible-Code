// HIDDEN adversarial suite — groupBy utility.
// Run via `npx tsx __audit__/groupBy.hidden.ts` inside the scratch project.
import { groupBy } from '../src/groupBy'

let failures = 0
function eq(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b) }
function check(name: string, got: unknown, want: unknown) {
  const ok = eq(got, want)
  console.log(`  ${ok ? 'PASS' : 'FAIL'} — ${name}`)
  if (!ok) { console.log(`       got:  ${JSON.stringify(got)}`); console.log(`       want: ${JSON.stringify(want)}`); failures++ }
}

check('group by length',
  groupBy(['one','two','three','four'], w => w.length),
  { '3': ['one','two'], '5': ['three'], '4': ['four'] })

check('group by first char',
  groupBy(['apple','avocado','banana','blueberry'], w => w[0]),
  { 'a': ['apple','avocado'], 'b': ['banana','blueberry'] })

check('group numbers by parity',
  groupBy([1,2,3,4,5,6], n => n % 2 === 0 ? 'even' : 'odd'),
  { 'odd': [1,3,5], 'even': [2,4,6] })

check('empty array',
  groupBy([], (x: number) => x),
  {})

check('all same key',
  groupBy([1,2,3], () => 'x'),
  { 'x': [1,2,3] })

check('preserves insertion order within group',
  groupBy([3,1,2,1,3], n => n),
  { '3': [3,3], '1': [1,1], '2': [2] })

check('numeric key coerced to string',
  groupBy(['a','bb','ccc'], s => s.length),
  { '1': ['a'], '2': ['bb'], '3': ['ccc'] })

check('objects grouped by field',
  groupBy([{t:'a',v:1},{t:'b',v:2},{t:'a',v:3}], o => o.t),
  { 'a': [{t:'a',v:1},{t:'a',v:3}], 'b': [{t:'b',v:2}] })

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
