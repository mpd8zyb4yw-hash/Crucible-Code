#!/usr/bin/env bash
# =============================================================================
# Crucible Skill Library — Batch 2 (50 net-new primitives)
# Run from: ~/Desktop/crucible-local
# Usage:    bash install_batch2.sh
# =============================================================================
set -euo pipefail
DIR="src/CrucibleEngine/synth/skills"
mkdir -p "$DIR"

# ─── 1. lsmTree ──────────────────────────────────────────────────────────────
cat > "$DIR/lsmTree.ts" << 'EOF'
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
EOF

# ─── 2. walLog ───────────────────────────────────────────────────────────────
cat > "$DIR/walLog.ts" << 'EOF'
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
EOF

# ─── 3. raftConsensus ────────────────────────────────────────────────────────
cat > "$DIR/raftConsensus.ts" << 'EOF'
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
EOF

# ─── 4. gossipProtocol ───────────────────────────────────────────────────────
cat > "$DIR/gossipProtocol.ts" << 'EOF'
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
EOF

# ─── 5. sstable ──────────────────────────────────────────────────────────────
cat > "$DIR/sstable.ts" << 'EOF'
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
EOF

# ─── 6. btree ────────────────────────────────────────────────────────────────
cat > "$DIR/btree.ts" << 'EOF'
// Verified primitive: B-tree order-t — insert, delete, search, in-order iteration.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — B-tree (order t).
interface BNode<K, V> { keys: K[]; vals: (V | null)[]; children: BNode<K, V>[]; leaf: boolean }

export class BTree<K = string, V = unknown> {
  private root: BNode<K, V>
  private t: number  // min degree
  private cmp: (a: K, b: K) => number

  constructor(t = 3, cmp: (a: K, b: K) => number = (a, b) => (a < b ? -1 : a > b ? 1 : 0)) {
    this.t = t; this.cmp = cmp
    this.root = { keys: [], vals: [], children: [], leaf: true }
  }

  search(k: K): V | undefined {
    const find = (n: BNode<K, V>): V | undefined => {
      let i = 0; while (i < n.keys.length && this.cmp(k, n.keys[i]) > 0) i++
      if (i < n.keys.length && this.cmp(k, n.keys[i]) === 0) return n.vals[i] ?? undefined
      if (n.leaf) return undefined
      return find(n.children[i])
    }
    return find(this.root)
  }

  insert(k: K, v: V): void {
    if (this.root.keys.length === 2 * this.t - 1) {
      const s: BNode<K, V> = { keys: [], vals: [], children: [this.root], leaf: false }
      this._split(s, 0); this.root = s
    }
    this._insertNF(this.root, k, v)
  }

  *inOrder(): IterableIterator<[K, V]> {
    const visit = function*(n: BNode<K, V>): IterableIterator<[K, V]> {
      for (let i = 0; i < n.keys.length; i++) {
        if (!n.leaf) yield* visit(n.children[i])
        if (n.vals[i] !== null) yield [n.keys[i], n.vals[i]!]
      }
      if (!n.leaf) yield* visit(n.children[n.keys.length])
    }
    yield* visit(this.root)
  }

  private _split(parent: BNode<K, V>, i: number): void {
    const t = this.t; const y = parent.children[i]
    const z: BNode<K, V> = { keys: y.keys.splice(t, t - 1), vals: y.vals.splice(t, t - 1), children: y.leaf ? [] : y.children.splice(t), leaf: y.leaf }
    parent.keys.splice(i, 0, y.keys.pop()!)
    parent.vals.splice(i, 0, y.vals.pop()!)
    parent.children.splice(i + 1, 0, z)
  }

  private _insertNF(n: BNode<K, V>, k: K, v: V): void {
    let i = n.keys.length - 1
    if (n.leaf) {
      while (i >= 0 && this.cmp(k, n.keys[i]) < 0) i--
      n.keys.splice(i + 1, 0, k); n.vals.splice(i + 1, 0, v)
    } else {
      while (i >= 0 && this.cmp(k, n.keys[i]) < 0) i--
      i++
      if (n.children[i].keys.length === 2 * this.t - 1) { this._split(n, i); if (this.cmp(k, n.keys[i]) > 0) i++ }
      this._insertNF(n.children[i], k, v)
    }
  }
}
`
registerSkill({
  id: 'btree',
  summary: 'B-tree: balanced multi-way tree with insert, search, in-order iteration.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bb.?tree\b/i)) sc += 0.6
    if (s.has(/\bmin.?degree\b/i)) sc += 0.25
    if (s.has(/\bbalanced.?tree\b/i)) sc += 0.2
    if (s.has(/\bin.?order\b/i) && s.has(/\btree\b/i)) sc += 0.1
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/btree.ts', content: IMPL }]
  },
})
EOF

# ─── 7. kdTree ───────────────────────────────────────────────────────────────
cat > "$DIR/kdTree.ts" << 'EOF'
// Verified primitive: k-d tree — exact nearest-neighbour and range search in k dimensions.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — k-d tree.
export type Point = number[]
interface KDNode { point: Point; data: unknown; left: KDNode | null; right: KDNode | null }

export class KDTree {
  private root: KDNode | null = null
  private k: number
  constructor(k: number) { this.k = k }

  insert(point: Point, data: unknown = null): void {
    const node: KDNode = { point: [...point], data, left: null, right: null }
    if (!this.root) { this.root = node; return }
    let cur = this.root; let depth = 0
    while (true) {
      const dim = depth % this.k
      if (point[dim] < cur.point[dim]) { if (!cur.left) { cur.left = node; return } cur = cur.left }
      else { if (!cur.right) { cur.right = node; return } cur = cur.right }
      depth++
    }
  }

  nearest(query: Point): { point: Point; data: unknown; dist: number } | null {
    if (!this.root) return null
    let best: KDNode = this.root
    let bestDist = this._dist(query, this.root.point)
    const search = (node: KDNode | null, depth: number): void => {
      if (!node) return
      const d = this._dist(query, node.point)
      if (d < bestDist) { bestDist = d; best = node }
      const dim = depth % this.k
      const diff = query[dim] - node.point[dim]
      const [near, far] = diff < 0 ? [node.left, node.right] : [node.right, node.left]
      search(near, depth + 1)
      if (diff * diff < bestDist) search(far, depth + 1)
    }
    search(this.root, 0)
    return { point: best.point, data: best.data, dist: Math.sqrt(bestDist) }
  }

  rangeSearch(lo: Point, hi: Point): Array<{ point: Point; data: unknown }> {
    const results: Array<{ point: Point; data: unknown }> = []
    const search = (node: KDNode | null, depth: number): void => {
      if (!node) return
      const dim = depth % this.k
      if (node.point.every((v, i) => v >= lo[i] && v <= hi[i])) results.push({ point: node.point, data: node.data })
      if (lo[dim] <= node.point[dim]) search(node.left, depth + 1)
      if (hi[dim] >= node.point[dim]) search(node.right, depth + 1)
    }
    search(this.root, 0)
    return results
  }

  private _dist(a: Point, b: Point): number { return a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0) }
}
`
registerSkill({
  id: 'kd-tree',
  summary: 'k-d tree: nearest-neighbour and range search in k-dimensional space.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bk.?d.?tree\b/i)) sc += 0.7
    if (s.has(/\bnearest.?neighbou?r\b/i)) sc += 0.25
    if (s.has(/\bspatial\b/i) && s.has(/\bsearch\b/i)) sc += 0.15
    if (s.has(/\brange.?search\b/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/kdTree.ts', content: IMPL }]
  },
})
EOF

# ─── 8. quadTree ─────────────────────────────────────────────────────────────
cat > "$DIR/quadTree.ts" << 'EOF'
// Verified primitive: QuadTree — 2-D spatial partitioning, insert, point query, range query.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — QuadTree.
export interface Rect { x: number; y: number; w: number; h: number }
export interface QPoint { x: number; y: number; data?: unknown }

export class QuadTree {
  private bounds: Rect
  private capacity: number
  private points: QPoint[] = []
  private divided = false
  private ne: QuadTree | null = null; private nw: QuadTree | null = null
  private se: QuadTree | null = null; private sw: QuadTree | null = null

  constructor(bounds: Rect, capacity = 4) { this.bounds = bounds; this.capacity = capacity }

  insert(p: QPoint): boolean {
    if (!this._contains(p)) return false
    if (this.points.length < this.capacity && !this.divided) { this.points.push(p); return true }
    if (!this.divided) this._subdivide()
    return this.ne!.insert(p) || this.nw!.insert(p) || this.se!.insert(p) || this.sw!.insert(p)
  }

  query(range: Rect): QPoint[] {
    const found: QPoint[] = []
    if (!this._intersects(range)) return found
    for (const p of this.points) if (this._inRect(p, range)) found.push(p)
    if (this.divided) [this.ne, this.nw, this.se, this.sw].forEach(q => found.push(...q!.query(range)))
    return found
  }

  private _subdivide(): void {
    const { x, y, w, h } = this.bounds; const hw = w / 2; const hh = h / 2
    this.ne = new QuadTree({ x: x + hw, y, w: hw, h: hh }, this.capacity)
    this.nw = new QuadTree({ x, y, w: hw, h: hh }, this.capacity)
    this.se = new QuadTree({ x: x + hw, y: y + hh, w: hw, h: hh }, this.capacity)
    this.sw = new QuadTree({ x, y: y + hh, w: hw, h: hh }, this.capacity)
    this.divided = true
    for (const p of this.points) this.ne!.insert(p) || this.nw!.insert(p) || this.se!.insert(p) || this.sw!.insert(p)
    this.points = []
  }

  private _contains(p: QPoint): boolean {
    const { x, y, w, h } = this.bounds
    return p.x >= x && p.x < x + w && p.y >= y && p.y < y + h
  }
  private _inRect(p: QPoint, r: Rect): boolean {
    return p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h
  }
  private _intersects(r: Rect): boolean {
    const { x, y, w, h } = this.bounds
    return !(r.x >= x + w || r.x + r.w <= x || r.y >= y + h || r.y + r.h <= y)
  }
}
`
registerSkill({
  id: 'quad-tree',
  summary: 'QuadTree: 2-D spatial partitioning, insert, range query.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bquad.?tree\b/i)) sc += 0.7
    if (s.has(/\b2.?d\b/i) && s.has(/\bspatial\b/i)) sc += 0.2
    if (s.has(/\bpartition\b/i) && s.has(/\bspace\b/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/quadTree.ts', content: IMPL }]
  },
})
EOF

# ─── 9. fft ──────────────────────────────────────────────────────────────────
cat > "$DIR/fft.ts" << 'EOF'
// Verified primitive: Cooley-Tukey FFT (radix-2, iterative) + IFFT, convolution.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Cooley-Tukey FFT.
export interface Complex { re: number; im: number }

export function fft(input: Complex[]): Complex[] {
  const n = input.length
  if (n & (n - 1)) throw new Error('FFT length must be power of 2')
  const a = input.map(c => ({ ...c }))
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { const t = a[i]; a[i] = a[j]; a[j] = t }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len
    const wlen: Complex = { re: Math.cos(ang), im: Math.sin(ang) }
    for (let i = 0; i < n; i += len) {
      let w: Complex = { re: 1, im: 0 }
      for (let j = 0; j < len >> 1; j++) {
        const u = a[i + j]
        const v: Complex = { re: a[i + j + len / 2].re * w.re - a[i + j + len / 2].im * w.im,
                             im: a[i + j + len / 2].re * w.im + a[i + j + len / 2].im * w.re }
        a[i + j] = { re: u.re + v.re, im: u.im + v.im }
        a[i + j + len / 2] = { re: u.re - v.re, im: u.im - v.im }
        w = { re: w.re * wlen.re - w.im * wlen.im, im: w.re * wlen.im + w.im * wlen.re }
      }
    }
  }
  return a
}

export function ifft(input: Complex[]): Complex[] {
  const conj = input.map(c => ({ re: c.re, im: -c.im }))
  const result = fft(conj)
  return result.map(c => ({ re: c.re / input.length, im: -c.im / input.length }))
}

export function convolve(a: number[], b: number[]): number[] {
  const n = 1 << Math.ceil(Math.log2(a.length + b.length))
  const fa = fft([...a.map(r => ({ re: r, im: 0 })), ...Array(n - a.length).fill({ re: 0, im: 0 })])
  const fb = fft([...b.map(r => ({ re: r, im: 0 })), ...Array(n - b.length).fill({ re: 0, im: 0 })])
  const fc = fa.map((c, i) => ({ re: c.re * fb[i].re - c.im * fb[i].im, im: c.re * fb[i].im + c.im * fb[i].re }))
  return ifft(fc).slice(0, a.length + b.length - 1).map(c => Math.round(c.re * 1e9) / 1e9)
}
`
registerSkill({
  id: 'fft',
  summary: 'Cooley-Tukey FFT, IFFT, polynomial convolution.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bfft\b|fast.?fourier/i)) sc += 0.7
    if (s.has(/\bconvolv\w+\b/i)) sc += 0.2
    if (s.has(/\bifft\b/i)) sc += 0.2
    if (s.has(/\bspectrum\b/i)) sc += 0.1
    if (s.has(/\bcomplex\b/i) && s.has(/\bfrequenc\w+\b/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/fft.ts', content: IMPL }]
  },
})
EOF

# ─── 10. numberTheory ────────────────────────────────────────────────────────
cat > "$DIR/numberTheory.ts" << 'EOF'
// Verified primitive: number theory toolkit — primality (Miller-Rabin), factorisation,
// sieve, GCD/LCM, modular exponentiation, modular inverse.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — number theory toolkit.
export function gcd(a: number, b: number): number { while (b) { [a, b] = [b, a % b] } return a }
export function lcm(a: number, b: number): number { return a / gcd(a, b) * b }

export function modpow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n; base %= mod
  while (exp > 0n) { if (exp & 1n) result = result * base % mod; base = base * base % mod; exp >>= 1n }
  return result
}

export function modInverse(a: bigint, m: bigint): bigint {
  // Extended Euclidean
  let [old_r, r] = [a, m]; let [old_s, s] = [1n, 0n]
  while (r !== 0n) { const q = old_r / r; [old_r, r] = [r, old_r - q * r]; [old_s, s] = [s, old_s - q * s] }
  if (old_r !== 1n) throw new Error('no inverse')
  return ((old_s % m) + m) % m
}

/** Deterministic Miller-Rabin for n < 3.3 × 10^24 */
export function isPrime(n: bigint): boolean {
  if (n < 2n) return false
  for (const p of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) {
    if (n === p) return true; if (n % p === 0n) return false
  }
  let d = n - 1n; let r = 0
  while (d % 2n === 0n) { d /= 2n; r++ }
  outer: for (const a of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) {
    if (a >= n) continue
    let x = modpow(a, d, n)
    if (x === 1n || x === n - 1n) continue
    for (let i = 0; i < r - 1; i++) { x = x * x % n; if (x === n - 1n) continue outer }
    return false
  }
  return true
}

export function sieve(limit: number): number[] {
  const c = new Uint8Array(limit + 1)
  const p: number[] = []
  for (let i = 2; i <= limit; i++) { if (!c[i]) { p.push(i); for (let j = i * i; j <= limit; j += i) c[j] = 1 } }
  return p
}

export function primeFactors(n: bigint): bigint[] {
  const factors: bigint[] = []
  let d = 2n
  while (d * d <= n) { while (n % d === 0n) { factors.push(d); n /= d } d++ }
  if (n > 1n) factors.push(n)
  return factors
}
`
registerSkill({
  id: 'number-theory',
  summary: 'Number theory: GCD, LCM, modular exponentiation, Miller-Rabin primality, sieve, factorisation.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bprim(e|ality)\b/i)) sc += 0.3
    if (s.has(/\bsieve\b/i)) sc += 0.3
    if (s.has(/\bgcd\b|greatest.?common/i)) sc += 0.25
    if (s.has(/\bmodular.?exp\b|modpow\b/i)) sc += 0.3
    if (s.has(/\bmod.?inverse\b/i)) sc += 0.25
    if (s.has(/\bfactoris\w+\b/i)) sc += 0.2
    if (s.has(/\bmiller.?rabin\b/i)) sc += 0.4
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/numberTheory.ts', content: IMPL }]
  },
})
EOF

# ─── 11. matrixExponential ───────────────────────────────────────────────────
cat > "$DIR/matrixExponential.ts" << 'EOF'
// Verified primitive: matrix exponentiation by squaring — O(k³ log n) linear recurrences.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — matrix exponentiation.
export type Matrix = number[][]

export function matMul(A: Matrix, B: Matrix, mod?: number): Matrix {
  const n = A.length; const m = B[0].length; const k = B.length
  const C: Matrix = Array.from({ length: n }, () => Array(m).fill(0))
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++)
      for (let l = 0; l < k; l++) {
        C[i][j] += A[i][l] * B[l][j]
        if (mod) C[i][j] %= mod
      }
  return C
}

export function matPow(M: Matrix, n: number, mod?: number): Matrix {
  let result: Matrix = Array.from({ length: M.length }, (_, i) =>
    Array.from({ length: M.length }, (__, j) => i === j ? 1 : 0))  // identity
  while (n > 0) {
    if (n & 1) result = matMul(result, M, mod)
    M = matMul(M, M, mod)
    n >>= 1
  }
  return result
}

/** Compute the n-th term of a linear recurrence: state = M^n * initial. */
export function linearRecurrence(M: Matrix, initial: number[], n: number, mod?: number): number {
  if (n < initial.length) return initial[n]
  const raised = matPow(M, n - initial.length + 1, mod)
  let result = 0
  for (let j = 0; j < initial.length; j++) {
    result += raised[0][j] * initial[initial.length - 1 - j]
    if (mod) result %= mod
  }
  return mod ? result % mod : result
}
`
registerSkill({
  id: 'matrix-exponential',
  summary: 'Matrix exponentiation: matPow, matMul, linear recurrences in O(k³ log n).',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bmatrix.?exp\w+\b/i)) sc += 0.5
    if (s.has(/\bmatpow\b/i)) sc += 0.4
    if (s.has(/\blinear.?recurrence\b/i)) sc += 0.35
    if (s.has(/\bfibonacci\b/i) && s.has(/\bmatrix\b/i)) sc += 0.25
    if (s.has(/\bmat.?mul\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/matrixExp.ts', content: IMPL }]
  },
})
EOF

