import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Segment Tree: range query + point/range update with lazy propagation.
export class SegmentTree {
  private tree: number[]
  private lazy: number[]
  readonly n: number
  private combine: (a: number, b: number) => number
  private identity: number
  constructor(n: number, combine = Math.min, identity = Infinity) {
    this.n = n; this.combine = combine; this.identity = identity
    this.tree = new Array(4 * n).fill(identity)
    this.lazy = new Array(4 * n).fill(0)
  }
  build(a: number[], node = 1, l = 0, r = this.n - 1): void {
    if (l === r) { this.tree[node] = a[l]; return }
    const m = (l + r) >> 1
    this.build(a, 2*node, l, m); this.build(a, 2*node+1, m+1, r)
    this.tree[node] = this.combine(this.tree[2*node], this.tree[2*node+1])
  }
  private push(node: number): void {
    if (this.lazy[node]) {
      for (const c of [2*node, 2*node+1]) { this.tree[c] += this.lazy[node]; this.lazy[c] += this.lazy[node] }
      this.lazy[node] = 0
    }
  }
  update(ql: number, qr: number, val: number, node = 1, l = 0, r = this.n - 1): void {
    if (qr < l || r < ql) return
    if (ql <= l && r <= qr) { this.tree[node] += val; this.lazy[node] += val; return }
    this.push(node); const m = (l + r) >> 1
    this.update(ql, qr, val, 2*node, l, m); this.update(ql, qr, val, 2*node+1, m+1, r)
    this.tree[node] = this.combine(this.tree[2*node], this.tree[2*node+1])
  }
  query(ql: number, qr: number, node = 1, l = 0, r = this.n - 1): number {
    if (qr < l || r < ql) return this.identity
    if (ql <= l && r <= qr) return this.tree[node]
    this.push(node); const m = (l + r) >> 1
    return this.combine(this.query(ql, qr, 2*node, l, m), this.query(ql, qr, 2*node+1, m+1, r))
  }
}
`
registerSkill({
  id: 'segment-tree',
  summary: 'Segment tree: range query + lazy propagation range update.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bsegment.?tree\b/i)) sc += 0.7
    if (s.has(/\blazy.?propag/i)) sc += 0.3
    if (s.has(/\brange.?query\b/i) && s.has(/\bupdate\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/segmentTree.ts', content: IMPL }]
  },
})
