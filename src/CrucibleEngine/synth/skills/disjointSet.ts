import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Union-Find / Disjoint Set Union with path compression + union by rank.
export class DisjointSet {
  private parent: number[]
  private rank: number[]
  private size_: number[]
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i)
    this.rank   = new Array(n).fill(0)
    this.size_  = new Array(n).fill(1)
  }
  find(x: number): number {
    if (this.parent[x] !== x) this.parent[x] = this.find(this.parent[x])
    return this.parent[x]
  }
  union(x: number, y: number): boolean {
    const rx = this.find(x), ry = this.find(y)
    if (rx === ry) return false
    if (this.rank[rx] < this.rank[ry]) { this.parent[rx] = ry; this.size_[ry] += this.size_[rx] }
    else if (this.rank[rx] > this.rank[ry]) { this.parent[ry] = rx; this.size_[rx] += this.size_[ry] }
    else { this.parent[ry] = rx; this.size_[rx] += this.size_[ry]; this.rank[rx]++ }
    return true
  }
  connected(x: number, y: number): boolean { return this.find(x) === this.find(y) }
  componentSize(x: number): number { return this.size_[this.find(x)] }
}
`
registerSkill({
  id: 'disjoint-set',
  summary: 'Union-Find / DSU with path compression and union by rank.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bdsu\b|disjoint.?set|union.?find/i)) sc += 0.7
    if (s.has(/\bpath.?compress/i)) sc += 0.3
    if (s.has(/\bconnected.?component/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/disjointSet.ts', content: IMPL }]
  },
})
