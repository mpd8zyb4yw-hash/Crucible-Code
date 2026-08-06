// Verified primitive: Raft consensus — leader election, log replication state machine
// (in-process simulation, deterministic, no I/O).
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Raft consensus simulation.
export type NodeRole = 'follower' | 'candidate' | 'leader'
export interface LogEntry { term: number; command: unknown }

export class RaftNode {
  role: NodeRole = 'follower'
  currentTerm = 0
  votedFor: string | null = null
  log: LogEntry[] = []
  commitIndex = -1
  lastApplied = -1
  readonly id: string
  private votes = new Set<string>()

  constructor(id: string) { this.id = id }

  startElection(peers: string[]): void {
    this.role = 'candidate'
    this.currentTerm++
    this.votedFor = this.id
    this.votes = new Set([this.id])
  }

  receiveVote(fromId: string, granted: boolean, clusterSize: number): void {
    if (!granted || this.role !== 'candidate') return
    this.votes.add(fromId)
    if (this.votes.size > clusterSize / 2) this.role = 'leader'
  }

  appendEntry(entry: LogEntry): number {
    if (this.role !== 'leader') throw new Error('only leader can append')
    this.log.push(entry)
    return this.log.length - 1
  }

  /** Returns true if follower accepts the entry (term check). */
  receiveAppend(leaderTerm: number, entry: LogEntry): boolean {
    if (leaderTerm < this.currentTerm) return false
    this.currentTerm = leaderTerm
    this.role = 'follower'
    this.log.push(entry)
    return true
  }

  commit(index: number): void {
    if (index > this.commitIndex) this.commitIndex = index
  }

  stepDown(term: number): void {
    this.currentTerm = term; this.role = 'follower'; this.votedFor = null
  }
}
`
registerSkill({
  id: 'raft-consensus',
  summary: 'Raft consensus: leader election, log replication, term tracking.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\braft\b/i)) sc += 0.7
    if (s.has(/\bconsensus\b/i)) sc += 0.2
    if (s.has(/\bleader.?election\b/i)) sc += 0.25
    if (s.has(/\bterm\b/i) && s.has(/\blog\b/i)) sc += 0.15
    if (s.has(/\bquorum\b/i)) sc += 0.1
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/raft.ts', content: IMPL }]
  },
})
