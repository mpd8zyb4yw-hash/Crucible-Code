import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url'
const HERE = path.dirname(fileURLToPath(import.meta.url))

const entries = [
  {
    id: 'dsu-union-find', filename: 'dsuUnionFind',
    summary: 'DSU (disjoint-set union) with constructor, find (path compression), union, connected, and count.',
    defaultPath: 'src/dsuUnionFind.ts', exports: ['DSU'],
    patterns: [{ re: '\\bDSU\\b', weight: 0.6 }, { re: 'disjoint.?set|union.?find', weight: 0.3 }],
    impl: `export class DSU {
  private parent
  private rank
  private cnt
  constructor(n) {
    this.parent = Array.from({ length: n }, (_, i) => i)
    this.rank = new Array(n).fill(0)
    this.cnt = n
  }
  find(x) {
    while (this.parent[x] !== x) { this.parent[x] = this.parent[this.parent[x]]; x = this.parent[x] }
    return x
  }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b)
    if (ra === rb) return
    if (this.rank[ra] < this.rank[rb]) this.parent[ra] = rb
    else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra
    else { this.parent[rb] = ra; this.rank[ra]++ }
    this.cnt--
  }
  connected(a, b) { return this.find(a) === this.find(b) }
  count() { return this.cnt }
}`,
    tests: [
      { desc: 'union and connected', call: '(() => { const d = new DSU(4); d.union(0,1); d.union(2,3); return d.connected(0,1) })()', want: 'true' },
      { desc: 'not connected', call: '(() => { const d = new DSU(4); d.union(0,1); return d.connected(0,2) })()', want: 'false' },
      { desc: 'count init', call: 'new DSU(5).count()', want: '5' },
      { desc: 'count after union', call: '(() => { const d = new DSU(4); d.union(0,1); d.union(2,3); return d.count() })()', want: '2' },
      { desc: 'self connected', call: '(() => { const d = new DSU(3); return d.connected(1,1) })()', want: 'true' },
      { desc: 'path compression works', call: '(() => { const d = new DSU(5); d.union(0,1); d.union(1,2); d.union(2,3); return d.connected(0,3) })()', want: 'true' },
    ],
  },
  {
    id: 'is-bipartite-graph', filename: 'isBipartiteGraph',
    summary: 'isBipartiteGraph reports whether an undirected graph is 2-colorable (bipartite).',
    defaultPath: 'src/isBipartiteGraph.ts', exports: ['isBipartiteGraph'],
    patterns: [{ re: '\\bisBipartiteGraph\\b', weight: 0.6 }, { re: 'bipartite|2.?colorable', weight: 0.3 }],
    impl: `export function isBipartiteGraph(n, edges) {
  const adj = Array.from({ length: n }, () => [])
  for (const [u, v] of edges) { adj[u].push(v); adj[v].push(u) }
  const color = new Array(n).fill(-1)
  for (let s = 0; s < n; s++) {
    if (color[s] !== -1) continue
    const queue = [s]; color[s] = 0
    while (queue.length) {
      const u = queue.shift()
      for (const v of adj[u]) {
        if (color[v] === -1) { color[v] = 1 - color[u]; queue.push(v) }
        else if (color[v] === color[u]) return false
      }
    }
  }
  return true
}`,
    tests: [
      { desc: 'even cycle', call: 'isBipartiteGraph(4,[[0,1],[1,2],[2,3],[3,0]])', want: 'true' },
      { desc: 'triangle', call: 'isBipartiteGraph(3,[[0,1],[1,2],[2,0]])', want: 'false' },
      { desc: 'no edges', call: 'isBipartiteGraph(4,[])', want: 'true' },
      { desc: 'path', call: 'isBipartiteGraph(3,[[0,1],[1,2]])', want: 'true' },
      { desc: 'odd cycle', call: 'isBipartiteGraph(5,[[0,1],[1,2],[2,3],[3,4],[4,0]])', want: 'false' },
    ],
  },
  {
    id: 'kruskal-mst-weight', filename: 'kruskalMstWeight',
    summary: 'kruskalMstWeight returns the total weight of the minimum spanning forest using Kruskal.',
    defaultPath: 'src/kruskalMstWeight.ts', exports: ['kruskalMstWeight'],
    patterns: [{ re: '\\bkruskalMstWeight\\b', weight: 0.6 }, { re: 'kruskal|minimum spanning', weight: 0.3 }],
    impl: `export function kruskalMstWeight(n, edges) {
  const sorted = [...edges].sort((a, b) => a[2] - b[2])
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
  let total = 0
  for (const [u, v, w] of sorted) {
    const ru = find(u), rv = find(v)
    if (ru !== rv) { parent[ru] = rv; total += w }
  }
  return total
}`,
    tests: [
      { desc: 'classic', call: 'kruskalMstWeight(4,[[0,1,1],[0,2,4],[1,2,2],[1,3,5],[2,3,3]])', want: '6' },
      { desc: 'no edges single', call: 'kruskalMstWeight(1,[])', want: '0' },
      { desc: 'two nodes', call: 'kruskalMstWeight(2,[[0,1,7]])', want: '7' },
      { desc: 'parallel edges picks min', call: 'kruskalMstWeight(2,[[0,1,5],[0,1,3]])', want: '3' },
      { desc: 'disconnected forest', call: 'kruskalMstWeight(4,[[0,1,2],[2,3,3]])', want: '5' },
    ],
  },
  {
    id: 'prim-mst-weight', filename: 'primMstWeight',
    summary: 'primMstWeight returns the MST weight via Prim starting from node 0.',
    defaultPath: 'src/primMstWeight.ts', exports: ['primMstWeight'],
    patterns: [{ re: '\\bprimMstWeight\\b', weight: 0.6 }, { re: "prim'?s.*algorithm|prim.*spanning", weight: 0.3 }],
    impl: `export function primMstWeight(n, edges) {
  const adj = Array.from({ length: n }, () => [])
  for (const [u, v, w] of edges) { adj[u].push([v, w]); adj[v].push([u, w]) }
  const inMST = new Array(n).fill(false)
  const key = new Array(n).fill(Infinity); key[0] = 0
  let total = 0
  for (let iter = 0; iter < n; iter++) {
    let u = -1
    for (let i = 0; i < n; i++) if (!inMST[i] && (u < 0 || key[i] < key[u])) u = i
    if (u < 0 || key[u] === Infinity) break
    inMST[u] = true; total += key[u]
    for (const [v, w] of adj[u]) if (!inMST[v] && w < key[v]) key[v] = w
  }
  return total
}`,
    tests: [
      { desc: 'classic', call: 'primMstWeight(4,[[0,1,1],[0,2,4],[1,2,2],[1,3,5],[2,3,3]])', want: '6' },
      { desc: 'single', call: 'primMstWeight(1,[])', want: '0' },
      { desc: 'two nodes', call: 'primMstWeight(2,[[0,1,7]])', want: '7' },
      { desc: 'triangle', call: 'primMstWeight(3,[[0,1,1],[1,2,1],[0,2,10]])', want: '2' },
    ],
  },
  {
    id: 'transitive-closure', filename: 'transitiveClosure',
    summary: 'transitiveClosure returns a reachability matrix where entry [i][j] is true if j is reachable from i (a node reaches itself).',
    defaultPath: 'src/transitiveClosure.ts', exports: ['transitiveClosure'],
    patterns: [{ re: '\\btransitiveClosure\\b', weight: 0.6 }, { re: 'transitive.*closure|reachability.*matrix', weight: 0.3 }],
    impl: `export function transitiveClosure(n, edges) {
  const reach = Array.from({ length: n }, (_, i) => {
    const r = new Array(n).fill(false); r[i] = true; return r
  })
  for (const [u, v] of edges) reach[u][v] = true
  for (let k = 0; k < n; k++)
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        if (reach[i][k] && reach[k][j]) reach[i][j] = true
  return reach
}`,
    tests: [
      { desc: 'chain', call: 'transitiveClosure(3,[[0,1],[1,2]])', want: '[[true,true,true],[false,true,true],[false,false,true]]' },
      { desc: 'self always true', call: 'transitiveClosure(2,[])[0][0]', want: 'true' },
      { desc: 'no edges', call: 'transitiveClosure(2,[])', want: '[[true,false],[false,true]]' },
      { desc: 'direct only', call: 'transitiveClosure(2,[[0,1]])', want: '[[true,true],[false,true]]' },
    ],
  },
  {
    id: 'topo-sort-levels', filename: 'topoSortLevels',
    summary: 'topoSortLevels groups nodes into Kahn levels (each inner array sorted ascending); returns empty outer array if graph is cyclic.',
    defaultPath: 'src/topoSortLevels.ts', exports: ['topoSortLevels'],
    patterns: [{ re: '\\btopoSortLevels\\b', weight: 0.6 }, { re: 'topological.*level|level.*kahn', weight: 0.3 }],
    impl: `export function topoSortLevels(n, edges) {
  const indeg = new Array(n).fill(0)
  const adj = Array.from({ length: n }, () => [])
  for (const [u, v] of edges) { adj[u].push(v); indeg[v]++ }
  let frontier = []
  for (let i = 0; i < n; i++) if (indeg[i] === 0) frontier.push(i)
  frontier.sort((a, b) => a - b)
  const levels = []
  let processed = 0
  while (frontier.length) {
    levels.push([...frontier]); processed += frontier.length
    const next = []
    for (const u of frontier) for (const v of adj[u]) if (--indeg[v] === 0) next.push(v)
    frontier = next.sort((a, b) => a - b)
  }
  return processed === n ? levels : []
}`,
    tests: [
      { desc: 'chain', call: 'topoSortLevels(3,[[0,1],[1,2]])', want: '[[0],[1],[2]]' },
      { desc: 'diamond', call: 'topoSortLevels(4,[[0,1],[0,2],[1,3],[2,3]])', want: '[[0],[1,2],[3]]' },
      { desc: 'no edges', call: 'topoSortLevels(3,[])', want: '[[0,1,2]]' },
      { desc: 'cycle', call: 'topoSortLevels(2,[[0,1],[1,0]])', want: '[]' },
    ],
  },
  {
    id: 'degree-sequence', filename: 'degreeSequence',
    summary: 'degreeSequence returns the undirected degree of each node in a graph, sorted descending.',
    defaultPath: 'src/degreeSequence.ts', exports: ['degreeSequence'],
    patterns: [{ re: '\\bdegreeSequence\\b', weight: 0.6 }, { re: 'degree.*sequence|degree.*graph', weight: 0.3 }],
    impl: `export function degreeSequence(n, edges) {
  const deg = new Array(n).fill(0)
  for (const [u, v] of edges) { deg[u]++; if (u !== v) deg[v]++ }
  return deg.sort((a, b) => b - a)
}`,
    tests: [
      { desc: 'triangle', call: 'degreeSequence(3,[[0,1],[1,2],[2,0]])', want: '[2,2,2]' },
      { desc: 'star', call: 'degreeSequence(4,[[0,1],[0,2],[0,3]])', want: '[3,1,1,1]' },
      { desc: 'no edges', call: 'degreeSequence(3,[])', want: '[0,0,0]' },
      { desc: 'path', call: 'degreeSequence(3,[[0,1],[1,2]])', want: '[2,1,1]' },
    ],
  },
  {
    id: 'count-paths-dag', filename: 'countPathsDag',
    summary: 'countPathsDag returns the number of distinct paths from a source to a target in a DAG.',
    defaultPath: 'src/countPathsDag.ts', exports: ['countPathsDag'],
    patterns: [{ re: '\\bcountPathsDag\\b', weight: 0.6 }, { re: 'count.*paths.*dag|number.*paths.*directed', weight: 0.3 }],
    impl: `export function countPathsDag(n, edges, src, tgt) {
  const adj = Array.from({ length: n }, () => [])
  for (const [u, v] of edges) adj[u].push(v)
  const memo = new Map()
  const dfs = (u) => {
    if (u === tgt) return 1
    if (memo.has(u)) return memo.get(u)
    let cnt = 0
    for (const v of adj[u]) cnt += dfs(v)
    memo.set(u, cnt); return cnt
  }
  return dfs(src)
}`,
    tests: [
      { desc: 'direct', call: 'countPathsDag(2,[[0,1]],0,1)', want: '1' },
      { desc: 'two paths', call: 'countPathsDag(4,[[0,1],[0,2],[1,3],[2,3]],0,3)', want: '2' },
      { desc: 'no path', call: 'countPathsDag(3,[[0,1]],0,2)', want: '0' },
      { desc: 'src equals tgt', call: 'countPathsDag(3,[[0,1],[1,2]],1,1)', want: '1' },
      { desc: 'three paths', call: 'countPathsDag(5,[[0,1],[0,2],[0,3],[1,4],[2,4],[3,4]],0,4)', want: '3' },
    ],
  },
]

const out = path.join(HERE, 'graphStruct.json')
fs.writeFileSync(out, JSON.stringify(entries, null, 2))
console.log(`wrote ${entries.length} -> ${out}`)
