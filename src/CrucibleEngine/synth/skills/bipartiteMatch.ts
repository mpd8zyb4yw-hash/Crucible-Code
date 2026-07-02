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
