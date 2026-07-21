// Extended coding-bench corpus — data-structures shard (W42). See tasks-strings.ts for
// the corpus rules (catalog-free, ref+suite are bench-side ground truth, no backticks or
// dollar-brace inside embedded code).

import type { ExtTask } from './tasks-strings'

const CONTRACT =
  'Build the COMPLETE, production-quality implementation — no placeholders, no TODOs, no stub bodies. ' +
  'You MUST create the exact file path and export the exact API named below (an automated audit imports it verbatim). ' +
  'Verify it actually runs before reporting done.'

export const STRUCTURE_TASKS: ExtTask[] = [
  {
    id: 'intervalMerge',
    title: 'Merge overlapping and adjacent integer intervals',
    modulePath: 'src/intervalMerge.ts',
    prompt: `Implement interval merging in TypeScript at src/intervalMerge.ts. ${CONTRACT}

Export exactly:
  export function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]>

Semantics:
- Each interval is [start, end] with start <= end, endpoints inclusive.
- Input may be unsorted. Output is sorted by start, and contains the minimal set of
  disjoint intervals covering exactly the same points.
- Overlapping intervals merge; ADJACENT intervals ([1,2] and [3,4]) also merge, because
  with inclusive integer endpoints there is no gap between them. [1,2] and [4,5] do not.
- The input array and its tuples must not be mutated. Empty input returns [].
- Error contract: any interval with end < start throws a RangeError.`,
    ref: `export function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  for (const [s, e] of intervals) {
    if (e < s) throw new RangeError('interval end before start')
  }
  const sorted = intervals.map(iv => [iv[0], iv[1]] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out: Array<[number, number]> = []
  for (const [s, e] of sorted) {
    const last = out[out.length - 1]
    if (last && s <= last[1] + 1) {
      if (e > last[1]) last[1] = e
    } else {
      out.push([s, e])
    }
  }
  return out
}
`,
    suite: `// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — intervalMerge.
// Run: npx tsx __audit__/intervalMerge.hidden.ts   (imports ../src/intervalMerge)
import { mergeIntervals } from '../src/intervalMerge'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}
const eq = (a: Array<[number, number]>, b: Array<[number, number]>): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

check('disjoint stay disjoint', eq(mergeIntervals([[1, 2], [5, 6]]), [[1, 2], [5, 6]]))
check('overlap merges', eq(mergeIntervals([[1, 4], [3, 6]]), [[1, 6]]))
check('adjacent integers merge', eq(mergeIntervals([[1, 2], [3, 4]]), [[1, 4]]))
check('gap of one does not merge', eq(mergeIntervals([[1, 2], [4, 5]]), [[1, 2], [4, 5]]))
check('unsorted input handled', eq(mergeIntervals([[5, 6], [1, 2], [2, 4]]), [[1, 6]]))
check('containment collapses', eq(mergeIntervals([[1, 10], [2, 3]]), [[1, 10]]))
check('duplicate intervals', eq(mergeIntervals([[1, 2], [1, 2]]), [[1, 2]]))
check('point intervals', eq(mergeIntervals([[3, 3], [1, 1], [2, 2]]), [[1, 3]]))
check('negative coordinates', eq(mergeIntervals([[-5, -3], [-4, 0]]), [[-5, 0]]))
check('empty input', eq(mergeIntervals([]), []))
const input: Array<[number, number]> = [[3, 4], [1, 2]]
mergeIntervals(input)
check('input array not mutated', input[0][0] === 3 && input[1][0] === 1)
let threw = false
try { mergeIntervals([[2, 1]]) } catch (e) { threw = e instanceof RangeError }
check('inverted interval throws RangeError', threw)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`,
  },

  {
    id: 'intervalSubtract',
    title: 'Subtract one set of intervals from another',
    modulePath: 'src/intervalSubtract.ts',
    prompt: `Implement interval subtraction in TypeScript at src/intervalSubtract.ts. ${CONTRACT}

Export exactly:
  export function subtractIntervals(
    base: Array<[number, number]>,
    remove: Array<[number, number]>,
  ): Array<[number, number]>

Semantics:
- Intervals are [start, end], start <= end, inclusive INTEGER endpoints.
- Result covers exactly the integer points covered by base but not by remove, as a minimal
  sorted list of disjoint intervals.
- Both inputs may be unsorted and may contain overlapping intervals themselves.
- Neither input is mutated. Removing everything (or an empty base) yields [].
- Error contract: any interval with end < start throws a RangeError.`,
    ref: `function normalize(list: Array<[number, number]>): Array<[number, number]> {
  for (const [s, e] of list) {
    if (e < s) throw new RangeError('interval end before start')
  }
  const sorted = list.map(iv => [iv[0], iv[1]] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out: Array<[number, number]> = []
  for (const [s, e] of sorted) {
    const last = out[out.length - 1]
    if (last && s <= last[1] + 1) { if (e > last[1]) last[1] = e }
    else out.push([s, e])
  }
  return out
}

export function subtractIntervals(
  base: Array<[number, number]>,
  remove: Array<[number, number]>,
): Array<[number, number]> {
  const b = normalize(base)
  const r = normalize(remove)
  const out: Array<[number, number]> = []
  let ri = 0
  for (const [bs, be] of b) {
    let cur = bs
    while (ri < r.length && r[ri][1] < cur) ri++
    let i = ri
    while (i < r.length && r[i][0] <= be) {
      const [rs, re] = r[i]
      if (rs > cur) out.push([cur, Math.min(be, rs - 1)])
      cur = Math.max(cur, re + 1)
      if (cur > be) break
      i++
    }
    if (cur <= be) out.push([cur, be])
  }
  return out
}
`,
    suite: `// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — intervalSubtract.
// Run: npx tsx __audit__/intervalSubtract.hidden.ts   (imports ../src/intervalSubtract)
import { subtractIntervals } from '../src/intervalSubtract'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}
const eq = (a: Array<[number, number]>, b: Array<[number, number]>): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

check('no removal returns base', eq(subtractIntervals([[1, 5]], []), [[1, 5]]))
check('hole in the middle', eq(subtractIntervals([[1, 10]], [[4, 6]]), [[1, 3], [7, 10]]))
check('trim left edge', eq(subtractIntervals([[1, 10]], [[1, 3]]), [[4, 10]]))
check('trim right edge', eq(subtractIntervals([[1, 10]], [[8, 10]]), [[1, 7]]))
check('full cover removes interval', eq(subtractIntervals([[2, 4]], [[1, 5]]), []))
check('exact cover removes interval', eq(subtractIntervals([[2, 4]], [[2, 4]]), []))
check('single point removed', eq(subtractIntervals([[1, 3]], [[2, 2]]), [[1, 1], [3, 3]]))
check('multiple holes', eq(subtractIntervals([[1, 10]], [[2, 3], [5, 6]]), [[1, 1], [4, 4], [7, 10]]))
check('removal spanning two bases', eq(subtractIntervals([[1, 3], [6, 9]], [[2, 7]]), [[1, 1], [8, 9]]))
check('disjoint removal ignored', eq(subtractIntervals([[1, 3]], [[10, 20]]), [[1, 3]]))
check('unsorted overlapping inputs', eq(subtractIntervals([[6, 9], [1, 3]], [[7, 8], [2, 2]]), [[1, 1], [3, 3], [6, 6], [9, 9]]))
check('empty base', eq(subtractIntervals([], [[1, 2]]), []))
check('negative coordinates', eq(subtractIntervals([[-10, -1]], [[-5, -3]]), [[-10, -6], [-2, -1]]))
let threw = false
try { subtractIntervals([[1, 2]], [[5, 4]]) } catch (e) { threw = e instanceof RangeError }
check('inverted remove interval throws', threw)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`,
  },

  {
    id: 'ringBuffer',
    title: 'Fixed-capacity ring buffer that overwrites oldest',
    modulePath: 'src/ringBuffer.ts',
    prompt: `Implement a ring buffer in TypeScript at src/ringBuffer.ts. ${CONTRACT}

Export exactly:
  export class RingBuffer<T> {
    constructor(capacity: number)
    push(item: T): void
    pop(): T            // removes and returns the OLDEST item
    peek(): T           // returns the oldest without removing
    toArray(): T[]      // oldest -> newest, does not modify the buffer
    get size(): number
    get capacity(): number
  }

Semantics:
- push on a full buffer overwrites the oldest item (size stays at capacity).
- pop and peek on an empty buffer throw an Error.
- toArray returns a fresh array each call.
- Error contract: constructor throws a RangeError unless capacity is an integer >= 1.`,
    ref: `export class RingBuffer<T> {
  private buf: T[]
  private head = 0
  private count = 0
  private readonly cap: number

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be an integer >= 1')
    this.cap = capacity
    this.buf = new Array<T>(capacity)
  }

  push(item: T): void {
    const idx = (this.head + this.count) % this.cap
    this.buf[idx] = item
    if (this.count < this.cap) this.count += 1
    else this.head = (this.head + 1) % this.cap
  }

  pop(): T {
    if (this.count === 0) throw new Error('empty')
    const item = this.buf[this.head]
    this.head = (this.head + 1) % this.cap
    this.count -= 1
    return item
  }

  peek(): T {
    if (this.count === 0) throw new Error('empty')
    return this.buf[this.head]
  }

  toArray(): T[] {
    const out: T[] = []
    for (let i = 0; i < this.count; i++) out.push(this.buf[(this.head + i) % this.cap])
    return out
  }

  get size(): number { return this.count }
  get capacity(): number { return this.cap }
}
`,
    suite: `// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — ringBuffer.
// Run: npx tsx __audit__/ringBuffer.hidden.ts   (imports ../src/ringBuffer)
import { RingBuffer } from '../src/ringBuffer'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

const rb = new RingBuffer<number>(3)
check('starts empty', rb.size === 0 && rb.capacity === 3)
rb.push(1); rb.push(2)
check('size tracks pushes', rb.size === 2)
check('peek is oldest', rb.peek() === 1)
check('toArray oldest to newest', rb.toArray().join(',') === '1,2')
rb.push(3); rb.push(4)
check('overwrite drops oldest', rb.toArray().join(',') === '2,3,4')
check('size capped at capacity', rb.size === 3)
check('pop returns oldest after wrap', rb.pop() === 2)
check('pop shrinks size', rb.size === 2)
rb.push(5); rb.push(6)
check('interleaved push/pop order', rb.toArray().join(',') === '4,5,6')
check('toArray is a fresh array', (() => { const a = rb.toArray(); a.push(99); return rb.toArray().length === 3 })())
const one = new RingBuffer<string>(1)
one.push('a'); one.push('b')
check('capacity one always keeps newest', one.peek() === 'b')
let threwEmpty = false
try { new RingBuffer<number>(2).pop() } catch { threwEmpty = true }
check('pop on empty throws', threwEmpty)
let threwPeek = false
try { new RingBuffer<number>(2).peek() } catch { threwPeek = true }
check('peek on empty throws', threwPeek)
let threwCap = false
try { new RingBuffer<number>(0) } catch (e) { threwCap = e instanceof RangeError }
check('zero capacity throws RangeError', threwCap)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`,
  },

  {
    id: 'minStack',
    title: 'Stack with O(1) minimum tracking',
    modulePath: 'src/minStack.ts',
    prompt: `Implement a min-tracking stack in TypeScript at src/minStack.ts. ${CONTRACT}

Export exactly:
  export class MinStack {
    push(value: number): void
    pop(): number
    top(): number
    min(): number
    get size(): number
  }

Semantics:
- Standard LIFO stack of numbers; min() returns the smallest value currently on the stack.
- All five operations run in O(1) — in particular min() must NOT scan the stack. The audit
  includes a large-input check that will time out a linear-scan min under the harness cap.
- Duplicates of the minimum are handled: pushing the same minimum twice and popping one
  must keep min() at that value.
- Error contract: pop, top, and min on an empty stack throw an Error.`,
    ref: `export class MinStack {
  private values: number[] = []
  private mins: number[] = []

  push(value: number): void {
    this.values.push(value)
    const m = this.mins.length === 0 ? value : Math.min(value, this.mins[this.mins.length - 1])
    this.mins.push(m)
  }

  pop(): number {
    if (this.values.length === 0) throw new Error('empty')
    this.mins.pop()
    return this.values.pop() as number
  }

  top(): number {
    if (this.values.length === 0) throw new Error('empty')
    return this.values[this.values.length - 1]
  }

  min(): number {
    if (this.mins.length === 0) throw new Error('empty')
    return this.mins[this.mins.length - 1]
  }

  get size(): number { return this.values.length }
}
`,
    suite: `// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — minStack.
// Run: npx tsx __audit__/minStack.hidden.ts   (imports ../src/minStack)
import { MinStack } from '../src/minStack'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

const s = new MinStack()
s.push(5); s.push(3); s.push(7)
check('top is last pushed', s.top() === 7)
check('min through stack', s.min() === 3)
check('pop returns last', s.pop() === 7)
check('min unchanged after popping non-min', s.min() === 3)
s.pop()
check('min recovers after popping the min', s.min() === 5)
s.push(5); s.push(5)
check('duplicate minimum both counted', s.min() === 5)
s.pop()
check('one duplicate popped, min stays', s.min() === 5)
check('size tracks', s.size === 2)
const neg = new MinStack()
neg.push(-1); neg.push(-10)
check('negative values', neg.min() === -10)
neg.pop()
check('negative min recovers', neg.min() === -1)
const big = new MinStack()
for (let i = 0; i < 200000; i++) big.push((i * 7919) % 100000)
let sink = 0
for (let i = 0; i < 200000; i++) { sink += big.min(); big.pop() }
check('large interleaved min/pop completes (O(1) min)', sink !== -1 && big.size === 0)
let threw = false
try { new MinStack().pop() } catch { threw = true }
check('pop empty throws', threw)
let threwMin = false
try { new MinStack().min() } catch { threwMin = true }
check('min empty throws', threwMin)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`,
  },

  {
    id: 'bitsetRange',
    title: 'Fixed-size bitset over Uint32Array with range popcount',
    modulePath: 'src/bitsetRange.ts',
    prompt: `Implement a bitset in TypeScript at src/bitsetRange.ts. ${CONTRACT}

Export exactly:
  export class BitSet {
    constructor(size: number)         // bits 0..size-1, all initially 0
    set(i: number): void
    clear(i: number): void
    get(i: number): boolean
    countRange(start: number, end: number): number  // set bits with start <= index < end
    get size(): number
  }

Semantics:
- Backed by a Uint32Array (one bit per position, 32 positions per word) — the audit
  includes a size that makes a boolean-array-per-bit implementation acceptable, but
  countRange over a large range must complete under the harness cap.
- countRange with start >= end returns 0.
- Error contract: constructor throws a RangeError unless size is an integer >= 1; set,
  clear, and get throw a RangeError for indexes outside 0..size-1; countRange throws a
  RangeError if start or end lies outside 0..size.`,
    ref: `export class BitSet {
  private words: Uint32Array
  private readonly n: number

  constructor(size: number) {
    if (!Number.isInteger(size) || size < 1) throw new RangeError('size must be an integer >= 1')
    this.n = size
    this.words = new Uint32Array(Math.ceil(size / 32))
  }

  private checkIndex(i: number): void {
    if (!Number.isInteger(i) || i < 0 || i >= this.n) throw new RangeError('index out of range')
  }

  set(i: number): void { this.checkIndex(i); this.words[i >>> 5] |= (1 << (i & 31)) }
  clear(i: number): void { this.checkIndex(i); this.words[i >>> 5] &= ~(1 << (i & 31)) }
  get(i: number): boolean { this.checkIndex(i); return (this.words[i >>> 5] & (1 << (i & 31))) !== 0 }

  countRange(start: number, end: number): number {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > this.n) {
      throw new RangeError('range out of bounds')
    }
    if (start >= end) return 0
    let count = 0
    for (let i = start; i < end; ) {
      if ((i & 31) === 0 && i + 32 <= end) {
        let w = this.words[i >>> 5]
        w = w - ((w >>> 1) & 0x55555555)
        w = (w & 0x33333333) + ((w >>> 2) & 0x33333333)
        count += (((w + (w >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
        i += 32
      } else {
        if ((this.words[i >>> 5] & (1 << (i & 31))) !== 0) count += 1
        i += 1
      }
    }
    return count
  }

  get size(): number { return this.n }
}
`,
    suite: `// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — bitsetRange.
// Run: npx tsx __audit__/bitsetRange.hidden.ts   (imports ../src/bitsetRange)
import { BitSet } from '../src/bitsetRange'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

const b = new BitSet(100)
check('starts clear', b.get(0) === false && b.countRange(0, 100) === 0)
b.set(0); b.set(31); b.set(32); b.set(99)
check('set/get across word boundary', b.get(31) && b.get(32) && b.get(0) && b.get(99))
check('unset stays false', b.get(50) === false)
check('full-range count', b.countRange(0, 100) === 4)
check('subrange excludes end', b.countRange(0, 99) === 3)
check('subrange includes start', b.countRange(32, 100) === 2)
check('interior empty range', b.countRange(40, 60) === 0)
check('start equals end is zero', b.countRange(50, 50) === 0)
check('start beyond end is zero', b.countRange(60, 40) === 0)
b.clear(31)
check('clear works', b.get(31) === false && b.countRange(0, 100) === 3)
b.set(0)
check('double set idempotent', b.countRange(0, 1) === 1)
const big = new BitSet(100000)
for (let i = 0; i < 100000; i += 3) big.set(i)
check('large range popcount correct', big.countRange(0, 100000) === 33334)
check('large subrange popcount', big.countRange(1, 100000) === 33333)
let threwCtor = false
try { new BitSet(0) } catch (e) { threwCtor = e instanceof RangeError }
check('size 0 throws RangeError', threwCtor)
let threwIdx = false
try { b.get(100) } catch (e) { threwIdx = e instanceof RangeError }
check('index at size throws', threwIdx)
let threwNeg = false
try { b.set(-1) } catch (e) { threwNeg = e instanceof RangeError }
check('negative index throws', threwNeg)
let threwRange = false
try { b.countRange(0, 101) } catch (e) { threwRange = e instanceof RangeError }
check('range end beyond size throws', threwRange)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`,
  },

  {
    id: 'slidingWindowMax',
    title: 'Sliding-window maximum via monotonic deque',
    modulePath: 'src/slidingWindowMax.ts',
    prompt: `Implement sliding-window maximum in TypeScript at src/slidingWindowMax.ts. ${CONTRACT}

Export exactly:
  export function slidingWindowMax(values: number[], k: number): number[]

Semantics:
- Returns the maximum of each contiguous window of length k, left to right; for input
  length n the result has n - k + 1 entries.
- Must run in O(n) overall (monotonic-deque or equivalent) — the audit includes an input
  large enough that an O(n*k) rescan per window exceeds the harness cap.
- k equal to the input length returns a single maximum; k = 1 returns a copy of the input.
- Error contract: throw a RangeError if k is not an integer, k < 1, or k > values.length
  (including any k against an empty input).`,
    ref: `export function slidingWindowMax(values: number[], k: number): number[] {
  if (!Number.isInteger(k) || k < 1 || k > values.length) throw new RangeError('k out of range')
  const out: number[] = []
  const deque: number[] = []
  for (let i = 0; i < values.length; i++) {
    while (deque.length > 0 && values[deque[deque.length - 1]] <= values[i]) deque.pop()
    deque.push(i)
    if (deque[0] <= i - k) deque.shift()
    if (i >= k - 1) out.push(values[deque[0]])
  }
  return out
}
`,
    suite: `// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — slidingWindowMax.
// Run: npx tsx __audit__/slidingWindowMax.hidden.ts   (imports ../src/slidingWindowMax)
import { slidingWindowMax } from '../src/slidingWindowMax'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}
const eq = (a: number[], b: number[]): boolean => JSON.stringify(a) === JSON.stringify(b)

check('classic case', eq(slidingWindowMax([1, 3, -1, -3, 5, 3, 6, 7], 3), [3, 3, 5, 5, 6, 7]))
check('k=1 is identity copy', eq(slidingWindowMax([4, 2, 9], 1), [4, 2, 9]))
check('k=n single max', eq(slidingWindowMax([4, 2, 9, 1], 4), [9]))
check('descending input', eq(slidingWindowMax([9, 7, 5, 3], 2), [9, 7, 5]))
check('ascending input', eq(slidingWindowMax([1, 2, 3, 4], 2), [2, 3, 4]))
check('all equal values', eq(slidingWindowMax([5, 5, 5], 2), [5, 5]))
check('duplicates of max inside window', eq(slidingWindowMax([2, 5, 5, 2], 2), [5, 5, 5]))
check('negatives', eq(slidingWindowMax([-4, -2, -9], 2), [-2, -2]))
check('single element k=1', eq(slidingWindowMax([7], 1), [7]))
const n = 300000
const big: number[] = new Array(n)
for (let i = 0; i < n; i++) big[i] = (i * 2654435761) % 1000003
const res = slidingWindowMax(big, 5000)
check('large input completes (O(n) required)', res.length === n - 5000 + 1)
let spot = true
for (let w = 0; w < 3; w++) {
  const start = w * 100000
  let m = -1
  for (let i = start; i < start + 5000; i++) m = Math.max(m, big[i])
  if (res[start] !== m) spot = false
}
check('spot-check large windows against rescan', spot)
let threwBig = false
try { slidingWindowMax([1, 2], 3) } catch (e) { threwBig = e instanceof RangeError }
check('k beyond length throws', threwBig)
let threwZero = false
try { slidingWindowMax([1, 2], 0) } catch (e) { threwZero = e instanceof RangeError }
check('k=0 throws', threwZero)
let threwEmpty = false
try { slidingWindowMax([], 1) } catch (e) { threwEmpty = e instanceof RangeError }
check('empty input throws', threwEmpty)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`,
  },
]
