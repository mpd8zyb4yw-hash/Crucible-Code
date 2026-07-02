import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `export class BloomFilter {
  private bits: Uint8Array
  private size: number
  private numHashes: number

  constructor(expectedItems: number, falsePositiveRate = 0.01) {
    this.size = Math.ceil(
      (-expectedItems * Math.log(falsePositiveRate)) / (Math.log(2) ** 2)
    )
    this.numHashes = Math.max(1, Math.round((this.size / expectedItems) * Math.log(2)))
    this.bits = new Uint8Array(Math.ceil(this.size / 8))
  }

  private hash(str: string, seed: number): number {
    let h = seed
    for (let i = 0; i < str.length; i++) {
      h = (h * 31 + str.charCodeAt(i)) | 0
    }
    return Math.abs(h) % this.size
  }

  private setBit(pos: number) {
    this.bits[pos >> 3] |= 1 << (pos & 7)
  }

  private getBit(pos: number): boolean {
    return (this.bits[pos >> 3] & (1 << (pos & 7))) !== 0
  }

  add(item: string): void {
    for (let i = 0; i < this.numHashes; i++) {
      this.setBit(this.hash(item, i))
    }
  }

  mightContain(item: string): boolean {
    for (let i = 0; i < this.numHashes; i++) {
      if (!this.getBit(this.hash(item, i))) return false
    }
    return true
  }
}`

registerSkill({
  id: 'bloom-filter',
  summary: 'Bloom Filter - probabilistic set membership, no false negatives, tunable false-positive rate.',
  match(s: SpecFeatures): number {
    let score = 0
    if (s.has(/bloom.?filter/i)) score += 0.95
    if (s.has(/probabilistic.*(set|membership)/i)) score += 0.5
    if (s.has(/false.?positive/i) && s.has(/membership|contain/i)) score += 0.4
    if (s.has(/space.?efficient.*membership/i)) score += 0.3
    return score
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/bloomFilter.ts', content: IMPL }]
  },
})
