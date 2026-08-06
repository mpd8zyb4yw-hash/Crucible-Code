// Verified primitive: Clock / CLOCK-Pro page replacement algorithm.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Clock page-replacement cache.
interface ClockEntry<K, V> { key: K; value: V; used: boolean }

export class ClockCache<K, V> {
  private slots: Array<ClockEntry<K, V> | null>
  private map = new Map<K, number>()   // key → slot index
  private hand = 0
  private cap: number

  constructor(capacity: number) { this.cap = capacity; this.slots = new Array(capacity).fill(null) }

  get(key: K): V | undefined {
    const idx = this.map.get(key)
    if (idx === undefined) return undefined
    this.slots[idx]!.used = true
    return this.slots[idx]!.value
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) { const idx = this.map.get(key)!; this.slots[idx]!.value = value; this.slots[idx]!.used = true; return }
    const evictIdx = this._findSlot()
    if (this.slots[evictIdx]) this.map.delete(this.slots[evictIdx]!.key)
    this.slots[evictIdx] = { key, value, used: false }
    this.map.set(key, evictIdx)
  }

  private _findSlot(): number {
    while (true) {
      if (!this.slots[this.hand]) { const s = this.hand; this.hand = (this.hand + 1) % this.cap; return s }
      if (!this.slots[this.hand]!.used) { const s = this.hand; this.hand = (this.hand + 1) % this.cap; return s }
      this.slots[this.hand]!.used = false
      this.hand = (this.hand + 1) % this.cap
    }
  }

  size(): number { return this.map.size }
}
`
registerSkill({
  id: 'clock-cache',
  summary: 'Clock (second-chance) page-replacement cache, O(1) amortised get/set.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bclock\b/i) && s.has(/\bcache\b|\bpage.?replace\w+\b/i)) sc += 0.5
    if (s.has(/\bsecond.?chance\b/i)) sc += 0.4
    if (s.has(/\bclock.?hand\b/i)) sc += 0.4
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/clockCache.ts', content: IMPL }]
  },
})