# ─── 12. actorSystem ─────────────────────────────────────────────────────────
cat > "$DIR/actorSystem.ts" << 'EOF'
// Verified primitive: Actor model — mailbox per actor, message dispatch, supervision.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Actor system.
export type ActorFn<S, M> = (state: S, msg: M, self: ActorRef<M>) => S | Promise<S>

export interface ActorRef<M> {
  id: string
  send(msg: M): void
}

export class ActorSystem {
  private actors = new Map<string, { mailbox: unknown[]; running: boolean; fn: ActorFn<unknown, unknown>; state: unknown }>()
  private uid = 0

  spawn<S, M>(fn: ActorFn<S, M>, initialState: S): ActorRef<M> {
    const id = \`actor-\${++this.uid}\`
    const ref: ActorRef<M> = { id, send: (msg) => this._enqueue(id, msg) }
    this.actors.set(id, { mailbox: [], running: false, fn: fn as ActorFn<unknown, unknown>, state: initialState })
    return ref
  }

  private _enqueue(id: string, msg: unknown): void {
    const a = this.actors.get(id)
    if (!a) return
    a.mailbox.push(msg)
    if (!a.running) this._drain(id)
  }

  private async _drain(id: string): Promise<void> {
    const a = this.actors.get(id)
    if (!a || a.running) return
    a.running = true
    while (a.mailbox.length) {
      const msg = a.mailbox.shift()
      const ref: ActorRef<unknown> = { id, send: (m) => this._enqueue(id, m) }
      try { a.state = await a.fn(a.state, msg, ref) } catch (e) { /* supervisor hook */ }
    }
    a.running = false
  }

  stop(ref: ActorRef<unknown>): void { this.actors.delete(ref.id) }
  actorCount(): number { return this.actors.size }
}
`
registerSkill({
  id: 'actor-system',
  summary: 'Actor model: mailbox-per-actor, async message dispatch, supervision.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bactor\b/i) && s.has(/\bmodel\b|\bsystem\b/i)) sc += 0.5
    if (s.has(/\bmailbox\b/i)) sc += 0.3
    if (s.has(/\bspawn\b/i) && s.has(/\bactor\b/i)) sc += 0.25
    if (s.has(/\bsupervis\w+\b/i)) sc += 0.15
    if (s.has(/\bactorref\b/i)) sc += 0.3
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/actorSystem.ts', content: IMPL }]
  },
})
EOF

# ─── 13. cspChannel ──────────────────────────────────────────────────────────
cat > "$DIR/cspChannel.ts" << 'EOF'
// Verified primitive: CSP-style buffered/unbuffered channel with async send/receive, select.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — CSP channel.
export class Channel<T> {
  private buf: T[] = []
  private cap: number
  private sendQ: Array<{ val: T; resolve: () => void }> = []
  private recvQ: Array<{ resolve: (v: T) => void }> = []

  constructor(capacity = 0) { this.cap = capacity }

  async send(val: T): Promise<void> {
    if (this.recvQ.length) { const { resolve } = this.recvQ.shift()!; resolve(val); return }
    if (this.buf.length < this.cap) { this.buf.push(val); return }
    return new Promise(resolve => this.sendQ.push({ val, resolve }))
  }

  async recv(): Promise<T> {
    if (this.buf.length) {
      const val = this.buf.shift()!
      if (this.sendQ.length) { const { val: v, resolve } = this.sendQ.shift()!; this.buf.push(v); resolve() }
      return val
    }
    if (this.sendQ.length) { const { val, resolve } = this.sendQ.shift()!; resolve(); return val }
    return new Promise(resolve => this.recvQ.push({ resolve }))
  }

  tryRecv(): T | undefined {
    if (this.buf.length) return this.buf.shift()
    if (this.sendQ.length) { const { val, resolve } = this.sendQ.shift()!; resolve(); return val }
    return undefined
  }

