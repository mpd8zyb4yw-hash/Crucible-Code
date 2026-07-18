// Pure, offline bench for the answer-path BEHAVIORAL-CONTRACT verifier. No model, no network.
// Run: npx tsx src/CrucibleEngine/reasoning/__contract_bench.ts   (npm run vgr:contract)
//
// Guards the cont.91 residual: the structural tiers certified a linked list whose pop() loses
// nodes and a token bucket whose acquire() is inverted — both parsed, both survived their own
// demo, both shipped stamped. Cases marked [REAL] reproduce those live failure SHAPES.
//
// The FALSE-REJECT guards are the load-bearing half (cont.85 — verifiers fail in TWO
// directions): every contract pins at least one KNOWN-CORRECT implementation as certified,
// including convention variants (head-push lists, push/shift queues, leading-edge debounce,
// setInterval-driven refill, options-object constructors). Ambiguity must ABSTAIN, never guess.
import { verifyAnswerContract, detectContract, contractRepairSpec, replaceAnswerCodeBlocks } from './contractVerify'
import { certifyAnswer } from './executionVerify'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}
const code = (s: string) => '```ts\n' + s + '\n```'
const T = { timeoutMs: 1500 }

// ════════════════════════════════ linked-list ════════════════════════════════
console.log('== linked-list (the cont.90/91 live failure class) ==')
{
  // KNOWN-CORRECT tail-append list with toArray — must certify (false-reject guard).
  const good = code(`class LinkedList {
  constructor() { this.head = null; this.size = 0 }
  append(v) { const n = { value: v, next: null }; if (!this.head) { this.head = n } else { let c = this.head; while (c.next) c = c.next; c.next = n } this.size++; return this }
  pop() { if (!this.head) return undefined; if (!this.head.next) { const v = this.head.value; this.head = null; this.size--; return v } let c = this.head; while (c.next.next) c = c.next; const v = c.next.value; c.next = null; this.size--; return v }
  toArray() { const out = []; let c = this.head; while (c) { out.push(c.value); c = c.next } return out }
}
const l = new LinkedList(); l.append(1).append(2); console.log(l.toArray())`)
  const v = verifyAnswerContract('implement a singly linked list with append and pop', good, T)
  check('correct tail-append list → certified', v.status === 'certified', v.reason)
  check('judged the LinkedList class', v.entry === 'LinkedList', v.entry)
}
{
  // KNOWN-CORRECT head-push list (classic O(1) tutorial convention) — reverse order is VALID.
  const headPush = code(`class LinkedList {
  constructor() { this.head = null }
  push(v) { this.head = { value: v, next: this.head } }
  toArray() { const out = []; let c = this.head; while (c) { out.push(c.value); c = c.next } return out }
}
const l = new LinkedList(); l.push(1); console.log(l.toArray())`)
  const v = verifyAnswerContract('write a linked list class', headPush, T)
  check('head-push convention (reverse order) → certified, not false-rejected', v.status === 'certified', v.reason)
}
{
  // [REAL shape] pop() that reads the tail but never UNLINKS it — drain returns the same value
  // forever, elements are never removed. Parses, demo survives → the structural tiers stamp it.
  const brokenPop = code(`class LinkedList {
  constructor() { this.head = null }
  append(v) { const n = { value: v, next: null }; if (!this.head) { this.head = n } else { let c = this.head; while (c.next) c = c.next; c.next = n } }
  pop() { if (!this.head) return undefined; let c = this.head; while (c.next) c = c.next; return c.value }
  toArray() { const out = []; let c = this.head; while (c) { out.push(c.value); c = c.next } return out }
}
const l = new LinkedList(); l.append(1); l.append(2); l.pop(); console.log(l.toArray())`)
  const v = verifyAnswerContract('implement a linked list with append and pop', brokenPop, T)
  check('[REAL] pop() never unlinks → violations', v.status === 'violations', v.reason)
  check('[REAL] counterexample names the drain defect', v.defects.some(d => /exactly once|came back|returned/.test(d.counterexample)), JSON.stringify(v.defects.map(d => d.check)))
  check('[REAL] repair constraints are forward-phrased (no code, no "your")', contractRepairSpec('implement a linked list with append and pop', v).constraints.every(c => !/your|previous|attempt/i.test(c) && c.length > 10), JSON.stringify(contractRepairSpec('implement a linked list with append and pop', v).constraints))
}
{
  // Cursor that never advances — infinite loop. The vm timeout must interrupt and ATTRIBUTE it.
  const hang = code(`class LinkedList {
  constructor() { this.head = null }
  append(v) { const n = { value: v, next: null }; if (!this.head) { this.head = n } else { let c = this.head; while (c.next) c = c.next; c.next = n } }
  toArray() { const out = []; let c = this.head; while (c) { out.push(c.value) } return out }
}
const l = new LinkedList(); l.append(1)`)
  const v = verifyAnswerContract('implement a linked list', hang, T)
  check('never-advancing cursor → violations (termination)', v.status === 'violations' && v.defects.some(d => d.check === 'termination'), v.reason)
}

