import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — verified Kruskal and Prim MST.
export interface WEdge { u:number; v:number; w:number }
export function kruskalMST(n: number, edges: WEdge[]): WEdge[] {
  const parent=Array.from({length:n},(_,i)=>i),rank=new Array(n).fill(0)
  const find=(x:number):number=>{if(parent[x]!==x)parent[x]=find(parent[x]);return parent[x]}
  const union=(x:number,y:number):boolean=>{const px=find(x),py=find(y);if(px===py)return false;if(rank[px]<rank[py])parent[px]=py;else if(rank[px]>rank[py])parent[py]=px;else{parent[py]=px;rank[px]++};return true}
  return edges.slice().sort((a,b)=>a.w-b.w).filter(e=>union(e.u,e.v))
}
export function primMST(n: number, adj: {to:number,w:number}[][]): WEdge[] {
  const inMST=new Array(n).fill(false),key=new Array(n).fill(Infinity),parent=new Array(n).fill(-1)
  key[0]=0; const res:WEdge[]=[]
  for(let iter=0;iter<n;iter++){
    let u=-1;for(let v=0;v<n;v++)if(!inMST[v]&&(u===-1||key[v]<key[u]))u=v
    if(u===-1||key[u]===Infinity)break; inMST[u]=true
    if(parent[u]!==-1)res.push({u:parent[u],v:u,w:key[u]})
    for(const{to,w}of adj[u])if(!inMST[to]&&w<key[to]){key[to]=w;parent[to]=u}
  }
  return res
}
`
registerSkill({ id: 'mst', summary: "Kruskal and Prim minimum spanning tree algorithms.",
  match(s: SpecFeatures) { let score = 0; if (s.has(/minimum.?spanning.?tree|mst/i)) score += 0.7; if (s.has(/kruskal/i)) score += 0.5; if (s.has(/prim.?s/i)) score += 0.5; return score },
  emit(s: SpecFeatures): SynthFile[] { return [{ path: s.modulePath ?? 'src/mst.ts', content: IMPL }] } })
