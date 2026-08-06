// Verified primitive: Tarjan's SCC + Kosaraju's SCC algorithms.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Strongly Connected Components.
export function tarjanSCC(n: number, adj: number[][]): number[][] {
  const index = new Array(n).fill(-1)
  const lowlink = new Array(n).fill(0)
  const onStack = new Array(n).fill(false)
  const stack: number[] = []; const sccs: number[][] = []; let idx = 0

  const strongConnect = (v: number): void => {
    index[v] = lowlink[v] = idx++; stack.push(v); onStack[v] = true
    for (const w of adj[v]) {
      if (index[w] < 0) { strongConnect(w); lowlink[v] = Math.min(lowlink[v], lowlink[w]) }
      else if (onStack[w]) lowlink[v] = Math.min(lowlink[v], index[w])
    }
    if (lowlink[v] === index[v]) {
      const scc: number[] = []; let w: number
      do { w = stack.pop()!; onStack[w] = false; scc.push(w) } while (w !== v)
      sccs.push(scc)
    }
  }

  for (let i = 0; i < n; i++) if (index[i] < 0) strongConnect(i)
  return sccs
}

export function kosarajuSCC(n: number, adj: number[][]): number[][] {
  const radj: number[][] = Array.from({ length: n }, () => [])
  for (let u = 0; u < n; u++) for (const v of adj[u]) radj[v].push(u)
  const visited = new Array(n).fill(false); const order: number[] = []
  const dfs1 = (u: number): void => { visited[u] = true; for (const v of adj[u]) if (!visited[v]) dfs1(v); order.push(u) }
  for (let i = 0; i < n; i++) if (!visited[i]) dfs1(i)
  const comp = new Array(n).fill(-1)
  const dfs2 = (u: number, c: number): void => { comp[u] = c; for (const v of radj[u]) if (comp[v] < 0) dfs2(v, c) }
  let c = 0; for (let i = order.length - 1; i >= 0; i--) if (comp[order[i]] < 0) dfs2(order[i], c++)
  const sccs: number[][] = Array.from({ length: c }, () => [])
  for (let i = 0; i < n; i++) sccs[comp[i]].push(i)
  return sccs
}
`
registerSkill({
  id: 'strongly-connected',
  summary: "Tarjan's SCC + Kosaraju's SCC algorithms.",
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bscc\b|strongly.?connected/i)) sc += 0.5
    if (s.has(/\btarjan\b/i)) sc += 0.4
    if (s.has(/\bkosaraju\b/i)) sc += 0.4
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/scc.ts', content: IMPL }]
  },
})
