// Verified primitive: persistent key-value store with LRU eviction, per-key TTL, and a
// write-ahead log with crash-recovery replay. General over string keys/values; the
// "persistent cache / KV store" task family maps onto it.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — verified LRU+TTL store with WAL recovery.
import * as fs from 'fs'

interface Entry { value: string; expireAt: number | null }

export class KVStore {
  private map = new Map<string, Entry>()   // insertion order == LRU order (oldest first)
  private max: number
  private walPath: string
  private fd: number

  constructor(opts: { maxEntries: number; walPath: string }) {
    this.max = opts.maxEntries
    this.walPath = opts.walPath
    this.replay()
    this.fd = fs.openSync(this.walPath, 'a')
  }

  private replay(): void {
    if (!fs.existsSync(this.walPath)) return
    for (const line of fs.readFileSync(this.walPath, 'utf8').split('\\n')) {
      if (!line) continue
      try {
        const rec = JSON.parse(line)
        if (rec.op === 'set') this.map.set(rec.key, { value: rec.value, expireAt: rec.expireAt })
        else if (rec.op === 'del') this.map.delete(rec.key)
      } catch { /* skip a torn final line */ }
    }
    const now = Date.now()
    for (const [k, e] of [...this.map]) if (e.expireAt !== null && e.expireAt <= now) this.map.delete(k)
  }

  private append(rec: unknown): void { fs.writeSync(this.fd, JSON.stringify(rec) + '\\n') }

  set(key: string, value: string, ttlMs?: number): void {
    const expireAt = ttlMs != null ? Date.now() + ttlMs : null
    this.map.delete(key)                       // re-insert => most-recently-used
    this.map.set(key, { value, expireAt })
    this.append({ op: 'set', key, value, expireAt })
    while (this.map.size > this.max) {
      const lru = this.map.keys().next().value as string   // oldest
      this.map.delete(lru)
      this.append({ op: 'del', key: lru })
    }
  }

  get(key: string): string | undefined {
    const e = this.map.get(key)
    if (!e) return undefined
    if (e.expireAt !== null && e.expireAt <= Date.now()) { this.map.delete(key); return undefined }
    this.map.delete(key); this.map.set(key, e) // refresh recency
    return e.value
  }

  delete(key: string): boolean {
    const had = this.map.delete(key)
    if (had) this.append({ op: 'del', key })
    return had
  }

  size(): number { return this.map.size }
  close(): void { try { fs.closeSync(this.fd) } catch { /* already closed */ } }
}
`

registerSkill({
  id: 'lru-ttl-wal-store',
  summary: 'Persistent key-value store: LRU eviction + per-key TTL + write-ahead log with crash recovery.',
  match(s: SpecFeatures): number {
    let score = 0
    if (s.has(/\bkv\b|key[- ]?value|key\/value/i)) score += 0.3
    if (s.has(/\blru\b|least[- ]recently[- ]used/i)) score += 0.3
    if (s.has(/\bttl\b|expir/i)) score += 0.2
    if (s.has(/write[- ]?ahead|\bwal\b|crash[- ]recover|persist/i)) score += 0.25
    if (s.has(/\bKVStore\b/)) score += 0.25
    if (s.has(/\bcache\b/i) && s.has(/evict/i)) score += 0.15
    return score
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/kvstore.ts', content: IMPL }]
  },
})