// ════════════════════════════════ rate-limiter ═══════════════════════════════
console.log('== rate-limiter (the cont.91 live failure class) ==')
{
  // KNOWN-CORRECT lazy-refill token bucket (Date.now math) — positional ctor with named params.
  const good = code(`class TokenBucket {
  constructor(capacity, refillRate) { this.capacity = capacity; this.tokens = capacity; this.refillRate = refillRate; this.last = Date.now() }
  refill() { const now = Date.now(); this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillRate); this.last = now }
  acquire() { this.refill(); if (this.tokens >= 1) { this.tokens -= 1; return true } return false }
}
const b = new TokenBucket(3, 1); console.log(b.acquire())`)
  const v = verifyAnswerContract('implement a token bucket rate limiter', good, T)
  check('correct lazy-refill token bucket → certified', v.status === 'certified', v.reason)
}
{
  // KNOWN-CORRECT setInterval-driven refill — the fake timer queue must drive it.
  const timer = code(`class RateLimiter {
  constructor(capacity, intervalMs) { this.capacity = capacity; this.tokens = capacity; setInterval(() => { this.tokens = Math.min(this.capacity, this.tokens + 1) }, intervalMs) }
  acquire() { if (this.tokens > 0) { this.tokens--; return true } return false }
}
const r = new RateLimiter(3, 1000); console.log(r.acquire())`)
  const v = verifyAnswerContract('build a rate limiter', timer, T)
  check('correct setInterval-driven refill → certified (fake timers)', v.status === 'certified', v.reason)
}
{
  // KNOWN-CORRECT options-object ctor (destructured) — the kitchen-sink form must feed it.
  const optsCtor = code(`class RateLimiter {
  constructor({ capacity, refillRate }) { this.capacity = capacity; this.tokens = capacity; this.refillRate = refillRate; this.last = Date.now() }
  tryAcquire() { const now = Date.now(); this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillRate); this.last = now; if (this.tokens >= 1) { this.tokens -= 1; return true } return false }
}
const r = new RateLimiter({ capacity: 2, refillRate: 1 }); console.log(r.tryAcquire())`)
  const v = verifyAnswerContract('write a rate limiter class', optsCtor, T)
  check('options-object constructor → certified', v.status === 'certified', v.reason)
}
{
  // [REAL shape] INVERTED acquire — allows when exhausted, denies when full.
  const inverted = code(`class TokenBucket {
  constructor(capacity, refillRate) { this.capacity = capacity; this.tokens = capacity; this.refillRate = refillRate }
  acquire() { if (this.tokens <= 0) { this.tokens--; return true } this.tokens--; return false }
}
const b = new TokenBucket(3, 1); console.log(b.acquire())`)
  const v = verifyAnswerContract('implement a token bucket rate limiter', inverted, T)
  check('[REAL] inverted acquire → violations', v.status === 'violations', v.reason)
  check('[REAL] names the fresh-limiter-denies defect', v.defects.some(d => /first request|fresh/i.test(d.counterexample)), JSON.stringify(v.defects.map(d => d.check)))
}
{
  // [REAL shape] no time refill — burst works, tokens never come back.
  const noRefill = code(`class TokenBucket {
  constructor(capacity, refillRate) { this.capacity = capacity; this.tokens = capacity }
  acquire() { if (this.tokens > 0) { this.tokens--; return true } return false }
}
const b = new TokenBucket(3, 1); console.log(b.acquire())`)
  const v = verifyAnswerContract('implement a token bucket rate limiter with refill', noRefill, T)
  check('[REAL] refill never happens → violations', v.status === 'violations' && v.defects.some(d => d.check === 'refill'), v.reason)
}
{
  // Never limits — every request admitted with time frozen.
  const noLimit = code(`class RateLimiter {
  constructor(capacity) { this.capacity = capacity }
  allow() { return true }
}
const r = new RateLimiter(3); console.log(r.allow())`)
  const v = verifyAnswerContract('implement a rate limiter', noLimit, T)
  check('never-limits → violations (over-capacity)', v.status === 'violations' && v.defects.some(d => d.check === 'over-capacity limit'), v.reason)
}
{
  // Async (waiting) acquire is a VALID design — must abstain, never reject.
  const asyncAcq = code(`class RateLimiter {
  constructor(capacity) { this.capacity = capacity; this.tokens = capacity }
  async acquire() { while (this.tokens <= 0) { await new Promise(r => setTimeout(r, 50)) } this.tokens--; return true }
}
const r = new RateLimiter(3)`)
  const v = verifyAnswerContract('implement a rate limiter', asyncAcq, T)
  check('async acquire → abstain (not judged)', v.status === 'abstain', v.status + ': ' + v.reason)
}

