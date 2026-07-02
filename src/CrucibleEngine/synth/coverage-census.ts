// ============================================================================
// coverage-census — the honest headline metric.
//
// Runs independently-written PROSE specs (the kind a user types, with NO worked
// f(x)===y examples) through the full offline cascade (L0+L1+L2, MODELS OFF) and
// reports how many ship oracle-verified code vs escalate honestly.
//
//   Coverage%   = SHIPPED / (specs that SHOULD be covered)
//   Escalation% = ESCALATED / (specs that SHOULD escalate — app logic / novel)
//
// This is deliberately NOT the proof harness. prove:all proves each skill is
// correct. The census measures BREADTH: does a natural request actually reach
// the library and ship? Run: npm run census
// ============================================================================

import { synthesizePureCode } from './pureCode'

interface CensusSpec { id: string; shouldCover: boolean; spec: string }

// ── SHOULD COVER — fully-specified single-file utility/algorithm requests ──────
const SPECS: CensusSpec[] = [
  // strings
  { id: 'capitalize', shouldCover: true, spec: 'Capitalize the first letter of each word at src/cap.ts.\nexport function capitalize(str:string):string' },
  { id: 'camelcase', shouldCover: true, spec: 'Convert a string to camelCase at src/cc.ts.\nexport function camelCase(str:string):string' },
  { id: 'slugify', shouldCover: true, spec: 'Make a URL-safe slug from a string at src/s.ts.\nexport function slug(str:string):string' },
  { id: 'truncate', shouldCover: true, spec: 'Truncate a string to a max length with an ellipsis at src/t.ts.\nexport function truncate(str:string, maxLength:number):string' },
  { id: 'palindrome', shouldCover: true, spec: 'Check if a string is a palindrome at src/p.ts.\nexport function isPalindrome(str:string):boolean' },
  { id: 'reverse', shouldCover: true, spec: 'Reverse a string at src/r.ts.\nexport function reverseString(str:string):string' },
  { id: 'wordwrap', shouldCover: true, spec: 'Word-wrap text at a column width at src/w.ts.\nexport function wordWrap(text:string, width:number):string' },
  { id: 'rot13', shouldCover: true, spec: 'ROT13 cipher at src/rot.ts.\nexport function rot13(str:string):string' },

  // arrays
  { id: 'flatten', shouldCover: true, spec: 'Flatten a nested array at src/f.ts.\nexport function flatten<T>(arr:any[], depth?:number):T[]' },
  { id: 'unique', shouldCover: true, spec: 'Remove duplicates from an array preserving order at src/u.ts.\nexport function unique<T>(arr:T[]):T[]' },
  { id: 'chunk', shouldCover: true, spec: 'Split an array into fixed-size chunks at src/c.ts.\nexport function chunk<T>(arr:T[], size:number):T[][]' },
  { id: 'groupby', shouldCover: true, spec: 'Group array elements by a key selector at src/g.ts.\nexport function groupBy<T>(arr:T[], key:(item:T)=>string):Record<string,T[]>' },
  { id: 'zip', shouldCover: true, spec: 'Zip two arrays into pairs at src/z.ts.\nexport function zip<A,B>(a:A[], b:B[]):[A,B][]' },
  { id: 'range', shouldCover: true, spec: 'Generate a range of numbers at src/rg.ts.\nexport function range(start:number, end:number, step?:number):number[]' },
  { id: 'setops', shouldCover: true, spec: 'Array set intersection at src/so.ts.\nexport function intersection<T>(a:T[], b:T[]):T[]\nexport function difference<T>(a:T[], b:T[]):T[]\nexport function union<T>(a:T[], b:T[]):T[]' },

  // objects
  { id: 'deepclone', shouldCover: true, spec: 'Deep clone a value at src/dc.ts.\nexport function deepClone<T>(value:T):T' },
  { id: 'pickomit', shouldCover: true, spec: 'Pick and omit object keys at src/po.ts.\nexport function pick<T extends object,K extends keyof T>(obj:T, keys:K[]):Pick<T,K>\nexport function omit<T extends object,K extends keyof T>(obj:T, keys:K[]):Omit<T,K>' },
  { id: 'objectpath', shouldCover: true, spec: 'Get and set nested object values by dot path at src/op.ts.\nexport function getPath(obj:unknown, path:string, defaultVal?:unknown):unknown\nexport function setPath(obj:Record<string,unknown>, path:string, value:unknown):void' },
  { id: 'flattenobj', shouldCover: true, spec: 'Flatten a nested object to dot keys at src/fo.ts.\nexport function flattenObject(obj:Record<string,unknown>):Record<string,unknown>' },

  // numbers / math
  { id: 'clamp', shouldCover: true, spec: 'Clamp a number between min and max at src/cl.ts.\nexport function clamp(value:number, min:number, max:number):number' },
  { id: 'gcd', shouldCover: true, spec: 'Greatest common divisor and least common multiple at src/nt.ts.\nexport function gcd(a:number, b:number):number\nexport function lcm(a:number, b:number):number' },
  { id: 'isprime', shouldCover: true, spec: 'Prime check, factorial, and fibonacci at src/m.ts.\nexport function isPrime(n:number):boolean\nexport function factorial(n:number):number\nexport function fibonacci(n:number):number' },
  { id: 'stats', shouldCover: true, spec: 'Sum, average, median, and mode of a number array at src/st.ts.\nexport function sum(arr:number[]):number\nexport function average(arr:number[]):number\nexport function median(arr:number[]):number' },
  { id: 'formatnum', shouldCover: true, spec: 'Format a number with thousand separators at src/fn.ts.\nexport function formatNumber(value:number, decimals?:number):string' },
  { id: 'roman', shouldCover: true, spec: 'Convert integers to and from Roman numerals at src/rn.ts.\nexport function toRoman(n:number):string\nexport function fromRoman(s:string):number' },

  // data structures
  { id: 'stack', shouldCover: true, spec: 'A LIFO stack at src/stk.ts.\nexport class Stack<T> { push(item:T):void; pop():T|undefined; peek():T|undefined; size():number; isEmpty():boolean }' },
  { id: 'queue', shouldCover: true, spec: 'A FIFO queue at src/q.ts.\nexport class Queue<T> { enqueue(item:T):void; dequeue():T|undefined; peek():T|undefined; size():number; isEmpty():boolean }' },
  { id: 'trie', shouldCover: true, spec: 'A prefix trie with insert and search at src/tr.ts.\nexport class Trie { insert(word:string):void; search(word:string):boolean; startsWith(prefix:string):boolean }' },
  { id: 'minheap', shouldCover: true, spec: 'A min-heap priority queue at src/mh.ts.\nexport class MinHeap<T> { insert(value:T, priority:number):void; extractMin():{value:T;priority:number}|null; size():number }' },
  { id: 'lru', shouldCover: true, spec: 'An LRU cache at src/lru.ts.\nexport class LRUCache<K,V> { constructor(capacity:number); get(key:K):V|undefined; set(key:K,value:V):void; has(key:K):boolean }' },
  { id: 'linkedlist', shouldCover: true, spec: 'A doubly linked list at src/dll.ts.\nexport class DoublyLinkedList<T> { push(value:T):void; pop():T|undefined; unshift(value:T):void; shift():T|undefined; toArray():T[] }' },

  // validators / parsers / encoding
  { id: 'isemail', shouldCover: true, spec: 'Validate an email address at src/em.ts.\nexport function isEmail(str:string):boolean' },
  { id: 'base64', shouldCover: true, spec: 'Base64 encode and decode a string at src/b64.ts.\nexport function base64Encode(str:string):string\nexport function base64Decode(str:string):string' },
  { id: 'escapehtml', shouldCover: true, spec: 'Escape and unescape HTML entities at src/eh.ts.\nexport function escapeHtml(str:string):string\nexport function unescapeHtml(str:string):string' },
  { id: 'iniparse', shouldCover: true, spec: 'Parse and stringify INI config at src/ini.ts.\nexport function parseINI(text:string):any\nexport function stringifyINI(data:any):string' },
  { id: 'dotenv', shouldCover: true, spec: 'Parse a .env file at src/de.ts.\nexport function parseDotenv(text:string):Record<string,string>' },
  { id: 'sha256', shouldCover: true, spec: 'Compute MD5, SHA-1, and SHA-256 hashes of a string at src/h.ts.\nexport function md5(str:string):string\nexport function sha1(str:string):string\nexport function sha256(str:string):string' },

  // ── SHOULD ESCALATE — app logic / underspecified / novel ──────────────────
  { id: 'esc-react-form', shouldCover: false, spec: 'Build a React signup form component with email/password validation and a submit handler that calls our /api/register endpoint, showing inline errors.' },
  { id: 'esc-express-crud', shouldCover: false, spec: 'Implement an Express REST router for a blog: GET/POST/PUT/DELETE /posts backed by our Postgres posts table, with auth middleware.' },
  { id: 'esc-business-logic', shouldCover: false, spec: 'Compute the loyalty-tier discount for a customer given their order history, regional tax rules, and active promotions in src/pricing.ts.' },
  { id: 'esc-vague', shouldCover: false, spec: 'Make the dashboard faster.' },
  { id: 'esc-game', shouldCover: false, spec: 'Write the collision-resolution and scoring logic for our 2D platformer level engine.' },
  { id: 'esc-novel-algo', shouldCover: false, spec: 'Implement our proprietary fraud-risk scoring that blends device fingerprint entropy with velocity features in src/fraud.ts.' },
  { id: 'esc-refactor', shouldCover: false, spec: 'Refactor the existing UserService in src/user-service.ts to extract the notification logic into a separate class.' },
  { id: 'esc-migration', shouldCover: false, spec: 'Write a database migration that splits the full_name column into first_name and last_name across all rows.' },
]

