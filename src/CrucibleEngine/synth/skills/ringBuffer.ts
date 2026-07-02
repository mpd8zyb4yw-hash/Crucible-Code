// Verified primitive: lock-free-style ring buffer (single-producer single-consumer).
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — SPSC ring buffer.
export class RingBuffer<T> {
  private buf: (T | undefined)[]
  private head = 0   // read  pointer
  private tail = 0   // write pointer
  private cap: number

  constructor(capacity: number) {
    this.cap = capacity + 1        // +1 sentinel to distinguish full from empty
    this.buf = new Array(this.cap)
  }

  push(item: T): boolean {
    const next = (this.tail + 1) % this.cap
    if (next === this.head) return false   // full
    this.buf[this.tail] = item
    this.tail = next
    return true
  }

  pop(): T | undefined {
    if (this.head === this.tail) return undefined   // empty
    const item = this.buf[this.head]!
    this.buf[this.head] = undefined
    this.head = (this.head + 1) % this.cap
    return item
  }

  peek(): T | undefined { return this.head === this.tail ? undefined : this.buf[this.head] }
  isEmpty(): boolean { return this.head === this.tail }
  isFull(): boolean { return (this.tail + 1) % this.cap === this.head }
  size(): number { return (this.tail - this.head + this.cap) % this.cap }
  capacity(): number { return this.cap - 1 }
}
`
registerSkill({
  id: 'ring-buffer',
  summary: 'SPSC ring buffer: push, pop, peek, isEmpty, isFull, O(1) all ops.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bring.?buffer\b|circular.?buffer\b/i)) sc += 0.6
    if (s.has(/\bspsc\b/i)) sc += 0.3
    if (s.has(/\bcircular\b/i) && s.has(/\bqueue\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/ringBuffer.ts', content: IMPL }]
  },
})
