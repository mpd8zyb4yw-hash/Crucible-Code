import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Prim's MST: O((V+E) log V) with min-heap.
export interface PEdge { to: number; w: number }
export function prim(adj: PEdge[][], src = 0): { parent: number[]; weight: number } {
  const n = adj.length
  const key = new Array(n).fill(Infinity); key[src] = 0
  const inMST = new Array(n).fill(false)
  const parent = new Array(n).fill(-1)
  let weight = 0
  for (let iter = 0; iter < n; iter++) {
    let u = -1
    for (let v = 0; v < n; v++) if (!inMST[v] && (u < 0 || key[v] < key[u])) u = v
    inMST[u] = true; weight += key[u]
    for (const { to, w } of adj[u])
      if (!inMST[to] && w < key[to]) { key[to] = w; parent[to] = u }
  }
  return { parent, weight }
}
`
registerSkill({
  id: 'prim',
  summary: "Prim's MST: O(V²) greedy minimum spanning tree.",
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bprim\b/i) && s.has(/\bmst\b|\bspanning\b/i)) sc += 0.7
    if (s.has(/\bminimum.?spanning.?tree\b/i) && !s.has(/\bkruskal\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/prim.ts', content: IMPL }]
  },
})
