// ============================================================================
// Offline Code Bench (OCB) — Phase 0+1 scorecard for the L0 pure-code path.
// Zero model calls, zero L1/L2. Run: npm run bench:ocb
//
// Intentionally L0-only: synthesize() + export-shape gate. L2 loads skills
// into the global REGISTRY as a side-effect, which would contaminate L0 for
// later tasks in the same process. OCB imports proven skills explicitly so L0
// sees all registered skills from the start, in a controlled order.
//
// Three invariants, every run:
//   Coverage%              = SOLVED / all solve-expected tasks  (grow this)
//   Correctness-on-covered = suite-passed / SOLVED              (must be 100%)
//   HonestEscalation%      = escalated / all escalate-expected  (must be 100%)
//
// CI exits 1 on WRONG > 0. Coverage regression is printed but non-fatal until
// Phase 2 stabilises the registered skill count.
// ============================================================================

import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { synthesize, extractFeatures } from './index'
import type { SynthFile } from './synthEngine'

// Import all proven skills so L0 sees them from the start (prevents ordering
// artifacts from L2's lazy load polluting the registry mid-run).
import './skills/slug'
import './skills/chunk'
import './skills/groupBy'
import './skills/formatBytes'
import './skills/base64'
import './skills/escapeHtml'
import './skills/pickOmit'
import './skills/deepClone'
// catalog-generated skills
import './skills/capitalize'
import './skills/camelCase'
import './skills/pascalCase'
import './skills/snakeCase'
import './skills/truncate'
import './skills/countOccurrences'
import './skills/isPalindrome'
import './skills/reverseString'
import './skills/flatten'
import './skills/unique'
import './skills/setOps'
import './skills/compact'
import './skills/zip'
import './skills/range'
import './skills/arrayUtils'
import './skills/sumBy'
import './skills/mapValues'
import './skills/invert'
import './skills/flattenObject'
import './skills/clamp'
import './skills/formatNumber'
import './skills/typeGuards'
import './skills/fnUtils'
// new Tier-1 hand-authored skills (2026-06-30)
import './skills/deepEqual'
import './skills/sortBy'
import './skills/partition'
import './skills/isValidators'
import './skills/sanitizeHtml'
import './skills/jwtDecode'
import './skills/mimeType'
import './skills/cronExpr'
import './skills/tomlParse'
// new catalog families (2026-06-30)
import './skills/dijkstraDistances'
import './skills/bellmanFordDistances'
import './skills/floydWarshall'
import './skills/bfsHopCounts'
import './skills/topoOrderKahn'
import './skills/connectedComponentsCount'
import './skills/dsuUnionFind'
import './skills/isBipartiteGraph'
import './skills/kruskalMstWeight'
import './skills/priorityQueueMin'
import './skills/counterFrequency'
import './skills/sortedInsertNum'
import './skills/lfuCache'
import './skills/composePipe'
import './skills/resultBox'
import './skills/memoizeUnary'
import './skills/mulberry32Prng'
import './skills/shuffleSeeded'
import './skills/randomIntInclusive'
import './skills/parseSemverParts'
import './skills/parseQueryParams'
import './skills/formatCurrency'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HIDDEN_DIR = path.resolve(HERE, '..', 'coding-bench')
const SKILL_SUITES_DIR = path.resolve(HERE, 'skills', '_suites')
const OUT_ROOT = path.join(os.tmpdir(), 'crucible-ocb')

// ── Shape-gate helpers (mirrors pureCode.ts — keep in sync) ──────────────────

function emittedExportNames(content: string): string[] {
  return Array.from(
    content.matchAll(/\bexport\s+(?:async\s+)?(?:class|function|const|interface|type)\s+([A-Za-z_$][\w$]*)/g),
    m => m[1],
  )
}

function satisfiesExportShape(files: SynthFile[], requested: string[]): boolean {
  if (!requested.length) return true
  const emitted = new Set(files.flatMap(f => emittedExportNames(f.content)))
  return requested.every(e => emitted.has(e))
}

// ── Task catalogue ────────────────────────────────────────────────────────────
//
// SOLVE        — L0 should match a registered skill AND pass the shape gate;
//                hidden suite confirms correctness.
// SHAPE-GATE   — keywords trigger a registered skill, but the spec declares
//                different export names → shape gate must reject → escalate.
//                (Tests the Phase-0 fix directly.)
// HONEST-ESC   — no registered skill covers this family; must escalate cleanly.
//
// Spec authoring rule: avoid "returns" / "→" / "=>" in inline comments inside
// signatures — derive.ts will extract them as (garbage) examples and confuse L2.

interface OCBTask {
  id: string
  spec: string
  expectSolve: boolean
  hiddenSuite?: string   // filename relative to suiteDir
  suiteDir?: string      // override directory for hiddenSuite (default: HIDDEN_DIR)
}

