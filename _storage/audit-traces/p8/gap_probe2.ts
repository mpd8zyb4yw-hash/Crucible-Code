import { fetchLibraryApiForQuery } from '../../src/CrucibleEngine/retrieval/retrievalLayer'
const LIB = [
  ['Write a Zod schema that validates an IPv4 address','zod'],
  ['zod schema to validate an ipv4 address','zod'],
  ['express middleware for error handling','express'],
  ['how do I use react useEffect with a cleanup function','react'],
  ['parse a csv file with papaparse','papaparse'],
  ['make an http request with axios','axios'],
  ['lodash debounce example','lodash'],
]
const ALGO = [  // must NOT ground — VGR certifies these; a false positive REPAIRS correct code
  'write a function to reverse a linked list',
  'implement binary search on a sorted array',
  'write a regex to match an IPv4 address',
  'sort a list of numbers in ascending order',
  'express a number as a fraction in lowest terms',
]
async function main(){
  let hit=0
  console.log('--- LIBRARY ASKS (want a package) ---')
  for (const [q,want] of LIB) {
    const t0=Date.now(); const d = await fetchLibraryApiForQuery(q, 60_000, 12_000)
    const ok = d?.pkg === want; if(ok) hit++
    console.log(`  ${ok?'OK  ':'MISS'} got=${String(d?.pkg ?? 'null').padEnd(11)} want=${String(want).padEnd(10)} ${String(Date.now()-t0).padStart(5)}ms  ${q.slice(0,42)}`)
  }
  let clean=0
  console.log('--- ALGORITHMIC ASKS (want null) ---')
  for (const q of ALGO) {
    const t0=Date.now(); const d = await fetchLibraryApiForQuery(q, 60_000, 12_000)
    const ok = !d; if(ok) clean++
    console.log(`  ${ok?'OK  ':'FALSE+'} got=${String(d?.pkg ?? 'null').padEnd(11)} ${String(Date.now()-t0).padStart(5)}ms  ${q.slice(0,42)}`)
  }
  console.log(`\nlibrary asks resolved : ${hit}/${LIB.length}   (was 1/10 before)`)
  console.log(`algorithmic kept clean: ${clean}/${ALGO.length}  (false positives REPAIR correct code)`)
}
main()
