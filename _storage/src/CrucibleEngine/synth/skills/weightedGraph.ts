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
