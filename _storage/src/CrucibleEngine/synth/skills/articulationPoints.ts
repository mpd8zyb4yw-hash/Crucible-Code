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
