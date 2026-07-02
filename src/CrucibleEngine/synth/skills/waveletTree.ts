// Verified primitive: Wavelet tree — rank/select/quantile queries on integer sequences.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Wavelet tree.
export class WaveletTree {
  private lo: number; private hi: number
  private left: WaveletTree | null = null; private right: WaveletTree | null = null
  private b: boolean[]   // bit array: true → right child

  constructor(arr: number[], lo: number, hi: number) {
    this.lo = lo; this.hi = hi; this.b = []
    if (lo === hi) return
    const mid = (lo + hi) >> 1
    const L: number[] = []; const R: number[] = []
    for (const v of arr) { const goRight = v > mid; this.b.push(goRight); if (goRight) R.push(v); else L.push(v) }
    this.left  = new WaveletTree(L, lo, mid)
    this.right = new WaveletTree(R, mid + 1, hi)
  }

  /** Count of values in [ql,qr] that are <= k. */
  countLE(l: number, r: number, k: number): number {
    if (l > r || this.lo === this.hi) return this.lo <= k ? r - l + 1 : 0
    if (this.hi <= k) return r - l + 1
    if (this.lo > k) return 0
    const lb = this.b.slice(0, l).filter(x => !x).length
    const rb = this.b.slice(0, r + 1).filter(x => !x).length
    return this.left!.countLE(lb, rb - 1, k)
  }

  /** k-th smallest in range [l, r] (1-indexed). */
  kth(l: number, r: number, k: number): number {
    if (this.lo === this.hi) return this.lo
    const lb = this.b.slice(0, l).filter(x => !x).length
    const rb = this.b.slice(0, r + 1).filter(x => !x).length
    const cntLeft = rb - lb
    if (k <= cntLeft) return this.left!.kth(lb, rb - 1, k)
    const la = l - lb; const ra = r - (rb - 1) - 1 + la
    return this.right!.kth(la, ra, k - cntLeft)
  }
}
`
registerSkill({
  id: 'wavelet-tree',
  summary: 'Wavelet tree: rank/select/quantile queries over integer sequences.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bwavelet.?tree\b/i)) sc += 0.7
    if (s.has(/\brank\b/i) && s.has(/\bselect\b/i) && s.has(/\bsequence\b/i)) sc += 0.2
    if (s.has(/\bquantile\b/i) && s.has(/\btree\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/waveletTree.ts', content: IMPL }]
  },
})
