import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Sparse Table: O(n log n) build, O(1) idempotent range query (RMQ).
export class SparseTable {
  private table: number[][]
  private log2: number[]
  readonly n: number
  private fn: (a: number, b: number) => number
  constructor(a: number[], fn = Math.min) {
    this.n = a.length; this.fn = fn
    const LOG = Math.floor(Math.log2(this.n)) + 1
    this.log2 = new Array(this.n + 1).fill(0)
    for (let i = 2; i <= this.n; i++) this.log2[i] = this.log2[i >> 1] + 1
    this.table = Array.from({ length: LOG }, () => new Array(this.n).fill(0))
    this.table[0] = a.slice()
    for (let j = 1; j < LOG; j++)
      for (let i = 0; i + (1 << j) <= this.n; i++)
        this.table[j][i] = fn(this.table[j-1][i], this.table[j-1][i + (1 << (j-1))])
  }
  query(l: number, r: number): number {
    const k = this.log2[r - l + 1]
    return this.fn(this.table[k][l], this.table[k][r - (1 << k) + 1])
  }
}
`
registerSkill({
  id: 'sparse-table',
  summary: 'Sparse table: O(1) idempotent range query (RMQ), O(n log n) build.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bsparse.?table\b/i)) sc += 0.7
    if (s.has(/\brmq\b|range.?min.?query/i)) sc += 0.4
    if (s.has(/\bidempotent\b/i) && s.has(/\brange\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/sparseTable.ts', content: IMPL }]
  },
})
