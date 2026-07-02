import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url'
const HERE = path.dirname(fileURLToPath(import.meta.url))
interface Entry { id: string; filename: string; summary: string; defaultPath: string; exports: string[]; patterns: { re: string; weight: number }[]; impl: string; tests: { desc: string; call: string; want: string }[] }

const entries: Entry[] = [
  {
    id: 'priority-queue-min', filename: 'priorityQueueMin',
    summary: 'PriorityQueue is a binary min-heap with push, pop (lowest priority first), peek, size, and isEmpty.',
    defaultPath: 'src/priorityQueueMin.ts', exports: ['PriorityQueue'],
    patterns: [{ re: '\\bPriorityQueue\\b', weight: 0.6 }, { re: 'priority queue|min.?heap', weight: 0.3 }],
    impl: `export class PriorityQueue<T> {
  private h: { item: T; p: number }[] = []
  size(): number { return this.h.length }
  isEmpty(): boolean { return this.h.length === 0 }
  peek(): T | undefined { return this.h[0]?.item }
  push(item: T, p: number): void {
    this.h.push({ item, p })
    let i = this.h.length - 1
    while (i > 0) { const par = (i - 1) >> 1; if (this.h[par].p <= this.h[i].p) break;[this.h[par], this.h[i]] = [this.h[i], this.h[par]]; i = par }
  }
  pop(): T | undefined {
    if (!this.h.length) return undefined
    const top = this.h[0].item, last = this.h.pop()!
    if (this.h.length) {
      this.h[0] = last; let i = 0; const n = this.h.length
      while (true) { let s = i; const l = 2 * i + 1, r = 2 * i + 2; if (l < n && this.h[l].p < this.h[s].p) s = l; if (r < n && this.h[r].p < this.h[s].p) s = r; if (s === i) break;[this.h[s], this.h[i]] = [this.h[i], this.h[s]]; i = s }
    }
    return top
  }
}`,
    tests: [
      { desc: 'lowest first', call: '(() => { const q = new PriorityQueue<string>(); q.push("a",3); q.push("b",1); q.push("c",2); return q.pop() })()', want: '"b"' },
      { desc: 'full order', call: '(() => { const q = new PriorityQueue<number>(); [5,1,4,2,3].forEach(n=>q.push(n,n)); return [q.pop(),q.pop(),q.pop()] })()', want: '[1,2,3]' },
      { desc: 'peek', call: '(() => { const q = new PriorityQueue<number>(); q.push(9,9); q.push(1,1); return q.peek() })()', want: '1' },
      { desc: 'size', call: '(() => { const q = new PriorityQueue<number>(); q.push(1,1); q.push(2,2); return q.size() })()', want: '2' },
      { desc: 'empty pop', call: 'new PriorityQueue().pop()', want: 'undefined' },
      { desc: 'isEmpty', call: 'new PriorityQueue().isEmpty()', want: 'true' },
      { desc: 'peek does not remove', call: '(() => { const q = new PriorityQueue<number>(); q.push(1,1); q.peek(); return q.size() })()', want: '1' },
    ],
  },
  {
    id: 'circular-buffer', filename: 'circularBuffer',
    summary: 'CircularBuffer is a fixed-capacity ring buffer that overwrites the oldest item when full; toArray returns oldest first.',
    defaultPath: 'src/circularBuffer.ts', exports: ['CircularBuffer'],
    patterns: [{ re: '\\bCircularBuffer\\b', weight: 0.6 }, { re: 'circular buffer|ring buffer', weight: 0.3 }],
    impl: `export class CircularBuffer<T> {
  private buf: T[] = []
  private start = 0
  constructor(private capacity: number) {}
  push(item: T): void {
    if (this.buf.length < this.capacity) this.buf.push(item)
    else { this.buf[this.start] = item; this.start = (this.start + 1) % this.capacity }
  }
  size(): number { return this.buf.length }
  isFull(): boolean { return this.buf.length === this.capacity }
  toArray(): T[] {
    const out: T[] = []
    for (let i = 0; i < this.buf.length; i++) out.push(this.buf[(this.start + i) % this.buf.length])
    return out
  }
}`,
    tests: [
      { desc: 'within cap', call: '(() => { const b = new CircularBuffer<number>(3); b.push(1); b.push(2); return b.toArray() })()', want: '[1,2]' },
      { desc: 'overwrite oldest', call: '(() => { const b = new CircularBuffer<number>(3); [1,2,3,4].forEach(n=>b.push(n)); return b.toArray() })()', want: '[2,3,4]' },
      { desc: 'overwrite two', call: '(() => { const b = new CircularBuffer<number>(2); [1,2,3,4,5].forEach(n=>b.push(n)); return b.toArray() })()', want: '[4,5]' },
      { desc: 'isFull true', call: '(() => { const b = new CircularBuffer<number>(2); b.push(1); b.push(2); return b.isFull() })()', want: 'true' },
      { desc: 'isFull false', call: '(() => { const b = new CircularBuffer<number>(2); b.push(1); return b.isFull() })()', want: 'false' },
      { desc: 'size capped', call: '(() => { const b = new CircularBuffer<number>(2); [1,2,3].forEach(n=>b.push(n)); return b.size() })()', want: '2' },
    ],
  },
  {
    id: 'counter-frequency', filename: 'counterFrequency',
    summary: 'Counter tallies item frequencies with add, count, total, and mostCommon (descending by count).',
    defaultPath: 'src/counterFrequency.ts', exports: ['Counter'],
    patterns: [{ re: '\\bCounter\\b', weight: 0.6 }, { re: 'frequency.*count|count.*frequency|most common', weight: 0.3 }],
    impl: `export class Counter<T> {
  private m = new Map<T, number>()
  add(item: T): void { this.m.set(item, (this.m.get(item) ?? 0) + 1) }
  count(item: T): number { return this.m.get(item) ?? 0 }
  total(): number { let t = 0; for (const v of this.m.values()) t += v; return t }
  mostCommon(n: number): [T, number][] {
    return [...this.m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
  }
}`,
    tests: [
      { desc: 'count', call: '(() => { const c = new Counter<string>(); c.add("a"); c.add("a"); c.add("b"); return c.count("a") })()', want: '2' },
      { desc: 'missing count', call: 'new Counter<string>().count("x")', want: '0' },
      { desc: 'total', call: '(() => { const c = new Counter<string>(); c.add("a"); c.add("b"); c.add("a"); return c.total() })()', want: '3' },
      { desc: 'mostCommon top', call: '(() => { const c = new Counter<string>(); ["a","a","a","b","b","c"].forEach(x=>c.add(x)); return c.mostCommon(1) })()', want: '[["a",3]]' },
      { desc: 'mostCommon two', call: '(() => { const c = new Counter<string>(); ["a","a","b","b","b","c"].forEach(x=>c.add(x)); return c.mostCommon(2) })()', want: '[["b",3],["a",2]]' },
      { desc: 'empty mostCommon', call: 'new Counter<string>().mostCommon(3)', want: '[]' },
    ],
  },
  {
    id: 'ordered-set', filename: 'orderedSet',
    summary: 'OrderedSet stores unique values in insertion order with add, has, delete, values, and size.',
    defaultPath: 'src/orderedSet.ts', exports: ['OrderedSet'],
    patterns: [{ re: '\\bOrderedSet\\b', weight: 0.6 }, { re: 'ordered set|insertion order.*unique', weight: 0.3 }],
    impl: `export class OrderedSet<T> {
  private s = new Set<T>()
  add(item: T): void { this.s.add(item) }
  has(item: T): boolean { return this.s.has(item) }
  delete(item: T): boolean { return this.s.delete(item) }
  values(): T[] { return [...this.s] }
  size(): number { return this.s.size }
}`,
    tests: [
      { desc: 'unique values', call: '(() => { const s = new OrderedSet<number>(); [1,2,1,3,2].forEach(x=>s.add(x)); return s.values() })()', want: '[1,2,3]' },
      { desc: 'has', call: '(() => { const s = new OrderedSet<number>(); s.add(5); return s.has(5) })()', want: 'true' },
      { desc: 'delete', call: '(() => { const s = new OrderedSet<number>(); s.add(1); s.delete(1); return s.has(1) })()', want: 'false' },
      { desc: 'size', call: '(() => { const s = new OrderedSet<number>(); s.add(1); s.add(2); s.add(1); return s.size() })()', want: '2' },
      { desc: 'insertion order kept', call: '(() => { const s = new OrderedSet<string>(); ["c","a","b"].forEach(x=>s.add(x)); return s.values() })()', want: '["c","a","b"]' },
      { desc: 'delete missing', call: 'new OrderedSet<number>().delete(9)', want: 'false' },
    ],
  },
  {
    id: 'sorted-insert', filename: 'sortedInsertNum',
    summary: 'sortedInsert inserts a value into a sorted ascending array via binary search, returning a new sorted array.',
    defaultPath: 'src/sortedInsertNum.ts', exports: ['sortedInsert'],
    patterns: [{ re: '\\bsortedInsert\\b', weight: 0.6 }, { re: 'sorted insert|insert.*sorted', weight: 0.3 }],
    impl: `export function sortedInsert(arr: number[], val: number): number[] {
  let lo = 0, hi = arr.length
  while (lo < hi) { const mid = (lo + hi) >> 1; arr[mid] < val ? lo = mid + 1 : hi = mid }
  return [...arr.slice(0, lo), val, ...arr.slice(lo)]
}`,
    tests: [
      { desc: 'middle', call: 'sortedInsert([1,3,5], 4)', want: '[1,3,4,5]' },
      { desc: 'front', call: 'sortedInsert([2,3,4], 1)', want: '[1,2,3,4]' },
      { desc: 'back', call: 'sortedInsert([1,2,3], 9)', want: '[1,2,3,9]' },
      { desc: 'empty', call: 'sortedInsert([], 5)', want: '[5]' },
      { desc: 'duplicate', call: 'sortedInsert([1,2,2,3], 2)', want: '[1,2,2,2,3]' },
      { desc: 'no mutate', call: '(() => { const a=[1,3]; sortedInsert(a,2); return a })()', want: '[1,3]' },
    ],
  },
  {
    id: 'lfu-cache', filename: 'lfuCache',
    summary: 'LFUCache evicts the least-frequently-used entry (ties broken least-recently-used) when capacity is exceeded.',
    defaultPath: 'src/lfuCache.ts', exports: ['LFUCache'],
    patterns: [{ re: '\\bLFUCache\\b', weight: 0.6 }, { re: 'least.?frequently.?used|lfu cache', weight: 0.3 }],
    impl: `export class LFUCache<K, V> {
  private vals = new Map<K, V>(); private freq = new Map<K, number>(); private order = new Map<K, number>(); private tick = 0
  constructor(private cap: number) {}
  get(k: K): V | undefined {
    if (!this.vals.has(k)) return undefined
    this.freq.set(k, (this.freq.get(k) ?? 0) + 1); this.order.set(k, this.tick++)
    return this.vals.get(k)
  }
  put(k: K, v: V): void {
    if (this.cap <= 0) return
    if (this.vals.has(k)) { this.vals.set(k, v); this.freq.set(k, (this.freq.get(k) ?? 0) + 1); this.order.set(k, this.tick++); return }
    if (this.vals.size >= this.cap) {
      let evict: K | undefined, bf = Infinity, bo = Infinity
      for (const key of this.vals.keys()) { const f = this.freq.get(key) ?? 0, o = this.order.get(key) ?? 0; if (f < bf || (f === bf && o < bo)) { bf = f; bo = o; evict = key } }
      if (evict !== undefined) { this.vals.delete(evict); this.freq.delete(evict); this.order.delete(evict) }
    }
    this.vals.set(k, v); this.freq.set(k, 1); this.order.set(k, this.tick++)
  }
}`,
    tests: [
      { desc: 'evicts LFU', call: '(() => { const c = new LFUCache<string,number>(2); c.put("a",1); c.put("b",2); c.get("a"); c.put("c",3); return c.get("b") })()', want: 'undefined' },
      { desc: 'keeps frequent', call: '(() => { const c = new LFUCache<string,number>(2); c.put("a",1); c.put("b",2); c.get("a"); c.put("c",3); return c.get("a") })()', want: '1' },
      { desc: 'new entry present', call: '(() => { const c = new LFUCache<string,number>(2); c.put("a",1); c.put("b",2); c.get("a"); c.put("c",3); return c.get("c") })()', want: '3' },
      { desc: 'get missing', call: 'new LFUCache<string,number>(2).get("x")', want: 'undefined' },
      { desc: 'update value', call: '(() => { const c = new LFUCache<string,number>(2); c.put("a",1); c.put("a",9); return c.get("a") })()', want: '9' },
      { desc: 'zero cap', call: '(() => { const c = new LFUCache<string,number>(0); c.put("a",1); return c.get("a") })()', want: 'undefined' },
    ],
  },
  {
    id: 'deque-structure', filename: 'dequeStructure',
    summary: 'Deque is a double-ended queue with pushFront, pushBack, popFront, popBack, size, and toArray.',
    defaultPath: 'src/dequeStructure.ts', exports: ['Deque'],
    patterns: [{ re: '\\bDeque\\b', weight: 0.6 }, { re: 'double.?ended queue|deque', weight: 0.3 }],
    impl: `export class Deque<T> {
  private items: T[] = []
  pushFront(item: T): void { this.items.unshift(item) }
  pushBack(item: T): void { this.items.push(item) }
  popFront(): T | undefined { return this.items.shift() }
  popBack(): T | undefined { return this.items.pop() }
  size(): number { return this.items.length }
  toArray(): T[] { return [...this.items] }
}`,
    tests: [
      { desc: 'pushBack order', call: '(() => { const d = new Deque<number>(); d.pushBack(1); d.pushBack(2); return d.toArray() })()', want: '[1,2]' },
      { desc: 'pushFront order', call: '(() => { const d = new Deque<number>(); d.pushBack(2); d.pushFront(1); return d.toArray() })()', want: '[1,2]' },
      { desc: 'popFront', call: '(() => { const d = new Deque<number>(); [1,2,3].forEach(n=>d.pushBack(n)); return d.popFront() })()', want: '1' },
      { desc: 'popBack', call: '(() => { const d = new Deque<number>(); [1,2,3].forEach(n=>d.pushBack(n)); return d.popBack() })()', want: '3' },
      { desc: 'size', call: '(() => { const d = new Deque<number>(); d.pushBack(1); d.pushFront(0); return d.size() })()', want: '2' },
      { desc: 'popFront empty', call: 'new Deque().popFront()', want: 'undefined' },
    ],
  },
  {
    id: 'interval-set', filename: 'intervalSet',
    summary: 'IntervalSet maintains merged numeric intervals with add (merging overlaps), contains, and list (sorted).',
    defaultPath: 'src/intervalSet.ts', exports: ['IntervalSet'],
    patterns: [{ re: '\\bIntervalSet\\b', weight: 0.6 }, { re: 'interval.*merg|merg.*interval', weight: 0.3 }],
    impl: `export class IntervalSet {
  private iv: [number, number][] = []
  add(s: number, e: number): void {
    if (s > e) { const t = s; s = e; e = t }
    this.iv.push([s, e]); this.iv.sort((a, b) => a[0] - b[0])
    const m: [number, number][] = []
    for (const [a, b] of this.iv) {
      if (m.length && a <= m[m.length - 1][1]) m[m.length - 1][1] = Math.max(m[m.length - 1][1], b)
      else m.push([a, b])
    }
    this.iv = m
  }
  contains(x: number): boolean { return this.iv.some(([a, b]) => x >= a && x <= b) }
  list(): [number, number][] { return this.iv.map(([a, b]) => [a, b]) }
}`,
    tests: [
      { desc: 'merge overlap', call: '(() => { const s = new IntervalSet(); s.add(1,3); s.add(2,4); return s.list() })()', want: '[[1,4]]' },
      { desc: 'disjoint', call: '(() => { const s = new IntervalSet(); s.add(1,3); s.add(5,7); return s.list() })()', want: '[[1,3],[5,7]]' },
      { desc: 'merge all', call: '(() => { const s = new IntervalSet(); s.add(1,3); s.add(5,7); s.add(2,6); return s.list() })()', want: '[[1,7]]' },
      { desc: 'contains inside', call: '(() => { const s = new IntervalSet(); s.add(1,5); return s.contains(3) })()', want: 'true' },
      { desc: 'contains outside', call: '(() => { const s = new IntervalSet(); s.add(1,5); return s.contains(9) })()', want: 'false' },
      { desc: 'adjacent merge', call: '(() => { const s = new IntervalSet(); s.add(1,4); s.add(4,7); return s.list() })()', want: '[[1,7]]' },
      { desc: 'reversed input', call: '(() => { const s = new IntervalSet(); s.add(5,2); return s.list() })()', want: '[[2,5]]' },
    ],
  },
]
const out = path.join(HERE, 'collectionsB.json'); fs.writeFileSync(out, JSON.stringify(entries, null, 2)); console.log(`wrote ${entries.length} → ${out}`)