async function main() {
  console.log('Crucible coverage census — prose specs, models OFF, full offline cascade\n')

  let coverShould = 0, covered = 0
  let escShould = 0, escalated = 0
  const wrongShips: string[] = []
  const missed: string[] = []
  const rows: string[] = []

  for (const { id, shouldCover, spec } of SPECS) {
    const t0 = process.hrtime.bigint()
    const r = await synthesizePureCode(spec, { verify: 'sync' })
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    const shipped = r.source !== null && r.verified

    if (shouldCover) {
      coverShould++
      if (shipped) { covered++; rows.push(`  SHIP   ${id.padEnd(16)} via ${(r.skillId ?? '?').padEnd(20)} (${ms.toFixed(0)}ms)`) }
      else { missed.push(id); rows.push(`  miss   ${id.padEnd(16)} escalated — ${r.detail.slice(0, 50)}`) }
    } else {
      escShould++
      if (!shipped) { escalated++; rows.push(`  esc    ${id.padEnd(16)} escalated correctly`) }
      else { wrongShips.push(id); rows.push(`  WRONG  ${id.padEnd(16)} shipped ${r.skillId} for an app-logic spec!`) }
    }
  }

  console.log(rows.join('\n'))

  const cov = coverShould ? (covered / coverShould * 100).toFixed(1) : 'n/a'
  const esc = escShould ? (escalated / escShould * 100).toFixed(1) : 'n/a'
  console.log(`
┌─ COVERAGE CENSUS ──────────────────────────────────────────────────────┐
│  Coverage%   ${cov}%  (${covered}/${coverShould} fully-specified utility/algo specs shipped)
│  Escalation% ${esc}%  (${escalated}/${escShould} app-logic/novel specs escalated honestly)
│  Wrong-ships ${wrongShips.length}   (must be 0 — shipping for an out-of-scope spec)
└────────────────────────────────────────────────────────────────────────┘`)
  if (missed.length) console.log(`\nNot yet covered: ${missed.join(', ')}`)
  if (wrongShips.length) { console.error(`\nFAIL — wrong-ships: ${wrongShips.join(', ')}`); process.exit(1) }
  process.exit(0)
}

main()
