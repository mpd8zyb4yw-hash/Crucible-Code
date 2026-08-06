import { namesExternalLibrary, extractPackageCandidates, isCodingQuery } from '../../src/CrucibleEngine/retrieval/retrievalLayer'
const LIB_ASKS = [  // all SHOULD ground — they name a real library
  'Write a Zod schema that validates an IPv4 address',
  'zod schema to validate an ipv4 address',
  'express middleware for error handling',
  'how do I use react useEffect with a cleanup function',
  'parse a csv file with papaparse',
  'make an http request with axios',
  'validate a form with yup',
  'connect to postgres with prisma',
  'lodash debounce example',
  'write a zod schema for a user object',
]
const ALGO_ASKS = [  // all SHOULD NOT ground — VGR certifies these
  'write a function to reverse a linked list',
  'implement binary search on a sorted array',
  'write a regex to match an IPv4 address',
  'sort a list of numbers in ascending order',
  'express a number as a fraction in lowest terms',
]
let g=0, b=0
console.log('--- LIBRARY ASKS (want grounds=true) ---')
for (const q of LIB_ASKS) { const n=namesExternalLibrary(q); if(n)g++; console.log(`  grounds=${String(n).padEnd(5)} cands=${JSON.stringify(extractPackageCandidates(q)).padEnd(22)} ${q.slice(0,46)}`) }
console.log('--- ALGORITHMIC ASKS (want grounds=false) ---')
for (const q of ALGO_ASKS) { const n=namesExternalLibrary(q); if(!n)b++; console.log(`  grounds=${String(n).padEnd(5)} cands=${JSON.stringify(extractPackageCandidates(q)).padEnd(22)} ${q.slice(0,46)}`) }
console.log(`\nlibrary asks grounded : ${g}/${LIB_ASKS.length}`)
console.log(`algorithmic correctly skipped: ${b}/${ALGO_ASKS.length}`)
