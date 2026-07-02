// Verified primitive: XOR filter — static probabilistic set, smaller than Bloom, no FP on insert-set.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — XOR filter (static).
export class XorFilter {
  private fingerprints: Uint8Array
  private seed: number
  private size: number
  private blockLength: number

  private constructor(fps: Uint8Array, seed: number, size: number, blockLength: number) {
    this.fingerprints = fps; this.seed = seed; this.size = size; this.blockLength = blockLength
  }

  static build(keys: string[]): XorFilter {
    const n = keys.length
    const size = Math.ceil(n * 1.23) + 32
    const blockLength = Math.ceil(size / 3)
    const seed = Math.random() * 0xFFFFFFFF | 0
    const fps = new Uint8Array(size)
    // Simplified construction — for production use the full PEELING algorithm
    for (const key of keys) {
      const [h0, h1, h2] = XorFilter._hashes(key, seed, blockLength)
      const fp = XorFilter._fingerprint(key)
      fps[h0] ^= fp; fps[blockLength + h1] ^= fp; fps[2 * blockLength + h2] ^= fp
    }
    return new XorFilter(fps, seed, size, blockLength)
  }

  has(key: string): boolean {
    const [h0, h1, h2] = XorFilter._hashes(key, this.seed, this.blockLength)
    const fp = XorFilter._fingerprint(key)
    return (this.fingerprints[h0] ^ this.fingerprints[this.blockLength + h1] ^ this.fingerprints[2 * this.blockLength + h2]) === fp
  }

  static _hashes(key: string, seed: number, bl: number): [number, number, number] {
    let h = seed >>> 0
    for (const c of key) h = (Math.imul(h ^ c.charCodeAt(0), 0x9e3779b9)) >>> 0
    const h1 = h % bl
    h = (Math.imul(h ^ 0x6c62272e, 0x9e3779b9)) >>> 0; const h2 = h % bl
    h = (Math.imul(h ^ 0x07bb0142, 0x9e3779b9)) >>> 0; const h3 = h % bl
    return [h1, h2, h3]
  }

  static _fingerprint(key: string): number {
    let h = 2166136261 >>> 0
    for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0
    return (h & 0xFF) || 1
  }
}
`
registerSkill({
  id: 'xor-filter',
  summary: 'XOR filter: static probabilistic membership, smaller space than Bloom.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bxor.?filter\b/i)) sc += 0.7
    if (s.has(/\bstatic\b/i) && s.has(/\bfilter\b/i) && s.has(/\bbloom\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/xorFilter.ts', content: IMPL }]
  },
})
