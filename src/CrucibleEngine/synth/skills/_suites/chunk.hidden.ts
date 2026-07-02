// HIDDEN adversarial suite — array chunking.
// Run via `npx tsx __audit__/chunk.hidden.ts` inside the scratch project.
import { chunk } from '../src/chunk'

let failures = 0
function eq(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b) }
function check(name: string, got: unknown, want: unknown) {
  const ok = eq(got, want)
  console.log(`  ${ok ? 'PASS' : 'FAIL'} — ${name}`)
  if (!ok) { console.log(`       got:  ${JSON.stringify(got)}`); console.log(`       want: ${JSON.stringify(want)}`); failures++ }
}

check('even split',            chunk([1,2,3,4], 2),           [[1,2],[3,4]])
check('uneven tail',           chunk([1,2,3,4,5], 2),         [[1,2],[3,4],[5]])
check('size 1',                chunk([1,2,3], 1),             [[1],[2],[3]])
check('size equals length',    chunk([1,2,3], 3),             [[1,2,3]])
check('size larger than arr',  chunk([1,2], 10),              [[1,2]])
check('empty array',           chunk([], 3),                  [])
check('size 0 returns empty',  chunk([1,2,3], 0),             [])
check('negative size empty',   chunk([1,2,3], -1),            [])
check('strings',               chunk(['a','b','c','d'], 2),   [['a','b'],['c','d']])
check('preserves order',       chunk([5,4,3,2,1], 2),         [[5,4],[3,2],[1]])
check('single element',        chunk([42], 3),                [[42]])
check('size 3 uneven',         chunk([1,2,3,4,5,6,7], 3),    [[1,2,3],[4,5,6],[7]])

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
