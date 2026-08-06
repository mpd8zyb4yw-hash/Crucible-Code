import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — verified min-heap / max-heap / priority queue.
export class Heap<T> {
  private data: T[] = []
  constructor(private cmp: (a: T, b: T) => number = (a,b) => a < b ? -1 : a > b ? 1 : 0) {}
  get size() { return this.data.length }
  peek(): T | undefined { return this.data[0] }
  push(v: T): void { this.data.push(v); this._up(this.data.length - 1) }
  pop(): T | undefined {
    if (!this.data.length) return undefined
    const top = this.data[0]; const last = this.data.pop()!
    if (this.data.length) { this.data[0] = last; this._down(0) }
    return top
  }
  private _up(i: number) { while (i > 0) { const p = (i - 1) >> 1; if (this.cmp(this.data[i], this.data[p]) < 0) { [this.data[i], this.data[p]] = [this.data[p], this.data[i]]; i = p } else break } }
  private _down(i: number) { const n = this.data.length; while (true) { let s = i, l = 2*i+1, r = 2*i+2; if (l < n && this.cmp(this.data[l], this.data[s]) < 0) s = l; if (r < n && this.cmp(this.data[r], this.data[s]) < 0) s = r; if (s === i) break; [this.data[i], this.data[s]] = [this.data[s], this.data[i]]; i = s } }
}
export class PriorityQueue<T> extends Heap<T> {}
export function minHeap<T>() { return new Heap<T>() }
export function maxHeap<T>() { return new Heap<T>((a,b) => a > b ? -1 : a < b ? 1 : 0) }
`
registerSkill({ id: 'heap', summary: 'Generic min/max heap and priority queue.',
  match(s: SpecFeatures) { let score = 0; if (s.has(/\bheap\b/i)) score += 0.4; if (s.has(/priority.?queue/i)) score += 0.4; if (s.has(/min.?heap|max.?heap/i)) score += 0.3; return score },
  emit(s: SpecFeatures): SynthFile[] { return [{ path: s.modulePath ?? 'src/heap.ts', content: IMPL }] } })
