import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — verified BFS and DFS for adjacency-list graphs.
export function bfs(graph: number[][], src: number): { visited: boolean[]; order: number[]; dist: number[] } {
  const n=graph.length, visited=new Array(n).fill(false), dist=new Array(n).fill(-1), order:number[]=[]
  const q=[src]; visited[src]=true; dist[src]=0
  while(q.length){ const u=q.shift()!; order.push(u); for(const v of graph[u]){if(!visited[v]){visited[v]=true;dist[v]=dist[u]+1;q.push(v)}} }
  return {visited,order,dist}
}
export function dfs(graph: number[][], src: number): { visited: boolean[]; order: number[] } {
  const n=graph.length, visited=new Array(n).fill(false), order:number[]=[]
  const stack=[src]
  while(stack.length){ const u=stack.pop()!; if(visited[u])continue; visited[u]=true; order.push(u); for(const v of [...graph[u]].reverse())if(!visited[v])stack.push(v) }
  return {visited,order}
}
export function hasCycle(graph: number[][], directed=true): boolean {
  const n=graph.length, color=new Array(n).fill(0)
  const dfs=(u:number):boolean=>{color[u]=1;for(const v of graph[u]){if(color[v]===1&&directed)return true;if(color[v]===0&&dfs(v))return true};color[u]=2;return false}
  for(let i=0;i<n;i++)if(color[i]===0&&dfs(i))return true; return false
}
`
registerSkill({ id: 'bfs-dfs', summary: 'BFS, DFS, and cycle detection for adjacency-list graphs.',
  match(s: SpecFeatures) { let score = 0; if (s.has(/\bbfs\b/i)) score += 0.4; if (s.has(/\bdfs\b/i)) score += 0.4; if (s.has(/breadth.?first/i)) score += 0.4; if (s.has(/depth.?first/i)) score += 0.4; if (s.has(/cycle.?detect/i)) score += 0.2; return score },
  emit(s: SpecFeatures): SynthFile[] { return [{ path: s.modulePath ?? 'src/bfsDfs.ts', content: IMPL }] } })
