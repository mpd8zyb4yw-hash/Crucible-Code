import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — A* search: optimal path with admissible heuristic.
export interface AStarNode { id: number; neighbors: Array<{ id: number; cost: number }> }
export function aStar(
  nodes: AStarNode[],
  start: number,
  goal: number,
  h: (id: number) => number
): { path: number[]; cost: number } | null {
  const g = new Array(nodes.length).fill(Infinity); g[start] = 0
  const prev = new Array(nodes.length).fill(-1)
  const open: Set<number> = new Set([start])
  const f = new Array(nodes.length).fill(Infinity); f[start] = h(start)
  while (open.size) {
    let u = -1
    for (const n of open) if (u < 0 || f[n] < f[u]) u = n
    if (u === goal) {
      const path = []; let c = u
      while (c !== -1) { path.push(c); c = prev[c] }
      return { path: path.reverse(), cost: g[goal] }
    }
    open.delete(u)
    for (const { id: v, cost } of nodes[u].neighbors) {
      const ng = g[u] + cost
      if (ng < g[v]) { g[v] = ng; f[v] = ng + h(v); prev[v] = u; open.add(v) }
    }
  }
  return null
}
`
registerSkill({
  id: 'a-star',
  summary: 'A* search: optimal pathfinding with admissible heuristic.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\ba\*.?search\b|\ba\*\b/i)) sc += 0.7
    if (s.has(/\badmissible\b/i) && s.has(/\bheuristic\b/i)) sc += 0.3
    if (s.has(/\bpathfind\w+\b/i) && s.has(/\bheuristic\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/aStar.ts', content: IMPL }]
  },
})