const TASKS: OCBTask[] = [

  // ── SOLVE: graph topology ─────────────────────────────────────────────────
  {
    id: 'scheduler-exact',
    expectSolve: true,
    hiddenSuite: 'scheduler.hidden.ts',
    spec: `Implement a topological-sort task scheduler with cycle detection at src/scheduler.ts.
export function topoSort(nodes:string[], edges:[string,string][]):string[]
export function findCycle(nodes:string[], edges:[string,string][]):string[]|null
Edge [a,b] means a must run before b. topoSort throws on a cycle and includes disconnected nodes. findCycle gives a cycle path or null; self-loops count.`,
  },
  {
    id: 'scheduler-depres',
    expectSolve: true,
    hiddenSuite: 'scheduler.hidden.ts',
    spec: `Dependency resolution: given nodes and directed edges, order them so each dependency runs before its dependents. Detect cycles. Write to src/scheduler.ts.
export function topoSort(nodes:string[], edges:[string,string][]):string[]
export function findCycle(nodes:string[], edges:[string,string][]):string[]|null`,
  },

  // ── SOLVE: LRU+TTL key-value store ───────────────────────────────────────
  {
    id: 'kvstore-exact',
    expectSolve: true,
    hiddenSuite: 'kvstore.hidden.ts',
    spec: `Implement a persistent key-value store at src/kvstore.ts.
export class KVStore { constructor(opts:{maxEntries:number;walPath:string}); set(key:string,value:string,ttlMs?:number):void; get(key:string):string|undefined; delete(key:string):boolean; size():number; close():void }
LRU eviction capped at maxEntries (get refreshes recency), per-key TTL expiry, write-ahead log at walPath, crash recovery replays WAL on construction.`,
  },
  {
    id: 'kvstore-wal',
    expectSolve: true,
    hiddenSuite: 'kvstore.hidden.ts',
    spec: `Persistent KV store with LRU eviction, per-key TTL, and a write-ahead log at src/kvstore.ts.
export class KVStore { constructor(opts:{maxEntries:number;walPath:string}); set(key:string,value:string,ttlMs?:number):void; get(key:string):string|undefined; delete(key:string):boolean; size():number; close():void }`,
  },

  // ── SOLVE: rate limiters ──────────────────────────────────────────────────
  {
    id: 'ratelimiter-exact',
    expectSolve: true,
    hiddenSuite: 'ratelimiter.hidden.ts',
    spec: `Implement rate limiters at src/ratelimiter.ts.
export class TokenBucket { constructor(capacity:number,refillPerSec:number,now?:()=>number); tryRemove(tokens?:number):boolean }
export class SlidingWindowLimiter { constructor(limit:number,windowMs:number,now?:()=>number); allow(key:string):boolean }
Token bucket refills over time capped at capacity; sliding window allows limit requests per rolling windowMs per key; both use the injected now() clock.`,
  },
  {
    id: 'ratelimiter-throttle',
    expectSolve: true,
    hiddenSuite: 'ratelimiter.hidden.ts',
    spec: `API throttling at src/ratelimiter.ts. Token-bucket refills at a fixed rate; sliding-window counts requests in a rolling window per key.
export class TokenBucket { constructor(capacity:number,refillPerSec:number,now?:()=>number); tryRemove(tokens?:number):boolean }
export class SlidingWindowLimiter { constructor(limit:number,windowMs:number,now?:()=>number); allow(key:string):boolean }`,
  },

  // ── SOLVE: regex engine ───────────────────────────────────────────────────
  {
    id: 'regex-exact',
    expectSolve: true,
    hiddenSuite: 'regex.hidden.ts',
    spec: `Implement a mini backtracking regex engine at src/regex.ts.
export function regexMatch(pattern:string, text:string):boolean
Full match. Support literals, '.', '*', '+', '?', character classes [abc] and [a-z], and backslash escaping.`,
  },
  {
    id: 'regex-pattern',
    expectSolve: true,
    hiddenSuite: 'regex.hidden.ts',
    spec: `Pattern matching engine at src/regex.ts. Full-match semantics, backtracking, character classes [abc]/[a-z], dot, quantifiers *, +, ?.
export function regexMatch(pattern:string, text:string):boolean`,
  },

  // ── SOLVE: Tier-1A utility skills ────────────────────────────────────────
  {
    id: 'slug-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'slug.hidden.ts',
    spec: `URL-safe slug generator at src/slug.ts.\nexport function slug(str:string):string`,
  },
  {
    id: 'slug-kebab', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'slug.hidden.ts',
    spec: `Convert a string to a URL-safe kebab-case slug at src/slug.ts.\nexport function slug(str:string):string\nLowercase, strip non-alphanumeric, collapse hyphens.`,
  },
  {
    id: 'chunk-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'chunk.hidden.ts',
    spec: `Split an array into fixed-size chunks at src/chunk.ts.\nexport function chunk<T>(arr:T[], size:number):T[][]`,
  },
  {
    id: 'chunk-batch', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'chunk.hidden.ts',
    spec: `Batch an array into sub-arrays of at most size elements at src/chunk.ts.\nexport function chunk<T>(arr:T[], size:number):T[][]`,
  },
  {
    id: 'groupby-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'groupBy.hidden.ts',
    spec: `Group-by utility at src/groupBy.ts.\nexport function groupBy<T>(arr:T[], key:(item:T)=>string|number):Record<string,T[]>`,
  },
  {
    id: 'groupby-bucket', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'groupBy.hidden.ts',
    spec: `Group array elements into buckets by a selector at src/groupBy.ts.\nexport function groupBy<T>(arr:T[], key:(item:T)=>string|number):Record<string,T[]>`,
  },
  {
    id: 'formatbytes-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'formatBytes.hidden.ts',
    spec: `Format bytes as a human-readable string at src/formatBytes.ts.\nexport function formatBytes(bytes:number, decimals?:number):string\nformatBytes(1024) === "1 KB", formatBytes(0) === "0 B"`,
  },
  {
    id: 'formatbytes-readable', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'formatBytes.hidden.ts',
    spec: `Human-readable file size formatter at src/formatBytes.ts. Outputs B, KB, MB, GB.\nexport function formatBytes(bytes:number, decimals?:number):string`,
  },
  {
    id: 'base64-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'base64.hidden.ts',
    spec: `Base64 encode and decode at src/base64.ts.\nexport function base64Encode(str:string):string\nexport function base64Decode(str:string):string`,
  },
  {
    id: 'base64-roundtrip', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'base64.hidden.ts',
    spec: `Base64 encoding utilities at src/base64.ts.\nexport function base64Encode(str:string):string\nexport function base64Decode(str:string):string`,
  },
  {
    id: 'escapehtml-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'escapeHtml.hidden.ts',
    spec: `HTML entity escape and unescape at src/escapeHtml.ts.\nexport function escapeHtml(str:string):string\nexport function unescapeHtml(str:string):string`,
  },
  {
    id: 'escapehtml-xss', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'escapeHtml.hidden.ts',
    spec: `Escape HTML special characters to prevent XSS at src/escapeHtml.ts.\nexport function escapeHtml(str:string):string\nexport function unescapeHtml(str:string):string`,
  },
  {
    id: 'pick-omit-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'pickOmit.hidden.ts',
    spec: `Pick and omit object keys at src/pickOmit.ts.\nexport function pick<T extends object, K extends keyof T>(obj:T, keys:K[]):Pick<T,K>\nexport function omit<T extends object, K extends keyof T>(obj:T, keys:K[]):Omit<T,K>`,
  },
  {
    id: 'pick-omit-subset', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'pickOmit.hidden.ts',
    spec: `Select or exclude keys from a plain object at src/pickOmit.ts.\nexport function pick<T extends object, K extends keyof T>(obj:T, keys:K[]):Pick<T,K>\nexport function omit<T extends object, K extends keyof T>(obj:T, keys:K[]):Omit<T,K>`,
  },
  {
    id: 'deepclone-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'deepClone.hidden.ts',
    spec: `Deep clone a value at src/deepClone.ts.\nexport function deepClone<T>(value:T):T`,
  },
  {
    id: 'deepclone-copy', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'deepClone.hidden.ts',
    spec: `Structural deep copy of nested objects and arrays at src/deepClone.ts.\nexport function deepClone<T>(value:T):T`,
  },

  // ── SOLVE: catalog Tier-1A/B skills ──────────────────────────────────────
  { id: 'capitalize-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'capitalize.hidden.ts', spec: 'Capitalize the first letter of each word at src/capitalize.ts.\nexport function capitalize(str:string):string' },
  { id: 'camelcase-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'camelCase.hidden.ts', spec: 'Convert a string to camelCase at src/camelCase.ts.\nexport function camelCase(str:string):string' },
  { id: 'pascalcase-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'pascalCase.hidden.ts', spec: 'Convert a string to PascalCase at src/pascalCase.ts.\nexport function pascalCase(str:string):string' },
  { id: 'snakecase-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'snakeCase.hidden.ts', spec: 'Convert a string to snake_case at src/snakeCase.ts.\nexport function snakeCase(str:string):string' },
  { id: 'truncate-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'truncate.hidden.ts', spec: 'Truncate a string with ellipsis at src/truncate.ts.\nexport function truncate(str:string, maxLength:number, ellipsis?:string):string' },
  { id: 'countoccurrences-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'countOccurrences.hidden.ts', spec: 'Count occurrences of a substring at src/countOccurrences.ts.\nexport function countOccurrences(str:string, sub:string):number' },
  { id: 'ispalindrome-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'isPalindrome.hidden.ts', spec: 'Check if a string is a palindrome at src/isPalindrome.ts.\nexport function isPalindrome(str:string):boolean' },
  { id: 'reversestring-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'reverseString.hidden.ts', spec: 'Reverse a string at src/reverseString.ts.\nexport function reverseString(str:string):string' },
  { id: 'flatten-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'flatten.hidden.ts', spec: 'Flatten a nested array at src/flatten.ts.\nexport function flatten<T>(arr:Array<T|T[]>, depth?:number):T[]' },
  { id: 'unique-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'unique.hidden.ts', spec: 'Remove duplicate values from an array at src/unique.ts.\nexport function unique<T>(arr:T[]):T[]\nexport function uniqueBy<T>(arr:T[], key:(item:T)=>unknown):T[]' },
  { id: 'setops-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'setOps.hidden.ts', spec: 'Array set operations at src/setOps.ts.\nexport function intersection<T>(a:T[],b:T[]):T[]\nexport function difference<T>(a:T[],b:T[]):T[]\nexport function union<T>(a:T[],b:T[]):T[]' },
  { id: 'compact-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'compact.hidden.ts', spec: 'Remove falsy values from an array at src/compact.ts.\nexport function compact<T>(arr:Array<T|null|undefined|false|0|"">):T[]' },
  { id: 'zip-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'zip.hidden.ts', spec: 'Zip two arrays into pairs at src/zip.ts.\nexport function zip<A,B>(a:A[],b:B[]):[A,B][]\nexport function unzip<A,B>(pairs:[A,B][]):[A[],B[]]' },
  { id: 'range-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'range.hidden.ts', spec: 'Generate a range of numbers at src/range.ts.\nexport function range(start:number, end?:number, step?:number):number[]' },
  { id: 'arrayutils-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'arrayUtils.hidden.ts', spec: 'take, drop, last, first, partition array helpers at src/arrayUtils.ts.\nexport function take<T>(arr:T[],n:number):T[]\nexport function drop<T>(arr:T[],n:number):T[]\nexport function last<T>(arr:T[]):T|undefined\nexport function first<T>(arr:T[]):T|undefined\nexport function partition<T>(arr:T[],pred:(item:T)=>boolean):[T[],T[]]' },
  { id: 'sumby-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'sumBy.hidden.ts', spec: 'sumBy, minBy, maxBy, sortBy at src/sumBy.ts.\nexport function sumBy<T>(arr:T[],key:(item:T)=>number):number\nexport function minBy<T>(arr:T[],key:(item:T)=>number):T|undefined\nexport function maxBy<T>(arr:T[],key:(item:T)=>number):T|undefined\nexport function sortBy<T>(arr:T[],key:(item:T)=>number|string):T[]' },
  { id: 'mapvalues-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'mapValues.hidden.ts', spec: 'Map object values, keys, filter entries at src/mapValues.ts.\nexport function mapValues<T,U>(obj:Record<string,T>,fn:(v:T,k:string)=>U):Record<string,U>\nexport function mapKeys<T>(obj:Record<string,T>,fn:(k:string,v:T)=>string):Record<string,T>\nexport function filterValues<T>(obj:Record<string,T>,pred:(v:T,k:string)=>boolean):Record<string,T>' },
  { id: 'invert-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'invert.hidden.ts', spec: 'Swap keys and values of an object at src/invert.ts.\nexport function invert(obj:Record<string,string>):Record<string,string>' },
  { id: 'flattenobject-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'flattenObject.hidden.ts', spec: 'Flatten nested object to dot-separated keys at src/flattenObject.ts.\nexport function flattenObject(obj:Record<string,unknown>,prefix?:string):Record<string,unknown>\nexport function unflattenObject(obj:Record<string,unknown>):Record<string,unknown>' },
  { id: 'clamp-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'clamp.hidden.ts', spec: 'Clamp, lerp, roundTo at src/clamp.ts.\nexport function clamp(value:number,min:number,max:number):number\nexport function lerp(a:number,b:number,t:number):number\nexport function roundTo(value:number,decimals:number):number' },
  { id: 'formatnumber-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'formatNumber.hidden.ts', spec: 'Format number with thousand separators at src/formatNumber.ts.\nexport function formatNumber(value:number,decimals?:number,decimalSep?:string,thousandSep?:string):string' },
  { id: 'typeguards-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'typeGuards.hidden.ts', spec: 'Runtime type guards at src/typeGuards.ts.\nexport function isString(v:unknown):v is string\nexport function isNumber(v:unknown):v is number\nexport function isBoolean(v:unknown):v is boolean\nexport function isArray(v:unknown):v is unknown[]\nexport function isObject(v:unknown):v is Record<string,unknown>\nexport function isNil(v:unknown):v is null|undefined\nexport function isEmpty(v:unknown):boolean' },
  { id: 'fnutils-exact', expectSolve: true, suiteDir: SKILL_SUITES_DIR, hiddenSuite: 'fnUtils.hidden.ts', spec: 'Higher-order helpers: once, compose, pipe at src/fnUtils.ts.\nexport function once<T extends (...args:unknown[])=>unknown>(fn:T):T\nexport function compose<T>(...fns:Array<(arg:T)=>T>):(arg:T)=>T\nexport function pipe<T>(...fns:Array<(arg:T)=>T>):(arg:T)=>T' },

  // ── SHAPE-GATE: different export names — Phase-0 guard must reject ────────
  {
    id: 'shape-gate-graph',
    expectSolve: false,
    spec: `Topological sort with cycle detection at src/tsort.ts.
export function topologicalSort(nodes:string[], deps:[string,string][]):string[]
export function hasCycle(nodes:string[], deps:[string,string][]):boolean`,
  },
  {
    id: 'shape-gate-kvstore',
    expectSolve: false,
    spec: `Key-value cache with LRU eviction and TTL at src/cache.ts.
export class Cache { constructor(maxSize:number, walPath:string); put(key:string, value:string, ttlMs?:number):void; get(key:string):string|undefined }`,
  },
  {
    id: 'shape-gate-ratelimiter',
    expectSolve: false,
    spec: `Rate limiting at src/limiter.ts. Token-bucket and sliding-window algorithms.
export class RateLimiter { constructor(capacity:number, windowMs:number); allow(key:string):boolean }`,
  },
  {
    id: 'shape-gate-regex',
    expectSolve: false,
    spec: `Mini regex engine at src/pattern.ts. Literals, dot, *, +, ?, character classes, backslash escaping.
export function matchRegex(pattern:string, text:string):boolean`,
  },

  // ── HONEST ESCALATE: no registered core skill covers these families ────────
  // Specs deliberately avoid "returns"/"=>" in inline comments to prevent
  // derive.ts from extracting garbage examples and accidentally triggering L2.
  {
    id: 'esc-fibonacci',
    expectSolve: false,
    spec: `Fibonacci sequence at src/fib.ts.
export function fib(n:number):number
0-indexed; fib(0)=0, fib(1)=1.`,
  },
  {
    id: 'esc-binary-search',
    expectSolve: false,
    spec: `Binary search over a sorted array at src/search.ts.
export function binarySearch(arr:number[], target:number):number
Index of target in arr, or -1 if absent.`,
  },
  {
    id: 'esc-event-emitter',
    expectSolve: false,
    spec: `Typed event emitter at src/emitter.ts.
export class EventEmitter { on(event:string, fn:Function):void; off(event:string, fn:Function):void; emit(event:string, ...args:unknown[]):void }`,
  },
  {
    id: 'esc-deep-equal',
    expectSolve: true,
    hiddenSuite: 'deepEqual.hidden.ts',
    suiteDir: SKILL_SUITES_DIR,
    spec: `Deep structural equality at src/module.ts. Handles arrays, objects, primitives, null, undefined.
export function deepEqual(a:unknown, b:unknown):boolean`,
  },
  {
    id: 'esc-merge-sort',
    expectSolve: false,
    spec: `Stable merge sort at src/sort.ts.
export function mergeSort(arr:number[]):number[]
Allocates a new sorted array; does not mutate the input.`,
  },
  {
    id: 'esc-linked-list',
    expectSolve: false,
    spec: `Doubly linked list at src/list.ts.
export class LinkedList<T> { push(value:T):void; pop():T|undefined; unshift(value:T):void; shift():T|undefined; toArray():T[] }`,
  },
  {
    id: 'esc-min-heap',
    expectSolve: false,
    spec: `Min-heap priority queue at src/heap.ts.
export class MinHeap<T> { insert(value:T, priority:number):void; extractMin():{value:T;priority:number}|null; size():number }`,
  },
  {
    id: 'esc-memoize',
    expectSolve: false,
    spec: `Memoization wrapper at src/memo.ts.
export function memoize<T extends (...args:unknown[])=>unknown>(fn:T):T
Caches by serialised argument list; subsequent calls with the same args skip fn.`,
  },
  {
    id: 'esc-promise-pool',
    expectSolve: false,
    spec: `Bounded concurrent promise executor at src/pool.ts.
export async function promisePool<T>(tasks:Array<()=>Promise<T>>, concurrency:number):Promise<T[]>
Runs at most concurrency tasks simultaneously; preserves input order in output.`,
  },
  {
    id: 'esc-ring-buffer',
    expectSolve: false,
    spec: `Fixed-capacity ring buffer at src/ring.ts.
export class RingBuffer<T> { constructor(capacity:number); push(value:T):void; pop():T|undefined; size():number; isFull():boolean }`,
  },
  {
    id: 'esc-edit-distance',
    expectSolve: false,
    spec: `Edit distance between two strings at src/diff.ts.
export function editDistance(a:string, b:string):number
Minimum insertions, deletions, and substitutions to transform a into b.`,
  },
  {
    id: 'esc-json-tokenizer',
    expectSolve: false,
    spec: `JSON tokenizer at src/tokenize.ts.
export function tokenize(input:string):Array<{type:string;value:string}>`,
  },
  {
    id: 'esc-url-parser',
    expectSolve: false,
    spec: `URL parser at src/url.ts.
export function parseURL(url:string):{protocol:string;host:string;path:string;query:Record<string,string>}`,
  },
  {
    id: 'esc-anagram',
    expectSolve: false,
    spec: `Anagram detection at src/anagram.ts.
export function isAnagram(a:string, b:string):boolean
export function groupAnagrams(words:string[]):string[][]`,
  },

  // ── SOLVE: graph algorithms (graphPaths / graphStruct families) ──────────────
  {
    id: 'dijkstra-exact',
    expectSolve: true,
    hiddenSuite: 'dijkstraDistances.hidden.ts',
    suiteDir: SKILL_SUITES_DIR,
    spec: `dijkstraDistances returns single-source shortest distances over a directed weighted graph at src/dijkstraDistances.ts.
export function dijkstraDistances(n: number, edges: [number,number,number][], src: number): number[]
Unreachable nodes are Infinity. Weights are non-negative. Nodes are 0..n-1.`,
  },
  {
    id: 'dsu-exact',
    expectSolve: true,
    hiddenSuite: 'dsuUnionFind.hidden.ts',
    suiteDir: SKILL_SUITES_DIR,
    spec: `DSU union-find data structure at src/dsuUnionFind.ts.
export class DSU { constructor(n: number); find(x: number): number; union(a: number, b: number): void; connected(a: number, b: number): boolean; count(): number }
Path compression in find. count() returns number of remaining disjoint sets.`,
  },
  {
    id: 'bfs-hops-exact',
    expectSolve: true,
    hiddenSuite: 'bfsHopCounts.hidden.ts',
    suiteDir: SKILL_SUITES_DIR,
    spec: `bfsHopCounts returns the shortest hop count in an unweighted graph at src/bfsHopCounts.ts.
export function bfsHopCounts(n: number, adj: number[][], src: number): number[]
Unreachable nodes return -1. Adjacency lists, nodes 0..n-1.`,
  },

  // ── SOLVE: collection data structures (collectionsB family) ─────────────────
  {
    id: 'priority-queue-min-exact',
    expectSolve: true,
    hiddenSuite: 'priorityQueueMin.hidden.ts',
    suiteDir: SKILL_SUITES_DIR,
    spec: `PriorityQueue min-heap at src/priorityQueueMin.ts.
export class PriorityQueue<T> { push(item: T, priority: number): void; pop(): T | undefined; peek(): T | undefined; size(): number; isEmpty(): boolean }
pop() and peek() return the item with the lowest priority number first.`,
  },
  {
    id: 'lfu-cache-exact',
    expectSolve: true,
    hiddenSuite: 'lfuCache.hidden.ts',
    suiteDir: SKILL_SUITES_DIR,
    spec: `LFUCache with capacity-limited get/put, least-frequently-used eviction at src/lfuCache.ts.
export class LFUCache<K, V> { constructor(capacity: number); get(k: K): V | undefined; put(k: K, v: V): void }
Ties broken by least-recently-used (LRU). get() increments frequency.`,
  },

  // ── SOLVE: functional primitives (fpB family) ────────────────────────────────
  {
    id: 'result-box-exact',
    expectSolve: true,
    hiddenSuite: 'resultBox.hidden.ts',
    suiteDir: SKILL_SUITES_DIR,
    spec: `ResultBox monad: ok/err/map/mapErr/unwrapOr/isOk at src/resultBox.ts.
export class ResultBox<V, E = unknown> { static ok<V>(v: V): ResultBox<V,never>; static err<E>(e: E): ResultBox<never,E>; map<U>(fn: (v: V) => U): ResultBox<U, E>; mapErr<F>(fn: (e: E) => F): ResultBox<V, F>; unwrapOr(def: V): V; isOk(): boolean }`,
  },

  // ── SOLVE: random / seeded utilities (randomUtils family) ────────────────────
  {
    id: 'mulberry32-exact',
    expectSolve: true,
    hiddenSuite: 'mulberry32Prng.hidden.ts',
    suiteDir: SKILL_SUITES_DIR,
    spec: `mulberry32 seeded PRNG at src/mulberry32Prng.ts.
export function mulberry32(seed: number): () => number
Returns a PRNG function yielding values in [0, 1). Deterministic — same seed gives same sequence.`,
  },
  {
    id: 'shuffle-seeded-exact',
    expectSolve: true,
    hiddenSuite: 'shuffleSeeded.hidden.ts',
    suiteDir: SKILL_SUITES_DIR,
    spec: `shuffleSeeded performs a deterministic Fisher-Yates shuffle of an array using a seeded PRNG at src/shuffleSeeded.ts.
export function shuffleSeeded<T>(arr: T[], seed: number): T[]
Does not mutate the input array. Same seed gives same output.`,
  },

  // ── SOLVE: format parsers (parsersB family) ───────────────────────────────────
  {
    id: 'parse-semver-exact',
    expectSolve: true,
    hiddenSuite: 'parseSemverParts.hidden.ts',
    suiteDir: SKILL_SUITES_DIR,
    spec: `parseSemverParts and compareSemver at src/parseSemverParts.ts.
export function parseSemverParts(v: string): { major: number; minor: number; patch: number; prerelease: string } | null
export function compareSemver(a: string, b: string): number
compareSemver returns -1/0/1. parseSemverParts returns null for malformed input.`,
  },
  {
    id: 'parse-query-exact',
    expectSolve: true,
    hiddenSuite: 'parseQueryParams.hidden.ts',
    suiteDir: SKILL_SUITES_DIR,
    spec: `parseQueryParams parses a URL query string into URL-decoded key-value pairs at src/parseQueryParams.ts.
export function parseQueryParams(qs: string): Record<string, string>
Leading ? is optional. Last value wins on repeated keys.`,
  },

  // ── SOLVE: new Tier-1 hand-authored skills ────────────────────────────────────
  {
    id: 'deep-equal-exact',
    expectSolve: true,
    hiddenSuite: 'deepEqual.hidden.ts',
    suiteDir: SKILL_SUITES_DIR,
    spec: `Deep structural equality at src/module.ts.
export function deepEqual(a: unknown, b: unknown): boolean
export const isEqual: typeof deepEqual
Handles nested objects, arrays, null, primitives. Mutations to one side don't affect the check.`,
  },
  {
    id: 'sort-by-exact',
    expectSolve: true,
    hiddenSuite: 'sortBy.hidden.ts',
    suiteDir: SKILL_SUITES_DIR,
    spec: `Sort array by key or comparator function using sortBy; multi-key orderBy at src/module.ts.
export function sortBy<T>(arr: T[], key: keyof T | ((item: T) => unknown), dir?: 'asc' | 'desc'): T[]
export function orderBy<T>(arr: T[], specs: Array<{ key: keyof T | ((item:T)=>unknown); dir?: 'asc'|'desc' }>): T[]
Does not mutate the original array. Null values sort last.`,
  },
  {
    id: 'jwt-decode-exact',
    expectSolve: true,
    hiddenSuite: 'jwtDecode.hidden.ts',
    suiteDir: SKILL_SUITES_DIR,
    spec: `JWT decode (no signature verification) at src/module.ts.
export function jwtDecode(token: string): { header: Record<string,unknown>; payload: Record<string,unknown>; signature: string }
export function isJwtExpired(token: string): boolean
Throws on malformed token. isJwtExpired uses payload.exp vs Date.now().`,
  },
  {
    id: 'mime-type-exact',
    expectSolve: true,
    hiddenSuite: 'mimeType.hidden.ts',
    suiteDir: SKILL_SUITES_DIR,
    spec: `MIME type lookup at src/module.ts.
export function getMimeType(fileOrExt: string): string
export function getExtension(mime: string): string | null
export function isTextMime(mime: string): boolean
getMimeType accepts a filename or bare extension. Returns application/octet-stream for unknown.`,
  },
]

// ── Runner ────────────────────────────────────────────────────────────────────

function runHiddenSuite(id: string, dir: string, suitePath: string): { ok: boolean; detail: string } {
  if (!fs.existsSync(suitePath)) return { ok: false, detail: `no suite at ${path.basename(suitePath)}` }
  const auditDir = path.join(dir, '__audit__')
  fs.mkdirSync(auditDir, { recursive: true })
  const dst = path.join(auditDir, path.basename(suitePath))
  fs.copyFileSync(suitePath, dst)
  const r = spawnSync('npx', ['tsx', dst], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const tail = out.split('\n').filter(l => /PASS|FAIL|ALL PASS|FAILURE|Error/.test(l)).slice(-4).join(' | ')
  return { ok: r.status === 0, detail: tail || out.slice(0, 200) }
}

function main() {
  console.log('Crucible OCB — L0 pure-code scorecard (zero model inference, zero L1/L2)\n')

  const rows: string[] = []
  let solveExpected = 0, solved = 0, suitePassed = 0
  let escalateExpected = 0, escalated = 0
  let wrongCount = 0

  for (const task of TASKS) {
    const feats = extractFeatures(task.spec)
    const t0 = process.hrtime.bigint()
    const result = synthesize(task.spec)
    const elapsedUs = Number(process.hrtime.bigint() - t0) / 1000

    // Apply export-shape gate (mirrors pureCode.ts no-example branch).
    const shapePassed = result.matched !== null && satisfiesExportShape(result.files, feats.exports)
    const didSolve = shapePassed

    if (task.expectSolve) {
      solveExpected++
      if (didSolve) {
        solved++
        if (task.hiddenSuite) {
          const suitePath = path.join(task.suiteDir ?? HIDDEN_DIR, task.hiddenSuite)
          const dir = path.join(OUT_ROOT, task.id)
          fs.rmSync(dir, { recursive: true, force: true })
          for (const f of result.files) {
            const abs = path.join(dir, f.path)
            fs.mkdirSync(path.dirname(abs), { recursive: true })
            fs.writeFileSync(abs, f.content)
          }
          const suite = runHiddenSuite(task.id, dir, suitePath)
          if (suite.ok) {
            suitePassed++
            rows.push(`  GREEN  ${task.id.padEnd(28)} via ${(result.matched!.id).padEnd(20)} (${elapsedUs.toFixed(0)}µs) :: ${suite.detail}`)
          } else {
            wrongCount++
            rows.push(`  WRONG  ${task.id.padEnd(28)} via ${(result.matched!.id).padEnd(20)} SUITE FAILED :: ${suite.detail}`)
          }
        } else {
          suitePassed++
          rows.push(`  SOLVE  ${task.id.padEnd(28)} via ${(result.matched!.id).padEnd(20)} (${elapsedUs.toFixed(0)}µs) [no suite]`)
        }
      } else if (result.matched && !shapePassed) {
        rows.push(`  MISS   ${task.id.padEnd(28)} matched ${result.matched.id} (conf ${result.confidence.toFixed(2)}) but shape gate rejected — emitted exports don't cover ${feats.exports.join(', ')}`)
      } else {
        rows.push(`  MISS   ${task.id.padEnd(28)} no L0 match (top: ${result.ranking.slice(0, 2).map(r => `${r.id}:${r.score.toFixed(2)}`).join(', ')})`)
      }
    } else {
      escalateExpected++
      if (!didSolve) {
        escalated++
        const why = result.matched && !shapePassed
          ? `shape gate rejected ${result.matched.id} (conf ${result.confidence.toFixed(2)})`
          : `no L0 match (top: ${result.ranking[0] ? `${result.ranking[0].id}:${result.ranking[0].score.toFixed(2)}` : 'none'})`
        rows.push(`  GATE   ${task.id.padEnd(28)} escalated correctly — ${why}`)
      } else {
        wrongCount++
        rows.push(`  WRONG  ${task.id.padEnd(28)} should have escalated — shipped ${result.matched!.id} (shape gate missed)`)
      }
    }
  }

  const coverage = solveExpected > 0
    ? `${(solved / solveExpected * 100).toFixed(1)}%  (${solved}/${solveExpected})`
    : 'N/A'
  const correctness = solved > 0
    ? `${(suitePassed / solved * 100).toFixed(1)}%  (${suitePassed}/${solved})`
    : '100.0%  (trivially)'
  const honestEsc = escalateExpected > 0
    ? `${(escalated / escalateExpected * 100).toFixed(1)}%  (${escalated}/${escalateExpected})`
    : 'N/A'

  console.log(rows.join('\n'))
  console.log(`
┌─ OCB SCORECARD (L0 only) ──────────────────────────────────────────────┐
│  Coverage%              ${coverage}
│  Correctness-on-covered ${correctness}
│  HonestEscalation%      ${honestEsc}
│  WRONG                  ${String(wrongCount).padStart(2)}   (must be 0 — permanent floor invariant)
└────────────────────────────────────────────────────────────────────────┘`)

  if (wrongCount > 0) {
    console.error(`\nFAIL — ${wrongCount} WRONG result(s). Fix before proceeding.`)
    process.exit(1)
  }
  console.log('\nAll OCB invariants hold.')
}

main()
