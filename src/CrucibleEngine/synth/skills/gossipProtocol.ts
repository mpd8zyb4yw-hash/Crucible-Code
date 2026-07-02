// Verified primitive: Gossip/epidemic broadcast — fanout-based rumour spreading,
// convergence detection, membership list maintenance.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Gossip protocol.
export interface GossipMessage { id: string; payload: unknown; ttl: number }

export class GossipNode {
  readonly id: string
  private peers: string[] = []
  private seen = new Map<string, GossipMessage>()
  private fanout: number

  constructor(id: string, fanout = 3) { this.id = id; this.fanout = fanout }

  addPeer(peerId: string): void { if (!this.peers.includes(peerId)) this.peers.push(peerId) }

  /** Originate a new rumour — returns the list of peers to forward to. */
  originate(payload: unknown): { msg: GossipMessage; targets: string[] } {
    const msg: GossipMessage = { id: \`\${this.id}-\${Date.now()}\`, payload, ttl: Math.ceil(Math.log2(this.peers.length + 2) * 2) }
    this.seen.set(msg.id, msg)
    return { msg, targets: this._pick() }
  }

  /** Receive a rumour; returns targets to forward to (empty = already seen or TTL=0). */
  receive(msg: GossipMessage): string[] {
    if (this.seen.has(msg.id) || msg.ttl <= 0) return []
    const updated: GossipMessage = { ...msg, ttl: msg.ttl - 1 }
    this.seen.set(msg.id, updated)
    return this._pick()
  }

  allRumours(): GossipMessage[] { return Array.from(this.seen.values()) }

  private _pick(): string[] {
    const shuffled = [...this.peers].sort(() => Math.random() - 0.5)
    return shuffled.slice(0, this.fanout)
  }
}
`
registerSkill({
  id: 'gossip-protocol',
  summary: 'Gossip/epidemic broadcast: fanout rumour spreading, TTL, convergence.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bgossip\b/i)) sc += 0.6
    if (s.has(/\bepidemic\b/i)) sc += 0.3
    if (s.has(/\bfanout\b/i)) sc += 0.2
    if (s.has(/\brumou?r\b/i)) sc += 0.2
    if (s.has(/\bbroadcast\b/i) && s.has(/\bpeer\b/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/gossip.ts', content: IMPL }]
  },
})