// ════════════════════════════════ stack / queue ══════════════════════════════
console.log('== stack / queue ==')
{
  const good = code(`class Stack {
  constructor() { this.items = [] }
  push(v) { this.items.push(v) }
  pop() { return this.items.pop() }
  peek() { return this.items[this.items.length - 1] }
  size() { return this.items.length }
}
const s = new Stack(); s.push(1); console.log(s.pop())`)
  check('correct stack → certified', verifyAnswerContract('implement a stack', good, T).status === 'certified')
}
{
  const fifoStack = code(`class Stack {
  constructor() { this.items = [] }
  push(v) { this.items.push(v) }
  pop() { return this.items.shift() }
}
const s = new Stack(); s.push(1); console.log(s.pop())`)
  const v = verifyAnswerContract('implement a stack with push and pop', fifoStack, T)
  check('FIFO-behaving "stack" → violations (LIFO broken)', v.status === 'violations' && v.defects.some(d => d.check === 'LIFO order'), v.reason)
}
{
  const goodQ = code(`class Queue {
  constructor() { this.items = [] }
  enqueue(v) { this.items.push(v) }
  dequeue() { return this.items.shift() }
  peek() { return this.items[0] }
}
const q = new Queue(); q.enqueue(1); console.log(q.dequeue())`)
  check('correct queue → certified', verifyAnswerContract('implement a queue', goodQ, T).status === 'certified')
}
{
  const lifoQ = code(`class Queue {
  constructor() { this.items = [] }
  enqueue(v) { this.items.push(v) }
  dequeue() { return this.items.pop() }
}
const q = new Queue(); q.enqueue(1); console.log(q.dequeue())`)
  const v = verifyAnswerContract('implement a queue with enqueue and dequeue', lifoQ, T)
  check('LIFO-behaving "queue" → violations (FIFO broken)', v.status === 'violations' && v.defects.some(d => d.check === 'FIFO order'), v.reason)
}
{
  // "queue using two stacks" — the medium after "using" must not hijack detection.
  const twoStacks = code(`class Stack {
  constructor() { this.a = [] }
  push(v) { this.a.push(v) }
  pop() { return this.a.pop() }
}
class Queue {
  constructor() { this.inS = new Stack(); this.outS = new Stack() }
  enqueue(v) { this.inS.push(v) }
  dequeue() { if (!this.outS.a.length) { while (this.inS.a.length) this.outS.push(this.inS.pop()) } return this.outS.pop() }
}
const q = new Queue(); q.enqueue(1); console.log(q.dequeue())`)
  const d = detectContract('implement a queue using two stacks')
  check('detection: "queue using two stacks" → queue', d?.kind === 'queue', d?.kind)
  const v = verifyAnswerContract('implement a queue using two stacks', twoStacks, T)
  check('two-stack queue → certified (judged the Queue)', v.status === 'certified' && v.entry === 'Queue', v.entry + ': ' + v.reason)
}

