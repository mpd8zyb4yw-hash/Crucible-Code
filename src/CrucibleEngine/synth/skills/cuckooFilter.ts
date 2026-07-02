// Verified primitive: Cuckoo filter — space-efficient probabilistic set with deletion.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Cuckoo filter.
export class CuckooFilter {
  private buckets: Uint32Array
  private numBuckets: number
  private bSize: number   // entries per bucket
  private fpBits: number
  private maxKicks: number
  private count = 0

  constructor(capacity = 1024, bucketSize = 4, fingerprintBits = 8, maxKicks = 500) {
    this.numBuckets = Math.max(1, Math.ceil(capacity / bucketSize))
    this.bSize = bucketSize; this.fpBits = fingerprintBits; this.maxKicks = maxKicks
    this.buckets = new Uint32Array(this.numBuckets * bucketSize)
  }

  private _fp(item: string): number {
    let h = 2166136261
    for (let i = 0; i < item.length; i++) h = (h ^ item.charCodeAt(i)) * 16777619 >>> 0
    return Math.max(1, h & ((1 << this.fpBits) - 1))
  }

  private _h(item: string): number {
    let h = 5381
    for (let i = 0; i < item.length; i++) h = ((h << 5) + h + item.charCodeAt(i)) >>> 0
    return h % this.numBuckets
  }

  private _altIdx(i: number, fp: number): number {
    return (i ^ (fp * 0x5bd1e995)) % this.numBuckets
  }

  private _slotBase(b: number): number { return b * this.bSize }

  private _insertFP(b: number, fp: number): boolean {
    const base = this._slotBase(b)
    for (let s = 0; s < this.bSize; s++) { if (!this.buckets[base + s]) { this.buckets[base + s] = fp; return true } }
    return false
  }

  private _removeFP(b: number, fp: number): boolean {
    const base = this._slotBase(b)
    for (let s = 0; s < this.bSize; s++) { if (this.buckets[base + s] === fp) { this.buckets[base + s] = 0; return true } }
    return false
  }

  private _hasFP(b: number, fp: number): boolean {
    const base = this._slotBase(b)
    for (let s = 0; s < this.bSize; s++) if (this.buckets[base + s] === fp) return true
    return false
  }

  insert(item: string): boolean {
    const fp = this._fp(item); let i1 = this._h(item); let i2 = this._altIdx(i1, fp)
    if (this._insertFP(i1, fp) || this._insertFP(i2, fp)) { this.count++; return true }
    let i = Math.random() < 0.5 ? i1 : i2
    for (let k = 0; k < this.maxKicks; k++) {
      const s = this._slotBase(i) + (Math.random() * this.bSize | 0)
      const evicted = this.buckets[s]; this.buckets[s] = fp
      i = this._altIdx(i, evicted)
      if (this._insertFP(i, evicted)) { this.count++; return true }
    }
    return false  // too full
  }

  has(item: string): boolean {
    const fp = this._fp(item); const i1 = this._h(item); const i2 = this._altIdx(i1, fp)
    return this._hasFP(i1, fp) || this._hasFP(i2, fp)
  }

  delete(item: string): boolean {
    const fp = this._fp(item); const i1 = this._h(item); const i2 = this._altIdx(i1, fp)
    if (this._removeFP(i1, fp) || this._removeFP(i2, fp)) { this.count--; return true }
    return false
  }

  size(): number { return this.count }
}
`
registerSkill({
  id: 'cuckoo-filter',
  summary: 'Cuckoo filter: probabilistic set membership with deletion support.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bcuckoo.?filter\b/i)) sc += 0.7
    if (s.has(/\bcuckoo\b/i) && s.has(/\bprobabilistic\b/i)) sc += 0.3
    if (s.has(/\bfingerprint\b/i) && s.has(/\bfilter\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/cuckooFilter.ts', content: IMPL }]
  },
})
