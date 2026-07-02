import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Leftist Heap: mergeable min-heap, O(log n) merge/insert/deleteMin.
interface LNode<T>{val:T;rank:number;l:LNode<T>|null;r:LNode<T>|null}
function rank<T>(n:LNode<T>|null):number{return n?n.rank:0}
function merge<T>(a:LNode<T>|null,b:LNode<T>|null,cmp:(x:T,y:T)=>number):LNode<T>|null{
  if(!a)return b;if(!b)return a
  if(cmp(a.val,b.val)>0)[a,b]=[b,a]
  a.r=merge(a.r,b,cmp)
  if(rank(a.l)<rank(a.r))[a.l,a.r]=[a.r,a.l]
  a.rank=rank(a.r)+1
  return a
}
export class LeftistHeap<T=number>{
  private root:LNode<T>|null=null
  private cmp:(a:T,b:T)=>number
  constructor(cmp:(a:T,b:T)=>number=(a,b)=>a<b?-1:a>b?1:0){this.cmp=cmp}
  push(val:T):void{this.root=merge(this.root,{val,rank:1,l:null,r:null},this.cmp)}
  peek():T|undefined{return this.root?.val}
  pop():T|undefined{if(!this.root)return undefined;const v=this.root.val;this.root=merge(this.root.l,this.root.r,this.cmp);return v}
  merge(other:LeftistHeap<T>):void{this.root=merge(this.root,other.root,this.cmp)}
  isEmpty():boolean{return!this.root}
}
`
registerSkill({
  id: 'leftist-heap',
  summary: 'Leftist heap: mergeable min-heap, O(log n) merge/insert/deleteMin.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bleftist.?heap\b/i)) sc += 0.7
    if (s.has(/\bmergeable.?heap\b/i)) sc += 0.4
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/leftistHeap.ts', content: IMPL }]
  },
})
