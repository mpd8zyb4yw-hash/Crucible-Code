import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Floyd-Warshall: all-pairs shortest paths + negative-cycle detection.
export function floydWarshall(w: number[][]): { dist: number[][]; next: number[][] } {
  const n = w.length
  const dist = w.map(r => r.slice())
  const next = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => j))
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (w[i][j] === Infinity) next[i][j] = -1
  for (let k = 0; k < n; k++)
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        if (dist[i][k] + dist[k][j] < dist[i][j]) {
          dist[i][j] = dist[i][k] + dist[k][j]; next[i][j] = next[i][k]
        }
  return { dist, next }
}
export function hasNegCycle(dist: number[][]): boolean {
  return dist.some((r, i) => r[i] < 0)
}
export function reconstructPath(next: number[][], u: number, v: number): number[] {
  if (next[u][v] === -1) return []
  const path = [u]; while (u !== v) { u = next[u][v]; path.push(u) }; return path
}
`
registerSkill({
  id: 'floyd-warshall',
  summary: 'Floyd-Warshall: all-pairs shortest paths O(V³), negative-cycle detection, path reconstruction.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bfloyd.?warshall\b/i)) sc += 0.7
    if (s.has(/\ball.?pairs.?shortest\b/i)) sc += 0.3
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/floydWarshall.ts', content: IMPL }]
  },
})
