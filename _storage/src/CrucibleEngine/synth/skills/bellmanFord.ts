import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — verified Bellman-Ford with negative cycle detection.
export interface BFEdge { from:number; to:number; weight:number }
export function bellmanFord(n: number, edges: BFEdge[], src: number): { dist: number[]; prev: (number|null)[]; hasNegCycle: boolean } {
  const dist=new Array(n).fill(Infinity),prev=new Array(n).fill(null); dist[src]=0
  for(let i=0;i<n-1;i++)for(const{from,to,weight}of edges)if(dist[from]+weight<dist[to]){dist[to]=dist[from]+weight;prev[to]=from}
  let hasNegCycle=false; for(const{from,to,weight}of edges)if(dist[from]+weight<dist[to])hasNegCycle=true
  return{dist,prev,hasNegCycle}
}
`
registerSkill({ id: 'bellman-ford', summary: 'Bellman-Ford shortest path with negative cycle detection.',
  match(s: SpecFeatures) { let score = 0; if (s.has(/bellman.?ford/i)) score += 0.8; if (s.has(/negative.{0,20}cycle|negative.{0,20}weight/i)) score += 0.4; return score },
  emit(s: SpecFeatures): SynthFile[] { return [{ path: s.modulePath ?? 'src/bellmanFord.ts', content: IMPL }] } })