// ════════════════════════════════ LRU cache ══════════════════════════════════
console.log('== LRU cache ==')
{
  const good = code(`class LRUCache {
  constructor(capacity) { this.capacity = capacity; this.map = new Map() }
  get(k) { if (!this.map.has(k)) return undefined; const v = this.map.get(k); this.map.delete(k); this.map.set(k, v); return v }
  put(k, v) { if (this.map.has(k)) this.map.delete(k); else if (this.map.size >= this.capacity) this.map.delete(this.map.keys().next().value); this.map.set(k, v) }
}
const c = new LRUCache(2); c.put('a', 1); console.log(c.get('a'))`)
  check('correct LRU → certified', verifyAnswerContract('implement an LRU cache', good, T).status === 'certified')
}
{
  // FIFO eviction masquerading as LRU — get() does not refresh recency.
  const fifo = code(`class LRUCache {
  constructor(capacity) { this.capacity = capacity; this.map = new Map() }
  get(k) { return this.map.has(k) ? this.map.get(k) : undefined }
  put(k, v) { if (!this.map.has(k) && this.map.size >= this.capacity) this.map.delete(this.map.keys().next().value); this.map.set(k, v) }
}
const c = new LRUCache(2); c.put('a', 1); console.log(c.get('a'))`)
  const v = verifyAnswerContract('implement an LRU cache', fifo, T)
  check('FIFO-evicting "LRU" → violations (recency)', v.status === 'violations' && v.defects.some(d => d.check === 'recency refresh'), v.reason)
}

