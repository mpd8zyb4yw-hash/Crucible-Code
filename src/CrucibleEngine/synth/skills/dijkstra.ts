import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — verified Dijkstra shortest path.
export interface Edge { to: number; weight: number }
export function dijkstra(graph: Edge[][], src: number): { dist: number[]; prev: (number|null)[] } {
  const n=graph.length, dist=new Array(n).fill(Infinity), prev=new Array(n).fill(null)
  dist[src]=0
  const pq: [number,number][]=[[0,src]]
  while(pq.length){
    pq.sort((a,b)=>a[0]-b[0]); const [d,u]=pq.shift()!
    if(d>dist[u])continue
    for(const {to,weight} of graph[u]){
      const nd=dist[u]+weight
      if(nd<dist[to]){dist[to]=nd;prev[to]=u;pq.push([nd,to])}
    }
  }
  return {dist,prev}
}
export function reconstructPath(prev: (number|null)[], dst: number): number[] {
  const path:number[]=[]; let cur:number|null=dst
  while(cur!==null){path.unshift(cur);cur=prev[cur]}
  return path
}
`
registerSkill({ id: 'dijkstra', summary: "Dijkstra shortest path with path reconstruction.",
  match(s: SpecFeatures) { let score = 0; if (s.has(/dijkstra/i)) score += 0.8; if (s.has(/shortest.?path/i)) score += 0.3; if (s.has(/single.?source/i)) score += 0.2; return score },
  emit(s: SpecFeatures): SynthFile[] { return [{ path: s.modulePath ?? 'src/dijkstra.ts', content: IMPL }] } })
