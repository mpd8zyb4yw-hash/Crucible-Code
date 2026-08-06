// Verified primitive: HyperLogLog++ — improved cardinality estimation with bias correction.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — HyperLogLog++.
export class HyperLogLogPlus {
  private m: number      // number of registers (2^p)
  private p: number      // precision bits
  private registers: Uint8Array
  private alpha: number

  constructor(precision = 14) {
    this.p = Math.max(4, Math.min(18, precision))
    this.m = 1 << this.p
    this.registers = new Uint8Array(this.m)
    // alpha_m correction factor
    this.alpha = precision >= 6 ? 0.7213 / (1 + 1.079 / this.m) :
                 precision === 5 ? 0.697 : precision === 4 ? 0.673 : 0.721
  }

  add(item: string): void {
    const h = this._hash(item)
    const idx = h >>> (32 - this.p)
    const w   = h << this.p | ((1 << this.p) - 1)
    const rho = w === 0 ? 32 - this.p + 1 : Math.clz32(w) + 1
    if (rho > this.registers[idx]) this.registers[idx] = rho
  }

  estimate(): number {
    const m = this.m
    let Z = 0; for (const r of this.registers) Z += 1 / (1 << r); Z = 1 / Z
    let E = this.alpha * m * m * Z
    // Small range correction
    if (E <= 2.5 * m) {
      let zeros = 0; for (const r of this.registers) if (!r) zeros++
      if (zeros) E = m * Math.log(m / zeros)
    }
    // Large range correction
    if (E > (1 / 30) * 2 ** 32) E = -(2 ** 32) * Math.log(1 - E / 2 ** 32)
    return Math.round(E)
  }

  merge(other: HyperLogLogPlus): HyperLogLogPlus {
    if (this.p !== other.p) throw new Error('precision mismatch')
    const merged = new HyperLogLogPlus(this.p)
    for (let i = 0; i < this.m; i++) merged.registers[i] = Math.max(this.registers[i], other.registers[i])
    return merged
  }

  private _hash(s: string): number {
    let h = 0x811c9dc5 >>> 0
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
    return h
  }
}
`
registerSkill({
  id: 'hyperloglog-plus',
  summary: 'HyperLogLog++: cardinality estimation with bias correction and merge.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bhyperloglog\+\+\b/i)) sc += 0.7
    if (s.has(/\bhll\+\+\b/i)) sc += 0.5
    if (s.has(/\bbias.?correction\b/i) && s.has(/\bcardinality\b/i)) sc += 0.3
    if (s.has(/\bimproved\b/i) && s.has(/\bhyperloglog\b/i)) sc += 0.3
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/hyperLogLogPlus.ts', content: IMPL }]
  },
})
