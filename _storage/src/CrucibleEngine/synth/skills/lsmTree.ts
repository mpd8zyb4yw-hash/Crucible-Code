// Verified primitive: LSM-tree (Log-Structured Merge-tree) — in-memory MemTable +
// immutable SSTable levels, compaction, point-get, range-scan.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — LSM-tree storage engine.
export class LSMTree<V = unknown> {
  private mem = new Map<string, V | null>()   // null = tombstone
  private levels: Array<Map<string, V | null>> = []
  private readonly memMax: number
  constructor(memMax = 128) { this.memMax = memMax }

  set(key: string, value: V): void {
    this.mem.set(key, value)
    if (this.mem.size >= this.memMax) this._flush()
  }
  delete(key: string): void { this.mem.set(key, null); if (this.mem.size >= this.memMax) this._flush() }

  get(key: string): V | undefined {
    if (this.mem.has(key)) { const v = this.mem.get(key)!; return v === null ? undefined : v }
    for (let i = this.levels.length - 1; i >= 0; i--) {
      if (this.levels[i].has(key)) { const v = this.levels[i].get(key)!; return v === null ? undefined : v }
    }
    return undefined
  }

  *scan(from: string, to: string): IterableIterator<[string, V]> {
    const merged = new Map<string, V | null>()
    for (const lvl of this.levels) for (const [k, v] of lvl) merged.set(k, v)
    for (const [k, v] of this.mem) merged.set(k, v)
    const keys = Array.from(merged.keys()).filter(k => k >= from && k <= to).sort()
    for (const k of keys) { const v = merged.get(k)!; if (v !== null) yield [k, v] }
  }

  private _flush(): void {
    const frozen = new Map(this.mem)
    this.mem.clear()
    this.levels.push(frozen)
    if (this.levels.length > 4) this._compact()
  }

  private _compact(): void {
    const merged = new Map<string, V | null>()
    for (const lvl of this.levels) for (const [k, v] of lvl) merged.set(k, v)
    this.levels = [merged]
  }
}
`
registerSkill({
  id: 'lsm-tree',
  summary: 'LSM-tree: MemTable + SSTable levels, compaction, get/set/delete/scan.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\blsm\b|log.?structured.?merge/i)) sc += 0.6
    if (s.has(/\bmemtable\b/i)) sc += 0.3
    if (s.has(/\bsstable\b/i)) sc += 0.3
    if (s.has(/\bcompact/i)) sc += 0.2
    if (s.has(/\blevel\w*\b/i) && s.has(/\bstor\w+/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/lsmTree.ts', content: IMPL }]
  },
})
