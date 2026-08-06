import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Skip List: probabilistic sorted structure, O(log n) average ops.
const MAX_LEVEL = 16; const P = 0.5
interface SLNode<K,V>{k:K;v:V;fwd:(SLNode<K,V>|null)[]}
export class SkipList<K=number,V=unknown>{
  private head:SLNode<K,V>
  private level=1
  private cmp:(a:K,b:K)=>number
  constructor(cmp:(a:K,b:K)=>number=(a,b)=>a<b?-1:a>b?1:0){
    this.cmp=cmp
    this.head={k:null as unknown as K,v:null as unknown as V,fwd:new Array(MAX_LEVEL).fill(null)}
  }
  private randLevel():number{let l=1;while(Math.random()<P&&l<MAX_LEVEL)l++;return l}
  set(k:K,v:V):void{
    const update:SLNode<K,V>[]=new Array(MAX_LEVEL).fill(this.head)
    let x=this.head
    for(let i=this.level-1;i>=0;i--){while(x.fwd[i]&&this.cmp(x.fwd[i]!.k,k)<0)x=x.fwd[i]!;update[i]=x}
    x=x.fwd[0]!
    if(x&&this.cmp(x.k,k)===0){x.v=v;return}
    const nl=this.randLevel()
    if(nl>this.level){for(let i=this.level;i<nl;i++)update[i]=this.head;this.level=nl}
    const n:SLNode<K,V>={k,v,fwd:new Array(MAX_LEVEL).fill(null)}
    for(let i=0;i<nl;i++){n.fwd[i]=update[i].fwd[i];update[i].fwd[i]=n}
  }
  get(k:K):V|undefined{
    let x=this.head
    for(let i=this.level-1;i>=0;i--)while(x.fwd[i]&&this.cmp(x.fwd[i]!.k,k)<0)x=x.fwd[i]!
    x=x.fwd[0]!;return x&&this.cmp(x.k,k)===0?x.v:undefined
  }
  *range(lo:K,hi:K):IterableIterator<[K,V]>{
    let x=this.head
    for(let i=this.level-1;i>=0;i--)while(x.fwd[i]&&this.cmp(x.fwd[i]!.k,lo)<0)x=x.fwd[i]!
    x=x.fwd[0]!
    while(x&&this.cmp(x.k,hi)<=0){yield[x.k,x.v];x=x.fwd[0]!}
  }
}
`
registerSkill({
  id: 'skip-list',
  summary: 'Skip list: probabilistic sorted structure, O(log n) average set/get/range.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bskip.?list\b/i)) sc += 0.7
    if (s.has(/\bprobabilistic\b/i) && s.has(/\bsorted\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/skipList.ts', content: IMPL }]
  },
})
