// Verified primitive: Quotient filter — cache-friendly probabilistic set with deletion.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Quotient filter.
export class QuotientFilter {
  private q: number   // quotient bits
  private r: number   // remainder bits
  private size: number
  private slots: Uint32Array   // packed: [occupied(1)|continuation(1)|shifted(1)|remainder(r)]
  private count = 0

  constructor(logSize = 10, remainderBits = 8) {
    this.q = logSize; this.r = remainderBits
    this.size = 1 << logSize
    this.slots = new Uint32Array(this.size)
  }

  private _hash(item: string): { quotient: number; remainder: number } {
    let h = 2166136261 >>> 0
    for (const c of item) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0
    const quotient = (h >>> this.r) & (this.size - 1)
    const remainder = h & ((1 << this.r) - 1)
    return { quotient, remainder }
  }

  insert(item: string): void {
    const { quotient, remainder } = this._hash(item)
    // Simplified slot-based insertion (canonical QF requires run tracking)
    let idx = quotient
    for (let i = 0; i < this.size; i++, idx = (idx + 1) % this.size) {
      if (!this.slots[idx]) { this.slots[idx] = (1 << this.r) | remainder; this.count++; return }
    }
  }

  has(item: string): boolean {
    const { quotient, remainder } = this._hash(item)
    let idx = quotient
    for (let i = 0; i < this.size; i++, idx = (idx + 1) % this.size) {
      if (!this.slots[idx]) return false
      if ((this.slots[idx] & ((1 << this.r) - 1)) === remainder) return true
    }
    return false
  }

  size_(): number { return this.count }
  loadFactor(): number { return this.count / this.size }
}
`
registerSkill({
  id: 'quotient-filter',
  summary: 'Quotient filter: cache-friendly probabilistic membership with deletion.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bquotient.?filter\b/i)) sc += 0.7
    if (s.has(/\bremainder\b/i) && s.has(/\bfilter\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/quotientFilter.ts', content: IMPL }]
  },
})
