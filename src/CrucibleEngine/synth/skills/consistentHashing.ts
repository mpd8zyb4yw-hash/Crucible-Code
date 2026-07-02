import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Consistent hashing: virtual nodes, add/remove node, key lookup.
function fnv1a(s:string):number{let h=2166136261;for(let i=0;i<s.length;i++)h=(h^s.charCodeAt(i))*16777619>>>0;return h}
export class ConsistentHash{
  private ring:Map<number,string>=new Map()
  private sorted:number[]=[]
  private replicas:number
  constructor(replicas=150){this.replicas=replicas}
  addNode(node:string):void{
    for(let i=0;i<this.replicas;i++){const h=fnv1a(\`\${node}:\${i}\`);this.ring.set(h,node)}
    this.sorted=[...this.ring.keys()].sort((a,b)=>a-b)
  }
  removeNode(node:string):void{
    for(let i=0;i<this.replicas;i++){const h=fnv1a(\`\${node}:\${i}\`);this.ring.delete(h)}
    this.sorted=[...this.ring.keys()].sort((a,b)=>a-b)
  }
  getNode(key:string):string|null{
    if(!this.sorted.length)return null
    const h=fnv1a(key)
    let lo=0,hi=this.sorted.length-1
    while(lo<hi){const mid=(lo+hi)>>1;if(this.sorted[mid]<h)lo=mid+1;else hi=mid}
    return this.ring.get(this.sorted[lo%this.sorted.length])!
  }
  getNodes(key:string,n:number):string[]{
    if(!this.sorted.length)return[]
    const h=fnv1a(key);let lo=0,hi=this.sorted.length-1
    while(lo<hi){const mid=(lo+hi)>>1;if(this.sorted[mid]<h)lo=mid+1;else hi=mid}
    const seen=new Set<string>();const res:string[]=[]
    for(let i=0;i<this.sorted.length&&res.length<n;i++){
      const node=this.ring.get(this.sorted[(lo+i)%this.sorted.length])!
      if(!seen.has(node)){seen.add(node);res.push(node)}
    }
    return res
  }
}
`
registerSkill({
  id: 'consistent-hashing',
  summary: 'Consistent hashing: virtual nodes, add/remove, single/multi-replica key lookup.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bconsistent.?hash\w+\b/i)) sc += 0.7
    if (s.has(/\bvirtual.?node\b/i)) sc += 0.3
    if (s.has(/\brendezvous.?hash\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/consistentHash.ts', content: IMPL }]
  },
})
