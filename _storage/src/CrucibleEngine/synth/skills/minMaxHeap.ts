// Verified primitive: min-max heap — O(1) findMin/findMax, O(log n) insert/deleteMin/deleteMax.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Min-Max Heap.
export class MinMaxHeap<T = number> {
  private data: T[] = []
  private cmp: (a: T, b: T) => number

  constructor(cmp: (a: T, b: T) => number = (a, b) => (a < b ? -1 : a > b ? 1 : 0)) {
    this.cmp = cmp
  }

  push(val: T): void { this.data.push(val); this._pushUp(this.data.length - 1) }

  peekMin(): T | undefined { return this.data[0] }
  peekMax(): T | undefined {
    if (this.data.length <= 1) return this.data[0]
    if (this.data.length === 2) return this.data[1]
    return this.cmp(this.data[1], this.data[2]) >= 0 ? this.data[1] : this.data[2]
  }

  popMin(): T | undefined {
    if (!this.data.length) return undefined
    const m = this.data[0]; this._swap(0, this.data.length - 1); this.data.pop(); this._pushDown(0); return m
  }

  popMax(): T | undefined {
    if (this.data.length <= 1) return this.data.pop()
    const mi = this.data.length === 2 ? 1 : (this.cmp(this.data[1], this.data[2]) >= 0 ? 1 : 2)
    const m = this.data[mi]; this._swap(mi, this.data.length - 1); this.data.pop(); this._pushDown(mi); return m
  }

  size(): number { return this.data.length }

  private _isMinLevel(i: number): boolean { return Math.floor(Math.log2(i + 1)) % 2 === 0 }
  private _swap(a: number, b: number): void { const t = this.data[a]; this.data[a] = this.data[b]; this.data[b] = t }

  private _pushUp(i: number): void {
    if (i === 0) return
    const parent = Math.floor((i - 1) / 2)
    if (this._isMinLevel(i)) {
      if (this.cmp(this.data[i], this.data[parent]) > 0) { this._swap(i, parent); this._pushUpMax(parent) }
      else this._pushUpMin(i)
    } else {
      if (this.cmp(this.data[i], this.data[parent]) < 0) { this._swap(i, parent); this._pushUpMin(parent) }
      else this._pushUpMax(i)
    }
  }

  private _pushUpMin(i: number): void {
    const gp = Math.floor((i - 1) / 2); const ggp = Math.floor((gp - 1) / 2)
    if (ggp >= 0 && this.cmp(this.data[i], this.data[ggp]) < 0) { this._swap(i, ggp); this._pushUpMin(ggp) }
  }

  private _pushUpMax(i: number): void {
    const gp = Math.floor((i - 1) / 2); const ggp = Math.floor((gp - 1) / 2)
    if (ggp >= 0 && this.cmp(this.data[i], this.data[ggp]) > 0) { this._swap(i, ggp); this._pushUpMax(ggp) }
  }

  private _pushDown(i: number): void {
    if (this._isMinLevel(i)) this._pushDownMin(i); else this._pushDownMax(i)
  }

  private _children(i: number): number[] {
    const c = [2*i+1, 2*i+2, 2*(2*i+1)+1, 2*(2*i+1)+2, 2*(2*i+2)+1, 2*(2*i+2)+2]
    return c.filter(x => x < this.data.length)
  }

  private _pushDownMin(i: number): void {
    const ch = this._children(i); if (!ch.length) return
    let m = ch.reduce((a, b) => this.cmp(this.data[a], this.data[b]) < 0 ? a : b)
    if (m > 2*i+2) {
      if (this.cmp(this.data[m], this.data[i]) < 0) {
        this._swap(m, i)
        const p = Math.floor((m - 1) / 2)
        if (this.cmp(this.data[m], this.data[p]) > 0) this._swap(m, p)
        this._pushDownMin(m)
      }
    } else if (this.cmp(this.data[m], this.data[i]) < 0) this._swap(m, i)
  }

  private _pushDownMax(i: number): void {
    const ch = this._children(i); if (!ch.length) return
    let m = ch.reduce((a, b) => this.cmp(this.data[a], this.data[b]) > 0 ? a : b)
    if (m > 2*i+2) {
      if (this.cmp(this.data[m], this.data[i]) > 0) {
        this._swap(m, i)
        const p = Math.floor((m - 1) / 2)
        if (this.cmp(this.data[m], this.data[p]) < 0) this._swap(m, p)
        this._pushDownMax(m)
      }
    } else if (this.cmp(this.data[m], this.data[i]) > 0) this._swap(m, i)
  }
}
`
registerSkill({
  id: 'min-max-heap',
  summary: 'Min-Max heap: O(1) peekMin/peekMax, O(log n) push/popMin/popMax.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bmin.?max.?heap\b/i)) sc += 0.7
    if (s.has(/\bpeekmin\b|\bpeekmax\b|\bpopmin\b|\bpopmax\b/i)) sc += 0.3
    if (s.has(/\bdouble.?ended.?priority\b/i)) sc += 0.35
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/minMaxHeap.ts', content: IMPL }]
  },
})
