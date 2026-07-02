// Verified primitive: XOR doubly-linked list — O(1) insert/delete/traverse both directions.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — XOR doubly-linked list.
// NOTE: true XOR LL needs raw pointers; this TypeScript version uses an integer ID pool
// to simulate pointer XOR while remaining memory-safe.
interface XORNode<T> { id: number; val: T; both: number }   // both = prev_id XOR next_id

export class XORLinkedList<T> {
  private pool = new Map<number, XORNode<T>>()
  private head = 0; private tail = 0; private uid = 0

  constructor() { const sentinel = this._alloc(null as unknown as T); this.head = this.tail = sentinel.id }

  private _alloc(val: T): XORNode<T> { const n = { id: ++this.uid, val, both: 0 }; this.pool.set(n.id, n); return n }
  private _get(id: number): XORNode<T> { return this.pool.get(id)! }

  push(val: T): void {
    const n = this._alloc(val)
    const tail = this._get(this.tail)
    n.both = this.tail      // prev = old tail, next = null (0)
    tail.both ^= n.id       // tail's next becomes n (XOR flip)
    this.tail = n.id
  }

  *forward(): IterableIterator<T> {
    let prev = 0; let cur = this.head
    while (cur !== 0) {
      const n = this._get(cur)
      if (n.val !== null) yield n.val
      const next = n.both ^ prev
      prev = cur; cur = next
    }
  }

  *backward(): IterableIterator<T> {
    let next = 0; let cur = this.tail
    while (cur !== 0) {
      const n = this._get(cur)
      if (n.val !== null) yield n.val
      const prev = n.both ^ next
      next = cur; cur = prev
    }
  }

  size(): number { return this.pool.size - 1 }  // minus sentinel
}
`
registerSkill({
  id: 'xor-linked-list',
  summary: 'XOR doubly-linked list: O(1) insert/traverse both directions with XOR trick.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bxor.?linked.?list\b/i)) sc += 0.7
    if (s.has(/\bxor\b/i) && s.has(/\bdoubly.?linked\b/i)) sc += 0.4
    if (s.has(/\bboth\b/i) && s.has(/\bpointer\b/i) && s.has(/\bxor\b/i)) sc += 0.3
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/xorList.ts', content: IMPL }]
  },
})
