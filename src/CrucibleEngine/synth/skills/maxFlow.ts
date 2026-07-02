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
