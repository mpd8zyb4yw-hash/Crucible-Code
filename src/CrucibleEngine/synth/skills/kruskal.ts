import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Kruskal's MST: O(E log E) using DSU.
export interface KEdge { u: number; v: number; w: number }
export function kruskal(n: number, edges: KEdge[]): { mst: KEdge[]; weight: number } {
  const sorted = [...edges].sort((a, b) => a.w - b.w)
  const parent = Array.from({ length: n }, (_, i) => i)
  const rank = new Array(n).fill(0)
  const find = (x: number): number => parent[x] === x ? x : (parent[x] = find(parent[x]))
  const union = (x: number, y: number): boolean => {
    const rx = find(x), ry = find(y); if (rx === ry) return false
    if (rank[rx] < rank[ry]) parent[rx] = ry
    else if (rank[rx] > rank[ry]) parent[ry] = rx
    else { parent[ry] = rx; rank[rx]++ }; return true
  }
  const mst: KEdge[] = []; let weight = 0
  for (const e of sorted) if (union(e.u, e.v)) { mst.push(e); weight += e.w }
  return { mst, weight }
}
`
registerSkill({
  id: 'kruskal',
  summary: "Kruskal's MST: O(E log E) minimum spanning tree using DSU.",
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bkruskal\b/i)) sc += 0.7
    if (s.has(/\bmst\b|minimum.?spanning.?tree/i)) sc += 0.3
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/kruskal.ts', content: IMPL }]
  },
})
