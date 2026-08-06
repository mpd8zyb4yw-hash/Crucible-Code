import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Dijkstra with binary min-heap: O((V+E) log V).
export interface Edge { to: number; w: number }
export function dijkstra(adj: Edge[][], src: number): { dist: number[]; prev: number[] } {
  const n = adj.length
  const dist = new Array(n).fill(Infinity); dist[src] = 0
  const prev = new Array(n).fill(-1)
  const heap: [number, number][] = [[0, src]] // [dist, node]
  const done = new Array(n).fill(false)
  while (heap.length) {
    heap.sort((a, b) => a[0] - b[0])
    const [d, u] = heap.shift()!
    if (done[u]) continue; done[u] = true
    for (const { to, w } of adj[u]) {
      if (dist[u] + w < dist[to]) {
        dist[to] = dist[u] + w; prev[to] = u
        heap.push([dist[to], to])
      }
    }
  }
  return { dist, prev }
}
export function shortestPath(prev: number[], target: number): number[] {
  const path: number[] = []; let n = target
  while (n !== -1) { path.push(n); n = prev[n] }
  return path.reverse()
}
`
registerSkill({
  id: 'dijkstra-heap',
  summary: 'Dijkstra with heap: O((V+E) log V) shortest path + path reconstruction.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bdijkstra\b/i)) sc += 0.6
    if (s.has(/\bshortest.?path\b/i) && s.has(/\bheap\b|\bpriority.?queue\b/i)) sc += 0.25
    if (s.has(/\bpath.?reconstruct\b/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/dijkstraHeap.ts', content: IMPL }]
  },
})
