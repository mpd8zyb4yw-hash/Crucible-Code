// Verified primitive: Counting Bloom filter — supports deletion via counters.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Counting Bloom filter.
export class CountingBloomFilter {
  private counters: Uint8Array
  private k: number      // number of hash functions
  private m: number      // counter array size

  constructor(capacity = 10000, errorRate = 0.01) {
    this.m = Math.ceil(-capacity * Math.log(errorRate) / Math.LN2 ** 2)
    this.k = Math.ceil((this.m / capacity) * Math.LN2)
    this.counters = new Uint8Array(this.m)
  }

  add(item: string): void {
    for (let i = 0; i < this.k; i++) {
      const idx = this._hash(item, i) % this.m
      if (this.counters[idx] < 255) this.counters[idx]++
    }
  }

  has(item: string): boolean {
    for (let i = 0; i < this.k; i++) if (!this.counters[this._hash(item, i) % this.m]) return false
    return true
  }

  remove(item: string): void {
    if (!this.has(item)) return
    for (let i = 0; i < this.k; i++) {
      const idx = this._hash(item, i) % this.m
      if (this.counters[idx] > 0) this.counters[idx]--
    }
  }

  private _hash(item: string, seed: number): number {
    let h = (seed * 0x9e3779b9) >>> 0
    for (let i = 0; i < item.length; i++) h = Math.imul(h ^ item.charCodeAt(i), 0x01000193) >>> 0
    return h
  }
}
`
registerSkill({
  id: 'counting-bloom-filter',
  summary: 'Counting Bloom filter: probabilistic set with deletion via saturating counters.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bcounting.?bloom\b/i)) sc += 0.7
    if (s.has(/\bbloom\b/i) && s.has(/\bdelet\w+\b/i)) sc += 0.3
    if (s.has(/\bcounter\b/i) && s.has(/\bbloom\b/i)) sc += 0.25
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/countingBloom.ts', content: IMPL }]
  },
})
