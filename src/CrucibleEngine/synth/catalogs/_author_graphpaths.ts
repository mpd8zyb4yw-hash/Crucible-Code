import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url'
const HERE = path.dirname(fileURLToPath(import.meta.url))

const entries = [
  {
    id: 'dijkstra-distances', filename: 'dijkstraDistances',
    summary: 'dijkstraDistances returns single-source shortest distances over a directed weighted graph; unreachable nodes are Infinity.',
    defaultPath: 'src/dijkstraDistances.ts', exports: ['dijkstraDistances'],
    patterns: [{ re: '\\bdijkstraDistances\\b', weight: 0.6 }, { re: 'dijkstra|shortest path.*weighted', weight: 0.3 }],
    impl: `export function dijkstraDistances(n, edges, src) {
  const adj = Array.from({ length: n }, () => [])
  for (const [u, v, w] of edges) adj[u].push([v, w])
  const dist = new Array(n).fill(Infinity); dist[src] = 0
  const visited = new Array(n).fill(false)
  for (let iter = 0; iter < n; iter++) {
    let u = -1, best = Infinity
    for (let i = 0; i < n; i++) if (!visited[i] && dist[i] < best) { best = dist[i]; u = i }
    if (u < 0) break
    visited[u] = true
    for (const [v, w] of adj[u]) if (dist[u] + w < dist[v]) dist[v] = dist[u] + w
  }
  return dist
}`,
    tests: [
      { desc: 'classic', call: 'dijkstraDistances(5,[[0,1,4],[0,2,1],[2,1,2],[1,3,1]],0)', want: '[0,3,1,4,null]' },
      { desc: 'single', call: 'dijkstraDistances(1,[],0)', want: '[0]' },
      { desc: 'unreachable', call: 'dijkstraDistances(2,[],0)', want: '[0,null]' },
      { desc: 'direct', call: 'dijkstraDistances(2,[[0,1,5]],0)', want: '[0,5]' },
      { desc: 'shorter via relay', call: 'dijkstraDistances(3,[[0,1,10],[0,2,1],[2,1,1]],0)', want: '[0,2,1]' },
      { desc: 'source offset', call: 'dijkstraDistances(3,[[0,1,1],[1,2,1]],2)', want: '[null,null,0]' },
    ],
  },
  {
    id: 'bellman-ford-distances', filename: 'bellmanFordDistances',
    summary: 'bellmanFordDistances returns shortest distances allowing negative edges, or null when a negative cycle is reachable from the source.',
    defaultPath: 'src/bellmanFordDistances.ts', exports: ['bellmanFordDistances'],
    patterns: [{ re: '\\bbellmanFordDistances\\b', weight: 0.6 }, { re: 'bellman.?ford|negative.*cycle', weight: 0.3 }],
    impl: `export function bellmanFordDistances(n, edges, src) {
  const dist = new Array(n).fill(Infinity); dist[src] = 0
  for (let i = 0; i < n - 1; i++)
    for (const [u, v, w] of edges)
      if (dist[u] !== Infinity && dist[u] + w < dist[v]) dist[v] = dist[u] + w
  for (const [u, v, w] of edges)
    if (dist[u] !== Infinity && dist[u] + w < dist[v]) return null
  return dist
}`,
    tests: [
      { desc: 'positive edges', call: 'bellmanFordDistances(4,[[0,1,1],[1,2,2],[0,2,4]],0)', want: '[0,1,3,null]' },
      { desc: 'negative edge ok', call: 'bellmanFordDistances(3,[[0,1,4],[1,2,-2],[0,2,5]],0)', want: '[0,4,2]' },
      { desc: 'negative cycle', call: 'bellmanFordDistances(3,[[0,1,1],[1,2,-1],[2,1,-1]],0)', want: 'null' },
      { desc: 'unreachable', call: 'bellmanFordDistances(2,[],0)', want: '[0,null]' },
      { desc: 'single', call: 'bellmanFordDistances(1,[],0)', want: '[0]' },
    ],
  },
  {
    id: 'bfs-hop-counts', filename: 'bfsHopCounts',
    summary: 'bfsHopCounts returns the shortest hop count from a source in an unweighted graph given adjacency lists; unreachable is -1.',
    defaultPath: 'src/bfsHopCounts.ts', exports: ['bfsHopCounts'],
    patterns: [{ re: '\\bbfsHopCounts\\b', weight: 0.6 }, { re: 'breadth.?first|hop count|unweighted.*shortest', weight: 0.3 }],
    impl: `export function bfsHopCounts(n, adj, src) {
  const dist = new Array(n).fill(-1); dist[src] = 0
  const queue = [src]
  while (queue.length) {
    const u = queue.shift()
    for (const v of adj[u]) if (dist[v] === -1) { dist[v] = dist[u] + 1; queue.push(v) }
  }
  return dist
}`,
    tests: [
      { desc: 'basic', call: 'bfsHopCounts(4,[[1,2],[0,3],[0],[1]],0)', want: '[0,1,1,2]' },
      { desc: 'unreachable', call: 'bfsHopCounts(3,[[1],[0],[]],0)', want: '[0,1,-1]' },
      { desc: 'single', call: 'bfsHopCounts(1,[[]],0)', want: '[0]' },
      { desc: 'chain', call: 'bfsHopCounts(4,[[1],[2],[3],[]],0)', want: '[0,1,2,3]' },
    ],
  },
  {
    id: 'topo-order-kahn', filename: 'topoOrderKahn',
    summary: 'topoOrderKahn returns a topological order (smallest id first on ties) via Kahn, or an empty array if the graph has a cycle.',
    defaultPath: 'src/topoOrderKahn.ts', exports: ['topoOrderKahn'],
    patterns: [{ re: '\\btopoOrderKahn\\b', weight: 0.6 }, { re: 'topological.*kahn|topological order', weight: 0.3 }],
    impl: `export function topoOrderKahn(n, edges) {
  const indeg = new Array(n).fill(0)
  const adj = Array.from({ length: n }, () => [])
  for (const [u, v] of edges) { adj[u].push(v); indeg[v]++ }
  const avail = new Set()
  for (let i = 0; i < n; i++) if (indeg[i] === 0) avail.add(i)
  const order = []
  while (avail.size) {
    const u = Math.min(...avail); avail.delete(u); order.push(u)
    for (const v of adj[u]) if (--indeg[v] === 0) avail.add(v)
  }
  return order.length === n ? order : []
}`,
    tests: [
      { desc: 'diamond', call: 'topoOrderKahn(4,[[0,1],[0,2],[1,3],[2,3]])', want: '[0,1,2,3]' },
      { desc: 'cycle', call: 'topoOrderKahn(2,[[0,1],[1,0]])', want: '[]' },
      { desc: 'no edges', call: 'topoOrderKahn(3,[])', want: '[0,1,2]' },
      { desc: 'reversed chain', call: 'topoOrderKahn(3,[[2,1],[1,0]])', want: '[2,1,0]' },
      { desc: 'self loop', call: 'topoOrderKahn(2,[[0,0]])', want: '[]' },
    ],
  },
  {
    id: 'connected-components-count', filename: 'connectedComponentsCount',
    summary: 'connectedComponentsCount returns the number of connected components in an undirected graph.',
    defaultPath: 'src/connectedComponentsCount.ts', exports: ['connectedComponentsCount'],
    patterns: [{ re: '\\bconnectedComponentsCount\\b', weight: 0.6 }, { re: 'connected component', weight: 0.3 }],
    impl: `export function connectedComponentsCount(n, edges) {
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
  let count = n
  for (const [u, v] of edges) { const ru = find(u), rv = find(v); if (ru !== rv) { parent[ru] = rv; count-- } }
  return count
}`,
    tests: [
      { desc: 'two groups', call: 'connectedComponentsCount(5,[[0,1],[1,2],[3,4]])', want: '2' },
      { desc: 'all isolated', call: 'connectedComponentsCount(3,[])', want: '3' },
      { desc: 'all connected', call: 'connectedComponentsCount(4,[[0,1],[2,3],[1,2]])', want: '1' },
      { desc: 'single', call: 'connectedComponentsCount(1,[])', want: '1' },
    ],
  },
  {
    id: 'has-cycle-undirected', filename: 'hasCycleUndirected',
    summary: 'hasCycleUndirected reports whether an undirected graph contains a cycle.',
    defaultPath: 'src/hasCycleUndirected.ts', exports: ['hasCycleUndirected'],
    patterns: [{ re: '\\bhasCycleUndirected\\b', weight: 0.6 }, { re: 'cycle.*undirected|undirected.*cycle', weight: 0.3 }],
    impl: `export function hasCycleUndirected(n, edges) {
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
  for (const [u, v] of edges) {
    const ru = find(u), rv = find(v)
    if (ru === rv) return true
    parent[ru] = rv
  }
  return false
}`,
    tests: [
      { desc: 'triangle', call: 'hasCycleUndirected(3,[[0,1],[1,2],[2,0]])', want: 'true' },
      { desc: 'tree', call: 'hasCycleUndirected(3,[[0,1],[1,2]])', want: 'false' },
      { desc: 'forest', call: 'hasCycleUndirected(4,[[0,1],[2,3]])', want: 'false' },
      { desc: 'single', call: 'hasCycleUndirected(1,[])', want: 'false' },
      { desc: 'self loop', call: 'hasCycleUndirected(2,[[0,0]])', want: 'true' },
    ],
  },
  {
    id: 'grid-bfs-steps', filename: 'gridBfsSteps',
    summary: 'gridBfsSteps returns the minimum 4-directional steps between two grid cells where 1 is a wall and 0 is open, or -1 if unreachable.',
    defaultPath: 'src/gridBfsSteps.ts', exports: ['gridBfsSteps'],
    patterns: [{ re: '\\bgridBfsSteps\\b', weight: 0.6 }, { re: 'grid.*bfs|shortest.*grid|maze.*path', weight: 0.3 }],
    impl: `export function gridBfsSteps(grid, sr, sc, tr, tc) {
  const R = grid.length, C = grid[0]?.length ?? 0
  if (grid[sr][sc] === 1 || grid[tr][tc] === 1) return -1
  const dist = Array.from({ length: R }, () => new Array(C).fill(-1))
  dist[sr][sc] = 0
  const queue = [[sr, sc]]
  const dirs = [[1,0],[-1,0],[0,1],[0,-1]]
  while (queue.length) {
    const [r, c] = queue.shift()
    if (r === tr && c === tc) return dist[r][c]
    for (const [dr, dc] of dirs) {
      const nr = r+dr, nc = c+dc
      if (nr>=0 && nr<R && nc>=0 && nc<C && grid[nr][nc]===0 && dist[nr][nc]===-1) {
        dist[nr][nc] = dist[r][c]+1; queue.push([nr, nc])
      }
    }
  }
  return dist[tr][tc]
}`,
    tests: [
      { desc: 'around wall', call: 'gridBfsSteps([[0,0,0],[1,1,0],[0,0,0]],0,0,2,0)', want: '6' },
      { desc: 'same cell', call: 'gridBfsSteps([[0]],0,0,0,0)', want: '0' },
      { desc: 'blocked', call: 'gridBfsSteps([[0,1],[1,0]],0,0,1,1)', want: '-1' },
      { desc: 'open square', call: 'gridBfsSteps([[0,0],[0,0]],0,0,1,1)', want: '2' },
      { desc: 'straight line', call: 'gridBfsSteps([[0,0,0,0]],0,0,0,3)', want: '3' },
    ],
  },
  {
    id: 'detect-cycle-directed', filename: 'detectCycleDirected',
    summary: 'detectCycleDirected reports whether a directed graph has a cycle.',
    defaultPath: 'src/detectCycleDirected.ts', exports: ['detectCycleDirected'],
    patterns: [{ re: '\\bdetectCycleDirected\\b', weight: 0.6 }, { re: 'cycle.*directed|directed.*cycle', weight: 0.3 }],
    impl: `export function detectCycleDirected(n, edges) {
  const adj = Array.from({ length: n }, () => [])
  for (const [u, v] of edges) adj[u].push(v)
  const WHITE = 0, GREY = 1, BLACK = 2
  const color = new Array(n).fill(WHITE)
  const dfs = (u) => {
    color[u] = GREY
    for (const v of adj[u]) {
      if (color[v] === GREY) return true
      if (color[v] === WHITE && dfs(v)) return true
    }
    color[u] = BLACK; return false
  }
  for (let i = 0; i < n; i++) if (color[i] === WHITE && dfs(i)) return true
  return false
}`,
    tests: [
      { desc: 'no cycle', call: 'detectCycleDirected(3,[[0,1],[1,2]])', want: 'false' },
      { desc: 'has cycle', call: 'detectCycleDirected(3,[[0,1],[1,2],[2,0]])', want: 'true' },
      { desc: 'self loop', call: 'detectCycleDirected(2,[[0,0]])', want: 'true' },
      { desc: 'no edges', call: 'detectCycleDirected(3,[])', want: 'false' },
      { desc: 'diamond no cycle', call: 'detectCycleDirected(4,[[0,1],[0,2],[1,3],[2,3]])', want: 'false' },
    ],
  },
]

const out = path.join(HERE, 'graphPaths.json')
fs.writeFileSync(out, JSON.stringify(entries, null, 2))
console.log(`wrote ${entries.length} -> ${out}`)
