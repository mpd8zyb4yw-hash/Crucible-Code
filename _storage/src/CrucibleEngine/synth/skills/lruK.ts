// Verified primitive: LRU-K cache — evict based on K-th most recent access, not just LRU.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — LRU-K cache (K=2 default).
export class LRUKCache<K, V> {
  private K: number
  private capacity: number
  private store = new Map<K, V>()
  private history = new Map<K, number[]>()   // last K access timestamps
  private time = 0

  constructor(capacity: number, K = 2) { this.capacity = capacity; this.K = K }

  get(key: K): V | undefined {
    if (!this.store.has(key)) return undefined
    this._touch(key); return this.store.get(key)
  }

  set(key: K, value: V): void {
    if (this.store.has(key)) { this.store.set(key, value); this._touch(key); return }
    if (this.store.size >= this.capacity) this._evict()
    this.store.set(key, value); this._touch(key)
  }

  private _touch(key: K): void {
    const h = this.history.get(key) ?? []
    h.push(++this.time); if (h.length > this.K) h.shift()
    this.history.set(key, h)
  }

  private _evict(): void {
    let worst: K | undefined; let worstKth = Infinity
    for (const [k, h] of this.history) {
      const kth = h.length < this.K ? -1 : h[0]
      if (kth < worstKth) { worstKth = kth; worst = k }
    }
    if (worst !== undefined) { this.store.delete(worst); this.history.delete(worst) }
  }

  size(): number { return this.store.size }
}
`
registerSkill({
  id: 'lru-k',
  summary: 'LRU-K cache: eviction based on K-th most recent access timestamp.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\blru.?k\b/i)) sc += 0.7
    if (s.has(/\bk.?th\b/i) && s.has(/\bcache\b/i)) sc += 0.3
    if (s.has(/\bk.?th.?most.?recent\b/i)) sc += 0.4
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/lruK.ts', content: IMPL }]
  },
})
