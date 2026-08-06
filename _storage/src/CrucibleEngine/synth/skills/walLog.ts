// Verified primitive: Write-Ahead Log — append-only journal with sequence numbers,
// checkpointing, and replay for crash recovery.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Write-Ahead Log.
export interface WALEntry { seq: number; op: string; data: unknown }

export class WAL {
  private entries: WALEntry[] = []
  private seq = 0
  private checkpoint = 0

  append(op: string, data: unknown): WALEntry {
    const entry: WALEntry = { seq: ++this.seq, op, data }
    this.entries.push(entry)
    return entry
  }

  /** Mark all entries up to current seq as durable — entries before can be purged. */
  checkpoint_(): void { this.checkpoint = this.seq }

  /** Entries not yet checkpointed — replay these after a crash. */
  pendingReplay(): WALEntry[] {
    return this.entries.filter(e => e.seq > this.checkpoint)
  }

  /** Full log since last checkpoint (for recovery). */
  replay(fromSeq = 0): WALEntry[] {
    return this.entries.filter(e => e.seq > fromSeq)
  }

  /** Truncate entries safely up to the last checkpoint. */
  truncate(): void {
    this.entries = this.entries.filter(e => e.seq > this.checkpoint)
  }

  size(): number { return this.entries.length }
  lastSeq(): number { return this.seq }
}
`
registerSkill({
  id: 'wal-log',
  summary: 'Write-Ahead Log: append, checkpoint, replay, truncate for crash recovery.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bwal\b|write.?ahead.?log/i)) sc += 0.6
    if (s.has(/\breplay\b/i)) sc += 0.25
    if (s.has(/\bcheckpoint\b/i)) sc += 0.25
    if (s.has(/\bcrash.?recov/i)) sc += 0.2
    if (s.has(/\bappend.?only\b/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/wal.ts', content: IMPL }]
  },
})