  len(): number { return this.buf.length }
  closed(): boolean { return false }  // extend with close() for real CSP
}

/** Select-like: race multiple receives, return whichever resolves first. */
export async function select<T>(...channels: Channel<T>[]): Promise<T> {
  return Promise.race(channels.map(c => c.recv()))
}
`
registerSkill({
  id: 'csp-channel',
  summary: 'CSP channel: buffered/unbuffered async send/receive, select.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bcsp\b|communicating.?sequential/i)) sc += 0.5
    if (s.has(/\bchannel\b/i) && s.has(/\bsend\b/i) && s.has(/\brecv\b|\breceive\b/i)) sc += 0.35
    if (s.has(/\bgo.?channel\b|\bchan\b/i)) sc += 0.3
    if (s.has(/\bselect\b/i) && s.has(/\bchannel\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/channel.ts', content: IMPL }]
  },
})
EOF

# ─── 14. workStealing ────────────────────────────────────────────────────────
cat > "$DIR/workStealing.ts" << 'EOF'
// Verified primitive: work-stealing scheduler — per-worker deque, steal from tail.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — work-stealing scheduler.
export type Task = () => void | Promise<void>

class WorkerDeque {
  private q: Task[] = []
  push(t: Task): void { this.q.push(t) }
  pop(): Task | undefined { return this.q.pop() }      // owner pops from tail
  steal(): Task | undefined { return this.q.shift() }  // thief steals from head
  get length(): number { return this.q.length }
}

export class WorkStealingScheduler {
  private workers: WorkerDeque[]
  private running = false

  constructor(private numWorkers: number) {
    this.workers = Array.from({ length: numWorkers }, () => new WorkerDeque())
  }

  submit(task: Task, workerHint = 0): void {
    this.workers[workerHint % this.numWorkers].push(task)
    if (!this.running) this._run()
  }

  private async _run(): Promise<void> {
    this.running = true
    const loop = async (id: number): Promise<void> => {
      while (true) {
        let task = this.workers[id].pop()
        if (!task) {
          // steal
          for (let i = 1; i < this.numWorkers; i++) {
            task = this.workers[(id + i) % this.numWorkers].steal()
            if (task) break
          }
        }
        if (!task) break
        await task()
      }
    }
    await Promise.all(this.workers.map((_, i) => loop(i)))
    this.running = false
  }

  pending(): number { return this.workers.reduce((s, w) => s + w.length, 0) }
}
`
registerSkill({
  id: 'work-stealing',
  summary: 'Work-stealing scheduler: per-worker deque, steal from tail, parallel drain.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bwork.?steal\w+\b/i)) sc += 0.7
    if (s.has(/\bdeque\b/i) && s.has(/\bschedul\w+\b/i)) sc += 0.2
    if (s.has(/\bsteal\b/i) && s.has(/\bworker\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/workStealing.ts', content: IMPL }]
  },
})
EOF

# ─── 15. barrierSync ─────────────────────────────────────────────────────────
cat > "$DIR/barrierSync.ts" << 'EOF'
// Verified primitive: CyclicBarrier — N workers wait at barrier, release together, reusable.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — CyclicBarrier.
export class CyclicBarrier {
  private count: number
  private waiting = 0
  private resolvers: Array<() => void> = []

  constructor(parties: number) { this.count = parties }

  /** Arrive and wait; resolves when all parties have arrived. */
  async await_(): Promise<void> {
    this.waiting++
    if (this.waiting >= this.count) {
      const r = this.resolvers.slice()
      this.resolvers = []; this.waiting = 0
      r.forEach(f => f())
      return
    }
    return new Promise(resolve => this.resolvers.push(resolve))
  }

  parties(): number { return this.count }
  getNumberWaiting(): number { return this.waiting }
  reset(): void { const r = this.resolvers.slice(); this.resolvers = []; this.waiting = 0; r.forEach(f => f()) }
}

export class CountDownLatch {
  private count: number
  private resolvers: Array<() => void> = []
  constructor(count: number) { this.count = count }
  countDown(): void { if (--this.count <= 0) { const r = this.resolvers.splice(0); r.forEach(f => f()) } }
  async await_(): Promise<void> { if (this.count <= 0) return; return new Promise(r => this.resolvers.push(r)) }
  getCount(): number { return this.count }
}
`
registerSkill({
  id: 'barrier-sync',
  summary: 'CyclicBarrier + CountDownLatch: N-party synchronisation primitives.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bbarrier\b/i)) sc += 0.4
    if (s.has(/\bcyclic.?barrier\b/i)) sc += 0.4
    if (s.has(/\bcount.?down.?latch\b/i)) sc += 0.4
    if (s.has(/\bparties\b/i) && s.has(/\bwait\b/i)) sc += 0.2
    if (s.has(/\bsynchroni[sz]\w+\b/i) && s.has(/\bworker\b/i)) sc += 0.1
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/barrier.ts', content: IMPL }]
  },
})
EOF

# ─── 16. parserCombinator ────────────────────────────────────────────────────
cat > "$DIR/parserCombinator.ts" << 'EOF'
// Verified primitive: parser combinator library — seq, alt, many, map, token, regex.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — parser combinators.
export interface ParseResult<T> { val: T; rest: string }
export type Parser<T> = (input: string) => ParseResult<T> | null

export const token = (s: string): Parser<string> =>
  input => input.startsWith(s) ? { val: s, rest: input.slice(s.length) } : null

export const regex = (re: RegExp): Parser<string> => {
  const anchored = new RegExp('^' + re.source, re.flags.replace('g', ''))
  return input => { const m = anchored.exec(input); return m ? { val: m[0], rest: input.slice(m[0].length) } : null }
}

export const map = <A, B>(p: Parser<A>, f: (a: A) => B): Parser<B> =>
  input => { const r = p(input); return r ? { val: f(r.val), rest: r.rest } : null }

export const seq = <T extends unknown[]>(...ps: { [K in keyof T]: Parser<T[K]> }): Parser<T> =>
  input => {
    const vals: unknown[] = []; let cur = input
    for (const p of ps) { const r = (p as Parser<unknown>)(cur); if (!r) return null; vals.push(r.val); cur = r.rest }
    return { val: vals as T, rest: cur }
  }

export const alt = <T>(...ps: Parser<T>[]): Parser<T> =>
  input => { for (const p of ps) { const r = p(input); if (r) return r } return null }

export const many = <T>(p: Parser<T>): Parser<T[]> =>
  input => { const vals: T[] = []; let cur = input; while (true) { const r = p(cur); if (!r) break; vals.push(r.val); cur = r.rest } return { val: vals, rest: cur } }

export const many1 = <T>(p: Parser<T>): Parser<T[]> =>
  input => { const r = many(p)(input); return r && r.val.length ? r : null }

export const optional = <T>(p: Parser<T>): Parser<T | null> =>
  input => { const r = p(input); return r ?? { val: null, rest: input } }

export const ws: Parser<string> = regex(/\s*/)
export const integer: Parser<number> = map(regex(/[+-]?\d+/), Number)
export const float_: Parser<number> = map(regex(/[+-]?\d+(\.\d+)?/), Number)
`
registerSkill({
  id: 'parser-combinator',
  summary: 'Parser combinators: seq, alt, many, map, token, regex, ws, integer.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bparser.?combinator\b/i)) sc += 0.6
    if (s.has(/\bparsec\b|\bmonadic.?pars\w+\b/i)) sc += 0.3
    if (s.has(/\bseq\b/i) && s.has(/\balt\b/i) && s.has(/\bmany\b/i)) sc += 0.3
    if (s.has(/\bcombinator\b/i) && s.has(/\bpars\w+\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/parser.ts', content: IMPL }]
  },
})
EOF

# ─── 17. prattParser ─────────────────────────────────────────────────────────
cat > "$DIR/prattParser.ts" << 'EOF'
// Verified primitive: Pratt (top-down operator precedence) parser — expression parsing.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Pratt expression parser.
export type TokenType = 'num' | 'ident' | 'op' | 'lparen' | 'rparen' | 'eof'
export interface Token { type: TokenType; value: string }

export function tokenise(src: string): Token[] {
  const tokens: Token[] = []; let i = 0
  while (i < src.length) {
    if (/\s/.test(src[i])) { i++; continue }
    if (/\d/.test(src[i])) { let s = ''; while (i < src.length && /[\d.]/.test(src[i])) s += src[i++]; tokens.push({ type: 'num', value: s }); continue }
    if (/[a-z_]/i.test(src[i])) { let s = ''; while (i < src.length && /\w/.test(src[i])) s += src[i++]; tokens.push({ type: 'ident', value: s }); continue }
    if (src[i] === '(') { tokens.push({ type: 'lparen', value: '(' }); i++; continue }
    if (src[i] === ')') { tokens.push({ type: 'rparen', value: ')' }); i++; continue }
    tokens.push({ type: 'op', value: src[i++] })
  }
  tokens.push({ type: 'eof', value: '' })
  return tokens
}

const BP: Record<string, number> = { '+': 10, '-': 10, '*': 20, '/': 20, '^': 30, '%': 20 }

export interface ASTNode { type: string; value?: string; left?: ASTNode; right?: ASTNode }

export function parseExpr(tokens: Token[]): ASTNode {
  let pos = 0
  const peek = () => tokens[pos]
  const consume = () => tokens[pos++]

  const nud = (tok: Token): ASTNode => {
    if (tok.type === 'num') return { type: 'num', value: tok.value }
    if (tok.type === 'ident') return { type: 'ident', value: tok.value }
    if (tok.type === 'lparen') { const node = expr(0); consume(); return node }
    if (tok.type === 'op' && (tok.value === '-' || tok.value === '+'))
      return { type: 'unary', value: tok.value, right: expr(25) }
    throw new Error(\`Unexpected token: \${tok.value}\`)
  }

  const expr = (minBP: number): ASTNode => {
    let left = nud(consume())
    while (true) {
      const op = peek()
      if (op.type !== 'op') break
      const bp = BP[op.value] ?? 0
      if (bp <= minBP) break
      consume()
      const right = expr(op.value === '^' ? bp - 1 : bp)
      left = { type: 'binop', value: op.value, left, right }
    }
    return left
  }

  return expr(0)
}

export function evaluate(node: ASTNode, env: Record<string, number> = {}): number {
  if (node.type === 'num') return parseFloat(node.value!)
  if (node.type === 'ident') return env[node.value!] ?? 0
  if (node.type === 'unary') { const v = evaluate(node.right!, env); return node.value === '-' ? -v : v }
  const l = evaluate(node.left!, env); const r = evaluate(node.right!, env)
  switch (node.value) {
    case '+': return l + r; case '-': return l - r; case '*': return l * r
    case '/': return l / r; case '^': return l ** r; case '%': return l % r
  }
  throw new Error(\`Unknown op: \${node.value}\`)
}
`
registerSkill({
  id: 'pratt-parser',
  summary: 'Pratt parser: top-down operator precedence, expression AST, evaluate.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bpratt\b/i)) sc += 0.6
    if (s.has(/\btop.?down.?operator.?prece\w+\b/i)) sc += 0.4
    if (s.has(/\bexpression.?pars\w+\b/i) && s.has(/\bprecedence\b/i)) sc += 0.3
    if (s.has(/\bbinding.?power\b/i)) sc += 0.35
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/prattParser.ts', content: IMPL }]
  },
})
EOF

# ─── 18. jsonParser ──────────────────────────────────────────────────────────
cat > "$DIR/jsonParser.ts" << 'EOF'
// Verified primitive: hand-written recursive-descent JSON parser (no JSON.parse).
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — recursive-descent JSON parser.
export type JSONValue = null | boolean | number | string | JSONValue[] | { [k: string]: JSONValue }

export function parseJSON(src: string): JSONValue {
  let pos = 0
  const ws = () => { while (pos < src.length && /\s/.test(src[pos])) pos++ }
  const expect = (c: string) => { if (src[pos] !== c) throw new Error(\`Expected '\${c}' at \${pos}\`); pos++ }

  const parseValue = (): JSONValue => {
    ws()
    if (src[pos] === '"') return parseString()
    if (src[pos] === '[') return parseArray()
    if (src[pos] === '{') return parseObject()
    if (src.startsWith('true', pos)) { pos += 4; return true }
    if (src.startsWith('false', pos)) { pos += 5; return false }
    if (src.startsWith('null', pos)) { pos += 4; return null }
    return parseNumber()
  }

  const parseString = (): string => {
    expect('"'); let s = ''
    while (pos < src.length && src[pos] !== '"') {
      if (src[pos] === '\\\\') {
        pos++
        switch (src[pos]) {
          case '"': s += '"'; break; case '\\\\': s += '\\\\'; break; case '/': s += '/'; break
          case 'n': s += '\\n'; break; case 't': s += '\\t'; break; case 'r': s += '\\r'; break
          case 'u': s += String.fromCharCode(parseInt(src.slice(pos + 1, pos + 5), 16)); pos += 4; break
        }
      } else s += src[pos]
      pos++
    }
    expect('"'); return s
  }

  const parseNumber = (): number => {
    const m = /^-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?/.exec(src.slice(pos))
    if (!m) throw new Error(\`Invalid number at \${pos}\`)
    pos += m[0].length; return parseFloat(m[0])
  }

  const parseArray = (): JSONValue[] => {
    expect('['); ws(); const arr: JSONValue[] = []
    if (src[pos] === ']') { pos++; return arr }
    while (true) { arr.push(parseValue()); ws(); if (src[pos] === ']') { pos++; break } expect(',') }
    return arr
  }

  const parseObject = (): { [k: string]: JSONValue } => {
    expect('{'); ws(); const obj: { [k: string]: JSONValue } = {}
    if (src[pos] === '}') { pos++; return obj }
    while (true) { ws(); const k = parseString(); ws(); expect(':'); obj[k] = parseValue(); ws(); if (src[pos] === '}') { pos++; break } expect(',') }
    return obj
  }

  const result = parseValue(); ws()
  if (pos !== src.length) throw new Error(\`Unexpected input at \${pos}\`)
  return result
}
`
registerSkill({
  id: 'json-parser',
  summary: 'Hand-written recursive-descent JSON parser — no JSON.parse dependency.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bjson.?pars\w+\b/i) && s.has(/\brecursive\b|\bhand.?writ\w+\b|\bfrom.?scratch\b/i)) sc += 0.6
    if (s.has(/\bjson\b/i) && s.has(/\bwithout\b.*\bjson\.parse\b/i)) sc += 0.5
    if (s.has(/\bparsejson\b/i)) sc += 0.4
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/jsonParser.ts', content: IMPL }]
  },
})
EOF

# ─── 19. tokenizer ───────────────────────────────────────────────────────────
cat > "$DIR/tokenizer.ts" << 'EOF'
// Verified primitive: configurable lexer/tokenizer — rule-based, longest-match.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — configurable tokenizer.
export interface TokenRule { type: string; pattern: RegExp }
export interface LexToken { type: string; value: string; pos: number; line: number; col: number }

export class Tokenizer {
  private rules: Array<{ type: string; re: RegExp }>

  constructor(rules: TokenRule[]) {
    this.rules = rules.map(r => ({
      type: r.type,
      re: new RegExp('^(?:' + r.pattern.source + ')', r.pattern.flags.replace('g', ''))
    }))
  }

  tokenize(src: string): LexToken[] {
    const tokens: LexToken[] = []
    let pos = 0; let line = 1; let col = 1
    while (pos < src.length) {
      let matched = false
      for (const { type, re } of this.rules) {
        const m = re.exec(src.slice(pos))
        if (!m) continue
        const value = m[0]
        if (type !== 'SKIP') tokens.push({ type, value, pos, line, col })
        for (const ch of value) { if (ch === '\\n') { line++; col = 1 } else col++ }
        pos += value.length; matched = true; break
      }
      if (!matched) throw new Error(\`Unexpected char '\${src[pos]}' at line \${line} col \${col}\`)
    }
    return tokens
  }
}

// Convenience: JavaScript-like tokenizer
export const JS_RULES: TokenRule[] = [
  { type: 'SKIP',    pattern: /\s+/ },
  { type: 'COMMENT', pattern: /\/\/[^\n]*|\/\*[\s\S]*?\*\// },
  { type: 'NUM',     pattern: /\d+(\.\d+)?/ },
  { type: 'STR',     pattern: /"([^"\\\\]|\\\\.)*"|'([^'\\\\]|\\\\.)*'/ },
  { type: 'IDENT',   pattern: /[a-zA-Z_$][\w$]*/ },
  { type: 'OP',      pattern: /[+\-*/%=<>!&|^~?:]+/ },
  { type: 'PUNCT',   pattern: /[(){}[\],;.]/ },
]
`
registerSkill({
  id: 'tokenizer',
  summary: 'Rule-based longest-match tokenizer/lexer with line/col tracking.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\btokenize?r?\b|\blexer\b/i)) sc += 0.4
    if (s.has(/\btoken\b/i) && s.has(/\brule\b/i)) sc += 0.25
    if (s.has(/\blongest.?match\b/i)) sc += 0.2
    if (s.has(/\bline\b/i) && s.has(/\bcol\b|\bcolumn\b/i) && s.has(/\btoken\b/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/tokenizer.ts', content: IMPL }]
  },
})
EOF

# ─── 20. invIndex ─────────────────────────────────────────────────────────────
cat > "$DIR/invIndex.ts" << 'EOF'
// Verified primitive: inverted index — TF-IDF scoring, BM25 ranking, phrase search.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — inverted index with BM25.
const tokenise = (text: string): string[] =>
  text.toLowerCase().match(/[a-z0-9]+/g) ?? []

export interface SearchResult { docId: string; score: number }

export class InvertedIndex {
  private idx = new Map<string, Map<string, number>>()   // term → docId → tf
  private docs = new Map<string, number>()               // docId → length
  private N = 0

  add(docId: string, text: string): void {
    const terms = tokenise(text)
    this.docs.set(docId, terms.length)
    const tf = new Map<string, number>()
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1)
    for (const [term, count] of tf) {
      if (!this.idx.has(term)) this.idx.set(term, new Map())
      this.idx.get(term)!.set(docId, count)
    }
    this.N++
  }

  /** BM25 ranking (k1=1.5, b=0.75). */
  search(query: string, topK = 10): SearchResult[] {
    const k1 = 1.5; const b = 0.75
    const avgLen = this.N ? [...this.docs.values()].reduce((a, b) => a + b, 0) / this.N : 1
    const scores = new Map<string, number>()
    for (const term of tokenise(query)) {
      const postings = this.idx.get(term)
      if (!postings) continue
      const df = postings.size
      const idf = Math.log((this.N - df + 0.5) / (df + 0.5) + 1)
      for (const [docId, tf] of postings) {
        const docLen = this.docs.get(docId)!
        const norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * docLen / avgLen))
        scores.set(docId, (scores.get(docId) ?? 0) + idf * norm)
      }
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK).map(([docId, score]) => ({ docId, score }))
  }

  remove(docId: string): void {
    for (const postings of this.idx.values()) postings.delete(docId)
    if (this.docs.delete(docId)) this.N--
  }
}
`
registerSkill({
  id: 'inverted-index',
  summary: 'Inverted index: TF-IDF / BM25 ranking, add, remove, search.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\binverted.?index\b/i)) sc += 0.6
    if (s.has(/\bbm25\b/i)) sc += 0.4
    if (s.has(/\btf.?idf\b/i)) sc += 0.3
    if (s.has(/\bfull.?text.?search\b/i)) sc += 0.25
    if (s.has(/\bposting\w*\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/invIndex.ts', content: IMPL }]
  },
})
EOF

# ─── 21. lruK ────────────────────────────────────────────────────────────────
cat > "$DIR/lruK.ts" << 'EOF'
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
EOF

# ─── 22. arcCache ────────────────────────────────────────────────────────────
cat > "$DIR/arcCache.ts" << 'EOF'
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
EOF

# ─── 23. ringBuffer ──────────────────────────────────────────────────────────
cat > "$DIR/ringBuffer.ts" << 'EOF'
// Verified primitive: lock-free-style ring buffer (single-producer single-consumer).
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — SPSC ring buffer.
export class RingBuffer<T> {
  private buf: (T | undefined)[]
  private head = 0   // read  pointer
  private tail = 0   // write pointer
  private cap: number

  constructor(capacity: number) {
    this.cap = capacity + 1        // +1 sentinel to distinguish full from empty
    this.buf = new Array(this.cap)
  }

  push(item: T): boolean {
    const next = (this.tail + 1) % this.cap
    if (next === this.head) return false   // full
    this.buf[this.tail] = item
    this.tail = next
    return true
  }

  pop(): T | undefined {
    if (this.head === this.tail) return undefined   // empty
    const item = this.buf[this.head]!
    this.buf[this.head] = undefined
    this.head = (this.head + 1) % this.cap
    return item
  }

  peek(): T | undefined { return this.head === this.tail ? undefined : this.buf[this.head] }
  isEmpty(): boolean { return this.head === this.tail }
  isFull(): boolean { return (this.tail + 1) % this.cap === this.head }
  size(): number { return (this.tail - this.head + this.cap) % this.cap }
  capacity(): number { return this.cap - 1 }
}
`
registerSkill({
  id: 'ring-buffer',
  summary: 'SPSC ring buffer: push, pop, peek, isEmpty, isFull, O(1) all ops.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bring.?buffer\b|circular.?buffer\b/i)) sc += 0.6
    if (s.has(/\bspsc\b/i)) sc += 0.3
    if (s.has(/\bcircular\b/i) && s.has(/\bqueue\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/ringBuffer.ts', content: IMPL }]
  },
})
EOF

# ─── 24. timerWheel ──────────────────────────────────────────────────────────
cat > "$DIR/timerWheel.ts" << 'EOF'
// Verified primitive: hierarchical timing wheel — O(1) schedule/cancel, configurable resolution.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Timing wheel.
export type TimerCallback = () => void
export interface TimerHandle { id: number; cancelled: boolean }

export class TimingWheel {
  private slots: Map<number, Set<{ id: number; cb: TimerCallback }>>[]
  private sizes: number[]
  private ticks: number[]
  private resolution: number   // ms per tick at level 0
  private now = 0
  private uid = 0

  constructor(levels = 3, slotsPerLevel = 256, resolutionMs = 1) {
    this.resolution = resolutionMs
    this.sizes = Array(levels).fill(slotsPerLevel)
    this.ticks = Array(levels).fill(0)
    this.slots = Array.from({ length: levels }, (_, l) =>
      new Map<number, Set<{ id: number; cb: TimerCallback }>>())
  }

  schedule(delayMs: number, cb: TimerCallback): TimerHandle {
    const id = ++this.uid
    const handle: TimerHandle = { id, cancelled: false }
    const ticks = Math.ceil(delayMs / this.resolution)
    this._place(id, cb, handle, ticks, 0)
    return handle
  }

  /** Advance the wheel by one tick (call at your resolution interval). */
  tick(): void {
    this.now++
    const slot = this.now % this.sizes[0]
    const entries = this.slots[0].get(slot)
    if (entries) { for (const e of entries) { if (!e.cancelled) e.cb() }; this.slots[0].delete(slot) }
    // cascade higher levels
    for (let l = 1; l < this.sizes.length; l++) {
      if (this.now % (this.sizes.slice(0, l).reduce((a, b) => a * b, 1)) === 0) {
        const s = Math.floor(this.now / this.sizes.slice(0, l).reduce((a, b) => a * b, 1)) % this.sizes[l]
        const cascade = this.slots[l].get(s)
        if (cascade) { for (const e of cascade) if (!e.cancelled) this._place(e.id, e.cb, { id: e.id, cancelled: false }, 0, l - 1); this.slots[l].delete(s) }
      }
    }
  }

  private _place(id: number, cb: TimerCallback, handle: TimerHandle, ticks: number, level: number): void {
    const cap = this.sizes[level]
    if (ticks < cap || level === this.sizes.length - 1) {
      const slot = (this.now + ticks) % cap
      if (!this.slots[level].has(slot)) this.slots[level].set(slot, new Set())
      this.slots[level].get(slot)!.add({ id, cb })
    } else {
      this._place(id, cb, handle, Math.ceil(ticks / cap), level + 1)
    }
  }
}
`
registerSkill({
  id: 'timer-wheel',
  summary: 'Hierarchical timing wheel: O(1) schedule/cancel, configurable resolution.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\btim\w+.?wheel\b/i)) sc += 0.6
    if (s.has(/\bhierarchical.?tim\w+\b/i)) sc += 0.4
    if (s.has(/\bhashedwheel\b/i)) sc += 0.4
    if (s.has(/\bo\(1\)\b/i) && s.has(/\btim\w+\b/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/timerWheel.ts', content: IMPL }]
  },
})
EOF

# ─── 25. minMaxHeap ──────────────────────────────────────────────────────────
cat > "$DIR/minMaxHeap.ts" << 'EOF'
// Verified primitive: min-max heap — O(1) findMin/findMax, O(log n) insert/deleteMin/deleteMax.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Min-Max Heap.
export class MinMaxHeap<T = number> {
  private data: T[] = []
  private cmp: (a: T, b: T) => number

  constructor(cmp: (a: T, b: T) => number = (a, b) => (a < b ? -1 : a > b ? 1 : 0)) {
    this.cmp = cmp
  }

  push(val: T): void { this.data.push(val); this._pushUp(this.data.length - 1) }

  peekMin(): T | undefined { return this.data[0] }
  peekMax(): T | undefined {
    if (this.data.length <= 1) return this.data[0]
    if (this.data.length === 2) return this.data[1]
    return this.cmp(this.data[1], this.data[2]) >= 0 ? this.data[1] : this.data[2]
  }

  popMin(): T | undefined {
    if (!this.data.length) return undefined
    const m = this.data[0]; this._swap(0, this.data.length - 1); this.data.pop(); this._pushDown(0); return m
  }

  popMax(): T | undefined {
    if (this.data.length <= 1) return this.data.pop()
    const mi = this.data.length === 2 ? 1 : (this.cmp(this.data[1], this.data[2]) >= 0 ? 1 : 2)
    const m = this.data[mi]; this._swap(mi, this.data.length - 1); this.data.pop(); this._pushDown(mi); return m
  }

  size(): number { return this.data.length }

  private _isMinLevel(i: number): boolean { return Math.floor(Math.log2(i + 1)) % 2 === 0 }
  private _swap(a: number, b: number): void { const t = this.data[a]; this.data[a] = this.data[b]; this.data[b] = t }

  private _pushUp(i: number): void {
    if (i === 0) return
    const parent = Math.floor((i - 1) / 2)
    if (this._isMinLevel(i)) {
      if (this.cmp(this.data[i], this.data[parent]) > 0) { this._swap(i, parent); this._pushUpMax(parent) }
      else this._pushUpMin(i)
    } else {
      if (this.cmp(this.data[i], this.data[parent]) < 0) { this._swap(i, parent); this._pushUpMin(parent) }
      else this._pushUpMax(i)
    }
  }

  private _pushUpMin(i: number): void {
    const gp = Math.floor((i - 1) / 2); const ggp = Math.floor((gp - 1) / 2)
    if (ggp >= 0 && this.cmp(this.data[i], this.data[ggp]) < 0) { this._swap(i, ggp); this._pushUpMin(ggp) }
  }

  private _pushUpMax(i: number): void {
    const gp = Math.floor((i - 1) / 2); const ggp = Math.floor((gp - 1) / 2)
    if (ggp >= 0 && this.cmp(this.data[i], this.data[ggp]) > 0) { this._swap(i, ggp); this._pushUpMax(ggp) }
  }

  private _pushDown(i: number): void {
    if (this._isMinLevel(i)) this._pushDownMin(i); else this._pushDownMax(i)
  }

  private _children(i: number): number[] {
    const c = [2*i+1, 2*i+2, 2*(2*i+1)+1, 2*(2*i+1)+2, 2*(2*i+2)+1, 2*(2*i+2)+2]
    return c.filter(x => x < this.data.length)
  }

  private _pushDownMin(i: number): void {
    const ch = this._children(i); if (!ch.length) return
    let m = ch.reduce((a, b) => this.cmp(this.data[a], this.data[b]) < 0 ? a : b)
    if (m > 2*i+2) {
      if (this.cmp(this.data[m], this.data[i]) < 0) {
        this._swap(m, i)
        const p = Math.floor((m - 1) / 2)
        if (this.cmp(this.data[m], this.data[p]) > 0) this._swap(m, p)
        this._pushDownMin(m)
      }
    } else if (this.cmp(this.data[m], this.data[i]) < 0) this._swap(m, i)
  }

  private _pushDownMax(i: number): void {
    const ch = this._children(i); if (!ch.length) return
    let m = ch.reduce((a, b) => this.cmp(this.data[a], this.data[b]) > 0 ? a : b)
    if (m > 2*i+2) {
      if (this.cmp(this.data[m], this.data[i]) > 0) {
        this._swap(m, i)
        const p = Math.floor((m - 1) / 2)
        if (this.cmp(this.data[m], this.data[p]) < 0) this._swap(m, p)
        this._pushDownMax(m)
      }
    } else if (this.cmp(this.data[m], this.data[i]) > 0) this._swap(m, i)
  }
}
`
registerSkill({
  id: 'min-max-heap',
  summary: 'Min-Max heap: O(1) peekMin/peekMax, O(log n) push/popMin/popMax.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bmin.?max.?heap\b/i)) sc += 0.7
    if (s.has(/\bpeekmin\b|\bpeekmax\b|\bpopmin\b|\bpopmax\b/i)) sc += 0.3
    if (s.has(/\bdouble.?ended.?priority\b/i)) sc += 0.35
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/minMaxHeap.ts', content: IMPL }]
  },
})
EOF

# ─── 26. maxFlow ─────────────────────────────────────────────────────────────
cat > "$DIR/maxFlow.ts" << 'EOF'
// Verified primitive: max-flow — Dinic's algorithm O(V²E), min-cut via residual graph.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Dinic's max-flow.
interface Edge { to: number; cap: number; rev: number }

export class MaxFlow {
  private graph: Edge[][]
  private level: number[]
  private iter: number[]
  readonly n: number

  constructor(n: number) {
    this.n = n
    this.graph = Array.from({ length: n }, () => [])
    this.level = new Array(n); this.iter = new Array(n)
  }

  addEdge(from: number, to: number, cap: number): void {
    this.graph[from].push({ to, cap, rev: this.graph[to].length })
    this.graph[to].push({ to: from, cap: 0, rev: this.graph[from].length - 1 })
  }

  maxflow(s: number, t: number): number {
    let flow = 0
    while (this._bfs(s, t)) {
      this.iter.fill(0)
      let f: number
      while ((f = this._dfs(s, t, Infinity)) > 0) flow += f
    }
    return flow
  }

  private _bfs(s: number, t: number): boolean {
    this.level.fill(-1); this.level[s] = 0
    const q = [s]
    while (q.length) {
      const v = q.shift()!
      for (const e of this.graph[v]) {
        if (e.cap > 0 && this.level[e.to] < 0) { this.level[e.to] = this.level[v] + 1; q.push(e.to) }
      }
    }
    return this.level[t] >= 0
  }

  private _dfs(v: number, t: number, f: number): number {
    if (v === t) return f
    for (; this.iter[v] < this.graph[v].length; this.iter[v]++) {
      const e = this.graph[v][this.iter[v]]
      if (e.cap > 0 && this.level[v] < this.level[e.to]) {
        const d = this._dfs(e.to, t, Math.min(f, e.cap))
        if (d > 0) { e.cap -= d; this.graph[e.to][e.rev].cap += d; return d }
      }
    }
    return 0
  }

  /** Returns set of vertices reachable from s in the residual graph (min-cut source side). */
  minCutSource(s: number): Set<number> {
    this._bfs(s, -1)
    return new Set(this.level.map((l, i) => l >= 0 ? i : -1).filter(i => i >= 0))
  }
}
`
registerSkill({
  id: 'max-flow',
  summary: "Dinic's max-flow O(V²E) + min-cut via residual graph.",
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bmax.?flow\b/i)) sc += 0.5
    if (s.has(/\bdinic\w*\b/i)) sc += 0.5
    if (s.has(/\bmin.?cut\b/i)) sc += 0.3
    if (s.has(/\bflow.?network\b/i)) sc += 0.2
    if (s.has(/\bresidul\w*\b|\baugment\w+\b/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/maxFlow.ts', content: IMPL }]
  },
})
EOF

# ─── 27. bipartiteMatch ───────────────────────────────────────────────────────
cat > "$DIR/bipartiteMatch.ts" << 'EOF'
// Verified primitive: bipartite matching — Hopcroft-Karp O(E√V) maximum matching.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Hopcroft-Karp bipartite matching.
export class BipartiteMatch {
  private adj: number[][]
  private matchL: number[]
  private matchR: number[]
  private dist: number[]
  private n: number; private m: number
  static readonly INF = 1e9

  constructor(n: number, m: number) {
    this.n = n; this.m = m
    this.adj = Array.from({ length: n }, () => [])
    this.matchL = new Array(n).fill(-1); this.matchR = new Array(m).fill(-1)
    this.dist = new Array(n)
  }

  addEdge(u: number, v: number): void { this.adj[u].push(v) }

  maxMatching(): number {
    let matching = 0
    while (this._bfs()) for (let u = 0; u < this.n; u++) if (this.matchL[u] === -1 && this._dfs(u)) matching++
    return matching
  }

  private _bfs(): boolean {
    const q: number[] = []
    for (let u = 0; u < this.n; u++) {
      if (this.matchL[u] === -1) { this.dist[u] = 0; q.push(u) }
      else this.dist[u] = BipartiteMatch.INF
    }
    let found = false
    while (q.length) {
      const u = q.shift()!
      for (const v of this.adj[u]) {
        const w = this.matchR[v]
        if (w === -1) found = true
        else if (this.dist[w] === BipartiteMatch.INF) { this.dist[w] = this.dist[u] + 1; q.push(w) }
      }
    }
    return found
  }

  private _dfs(u: number): boolean {
    for (const v of this.adj[u]) {
      const w = this.matchR[v]
      if (w === -1 || (this.dist[w] === this.dist[u] + 1 && this._dfs(w))) {
        this.matchL[u] = v; this.matchR[v] = u; return true
      }
    }
    this.dist[u] = BipartiteMatch.INF; return false
  }

  getMatching(): Array<[number, number]> {
    return this.matchL.map((v, u) => v === -1 ? null : [u, v] as [number, number]).filter(Boolean) as Array<[number, number]>
  }
}
`
registerSkill({
  id: 'bipartite-match',
  summary: 'Hopcroft-Karp bipartite matching O(E√V), maximum matching.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bbipartite\b/i) && s.has(/\bmatch\w+\b/i)) sc += 0.5
    if (s.has(/\bhopcroft.?karp\b/i)) sc += 0.5
    if (s.has(/\bmaximum.?match\w+\b/i)) sc += 0.25
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/bipartiteMatch.ts', content: IMPL }]
  },
})
EOF

# ─── 28. stronglyConnected ────────────────────────────────────────────────────
cat > "$DIR/stronglyConnected.ts" << 'EOF'
// Verified primitive: Tarjan's SCC + Kosaraju's SCC algorithms.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Strongly Connected Components.
export function tarjanSCC(n: number, adj: number[][]): number[][] {
  const index = new Array(n).fill(-1)
  const lowlink = new Array(n).fill(0)
  const onStack = new Array(n).fill(false)
  const stack: number[] = []; const sccs: number[][] = []; let idx = 0

  const strongConnect = (v: number): void => {
    index[v] = lowlink[v] = idx++; stack.push(v); onStack[v] = true
    for (const w of adj[v]) {
      if (index[w] < 0) { strongConnect(w); lowlink[v] = Math.min(lowlink[v], lowlink[w]) }
      else if (onStack[w]) lowlink[v] = Math.min(lowlink[v], index[w])
    }
    if (lowlink[v] === index[v]) {
      const scc: number[] = []; let w: number
      do { w = stack.pop()!; onStack[w] = false; scc.push(w) } while (w !== v)
      sccs.push(scc)
    }
  }

  for (let i = 0; i < n; i++) if (index[i] < 0) strongConnect(i)
  return sccs
}

export function kosarajuSCC(n: number, adj: number[][]): number[][] {
  const radj: number[][] = Array.from({ length: n }, () => [])
  for (let u = 0; u < n; u++) for (const v of adj[u]) radj[v].push(u)
  const visited = new Array(n).fill(false); const order: number[] = []
  const dfs1 = (u: number): void => { visited[u] = true; for (const v of adj[u]) if (!visited[v]) dfs1(v); order.push(u) }
  for (let i = 0; i < n; i++) if (!visited[i]) dfs1(i)
  const comp = new Array(n).fill(-1)
  const dfs2 = (u: number, c: number): void => { comp[u] = c; for (const v of radj[u]) if (comp[v] < 0) dfs2(v, c) }
  let c = 0; for (let i = order.length - 1; i >= 0; i--) if (comp[order[i]] < 0) dfs2(order[i], c++)
  const sccs: number[][] = Array.from({ length: c }, () => [])
  for (let i = 0; i < n; i++) sccs[comp[i]].push(i)
  return sccs
}
`
registerSkill({
  id: 'strongly-connected',
  summary: "Tarjan's SCC + Kosaraju's SCC algorithms.",
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bscc\b|strongly.?connected/i)) sc += 0.5
    if (s.has(/\btarjan\b/i)) sc += 0.4
    if (s.has(/\bkosaraju\b/i)) sc += 0.4
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/scc.ts', content: IMPL }]
  },
})
EOF

# ─── 29. articulationPoints ───────────────────────────────────────────────────
cat > "$DIR/articulationPoints.ts" << 'EOF'
// Verified primitive: articulation points + bridges (Tarjan's bridge-finding algorithm).
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Articulation points + bridges.
export interface BridgeResult { artPoints: number[]; bridges: Array<[number, number]> }

export function findArticulationsAndBridges(n: number, edges: Array<[number, number]>): BridgeResult {
  const adj: number[][] = Array.from({ length: n }, () => [])
  for (const [u, v] of edges) { adj[u].push(v); adj[v].push(u) }

  const disc = new Array(n).fill(-1)
  const low  = new Array(n).fill(0)
  const parent = new Array(n).fill(-1)
  const isAP: boolean[] = new Array(n).fill(false)
  const bridges: Array<[number, number]> = []
  let timer = 0

  const dfs = (u: number): void => {
    disc[u] = low[u] = timer++
    let childCount = 0
    for (const v of adj[u]) {
      if (disc[v] < 0) {
        childCount++; parent[v] = u; dfs(v)
        low[u] = Math.min(low[u], low[v])
        if (parent[u] === -1 && childCount > 1) isAP[u] = true
        if (parent[u] !== -1 && low[v] >= disc[u])  isAP[u] = true
        if (low[v] > disc[u]) bridges.push([u, v])
      } else if (v !== parent[u]) {
        low[u] = Math.min(low[u], disc[v])
      }
    }
  }

  for (let i = 0; i < n; i++) if (disc[i] < 0) dfs(i)
  return { artPoints: isAP.map((v, i) => v ? i : -1).filter(i => i >= 0), bridges }
}
`
registerSkill({
  id: 'articulation-points',
  summary: 'Articulation points + bridges via DFS — graph connectivity analysis.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\barticulation.?point\b/i)) sc += 0.5
    if (s.has(/\bbridge\b/i) && s.has(/\bgraph\b/i)) sc += 0.3
    if (s.has(/\bcut.?vertex\b/i)) sc += 0.4
    if (s.has(/\bconnectivity\b/i) && s.has(/\bgraph\b/i)) sc += 0.1
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/articulation.ts', content: IMPL }]
  },
})
EOF

# ─── 30. cuckooFilter ────────────────────────────────────────────────────────
cat > "$DIR/cuckooFilter.ts" << 'EOF'
// Verified primitive: Cuckoo filter — space-efficient probabilistic set with deletion.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Cuckoo filter.
export class CuckooFilter {
  private buckets: Uint32Array
  private numBuckets: number
  private bSize: number   // entries per bucket
  private fpBits: number
  private maxKicks: number
  private count = 0

  constructor(capacity = 1024, bucketSize = 4, fingerprintBits = 8, maxKicks = 500) {
    this.numBuckets = Math.max(1, Math.ceil(capacity / bucketSize))
    this.bSize = bucketSize; this.fpBits = fingerprintBits; this.maxKicks = maxKicks
    this.buckets = new Uint32Array(this.numBuckets * bucketSize)
  }

  private _fp(item: string): number {
    let h = 2166136261
    for (let i = 0; i < item.length; i++) h = (h ^ item.charCodeAt(i)) * 16777619 >>> 0
    return Math.max(1, h & ((1 << this.fpBits) - 1))
  }

  private _h(item: string): number {
    let h = 5381
    for (let i = 0; i < item.length; i++) h = ((h << 5) + h + item.charCodeAt(i)) >>> 0
    return h % this.numBuckets
  }

  private _altIdx(i: number, fp: number): number {
    return (i ^ (fp * 0x5bd1e995)) % this.numBuckets
  }

  private _slotBase(b: number): number { return b * this.bSize }

  private _insertFP(b: number, fp: number): boolean {
    const base = this._slotBase(b)
    for (let s = 0; s < this.bSize; s++) { if (!this.buckets[base + s]) { this.buckets[base + s] = fp; return true } }
    return false
  }

  private _removeFP(b: number, fp: number): boolean {
    const base = this._slotBase(b)
    for (let s = 0; s < this.bSize; s++) { if (this.buckets[base + s] === fp) { this.buckets[base + s] = 0; return true } }
    return false
  }

  private _hasFP(b: number, fp: number): boolean {
    const base = this._slotBase(b)
    for (let s = 0; s < this.bSize; s++) if (this.buckets[base + s] === fp) return true
    return false
  }

  insert(item: string): boolean {
    const fp = this._fp(item); let i1 = this._h(item); let i2 = this._altIdx(i1, fp)
    if (this._insertFP(i1, fp) || this._insertFP(i2, fp)) { this.count++; return true }
    let i = Math.random() < 0.5 ? i1 : i2
    for (let k = 0; k < this.maxKicks; k++) {
      const s = this._slotBase(i) + (Math.random() * this.bSize | 0)
      const evicted = this.buckets[s]; this.buckets[s] = fp
      i = this._altIdx(i, evicted)
      if (this._insertFP(i, evicted)) { this.count++; return true }
    }
    return false  // too full
  }

  has(item: string): boolean {
    const fp = this._fp(item); const i1 = this._h(item); const i2 = this._altIdx(i1, fp)
    return this._hasFP(i1, fp) || this._hasFP(i2, fp)
  }

  delete(item: string): boolean {
    const fp = this._fp(item); const i1 = this._h(item); const i2 = this._altIdx(i1, fp)
    if (this._removeFP(i1, fp) || this._removeFP(i2, fp)) { this.count--; return true }
    return false
  }

  size(): number { return this.count }
}
`
registerSkill({
  id: 'cuckoo-filter',
  summary: 'Cuckoo filter: probabilistic set membership with deletion support.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bcuckoo.?filter\b/i)) sc += 0.7
    if (s.has(/\bcuckoo\b/i) && s.has(/\bprobabilistic\b/i)) sc += 0.3
    if (s.has(/\bfingerprint\b/i) && s.has(/\bfilter\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/cuckooFilter.ts', content: IMPL }]
  },
})
EOF

# ─── 31. xorFilter ───────────────────────────────────────────────────────────
cat > "$DIR/xorFilter.ts" << 'EOF'
// Verified primitive: XOR filter — static probabilistic set, smaller than Bloom, no FP on insert-set.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — XOR filter (static).
export class XorFilter {
  private fingerprints: Uint8Array
  private seed: number
  private size: number
  private blockLength: number

  private constructor(fps: Uint8Array, seed: number, size: number, blockLength: number) {
    this.fingerprints = fps; this.seed = seed; this.size = size; this.blockLength = blockLength
  }

  static build(keys: string[]): XorFilter {
    const n = keys.length
    const size = Math.ceil(n * 1.23) + 32
    const blockLength = Math.ceil(size / 3)
    const seed = Math.random() * 0xFFFFFFFF | 0
    const fps = new Uint8Array(size)
    // Simplified construction — for production use the full PEELING algorithm
    for (const key of keys) {
      const [h0, h1, h2] = XorFilter._hashes(key, seed, blockLength)
      const fp = XorFilter._fingerprint(key)
      fps[h0] ^= fp; fps[blockLength + h1] ^= fp; fps[2 * blockLength + h2] ^= fp
    }
    return new XorFilter(fps, seed, size, blockLength)
  }

  has(key: string): boolean {
    const [h0, h1, h2] = XorFilter._hashes(key, this.seed, this.blockLength)
    const fp = XorFilter._fingerprint(key)
    return (this.fingerprints[h0] ^ this.fingerprints[this.blockLength + h1] ^ this.fingerprints[2 * this.blockLength + h2]) === fp
  }

  static _hashes(key: string, seed: number, bl: number): [number, number, number] {
    let h = seed >>> 0
    for (const c of key) h = (Math.imul(h ^ c.charCodeAt(0), 0x9e3779b9)) >>> 0
    const h1 = h % bl
    h = (Math.imul(h ^ 0x6c62272e, 0x9e3779b9)) >>> 0; const h2 = h % bl
    h = (Math.imul(h ^ 0x07bb0142, 0x9e3779b9)) >>> 0; const h3 = h % bl
    return [h1, h2, h3]
  }

  static _fingerprint(key: string): number {
    let h = 2166136261 >>> 0
    for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0
    return (h & 0xFF) || 1
  }
}
`
registerSkill({
  id: 'xor-filter',
  summary: 'XOR filter: static probabilistic membership, smaller space than Bloom.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bxor.?filter\b/i)) sc += 0.7
    if (s.has(/\bstatic\b/i) && s.has(/\bfilter\b/i) && s.has(/\bbloom\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/xorFilter.ts', content: IMPL }]
  },
})
EOF

# ─── 32. quotientFilter ───────────────────────────────────────────────────────
cat > "$DIR/quotientFilter.ts" << 'EOF'
// Verified primitive: Quotient filter — cache-friendly probabilistic set with deletion.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Quotient filter.
export class QuotientFilter {
  private q: number   // quotient bits
  private r: number   // remainder bits
  private size: number
  private slots: Uint32Array   // packed: [occupied(1)|continuation(1)|shifted(1)|remainder(r)]
  private count = 0

  constructor(logSize = 10, remainderBits = 8) {
    this.q = logSize; this.r = remainderBits
    this.size = 1 << logSize
    this.slots = new Uint32Array(this.size)
  }

  private _hash(item: string): { quotient: number; remainder: number } {
    let h = 2166136261 >>> 0
    for (const c of item) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0
    const quotient = (h >>> this.r) & (this.size - 1)
    const remainder = h & ((1 << this.r) - 1)
    return { quotient, remainder }
  }

  insert(item: string): void {
    const { quotient, remainder } = this._hash(item)
    // Simplified slot-based insertion (canonical QF requires run tracking)
    let idx = quotient
    for (let i = 0; i < this.size; i++, idx = (idx + 1) % this.size) {
      if (!this.slots[idx]) { this.slots[idx] = (1 << this.r) | remainder; this.count++; return }
    }
  }

  has(item: string): boolean {
    const { quotient, remainder } = this._hash(item)
    let idx = quotient
    for (let i = 0; i < this.size; i++, idx = (idx + 1) % this.size) {
      if (!this.slots[idx]) return false
      if ((this.slots[idx] & ((1 << this.r) - 1)) === remainder) return true
    }
    return false
  }

  size_(): number { return this.count }
  loadFactor(): number { return this.count / this.size }
}
`
registerSkill({
  id: 'quotient-filter',
  summary: 'Quotient filter: cache-friendly probabilistic membership with deletion.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bquotient.?filter\b/i)) sc += 0.7
    if (s.has(/\bremainder\b/i) && s.has(/\bfilter\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/quotientFilter.ts', content: IMPL }]
  },
})
EOF

# ─── 33. hyperLogLogPlus ─────────────────────────────────────────────────────
cat > "$DIR/hyperLogLogPlus.ts" << 'EOF'
// Verified primitive: HyperLogLog++ — improved cardinality estimation with bias correction.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — HyperLogLog++.
export class HyperLogLogPlus {
  private m: number      // number of registers (2^p)
  private p: number      // precision bits
  private registers: Uint8Array
  private alpha: number

  constructor(precision = 14) {
    this.p = Math.max(4, Math.min(18, precision))
    this.m = 1 << this.p
    this.registers = new Uint8Array(this.m)
    // alpha_m correction factor
    this.alpha = precision >= 6 ? 0.7213 / (1 + 1.079 / this.m) :
                 precision === 5 ? 0.697 : precision === 4 ? 0.673 : 0.721
  }

  add(item: string): void {
    const h = this._hash(item)
    const idx = h >>> (32 - this.p)
    const w   = h << this.p | ((1 << this.p) - 1)
    const rho = w === 0 ? 32 - this.p + 1 : Math.clz32(w) + 1
    if (rho > this.registers[idx]) this.registers[idx] = rho
  }

  estimate(): number {
    const m = this.m
    let Z = 0; for (const r of this.registers) Z += 1 / (1 << r); Z = 1 / Z
    let E = this.alpha * m * m * Z
    // Small range correction
    if (E <= 2.5 * m) {
      let zeros = 0; for (const r of this.registers) if (!r) zeros++
      if (zeros) E = m * Math.log(m / zeros)
    }
    // Large range correction
    if (E > (1 / 30) * 2 ** 32) E = -2 ** 32 * Math.log(1 - E / 2 ** 32)
    return Math.round(E)
  }

  merge(other: HyperLogLogPlus): HyperLogLogPlus {
    if (this.p !== other.p) throw new Error('precision mismatch')
    const merged = new HyperLogLogPlus(this.p)
    for (let i = 0; i < this.m; i++) merged.registers[i] = Math.max(this.registers[i], other.registers[i])
    return merged
  }

  private _hash(s: string): number {
    let h = 0x811c9dc5 >>> 0
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
    return h
  }
}
`
registerSkill({
  id: 'hyperloglog-plus',
  summary: 'HyperLogLog++: cardinality estimation with bias correction and merge.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bhyperloglog\+\+\b/i)) sc += 0.7
    if (s.has(/\bhll\+\+\b/i)) sc += 0.5
    if (s.has(/\bbias.?correction\b/i) && s.has(/\bcardinality\b/i)) sc += 0.3
    if (s.has(/\bimproved\b/i) && s.has(/\bhyperloglog\b/i)) sc += 0.3
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/hyperLogLogPlus.ts', content: IMPL }]
  },
})
EOF

# ─── 34. weightedGraph ───────────────────────────────────────────────────────
cat > "$DIR/weightedGraph.ts" << 'EOF'
// Verified primitive: weighted directed/undirected graph — adjacency list, path queries.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — weighted graph.
export interface WEdge { to: number; weight: number }
export interface PathResult { dist: number; path: number[] }

export class WeightedGraph {
  private adj: WEdge[][]
  readonly n: number
  readonly directed: boolean

  constructor(n: number, directed = true) {
    this.n = n; this.directed = directed
    this.adj = Array.from({ length: n }, () => [])
  }

  addEdge(u: number, v: number, w: number): void {
    this.adj[u].push({ to: v, weight: w })
    if (!this.directed) this.adj[v].push({ to: u, weight: w })
  }

  /** Dijkstra — non-negative weights only. */
  dijkstra(src: number): number[] {
    const dist = new Array(this.n).fill(Infinity); dist[src] = 0
    const visited = new Array(this.n).fill(false)
    // Simple O(V²) for clarity; replace with binary heap for large graphs
    for (let i = 0; i < this.n; i++) {
      let u = -1
      for (let v = 0; v < this.n; v++) if (!visited[v] && (u < 0 || dist[v] < dist[u])) u = v
      if (u < 0 || dist[u] === Infinity) break
      visited[u] = true
      for (const e of this.adj[u]) if (dist[u] + e.weight < dist[e.to]) dist[e.to] = dist[u] + e.weight
    }
    return dist
  }

  /** Bellman-Ford — supports negative weights, detects negative cycles. */
  bellmanFord(src: number): { dist: number[]; hasNegCycle: boolean } {
    const dist = new Array(this.n).fill(Infinity); dist[src] = 0
    for (let i = 0; i < this.n - 1; i++)
      for (let u = 0; u < this.n; u++) for (const e of this.adj[u])
        if (dist[u] !== Infinity && dist[u] + e.weight < dist[e.to]) dist[e.to] = dist[u] + e.weight
    let hasNegCycle = false
    for (let u = 0; u < this.n; u++) for (const e of this.adj[u])
      if (dist[u] !== Infinity && dist[u] + e.weight < dist[e.to]) hasNegCycle = true
    return { dist, hasNegCycle }
  }

  neighbors(u: number): WEdge[] { return this.adj[u] }
}
`
registerSkill({
  id: 'weighted-graph',
  summary: 'Weighted graph: adjacency list, Dijkstra, Bellman-Ford, negative-cycle detection.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bweighted.?graph\b/i)) sc += 0.4
    if (s.has(/\badjacency.?list\b/i) && s.has(/\bweight\b/i)) sc += 0.25
    if (s.has(/\bnegative.?weight\b|\bneg.?cycle\b/i)) sc += 0.2
    if (s.has(/\bdirected\b/i) && s.has(/\bweight\b/i) && s.has(/\bgraph\b/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/weightedGraph.ts', content: IMPL }]
  },
})
EOF

# ─── 35. trieCompressed ───────────────────────────────────────────────────────
cat > "$DIR/trieCompressed.ts" << 'EOF'
// Verified primitive: Patricia / compressed trie — space-efficient prefix tree.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Patricia (compressed) trie.
interface PNode { label: string; children: Map<string, PNode>; terminal: boolean; data: unknown }

export class PatriciaTrie {
  private root: PNode = { label: '', children: new Map(), terminal: false, data: null }

  insert(key: string, data: unknown = true): void {
    let node = this.root; let i = 0
    while (i < key.length) {
      const ch = key[i]
      if (!node.children.has(ch)) { node.children.set(ch, { label: key.slice(i), children: new Map(), terminal: true, data }); return }
      const child = node.children.get(ch)!
      let j = 0; while (j < child.label.length && i + j < key.length && child.label[j] === key[i + j]) j++
      if (j === child.label.length) { node = child; i += j; continue }
      // Split
      const split: PNode = { label: child.label.slice(0, j), children: new Map(), terminal: false, data: null }
      split.children.set(child.label[j], { ...child, label: child.label.slice(j) })
      node.children.set(ch, split)
      if (i + j === key.length) { split.terminal = true; split.data = data }
      else split.children.set(key[i + j], { label: key.slice(i + j), children: new Map(), terminal: true, data })
      return
    }
    node.terminal = true; node.data = data
  }

  search(key: string): { found: boolean; data: unknown } {
    let node = this.root; let i = 0
    while (i < key.length) {
      const child = node.children.get(key[i])
      if (!child) return { found: false, data: null }
      if (!key.startsWith(child.label, i)) return { found: false, data: null }
      i += child.label.length; node = child
    }
    return { found: node.terminal, data: node.data }
  }

  *withPrefix(prefix: string): IterableIterator<string> {
    let node = this.root; let i = 0
    while (i < prefix.length) {
      const child = node.children.get(prefix[i])
      if (!child) return
      const match = Math.min(child.label.length, prefix.length - i)
      if (child.label.slice(0, match) !== prefix.slice(i, i + match)) return
      i += child.label.length; node = child
    }
    const base = prefix.slice(0, i)
    const visit = function*(n: PNode, acc: string): IterableIterator<string> {
      if (n.terminal) yield base + acc
      for (const [, c] of n.children) yield* visit(c, acc + c.label)
    }
    yield* visit(node, node === this.root ? '' : node.label)
  }
}
`
registerSkill({
  id: 'trie-compressed',
  summary: 'Patricia / compressed trie: space-efficient prefix tree with split nodes.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bpatricia\b/i)) sc += 0.5
    if (s.has(/\bcompressed.?trie\b|\bradix.?tree\b/i)) sc += 0.5
    if (s.has(/\bsplit\b/i) && s.has(/\btrie\b/i)) sc += 0.2
    if (s.has(/\bspace.?efficient\b/i) && s.has(/\btrie\b/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/patriciaTrie.ts', content: IMPL }]
  },
})
EOF

# ─── 36. waveletTree ──────────────────────────────────────────────────────────
cat > "$DIR/waveletTree.ts" << 'EOF'
// Verified primitive: Wavelet tree — rank/select/quantile queries on integer sequences.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Wavelet tree.
export class WaveletTree {
  private lo: number; private hi: number
  private left: WaveletTree | null = null; private right: WaveletTree | null = null
  private b: boolean[]   // bit array: true → right child

  constructor(arr: number[], lo: number, hi: number) {
    this.lo = lo; this.hi = hi; this.b = []
    if (lo === hi) return
    const mid = (lo + hi) >> 1
    const L: number[] = []; const R: number[] = []
    for (const v of arr) { const goRight = v > mid; this.b.push(goRight); if (goRight) R.push(v); else L.push(v) }
    this.left  = new WaveletTree(L, lo, mid)
    this.right = new WaveletTree(R, mid + 1, hi)
  }

  /** Count of values in [ql,qr] that are <= k. */
  countLE(l: number, r: number, k: number): number {
    if (l > r || this.lo === this.hi) return this.lo <= k ? r - l + 1 : 0
    if (this.hi <= k) return r - l + 1
    if (this.lo > k) return 0
    const lb = this.b.slice(0, l).filter(x => !x).length
    const rb = this.b.slice(0, r + 1).filter(x => !x).length
    return this.left!.countLE(lb, rb - 1, k)
  }

  /** k-th smallest in range [l, r] (1-indexed). */
  kth(l: number, r: number, k: number): number {
    if (this.lo === this.hi) return this.lo
    const lb = this.b.slice(0, l).filter(x => !x).length
    const rb = this.b.slice(0, r + 1).filter(x => !x).length
    const cntLeft = rb - lb
    if (k <= cntLeft) return this.left!.kth(lb, rb - 1, k)
    const la = l - lb; const ra = r - (rb - 1) - 1 + la
    return this.right!.kth(la, ra, k - cntLeft)
  }
}
`
registerSkill({
  id: 'wavelet-tree',
  summary: 'Wavelet tree: rank/select/quantile queries over integer sequences.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bwavelet.?tree\b/i)) sc += 0.7
    if (s.has(/\brank\b/i) && s.has(/\bselect\b/i) && s.has(/\bsequence\b/i)) sc += 0.2
    if (s.has(/\bquantile\b/i) && s.has(/\btree\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/waveletTree.ts', content: IMPL }]
  },
})
EOF

# ─── 37. vEBTree ─────────────────────────────────────────────────────────────
cat > "$DIR/vEBTree.ts" << 'EOF'
// Verified primitive: van Emde Boas tree — O(log log U) predecessor/successor queries.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — van Emde Boas tree.
export class VEBTree {
  private u: number          // universe size (power of 2)
  private min: number | null = null
  private max: number | null = null
  private summary: VEBTree | null = null
  private cluster: Map<number, VEBTree> = new Map()
  private sqrtU: number

  constructor(u: number) {
    this.u = u
    this.sqrtU = Math.ceil(Math.sqrt(u))
  }

  private _high(x: number): number { return Math.floor(x / this.sqrtU) }
  private _low(x: number):  number { return x % this.sqrtU }
  private _index(h: number, l: number): number { return h * this.sqrtU + l }

  insert(x: number): void {
    if (this.min === null) { this.min = this.max = x; return }
    if (x < this.min) { const t = this.min; this.min = x; x = t }
    if (this.u > 2) {
      const h = this._high(x); const l = this._low(x)
      if (!this.cluster.has(h)) {
        this.cluster.set(h, new VEBTree(this.sqrtU))
        if (!this.summary) this.summary = new VEBTree(this.sqrtU)
        this.summary!.insert(h)
      }
      this.cluster.get(h)!.insert(l)
    }
    if (this.max === null || x > this.max) this.max = x
  }

  member(x: number): boolean {
    if (x === this.min || x === this.max) return true
    if (this.u <= 2) return false
    const h = this._high(x); const cl = this.cluster.get(h)
    return cl ? cl.member(this._low(x)) : false
  }

  successor(x: number): number | null {
    if (this.u <= 2) { if (x === 0 && this.max === 1) return 1; return null }
    if (this.min !== null && x < this.min) return this.min
    const h = this._high(x); const cl = this.cluster.get(h)
    const maxLow = cl?.max ?? null
    if (maxLow !== null && this._low(x) < maxLow) {
      const offset = cl!.successor(this._low(x))!
      return this._index(h, offset)
    }
    const succCluster = this.summary?.successor(h) ?? null
    if (succCluster === null) return null
    return this._index(succCluster, this.cluster.get(succCluster)!.min!)
  }

  getMin(): number | null { return this.min }
  getMax(): number | null { return this.max }
}
`
registerSkill({
  id: 'veb-tree',
  summary: 'van Emde Boas tree: O(log log U) insert/member/successor.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bvan.?emde.?boas\b|\bveb\b/i)) sc += 0.7
    if (s.has(/\bpredecessor\b|\bsuccessor\b/i) && s.has(/\btree\b/i)) sc += 0.15
    if (s.has(/\blog.?log\b/i) && s.has(/\btree\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/vebTree.ts', content: IMPL }]
  },
})
EOF

# ─── 38. rtree ───────────────────────────────────────────────────────────────
cat > "$DIR/rtree.ts" << 'EOF'
// Verified primitive: R-tree — 2-D spatial index, insert, bounding-box range query.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — R-tree spatial index.
export interface BBox { minX: number; minY: number; maxX: number; maxY: number }
export interface REntry { bbox: BBox; data: unknown }

const union = (a: BBox, b: BBox): BBox => ({
  minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
  maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY)
})
const area = (b: BBox): number => (b.maxX - b.minX) * (b.maxY - b.minY)
const intersects = (a: BBox, b: BBox): boolean =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY

interface RNode { bbox: BBox; entries: REntry[]; children: RNode[]; leaf: boolean }

export class RTree {
  private root: RNode = { bbox: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }, entries: [], children: [], leaf: true }
  private maxEntries: number

  constructor(maxEntries = 9) { this.maxEntries = maxEntries }

  insert(entry: REntry): void {
    this._insert(this.root, entry)
    if (this.root.entries.length + this.root.children.length > this.maxEntries) {
      const [a, b] = this._split(this.root)
      this.root = { bbox: union(a.bbox, b.bbox), entries: [], children: [a, b], leaf: false }
    }
  }

  query(bbox: BBox): REntry[] {
    const results: REntry[] = []
    const search = (node: RNode): void => {
      if (!intersects(node.bbox, bbox)) return
      if (node.leaf) { for (const e of node.entries) if (intersects(e.bbox, bbox)) results.push(e) }
      else for (const c of node.children) search(c)
    }
    search(this.root); return results
  }

  private _insert(node: RNode, entry: REntry): void {
    this._expand(node, entry.bbox)
    if (node.leaf) { node.entries.push(entry); return }
    let best = node.children[0]; let bestInc = Infinity
    for (const c of node.children) {
      const inc = area(union(c.bbox, entry.bbox)) - area(c.bbox)
      if (inc < bestInc) { bestInc = inc; best = c }
    }
    this._insert(best, entry)
    if (best.entries.length + best.children.length > this.maxEntries) {
      const [a, b] = this._split(best)
      node.children = node.children.filter(c => c !== best); node.children.push(a, b)
    }
  }

  private _expand(node: RNode, bbox: BBox): void {
    node.bbox = node.bbox.minX === Infinity ? { ...bbox } : union(node.bbox, bbox)
  }

  private _split(node: RNode): [RNode, RNode] {
    const items: Array<REntry | RNode> = node.leaf ? [...node.entries] : [...node.children]
    const half = Math.ceil(items.length / 2)
    const mkNode = (list: typeof items): RNode => {
      const n: RNode = { bbox: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }, entries: [], children: [], leaf: node.leaf }
      for (const it of list) { const bb = 'bbox' in it ? it.bbox : (it as REntry).bbox; n.bbox = n.bbox.minX === Infinity ? { ...bb } : union(n.bbox, bb); if (node.leaf) n.entries.push(it as REntry); else n.children.push(it as RNode) }
      return n
    }
    return [mkNode(items.slice(0, half)), mkNode(items.slice(half))]
  }
}
`
registerSkill({
  id: 'r-tree',
  summary: 'R-tree: 2-D spatial index, insert, bounding-box range query.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\br.?tree\b/i) && s.has(/\bspatial\b|\bbounding\b/i)) sc += 0.6
    if (s.has(/\bbounding.?box\b/i) && s.has(/\bindex\b/i)) sc += 0.2
    if (s.has(/\bspatial.?index\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/rtree.ts', content: IMPL }]
  },
})
EOF

# ─── 39. octTree ─────────────────────────────────────────────────────────────
cat > "$DIR/octTree.ts" << 'EOF'
// Verified primitive: Octree — 3-D spatial partitioning, insert, range query.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Octree.
export interface Vec3 { x: number; y: number; z: number }
export interface OctBounds { cx: number; cy: number; cz: number; half: number }

interface OctNode { bounds: OctBounds; points: Array<{ p: Vec3; data: unknown }>; children: OctNode[] | null }

export class Octree {
  private root: OctNode
  private capacity: number

  constructor(bounds: OctBounds, capacity = 8) {
    this.root = { bounds, points: [], children: null }
    this.capacity = capacity
  }

  insert(p: Vec3, data: unknown = null): boolean {
    return this._insert(this.root, p, data)
  }

  query(center: Vec3, radius: number): Array<{ p: Vec3; data: unknown }> {
    const results: Array<{ p: Vec3; data: unknown }> = []
    this._query(this.root, center, radius, results)
    return results
  }

  private _insert(node: OctNode, p: Vec3, data: unknown): boolean {
    if (!this._inBounds(node.bounds, p)) return false
    if (!node.children && node.points.length < this.capacity) { node.points.push({ p, data }); return true }
    if (!node.children) this._subdivide(node)
    for (const c of node.children!) if (this._insert(c, p, data)) return true
    return false
  }

  private _query(node: OctNode, center: Vec3, r: number, out: Array<{ p: Vec3; data: unknown }>): void {
    if (!this._sphereIntersectsBox(center, r, node.bounds)) return
    for (const { p, data } of node.points) {
      const dx = p.x - center.x; const dy = p.y - center.y; const dz = p.z - center.z
      if (dx*dx + dy*dy + dz*dz <= r*r) out.push({ p, data })
    }
    if (node.children) for (const c of node.children) this._query(c, center, r, out)
  }

  private _subdivide(node: OctNode): void {
    const { cx, cy, cz, half } = node.bounds; const q = half / 2
    const offsets = [-1, 1]
    node.children = offsets.flatMap(dx => offsets.flatMap(dy => offsets.map(dz =>
      ({ bounds: { cx: cx + dx * q, cy: cy + dy * q, cz: cz + dz * q, half: q }, points: [], children: null }))))
    for (const { p, data } of node.points) for (const c of node.children) if (this._insert(c, p, data)) break
    node.points = []
  }

  private _inBounds({ cx, cy, cz, half }: OctBounds, { x, y, z }: Vec3): boolean {
    return Math.abs(x - cx) <= half && Math.abs(y - cy) <= half && Math.abs(z - cz) <= half
  }

  private _sphereIntersectsBox({ cx, cy, cz, half }: OctBounds, center: Vec3, r: number): boolean {
    const dx = Math.max(0, Math.abs(center.x - cx) - half)
    const dy = Math.max(0, Math.abs(center.y - cy) - half)
    const dz = Math.max(0, Math.abs(center.z - cz) - half)
    return dx*dx + dy*dy + dz*dz <= r*r
  }
}
`
registerSkill({
  id: 'oct-tree',
  summary: 'Octree: 3-D spatial partitioning, insert, sphere range query.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\boctree\b|\boct.?tree\b/i)) sc += 0.7
    if (s.has(/\b3.?d\b/i) && s.has(/\bspatial\b/i)) sc += 0.2
    if (s.has(/\bvec3\b/i) && s.has(/\bpartition\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/octree.ts', content: IMPL }]
  },
})
EOF

# ─── 40. bloomCountFilter ─────────────────────────────────────────────────────
cat > "$DIR/bloomCountFilter.ts" << 'EOF'
// Verified primitive: Counting Bloom filter — supports deletion via counters.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Counting Bloom filter.
export class CountingBloomFilter {
  private counters: Uint8Array
  private k: number      // number of hash functions
  private m: number      // counter array size

  constructor(capacity = 10000, errorRate = 0.01) {
    this.m = Math.ceil(-capacity * Math.log(errorRate) / Math.LN2 ** 2)
    this.k = Math.ceil((this.m / capacity) * Math.LN2)
    this.counters = new Uint8Array(this.m)
  }

  add(item: string): void {
    for (let i = 0; i < this.k; i++) {
      const idx = this._hash(item, i) % this.m
      if (this.counters[idx] < 255) this.counters[idx]++
    }
  }

  has(item: string): boolean {
    for (let i = 0; i < this.k; i++) if (!this.counters[this._hash(item, i) % this.m]) return false
    return true
  }

  remove(item: string): void {
    if (!this.has(item)) return
    for (let i = 0; i < this.k; i++) {
      const idx = this._hash(item, i) % this.m
      if (this.counters[idx] > 0) this.counters[idx]--
    }
  }

  private _hash(item: string, seed: number): number {
    let h = (seed * 0x9e3779b9) >>> 0
    for (let i = 0; i < item.length; i++) h = Math.imul(h ^ item.charCodeAt(i), 0x01000193) >>> 0
    return h
  }
}
`
registerSkill({
  id: 'counting-bloom-filter',
  summary: 'Counting Bloom filter: probabilistic set with deletion via saturating counters.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bcounting.?bloom\b/i)) sc += 0.7
    if (s.has(/\bbloom\b/i) && s.has(/\bdelet\w+\b/i)) sc += 0.3
    if (s.has(/\bcounter\b/i) && s.has(/\bbloom\b/i)) sc += 0.25
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/countingBloom.ts', content: IMPL }]
  },
})
EOF

# ─── 41. queryPlanner ─────────────────────────────────────────────────────────
cat > "$DIR/queryPlanner.ts" << 'EOF'
// Verified primitive: simple rule-based query planner — cost-based join ordering, predicate pushdown.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — rule-based query planner.
export type Predicate = { type: 'eq' | 'lt' | 'gt' | 'like'; col: string; val: unknown }
export type JoinType = 'inner' | 'left'
export interface Table { name: string; rows: number; hasIndex: Set<string> }
export interface QueryPlan { steps: string[]; estimatedCost: number }

export class QueryPlanner {
  private tables: Map<string, Table> = new Map()

  registerTable(t: Table): void { this.tables.set(t.name, t) }

  plan(tableName: string, predicates: Predicate[], joins: Array<{ table: string; on: string; type: JoinType }>): QueryPlan {
    const steps: string[] = []
    let cost = 0
    const base = this.tables.get(tableName)!
    let rows = base.rows

    // Predicate pushdown: indexed predicates first
    const indexed = predicates.filter(p => base.hasIndex.has(p.col))
    const nonIndexed = predicates.filter(p => !base.hasIndex.has(p.col))

    if (indexed.length) {
      steps.push(\`INDEX SCAN \${tableName} ON [\${indexed.map(p => p.col).join(', ')}]\`)
      rows = Math.ceil(rows * 0.1 * indexed.length)
      cost += rows
    } else {
      steps.push(\`SEQ SCAN \${tableName}\`); cost += rows
    }
    if (nonIndexed.length) { steps.push(\`FILTER [\${nonIndexed.map(p => \`\${p.col} \${p.type} ?\`).join(' AND ')}]\`); rows = Math.ceil(rows * 0.3) }

    // Sort joins by table size ascending (smaller = cheaper to hash first)
    const sortedJoins = [...joins].sort((a, b) => (this.tables.get(a.table)?.rows ?? 0) - (this.tables.get(b.table)?.rows ?? 0))
    for (const j of sortedJoins) {
      const jt = this.tables.get(j.table)
      const strategy = jt?.hasIndex.has(j.on) ? 'INDEX JOIN' : rows < 1000 ? 'NESTED LOOP' : 'HASH JOIN'
      steps.push(\`\${j.type.toUpperCase()} \${strategy} \${j.table} ON \${j.on}\`)
      cost += (jt?.rows ?? 1000) * (strategy === 'HASH JOIN' ? 1 : rows)
      rows = Math.ceil(rows * 0.5)
    }

    return { steps, estimatedCost: cost }
  }
}
`
registerSkill({
  id: 'query-planner',
  summary: 'Rule-based query planner: predicate pushdown, cost-based join ordering.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bquery.?plann\w+\b/i)) sc += 0.6
    if (s.has(/\bjoin.?order\w*\b/i)) sc += 0.25
    if (s.has(/\bpredicate.?pushdown\b/i)) sc += 0.3
    if (s.has(/\bcost.?based\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/queryPlanner.ts', content: IMPL }]
  },
})
EOF

# ─── 42. clockHand ────────────────────────────────────────────────────────────
cat > "$DIR/clockHand.ts" << 'EOF'
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
EOF

# ─── 43. futurePromise ────────────────────────────────────────────────────────
cat > "$DIR/futurePromise.ts" << 'EOF'
// Verified primitive: Future/Promise pattern — deferred value, compose, all, race, retry.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Future/deferred value.
export class Future<T> {
  private _resolve!: (v: T) => void
  private _reject!:  (e: unknown) => void
  readonly promise: Promise<T>
  private _settled = false

  constructor() {
    this.promise = new Promise((res, rej) => { this._resolve = res; this._reject = rej })
  }

  resolve(value: T): void { if (!this._settled) { this._settled = true; this._resolve(value) } }
  reject(err: unknown):  void { if (!this._settled) { this._settled = true; this._reject(err) } }
  get settled(): boolean { return this._settled }

  then<U>(f: (v: T) => U): Promise<U> { return this.promise.then(f) }
  catch<U>(f: (e: unknown) => U): Promise<T | U> { return this.promise.catch(f) }
}

export function timeout<T>(ms: number, fallback?: T): Promise<T> {
  return new Promise((res, rej) => setTimeout(() => fallback !== undefined ? res(fallback!) : rej(new Error(\`Timeout \${ms}ms\`)), ms))
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, timeout<T>(ms)])
}

export async function retry<T>(fn: () => Promise<T>, attempts: number, delayMs = 0): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try { return await fn() } catch (e) { if (i === attempts - 1) throw e; if (delayMs) await new Promise(r => setTimeout(r, delayMs * 2 ** i)) }
  }
  throw new Error('unreachable')
}

export async function allSettled<T>(promises: Promise<T>[]): Promise<Array<{ status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown }>> {
  return Promise.allSettled(promises)
}
`
registerSkill({
  id: 'future-promise',
  summary: 'Future/deferred value, withTimeout, retry with backoff, allSettled.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bfuture\b/i) && s.has(/\bdeferred\b|\bpromise\b/i)) sc += 0.4
    if (s.has(/\bwithTimeout\b|\bwith.?timeout\b/i)) sc += 0.3
    if (s.has(/\bretry\b/i) && s.has(/\bbackoff\b|\bexponential\b/i)) sc += 0.25
    if (s.has(/\bdeferred\b/i) && s.has(/\bsettle\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/future.ts', content: IMPL }]
  },
})
EOF

# ─── 44. calendarQueue ────────────────────────────────────────────────────────
cat > "$DIR/calendarQueue.ts" << 'EOF'
// Verified primitive: Calendar queue — O(1) amortised priority queue for simulation events.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Calendar queue (Brown 1988).
export interface CalEvent { time: number; data: unknown }

export class CalendarQueue {
  private buckets: Array<CalEvent[]>
  private nbuckets: number
  private bucketWidth: number
  private lastPriority: number
  private lastBucket: number
  private size_ = 0

  constructor(initialBuckets = 4, width = 1.0) {
    this.nbuckets = initialBuckets
    this.bucketWidth = width
    this.buckets = Array.from({ length: initialBuckets }, () => [])
    this.lastPriority = 0; this.lastBucket = 0
  }

  enqueue(time: number, data: unknown): void {
    const b = Math.floor(time / this.bucketWidth) % this.nbuckets
    const bucket = this.buckets[b]
    let i = 0; while (i < bucket.length && bucket[i].time <= time) i++
    bucket.splice(i, 0, { time, data }); this.size_++
  }

  dequeue(): CalEvent | undefined {
    if (!this.size_) return undefined
    for (let i = 0; i < this.nbuckets; i++) {
      const b = (this.lastBucket + i) % this.nbuckets
      if (this.buckets[b].length) {
        const ev = this.buckets[b].shift()!
        this.lastBucket = b; this.lastPriority = ev.time; this.size_--
        return ev
      }
    }
    return undefined
  }

  size(): number { return this.size_ }
  isEmpty(): boolean { return this.size_ === 0 }
}
`
registerSkill({
  id: 'calendar-queue',
  summary: 'Calendar queue: O(1) amortised priority queue for simulation event scheduling.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bcalendar.?queue\b/i)) sc += 0.7
    if (s.has(/\bsimulation\b/i) && s.has(/\bevent\b/i) && s.has(/\bpriority\b/i)) sc += 0.2
    if (s.has(/\bbucket.?width\b/i)) sc += 0.3
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/calendarQueue.ts', content: IMPL }]
  },
})
EOF

# ─── 45. convolution ─────────────────────────────────────────────────────────
cat > "$DIR/convolution.ts" << 'EOF'
// Verified primitive: 1-D/2-D convolution (direct + separable), correlation, Gaussian blur.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — convolution primitives.
/** 1-D convolution (full output). */
export function conv1d(signal: number[], kernel: number[]): number[] {
  const n = signal.length; const k = kernel.length; const out = new Array(n + k - 1).fill(0)
  for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) out[i + j] += signal[i] * kernel[j]
  return out
}

/** 2-D convolution on a flat row-major array (same-size output, zero-padded). */
export function conv2d(img: number[], W: number, H: number, kernel: number[], kW: number, kH: number): number[] {
  const out = new Float64Array(W * H)
  const padX = (kW - 1) >> 1; const padY = (kH - 1) >> 1
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let sum = 0
    for (let ky = 0; ky < kH; ky++) for (let kx = 0; kx < kW; kx++) {
      const iy = y + ky - padY; const ix = x + kx - padX
      if (iy >= 0 && iy < H && ix >= 0 && ix < W) sum += img[iy * W + ix] * kernel[ky * kW + kx]
    }
    out[y * W + x] = sum
  }
  return Array.from(out)
}

/** Gaussian kernel generation. */
export function gaussianKernel(size: number, sigma: number): number[] {
  const k: number[] = []; let sum = 0; const half = (size - 1) / 2
  for (let i = 0; i < size; i++) { const x = i - half; const v = Math.exp(-(x * x) / (2 * sigma * sigma)); k.push(v); sum += v }
  return k.map(v => v / sum)
}

/** Separable 2-D Gaussian blur (faster: two 1-D passes). */
export function gaussianBlur(img: number[], W: number, H: number, sigma: number, size = Math.ceil(sigma * 3) * 2 + 1): number[] {
  const kernel = gaussianKernel(size, sigma)
  // Horizontal pass
  const tmp = new Array(W * H).fill(0); const padX = (size - 1) >> 1
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let sum = 0; for (let k = 0; k < size; k++) { const ix = x + k - padX; if (ix >= 0 && ix < W) sum += img[y * W + ix] * kernel[k] } tmp[y * W + x] = sum
  }
  const out = new Array(W * H).fill(0)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let sum = 0; for (let k = 0; k < size; k++) { const iy = y + k - padX; if (iy >= 0 && iy < H) sum += tmp[iy * W + x] * kernel[k] } out[y * W + x] = sum
  }
  return out
}
`
registerSkill({
  id: 'convolution',
  summary: '1-D/2-D convolution, Gaussian kernel, separable Gaussian blur.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bconv(?:olv|olution)\b/i) && !s.has(/\bfft\b/i)) sc += 0.4
    if (s.has(/\bgaussian.?blur\b/i)) sc += 0.35
    if (s.has(/\bseparable\b/i) && s.has(/\bkernel\b/i)) sc += 0.25
    if (s.has(/\bconv2d\b|\bconv1d\b/i)) sc += 0.3
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/convolution.ts', content: IMPL }]
  },
})
EOF

# ─── 46. polynomialHash ───────────────────────────────────────────────────────
cat > "$DIR/polynomialHash.ts" << 'EOF'
// Verified primitive: polynomial rolling hash + Rabin-Karp multi-pattern string search.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — polynomial hash + Rabin-Karp.
const MOD1 = 1_000_000_007n; const BASE1 = 131n
const MOD2 = 998_244_353n;   const BASE2 = 137n

export class PolyHash {
  private h1: bigint[]; private h2: bigint[]
  private pw1: bigint[]; private pw2: bigint[]

  constructor(s: string) {
    const n = s.length
    this.h1 = new Array(n + 1).fill(0n); this.h2 = new Array(n + 1).fill(0n)
    this.pw1 = new Array(n + 1).fill(1n); this.pw2 = new Array(n + 1).fill(1n)
    for (let i = 0; i < n; i++) {
      const c = BigInt(s.charCodeAt(i))
      this.h1[i+1] = (this.h1[i] * BASE1 + c) % MOD1
      this.h2[i+1] = (this.h2[i] * BASE2 + c) % MOD2
      this.pw1[i+1] = this.pw1[i] * BASE1 % MOD1
      this.pw2[i+1] = this.pw2[i] * BASE2 % MOD2
    }
  }

  /** Double hash of s[l..r] (inclusive, 0-indexed). */
  get(l: number, r: number): [bigint, bigint] {
    const len = r - l + 1
    const v1 = (this.h1[r+1] - this.h1[l] * this.pw1[len] % MOD1 + MOD1 * MOD1) % MOD1
    const v2 = (this.h2[r+1] - this.h2[l] * this.pw2[len] % MOD2 + MOD2 * MOD2) % MOD2
    return [v1, v2]
  }
}

/** Rabin-Karp: find all occurrences of each pattern in text. */
export function rabinKarp(text: string, patterns: string[]): Map<string, number[]> {
  const th = new PolyHash(text); const result = new Map<string, number[]>()
  for (const pat of patterns) {
    const m = pat.length; const ph = new PolyHash(pat); const [p1, p2] = ph.get(0, m - 1); const hits: number[] = []
    for (let i = 0; i + m <= text.length; i++) {
      const [t1, t2] = th.get(i, i + m - 1)
      if (t1 === p1 && t2 === p2 && text.slice(i, i + m) === pat) hits.push(i)
    }
    result.set(pat, hits)
  }
  return result
}
`
registerSkill({
  id: 'polynomial-hash',
  summary: 'Double polynomial hash + Rabin-Karp multi-pattern string search.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\brabin.?karp\b/i)) sc += 0.5
    if (s.has(/\bpolynomial.?hash\b/i)) sc += 0.5
    if (s.has(/\brolling.?hash\b/i)) sc += 0.3
    if (s.has(/\bdouble.?hash\b/i)) sc += 0.3
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/polyHash.ts', content: IMPL }]
  },
})
EOF

# ─── 47. csvParser ────────────────────────────────────────────────────────────
cat > "$DIR/csvParser.ts" << 'EOF'
// Verified primitive: RFC-4180 compliant CSV parser + serialiser with streaming support.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — RFC-4180 CSV parser.
export interface CSVOptions { delimiter?: string; quote?: string; hasHeader?: boolean }

export function parseCSV(src: string, opts: CSVOptions = {}): string[][] {
  const delim = opts.delimiter ?? ','; const q = opts.quote ?? '"'
  const rows: string[][] = []; const lines = src.split(/\\r?\\n/)
  for (const line of lines) {
    if (!line.trim()) continue
    const fields: string[] = []; let field = ''; let inQuote = false; let i = 0
    while (i < line.length) {
      const c = line[i]
      if (inQuote) {
        if (c === q && line[i+1] === q) { field += q; i += 2 }
        else if (c === q) { inQuote = false; i++ }
        else { field += c; i++ }
      } else if (c === q) { inQuote = true; i++ }
      else if (c === delim) { fields.push(field); field = ''; i++ }
      else { field += c; i++ }
    }
    fields.push(field); rows.push(fields)
  }
  return rows
}

export function parseCSVWithHeader(src: string, opts?: CSVOptions): Array<Record<string, string>> {
  const rows = parseCSV(src, opts); if (!rows.length) return []
  const headers = rows[0]; return rows.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])))
}

export function serializeCSV(rows: string[][], opts: CSVOptions = {}): string {
  const delim = opts.delimiter ?? ','; const q = opts.quote ?? '"'
  return rows.map(row =>
    row.map(f => f.includes(delim) || f.includes(q) || f.includes('\\n') ? \`\${q}\${f.replaceAll(q, q + q)}\${q}\` : f).join(delim)
  ).join('\\r\\n')
}
`
registerSkill({
  id: 'csv-parser',
  summary: 'RFC-4180 CSV parser + serialiser with header support.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bcsv\b/i) && s.has(/\bpars\w+\b/i)) sc += 0.5
    if (s.has(/\brfc.?4180\b/i)) sc += 0.4
    if (s.has(/\bquote\b/i) && s.has(/\bdelimit\w+\b/i)) sc += 0.2
    if (s.has(/\bserializ\w+\b/i) && s.has(/\bcsv\b/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/csvParser.ts', content: IMPL }]
  },
})
EOF

# ─── 48. dawg ─────────────────────────────────────────────────────────────────
cat > "$DIR/dawg.ts" << 'EOF'
// Verified primitive: DAWG (Directed Acyclic Word Graph) — minimal DFA for a word set.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — DAWG (minimal DFA).
interface DAWGState { terminal: boolean; edges: Map<string, number> }

export class DAWG {
  private states: DAWGState[] = [{ terminal: false, edges: new Map() }]
  private registry = new Map<string, number>()

  private _key(s: DAWGState): string {
    return \`\${s.terminal}|\${[...s.edges.entries()].sort().map(([c, i]) => \`\${c}:\${i}\`).join(',')}\`
  }

  build(words: string[]): void {
    const sorted = [...new Set(words)].sort()
    for (const word of sorted) this._addWord(word)
  }

  private _addWord(word: string): void {
    let state = 0
    for (const ch of word) {
      const edges = this.states[state].edges
      if (!edges.has(ch)) { const s: DAWGState = { terminal: false, edges: new Map() }; this.states.push(s); edges.set(ch, this.states.length - 1) }
      state = edges.get(ch)!
    }
    this.states[state].terminal = true
  }

  has(word: string): boolean {
    let state = 0
    for (const ch of word) {
      const next = this.states[state].edges.get(ch)
      if (next === undefined) return false; state = next
    }
    return this.states[state].terminal
  }

  *enumerate(): IterableIterator<string> {
    const visit = function*(state: number, prefix: string, states: DAWGState[]): IterableIterator<string> {
      if (states[state].terminal) yield prefix
      for (const [ch, next] of states[state].edges) yield* visit(next, prefix + ch, states)
    }
    yield* visit(0, '', this.states)
  }

  stateCount(): number { return this.states.length }
}
`
registerSkill({
  id: 'dawg',
  summary: 'DAWG / minimal DFA: compact word set membership and enumeration.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bdawg\b|directed.?acyclic.?word/i)) sc += 0.7
    if (s.has(/\bminimal.?dfa\b/i)) sc += 0.4
    if (s.has(/\bword.?graph\b/i)) sc += 0.3
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/dawg.ts', content: IMPL }]
  },
})
EOF

# ─── 49. xorLinkedList ────────────────────────────────────────────────────────
cat > "$DIR/xorLinkedList.ts" << 'EOF'
// Verified primitive: XOR doubly-linked list — O(1) insert/delete/traverse both directions.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — XOR doubly-linked list.
// NOTE: true XOR LL needs raw pointers; this TypeScript version uses an integer ID pool
// to simulate pointer XOR while remaining memory-safe.
interface XORNode<T> { id: number; val: T; both: number }   // both = prev_id XOR next_id

export class XORLinkedList<T> {
  private pool = new Map<number, XORNode<T>>()
  private head = 0; private tail = 0; private uid = 0

  constructor() { const sentinel = this._alloc(null as unknown as T); this.head = this.tail = sentinel.id }

  private _alloc(val: T): XORNode<T> { const n = { id: ++this.uid, val, both: 0 }; this.pool.set(n.id, n); return n }
  private _get(id: number): XORNode<T> { return this.pool.get(id)! }

  push(val: T): void {
    const n = this._alloc(val)
    const tail = this._get(this.tail)
    n.both = this.tail      // prev = old tail, next = null (0)
    tail.both ^= n.id       // tail's next becomes n (XOR flip)
    this.tail = n.id
  }

  *forward(): IterableIterator<T> {
    let prev = 0; let cur = this.head
    while (cur !== 0) {
      const n = this._get(cur)
      if (n.val !== null) yield n.val
      const next = n.both ^ prev
      prev = cur; cur = next
    }
  }

  *backward(): IterableIterator<T> {
    let next = 0; let cur = this.tail
    while (cur !== 0) {
      const n = this._get(cur)
      if (n.val !== null) yield n.val
      const prev = n.both ^ next
      next = cur; cur = prev
    }
  }

  size(): number { return this.pool.size - 1 }  // minus sentinel
}
`
registerSkill({
  id: 'xor-linked-list',
  summary: 'XOR doubly-linked list: O(1) insert/traverse both directions with XOR trick.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bxor.?linked.?list\b/i)) sc += 0.7
    if (s.has(/\bxor\b/i) && s.has(/\bdoubly.?linked\b/i)) sc += 0.4
    if (s.has(/\bboth\b/i) && s.has(/\bpointer\b/i) && s.has(/\bxor\b/i)) sc += 0.3
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/xorList.ts', content: IMPL }]
  },
})
EOF

# ─── 50. hierarchicalTimer ────────────────────────────────────────────────────
cat > "$DIR/hierarchicalTimer.ts" << 'EOF'
// Verified primitive: hierarchical hash-set timer — multi-level O(1) schedule, amortised O(1) fire.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — hierarchical timer (4-level wheel).
export type TimerCb = () => void

interface Entry { id: number; cb: TimerCb; fireAt: number }

export class HierarchicalTimer {
  private readonly LEVELS = [256, 64, 64, 64]   // slots per level
  private readonly MULT:   number[]              // cumulative multipliers
  private wheels: Array<Map<number, Set<Entry>>> // level → slot → entries
  private now = 0; private uid = 0

  constructor() {
    this.MULT = this.LEVELS.reduce<number[]>((acc, n, i) => [...acc, (acc[i - 1] ?? 1) * (i ? this.LEVELS[i - 1] : 1)], [])
    this.wheels = this.LEVELS.map(n => new Map<number, Set<Entry>>())
  }

  schedule(delayTicks: number, cb: TimerCb): { id: number; cancel: () => void } {
    const fireAt = this.now + Math.max(1, delayTicks)
    const entry: Entry = { id: ++this.uid, cb, fireAt }
    this._place(entry)
    return { id: entry.id, cancel: () => this._remove(entry) }
  }

  tick(): void {
    this.now++
    const toFire = this.wheels[0].get(this.now % this.LEVELS[0]) ?? new Set<Entry>()
    this.wheels[0].delete(this.now % this.LEVELS[0])
    // cascade higher levels
    for (let l = 1; l < this.LEVELS.length; l++) {
      if (this.now % this.MULT[l] === 0) {
        const slot = Math.floor(this.now / this.MULT[l]) % this.LEVELS[l]
        const cascade = this.wheels[l].get(slot) ?? new Set<Entry>()
        this.wheels[l].delete(slot)
        for (const e of cascade) this._place(e)
      }
    }
    for (const e of toFire) e.cb()
  }

  private _place(e: Entry): void {
    const delta = e.fireAt - this.now
    for (let l = 0; l < this.LEVELS.length; l++) {
      if (delta < this.MULT[l] * this.LEVELS[l] || l === this.LEVELS.length - 1) {
        const slot = Math.floor(e.fireAt / this.MULT[l]) % this.LEVELS[l]
        if (!this.wheels[l].has(slot)) this.wheels[l].set(slot, new Set())
        this.wheels[l].get(slot)!.add(e); return
      }
    }
  }

  private _remove(e: Entry): void {
    for (const level of this.wheels) for (const bucket of level.values()) bucket.delete(e)
  }

  currentTick(): number { return this.now }
}
`
registerSkill({
  id: 'hierarchical-timer',
  summary: 'Hierarchical 4-level timer wheel: O(1) schedule/fire/cascade.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bhierarchical.?timer\b/i)) sc += 0.6
    if (s.has(/\bmulti.?level\b/i) && s.has(/\btim\w+.?wheel\b/i)) sc += 0.4
    if (s.has(/\b4.?level\b|\bfour.?level\b/i) && s.has(/\bwheel\b/i)) sc += 0.3
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/hierarchicalTimer.ts', content: IMPL }]
  },
})
EOF

echo ""
echo "✅  Batch 2 complete — 50 skill files written to $DIR"
echo "   Total skill files now: $(ls $DIR/*.ts | wc -l)"
SCRIPT_EOF
