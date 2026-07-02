import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Topological sort: Kahn's BFS + DFS-based, cycle detection.
export function kahnSort(n: number, edges: [number,number][]): number[] | null {
  const adj: number[][] = Array.from({ length: n }, () => [])
  const indeg = new Array(n).fill(0)
  for (const [u,v] of edges) { adj[u].push(v); indeg[v]++ }
  const q = indeg.map((d,i)=>d===0?i:-1).filter(i=>i>=0)
  const order: number[] = []
  while (q.length) {
    const u = q.shift()!; order.push(u)
    for (const v of adj[u]) if (--indeg[v] === 0) q.push(v)
  }
  return order.length === n ? order : null
}
export function dfsSort(n: number, edges: [number,number][]): number[] | null {
  const adj: number[][] = Array.from({ length: n }, () => [])
  for (const [u,v] of edges) adj[u].push(v)
  const color = new Array(n).fill(0); const order: number[] = []
  const dfs = (u: number): boolean => {
    color[u] = 1
    for (const v of adj[u]) { if (color[v] === 1) return false; if (!color[v] && !dfs(v)) return false }
    color[u] = 2; order.push(u); return true
  }
  for (let i = 0; i < n; i++) if (!color[i] && !dfs(i)) return null
  return order.reverse()
}
`
registerSkill({
  id: 'topological-sort',
  summary: "Topological sort: Kahn's BFS + DFS, cycle detection.",
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\btopolog\w+.?sort\b/i)) sc += 0.6
    if (s.has(/\bkahn\b/i)) sc += 0.3
    if (s.has(/\bdag\b/i) && s.has(/\border\b/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/topoSort.ts', content: IMPL }]
  },
})
