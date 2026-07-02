// Verified primitive: ARC cache (Adaptive Replacement Cache) — self-tuning between
// recency and frequency.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — ARC cache.
export class ARCCache<K, V> {
  private c: number
  private p = 0          // target size for T1
  private t1 = new Map<K, V>()   // recent, 1 access
  private t2 = new Map<K, V>()   // frequent, 2+ accesses
  private b1 = new Set<K>()      // ghost for T1
  private b2 = new Set<K>()      // ghost for T2

  constructor(capacity: number) { this.c = capacity }

  get(key: K): V | undefined {
    if (this.t1.has(key)) { const v = this.t1.get(key)!; this.t1.delete(key); this.t2.set(key, v); return v }
    if (this.t2.has(key)) { return this.t2.get(key) }
    return undefined
  }

  set(key: K, value: V): void {
    if (this.t1.has(key) || this.t2.has(key)) { this.t2.set(key, value); this.t1.delete(key); return }
    if (this.b1.has(key)) { this.p = Math.min(this.c, this.p + Math.max(1, this.b2.size / this.b1.size || 1)); this.b1.delete(key); this._replace(key); this.t2.set(key, value); return }
    if (this.b2.has(key)) { this.p = Math.max(0, this.p - Math.max(1, this.b1.size / this.b2.size || 1)); this.b2.delete(key); this._replace(key); this.t2.set(key, value); return }
    if (this.t1.size + this.b1.size >= this.c) {
      if (this.t1.size < this.c) { this.b1.delete(this.b1.keys().next().value!); this._replace(key) }
      else { this.t1.delete(this.t1.keys().next().value!) }
    } else if (this.t1.size + this.t2.size + this.b1.size + this.b2.size >= 2 * this.c) {
      if (this.b2.size > 0) this.b2.delete(this.b2.keys().next().value!)
    }
    this.t1.set(key, value)
  }

  private _replace(key: K): void {
    if (this.t1.size > 0 && (this.t1.size > this.p || (this.b2.has(key) && this.t1.size === this.p))) {
      const k = this.t1.keys().next().value!; this.t1.delete(k); this.b1.add(k)
    } else if (this.t2.size > 0) {
      const k = this.t2.keys().next().value!; this.t2.delete(k); this.b2.add(k)
    }
  }

  size(): number { return this.t1.size + this.t2.size }
}
`
registerSkill({
  id: 'arc-cache',
  summary: 'ARC cache: self-tuning adaptive replacement between recency and frequency.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\barc\b/i) && s.has(/\bcache\b/i)) sc += 0.5
    if (s.has(/\badaptive.?replacement\b/i)) sc += 0.5
    if (s.has(/\brecency\b/i) && s.has(/\bfrequency\b/i) && s.has(/\bcache\b/i)) sc += 0.3
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/arcCache.ts', content: IMPL }]
  },
})
