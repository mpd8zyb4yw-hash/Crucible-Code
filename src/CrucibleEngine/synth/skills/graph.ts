// Verified primitive: directed-graph topology — topological sort (Kahn) + cycle detection
// (DFS colour). General over any string-node graph; the scheduler/dependency-ordering task
// family maps onto it. Hand-verified; correctness is also re-confirmed by execution at synth
// time. Emits the exact `topoSort`/`findCycle` API the dependency-scheduler spec requests.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — verified directed-graph topology.
// An edge [a, b] means "a must run before b".

export function topoSort(nodes: string[], edges: [string, string][]): string[] {
  const indeg = new Map<string, number>()
  const adj = new Map<string, string[]>()
  const ensure = (n: string) => {
    if (!indeg.has(n)) indeg.set(n, 0)
    if (!adj.has(n)) adj.set(n, [])
  }
  for (const n of nodes) ensure(n)
  for (const [a, b] of edges) {
    ensure(a); ensure(b)
    adj.get(a)!.push(b)
    indeg.set(b, indeg.get(b)! + 1)
  }
  // Kahn's algorithm — seed with every zero-indegree node (includes disconnected nodes).
  const queue = nodes.filter(n => indeg.get(n) === 0)
  const order: string[] = []
  while (queue.length) {
    const n = queue.shift()!
    order.push(n)
    for (const m of adj.get(n)!) {
      indeg.set(m, indeg.get(m)! - 1)
      if (indeg.get(m) === 0) queue.push(m)
    }
  }
  if (order.length !== nodes.length) {
    throw new Error('cycle detected: the dependency graph is not a DAG')
  }
  return order
}

export function findCycle(nodes: string[], edges: [string, string][]): string[] | null {
  const adj = new Map<string, string[]>()
  for (const n of nodes) adj.set(n, [])
  for (const [a, b] of edges) {
    if (!adj.has(a)) adj.set(a, [])
    adj.get(a)!.push(b)
  }
  const WHITE = 0, GREY = 1, BLACK = 2
  const colour = new Map<string, number>()
  const stack: string[] = []
  let cycle: string[] | null = null
  const dfs = (u: string): void => {
    if (cycle) return
    colour.set(u, GREY)
    stack.push(u)
    for (const v of adj.get(u) ?? []) {
      if (cycle) break
      const c = colour.get(v) ?? WHITE
      if (c === GREY) { cycle = stack.slice(stack.indexOf(v)); return }   // back-edge (self-loop included)
      if (c === WHITE) dfs(v)
    }
    stack.pop()
    colour.set(u, BLACK)
  }
  for (const n of nodes) {
    if (cycle) break
    if ((colour.get(n) ?? WHITE) === WHITE) dfs(n)
  }
  return cycle
}
`

registerSkill({
  id: 'graph-topology',
  summary: 'Topological sort + cycle/self-loop detection over a directed graph (dependency scheduling, build ordering).',
  match(s: SpecFeatures): number {
    let score = 0
    if (s.has(/topolog/i)) score += 0.5
    if (s.has(/\bcycle\b/i)) score += 0.25
    if (s.has(/\btoposort\b|topo[- ]?sort/i)) score += 0.4
    if (s.has(/findcycle/i)) score += 0.3
    if (s.has(/\b(dependenc|must run before|build order|ordering|schedule)\w*/i)) score += 0.2
    if (s.has(/\bnodes?\b/i) && s.has(/\bedges?\b/i)) score += 0.15
    return score
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/scheduler.ts', content: IMPL }]
  },
})
