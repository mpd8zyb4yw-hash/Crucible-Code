import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Fenwick Tree (Binary Indexed Tree): prefix sums, point update, range query.
export class FenwickTree {
  private tree: number[]
  readonly n: number
  constructor(n: number) { this.n = n; this.tree = new Array(n + 1).fill(0) }
  update(i: number, delta: number): void {
    for (let x = i + 1; x <= this.n; x += x & -x) this.tree[x] += delta
  }
  query(i: number): number {
    let s = 0; for (let x = i + 1; x > 0; x -= x & -x) s += this.tree[x]; return s
  }
  rangeQuery(l: number, r: number): number { return this.query(r) - (l > 0 ? this.query(l - 1) : 0) }
  static fromArray(a: number[]): FenwickTree {
    const t = new FenwickTree(a.length)
    a.forEach((v, i) => t.update(i, v))
    return t
  }
}
`
registerSkill({
  id: 'fenwick-tree',
  summary: 'Fenwick / BIT: O(log n) prefix sum, point update, range query.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bfenwick\b|\bbit\b|binary.?indexed/i)) sc += 0.7
    if (s.has(/\bprefix.?sum\b/i)) sc += 0.25
    if (s.has(/\bpoint.?update\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/fenwickTree.ts', content: IMPL }]
  },
})