// ═══════════════════════════ BST / heap / emitter ════════════════════════════
console.log('== BST / heap / event emitter ==')
{
  const bst = code(`class BST {
  constructor() { this.root = null }
  insert(v) { const n = { v, l: null, r: null }; if (!this.root) { this.root = n; return } let c = this.root; for (;;) { if (v < c.v) { if (!c.l) { c.l = n; return } c = c.l } else { if (!c.r) { c.r = n; return } c = c.r } } }
  contains(v) { let c = this.root; while (c) { if (c.v === v) return true; c = v < c.v ? c.l : c.r } return false }
  inorder() { const out = []; const walk = n => { if (!n) return; walk(n.l); out.push(n.v); walk(n.r) }; walk(this.root); return out }
}
const t = new BST(); t.insert(5); console.log(t.inorder())`)
  check('correct BST → certified', verifyAnswerContract('implement a binary search tree', bst, T).status === 'certified')
}
{
  // "inorder" that actually walks preorder — ordering invariant broken.
  const badBst = code(`class BST {
  constructor() { this.root = null }
  insert(v) { const n = { v, l: null, r: null }; if (!this.root) { this.root = n; return } let c = this.root; for (;;) { if (v < c.v) { if (!c.l) { c.l = n; return } c = c.l } else { if (!c.r) { c.r = n; return } c = c.r } } }
  inorder() { const out = []; const walk = n => { if (!n) return; out.push(n.v); walk(n.l); walk(n.r) }; walk(this.root); return out }
}
const t = new BST(); t.insert(5); console.log(t.inorder())`)
  const v = verifyAnswerContract('implement a binary search tree with insert and inorder traversal', badBst, T)
  check('preorder-as-inorder BST → violations', v.status === 'violations' && v.defects.some(d => d.check === 'inorder sorted'), v.reason)
}
{
  const heap = code(`class MinHeap {
  constructor() { this.a = [] }
  push(v) { this.a.push(v); let i = this.a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (this.a[p] <= this.a[i]) break; [this.a[p], this.a[i]] = [this.a[i], this.a[p]]; i = p } }
  pop() { const top = this.a[0]; const last = this.a.pop(); if (this.a.length) { this.a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = 2 * i + 2; let m = i; if (l < this.a.length && this.a[l] < this.a[m]) m = l; if (r < this.a.length && this.a[r] < this.a[m]) m = r; if (m === i) break; [this.a[m], this.a[i]] = [this.a[i], this.a[m]]; i = m } } return top }
}
const h = new MinHeap(); h.push(3); console.log(h.pop())`)
  check('correct min-heap → certified', verifyAnswerContract('implement a min-heap', heap, T).status === 'certified')
}
{
  // "min-heap" that pops insertion order, not priority order.
  const fake = code(`class MinHeap {
  constructor() { this.a = [] }
  push(v) { this.a.push(v) }
  pop() { return this.a.shift() }
}
const h = new MinHeap(); h.push(3); console.log(h.pop())`)
  const v = verifyAnswerContract('implement a min-heap', fake, T)
  check('insertion-order "heap" → violations', v.status === 'violations', v.reason)
}
{
  const em = code(`class EventEmitter {
  constructor() { this.m = new Map() }
  on(ev, fn) { if (!this.m.has(ev)) this.m.set(ev, []); this.m.get(ev).push(fn) }
  off(ev, fn) { const a = this.m.get(ev) || []; const i = a.indexOf(fn); if (i !== -1) a.splice(i, 1) }
  emit(ev, ...args) { for (const fn of this.m.get(ev) || []) fn(...args) }
}
const e = new EventEmitter(); e.on('x', () => {}); e.emit('x')`)
  check('correct emitter → certified', verifyAnswerContract('implement an event emitter', em, T).status === 'certified')
}
{
  // Broadcasts every emit to EVERY listener regardless of event name.
  const leaky = code(`class EventEmitter {
  constructor() { this.fns = [] }
  on(ev, fn) { this.fns.push(fn) }
  emit(ev, ...args) { for (const fn of this.fns) fn(...args) }
}
const e = new EventEmitter(); e.on('x', () => {}); e.emit('y')`)
  const v = verifyAnswerContract('write an event emitter class', leaky, T)
  check('name-blind emitter → violations (isolation)', v.status === 'violations' && v.defects.some(d => d.check === 'isolation'), v.reason)
}

// ═══════════════ memoize / debounce / throttle / functions ═══════════════════
console.log('== memoize / debounce / throttle ==')
{
  const memo = code(`function memoize(fn) {
  const cache = new Map()
  return function (...args) { const k = JSON.stringify(args); if (cache.has(k)) return cache.get(k); const v = fn(...args); cache.set(k, v); return v }
}
const slow = x => x * 2; const fast = memoize(slow); console.log(fast(2))`)
  check('correct memoize → certified', verifyAnswerContract('write a memoize function', memo, T).status === 'certified')
}
{
  const fakeMemo = code(`function memoize(fn) {
  return function (...args) { return fn(...args) }
}
const fast = memoize(x => x); console.log(fast(1))`)
  const v = verifyAnswerContract('write a memoize function', fakeMemo, T)
  check('pass-through "memoize" → violations (no caching)', v.status === 'violations' && v.defects.some(d => d.check === 'caching'), v.reason)
}
{
  const deb = code(`function debounce(fn, wait) {
  let t = null
  return function (...args) { if (t) clearTimeout(t); t = setTimeout(() => { t = null; fn(...args) }, wait) }
}
const d = debounce(() => {}, 100); d()`)
  check('correct trailing debounce → certified', verifyAnswerContract('implement a debounce function', deb, T).status === 'certified')
}
{
  const leadDeb = code(`function debounce(fn, wait) {
  let t = null
  return function (...args) { const callNow = !t; if (t) clearTimeout(t); t = setTimeout(() => { t = null }, wait); if (callNow) fn(...args) }
}
const d = debounce(() => {}, 100); d()`)
  check('leading-edge debounce → certified (convention accepted)', verifyAnswerContract('implement a debounce function', leadDeb, T).status === 'certified')
}
{
  const fakeDeb = code(`function debounce(fn, wait) {
  return function (...args) { fn(...args) }
}
const d = debounce(() => {}, 100); d()`)
  const v = verifyAnswerContract('implement a debounce function', fakeDeb, T)
  check('pass-through "debounce" → violations', v.status === 'violations' && v.defects.some(d => d.check === 'coalescing'), v.reason)
}
{
  const thr = code(`function throttle(fn, interval) {
  let last = 0
  return function (...args) { const now = Date.now(); if (now - last >= interval) { last = now; fn(...args) } }
}
const t = throttle(() => {}, 100); t()`)
  check('correct leading throttle → certified', verifyAnswerContract('implement a throttle function', thr, T).status === 'certified')
}
{
  const fakeThr = code(`function throttle(fn, interval) {
  return function (...args) { fn(...args) }
}
const t = throttle(() => {}, 100); t()`)
  const v = verifyAnswerContract('implement a throttle function', fakeThr, T)
  check('pass-through "throttle" → violations', v.status === 'violations' && v.defects.some(d => d.check === 'limiting'), v.reason)
}

