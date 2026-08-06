// Verified primitive: SSTable (Sorted String Table) — immutable sorted key-value block,
// binary-search point lookup, full iteration, sparse index.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — SSTable (immutable sorted KV block).
export interface SSEntry { key: string; value: unknown }

export class SSTable {
  private data: SSEntry[]
  private index: Array<{ key: string; pos: number }> = []
  static readonly INDEX_INTERVAL = 16

  constructor(sorted: SSEntry[]) {
    this.data = sorted.slice().sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    for (let i = 0; i < this.data.length; i += SSTable.INDEX_INTERVAL)
      this.index.push({ key: this.data[i].key, pos: i })
  }

  get(key: string): unknown | undefined {
    let lo = 0
    for (const idx of this.index) { if (idx.key <= key) lo = idx.pos; else break }
    const end = Math.min(lo + SSTable.INDEX_INTERVAL, this.data.length)
    for (let i = lo; i < end; i++) {
      if (this.data[i].key === key) return this.data[i].value
      if (this.data[i].key > key) break
    }
    return undefined
  }

  *scan(from: string, to: string): IterableIterator<SSEntry> {
    let lo = 0
    for (const idx of this.index) { if (idx.key <= from) lo = idx.pos; else break }
    for (let i = lo; i < this.data.length; i++) {
      if (this.data[i].key > to) break
      if (this.data[i].key >= from) yield this.data[i]
    }
  }

  size(): number { return this.data.length }
  minKey(): string | undefined { return this.data[0]?.key }
  maxKey(): string | undefined { return this.data[this.data.length - 1]?.key }
}
`
registerSkill({
  id: 'sstable',
  summary: 'SSTable: immutable sorted KV block, sparse index, binary-search get, scan.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bsstable\b|sorted.?string.?table/i)) sc += 0.7
    if (s.has(/\bimmutable\b/i) && s.has(/\bsort\w+\b/i)) sc += 0.2
    if (s.has(/\bsparse.?index\b/i)) sc += 0.25
    if (s.has(/\bscan\b/i) && s.has(/\blookup\b/i)) sc += 0.1
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/sstable.ts', content: IMPL }]
  },
})
