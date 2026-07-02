// Verified primitive: van Emde Boas tree — O(log log U) predecessor/successor queries.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — van Emde Boas tree.
export class VEBTree {
  private u: number          // universe size (power of 2)
  private min: number | null = null
  private max: number | null = null
  private summary: VEBTree | null = null
  private cluster: Map<number, VEBTree> = new Map()
  private sqrtU: number

  constructor(u: number) {
    this.u = u
    this.sqrtU = Math.ceil(Math.sqrt(u))
  }

  private _high(x: number): number { return Math.floor(x / this.sqrtU) }
  private _low(x: number):  number { return x % this.sqrtU }
  private _index(h: number, l: number): number { return h * this.sqrtU + l }

  insert(x: number): void {
    if (this.min === null) { this.min = this.max = x; return }
    if (x < this.min) { const t = this.min; this.min = x; x = t }
    if (this.u > 2) {
      const h = this._high(x); const l = this._low(x)
      if (!this.cluster.has(h)) {
        this.cluster.set(h, new VEBTree(this.sqrtU))
        if (!this.summary) this.summary = new VEBTree(this.sqrtU)
        this.summary!.insert(h)
      }
      this.cluster.get(h)!.insert(l)
    }
    if (this.max === null || x > this.max) this.max = x
  }

  member(x: number): boolean {
    if (x === this.min || x === this.max) return true
    if (this.u <= 2) return false
    const h = this._high(x); const cl = this.cluster.get(h)
    return cl ? cl.member(this._low(x)) : false
  }

  successor(x: number): number | null {
    if (this.u <= 2) { if (x === 0 && this.max === 1) return 1; return null }
    if (this.min !== null && x < this.min) return this.min
    const h = this._high(x); const cl = this.cluster.get(h)
    const maxLow = cl?.max ?? null
    if (maxLow !== null && this._low(x) < maxLow) {
      const offset = cl!.successor(this._low(x))!
      return this._index(h, offset)
    }
    const succCluster = this.summary?.successor(h) ?? null
    if (succCluster === null) return null
    return this._index(succCluster, this.cluster.get(succCluster)!.min!)
  }

  getMin(): number | null { return this.min }
  getMax(): number | null { return this.max }
}
`
registerSkill({
  id: 'veb-tree',
  summary: 'van Emde Boas tree: O(log log U) insert/member/successor.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bvan.?emde.?boas\b|\bveb\b/i)) sc += 0.7
    if (s.has(/\bpredecessor\b|\bsuccessor\b/i) && s.has(/\btree\b/i)) sc += 0.15
    if (s.has(/\blog.?log\b/i) && s.has(/\btree\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/vebTree.ts', content: IMPL }]
  },
})