console.log('== binary search / fizzbuzz / anagram / brackets / two-sum / deep clone / deep equal ==')
{
  const bs = code(`function binarySearch(arr, target) {
  let lo = 0, hi = arr.length - 1
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid] === target) return mid; if (arr[mid] < target) lo = mid + 1; else hi = mid - 1 }
  return -1
}
console.log(binarySearch([1, 2, 3], 2))`)
  check('correct binary search → certified', verifyAnswerContract('implement binary search', bs, T).status === 'certified')
}
{
  // Classic broken mid-update → misses elements (and can loop; termination check covers hangs).
  const badBs = code(`function binarySearch(arr, target) {
  let lo = 0, hi = arr.length - 1
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] === target) return mid; if (arr[mid] < target) lo = mid; else hi = mid }
  return -1
}
console.log(binarySearch([1, 2, 3], 2))`)
  const v = verifyAnswerContract('implement binary search', badBs, T)
  check('broken binary search → violations', v.status === 'violations', v.status + ': ' + v.reason)
}
{
  const fb = code(`function fizzbuzz(n) {
  if (n % 15 === 0) return 'FizzBuzz'
  if (n % 3 === 0) return 'Fizz'
  if (n % 5 === 0) return 'Buzz'
  return n
}
console.log(fizzbuzz(15))`)
  check('correct scalar fizzbuzz → certified', verifyAnswerContract('write fizzbuzz', fb, T).status === 'certified')
}
{
  const badFb = code(`function fizzbuzz(n) {
  if (n % 3 === 0) return 'Fizz'
  if (n % 5 === 0) return 'Buzz'
  if (n % 15 === 0) return 'FizzBuzz'
  return n
}
console.log(fizzbuzz(15))`)
  const v = verifyAnswerContract('write fizzbuzz', badFb, T)
  check('order-bug fizzbuzz (15 → "Fizz") → violations', v.status === 'violations', v.reason)
}
{
  const an = code(`function isAnagram(a, b) {
  if (a.length !== b.length) return false
  return [...a].sort().join('') === [...b].sort().join('')
}
console.log(isAnagram('listen', 'silent'))`)
  check('correct anagram → certified', verifyAnswerContract('check if two strings are anagrams', an, T).status === 'certified')
}
{
  const badAn = code(`function isAnagram(a, b) {
  return [...new Set(a)].sort().join('') === [...new Set(b)].sort().join('')
}
console.log(isAnagram('listen', 'silent'))`)
  const v = verifyAnswerContract('check if two strings are anagrams', badAn, T)
  check('set-based anagram (aab~abb) → violations', v.status === 'violations', v.reason)
}
{
  const br = code(`function isBalanced(s) {
  const stack = []; const pairs = { ')': '(', ']': '[', '}': '{' }
  for (const ch of s) { if (ch === '(' || ch === '[' || ch === '{') stack.push(ch); else if (pairs[ch]) { if (stack.pop() !== pairs[ch]) return false } }
  return stack.length === 0
}
console.log(isBalanced('()'))`)
  check('correct balanced brackets → certified', verifyAnswerContract('check for balanced brackets in a string', br, T).status === 'certified')
}
{
  const badBr = code(`function isBalanced(s) {
  let n = 0
  for (const ch of s) { if (ch === '(') n++; if (ch === ')') n-- }
  return n === 0
}
console.log(isBalanced('()'))`)
  const v = verifyAnswerContract('check for balanced parentheses', badBr, T)
  check('counter-only brackets (")(" passes) → violations', v.status === 'violations', v.reason)
}
{
  const ts2 = code(`function twoSum(nums, target) {
  const seen = new Map()
  for (let i = 0; i < nums.length; i++) { const need = target - nums[i]; if (seen.has(need)) return [seen.get(need), i]; seen.set(nums[i], i) }
  return []
}
console.log(twoSum([2, 7], 9))`)
  check('correct two-sum → certified', verifyAnswerContract('solve two sum', ts2, T).status === 'certified')
}
{
  const dc = code(`function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(deepClone)
  const out = {}
  for (const k of Object.keys(obj)) out[k] = deepClone(obj[k])
  return out
}
console.log(deepClone({ a: 1 }))`)
  check('correct deep clone → certified', verifyAnswerContract('write a deep clone function', dc, T).status === 'certified')
}
{
  const shallow = code(`function deepClone(obj) {
  return { ...obj }
}
console.log(deepClone({ a: 1 }))`)
  const v = verifyAnswerContract('write a deep clone function', shallow, T)
  check('shallow "deep clone" → violations', v.status === 'violations' && v.defects.some(d => d.check === 'deep independence'), v.reason)
}
{
  const de = code(`function deepEqual(a, b) {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  const ka = Object.keys(a), kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every(k => deepEqual(a[k], b[k]))
}
console.log(deepEqual({ a: 1 }, { a: 1 }))`)
  check('correct deep equal → certified', verifyAnswerContract('write a deep equal function', de, T).status === 'certified')
}

