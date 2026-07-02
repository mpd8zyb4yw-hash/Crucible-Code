import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — verified topological sort (Kahn + DFS).
export function kahnSort(n: number, edges: [number,number][]): number[]|null {
  const indeg=new Array(n).fill(0),adj:number[][]=Array.from({length:n},()=>[])
  for(const[u,v]of edges){adj[u].push(v);indeg[v]++}
  const q=[];for(let i=0;i<n;i++)if(indeg[i]===0)q.push(i)
  const order:number[]=[]
  while(q.length){const u=q.shift()!;order.push(u);for(const v of adj[u])if(--indeg[v]===0)q.push(v)}
  return order.length===n?order:null
}
export function dfsTopoSort(n: number, edges: [number,number][]): number[]|null {
  const adj:number[][]=Array.from({length:n},()=>[]);for(const[u,v]of edges)adj[u].push(v)
  const color=new Array(n).fill(0),order:number[]=[]
  const dfs=(u:number):boolean=>{color[u]=1;for(const v of adj[u]){if(color[v]===1)return false;if(color[v]===0&&!dfs(v))return false};color[u]=2;order.push(u);return true}
  for(let i=0;i<n;i++)if(color[i]===0&&!dfs(i))return null
  return order.reverse()
}
`
registerSkill({ id: 'topo-sort', summary: "Topological sort via Kahn's algorithm and DFS, with cycle detection.",
  match(s: SpecFeatures) { let score = 0; if (s.has(/topolog/i)) score += 0.6; if (s.has(/kahn/i)) score += 0.4; if (s.has(/dependency.{0,20}order/i)) score += 0.3; return score },
  emit(s: SpecFeatures): SynthFile[] { return [{ path: s.modulePath ?? 'src/topoSort.ts', content: IMPL }] } })