// ═══════════════ prong A: metamorphic + property families on the answer path ═════════
console.log('== metamorphic/property families reach the answer route ==')
{
  const desc = code(`function sortNumbers(arr) {
  return [...arr].sort((a, b) => b - a)
}
console.log(sortNumbers([3, 1, 2]))`)
  const v = verifyAnswerContract('write a function to sort an array of numbers in ascending order', desc, T)
  check('descending sort for an ascending ask → violations', v.status === 'violations', v.status + ': ' + v.reason)
  check('bound to the answer\'s own function name', v.entry === 'sortNumbers', v.entry)
}
{
  const asc = code(`function sortNumbers(arr) {
  return [...arr].sort((a, b) => a - b)
}
console.log(sortNumbers([3, 1, 2]))`)
  const v = verifyAnswerContract('write a function to sort an array of numbers in ascending order', asc, T)
  check('correct ascending sort → certified', v.status === 'certified', v.reason)
}
{
  const badPrime = code(`function isPrime(n) {
  if (n < 2) return false
  for (let d = 2; d * d < n; d++) if (n % d === 0) return false
  return true
}
console.log(isPrime(7))`)
  const v = verifyAnswerContract('write a function that checks whether a number is prime', badPrime, T)
  check('isPrime(9)=true bug → violations (property family)', v.status === 'violations', v.status + ': ' + v.reason)
}

// ═══════════════════════ detection guards + integration ══════════════════════
console.log('== detection guards / certifyAnswer integration / repair splice ==')
{
  check('"build a full-stack app" → no contract', detectContract('build me a full-stack app with react') === null)
  check('"message queue with rabbitmq" → no contract', detectContract('set up a message queue with rabbitmq') === null)
  check('"heap memory profiling" → no contract', detectContract('how do I debug heap memory allocation in node') === null)
  check('"call stack explanation" → no contract', detectContract('explain the call stack in javascript') === null)
  check('"binary search tree" → bst, not binary-search', detectContract('implement a binary search tree')?.kind === 'bst')
  check('"lodash debounce example" → debounce detected (judged only if impl present)', detectContract('lodash debounce example')?.kind === 'debounce')
}
{
  // A lodash USAGE example (imports) must be left to the library path — abstain here.
  const lodashUse = '```js\nconst debounce = require("lodash/debounce")\nconst d = debounce(() => {}, 100)\n```'
  const v = verifyAnswerContract('lodash debounce example', lodashUse, T)
  check('library-usage answer → abstain (library path judges)', v.status === 'abstain', v.status)
}
{
  // certifyAnswer single-oracle integration: question threads the contract tier in.
  const brokenPop = code(`class LinkedList {
  constructor() { this.head = null }
  append(v) { const n = { value: v, next: null }; if (!this.head) { this.head = n } else { let c = this.head; while (c.next) c = c.next; c.next = n } }
  pop() { if (!this.head) return undefined; let c = this.head; while (c.next) c = c.next; return c.value }
  toArray() { const out = []; let c = this.head; while (c) { out.push(c.value); c = c.next } return out }
}
const l = new LinkedList(); l.append(1); l.pop(); console.log(l.toArray())`)
  const withQ = certifyAnswer(brokenPop, '', { question: 'implement a linked list with append and pop', timeoutMs: 1500 })
  check('certifyAnswer + question: broken logic → violations, executed', withQ.status === 'violations' && withQ.executed === true, withQ.status + '/' + String(withQ.executed))
  const withoutQ = certifyAnswer(brokenPop, '', { timeoutMs: 1500 })
  check('certifyAnswer without question: unchanged (no contract tier)', withoutQ.status !== 'violations', withoutQ.status)
}
{
  // NODE-BUILTIN LAUNDERING (cont.93). Wrapping the SAME broken-pop logic around a pure builtin
  // import (`events`) previously dodged the tier (any import → abstain). The builtin now resolves,
  // so the contract battery probes the LIFO/drain invariant exactly as for the un-imported class.
  const launderedPop = code(`import { EventEmitter } from 'events';
class LinkedList extends EventEmitter {
  constructor() { super(); this.head = null }
  append(v) { const n = { value: v, next: null }; if (!this.head) { this.head = n } else { let c = this.head; while (c.next) c = c.next; c.next = n } this.emit('append', v); return this }
  pop() { if (!this.head) return undefined; let c = this.head; while (c.next) c = c.next; return c.value }
  toArray() { const out = []; let c = this.head; while (c) { out.push(c.value); c = c.next } return out }
}
const l = new LinkedList(); l.append(1); l.append(2); l.pop(); console.log(l.toArray())`)
  const v = verifyAnswerContract('implement a linked list with append and pop', launderedPop, T)
  check('laundered behind `events` import → violations (not abstain)', v.status === 'violations', v.status + ': ' + v.reason)
}
{
  // FALSE-REJECT GUARD. A third-party import still defers to the library path — abstain, not judge.
  const thirdParty = code(`import { EventEmitter } from 'events';
import _ from 'lodash';
class LinkedList extends EventEmitter { constructor() { super(); this.items = _.uniq([]) } }
const l = new LinkedList()`)
  const v = verifyAnswerContract('implement a linked list with append and pop', thirdParty, T)
  check('safe builtin + third-party → abstain (defers to library path)', v.status === 'abstain', v.status)
}
{
  const orig = 'Here is the implementation:\n\n```ts\nconst broken = 1\n```\n\nAnd usage:\n\n```ts\nconsole.log(broken)\n```\n\nDone.'
  const out = replaceAnswerCodeBlocks(orig, 'const fixed = 2')
  check('replaceAnswerCodeBlocks: first block replaced', out.includes('const fixed = 2'))
  check('replaceAnswerCodeBlocks: later blocks dropped', !out.includes('console.log(broken)'))
  check('replaceAnswerCodeBlocks: prose preserved', out.includes('Here is the implementation:') && out.includes('Done.'))
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
