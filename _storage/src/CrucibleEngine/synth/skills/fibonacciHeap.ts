import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Fibonacci Heap: O(1) insert/decrease-key, O(log n) amortised deleteMin.
interface FNode<K,V>{k:K;v:V;degree:number;marked:boolean;parent:FNode<K,V>|null;child:FNode<K,V>|null;prev:FNode<K,V>;next:FNode<K,V>}
export class FibonacciHeap<K=number,V=unknown>{
  private min:FNode<K,V>|null=null
  private n=0
  private cmp:(a:K,b:K)=>number
  constructor(cmp:(a:K,b:K)=>number=(a,b)=>a<b?-1:a>b?1:0){this.cmp=cmp}
  private mk(k:K,v:V):FNode<K,V>{const n={k,v,degree:0,marked:false,parent:null,child:null} as FNode<K,V>;n.prev=n;n.next=n;return n}
  private link(a:FNode<K,V>,b:FNode<K,V>):void{
    a.prev.next=a.next;a.next.prev=a.prev
    a.parent=b;a.marked=false
    if(!b.child){b.child=a;a.prev=a;a.next=a}else{a.next=b.child;a.prev=b.child.prev;b.child.prev.next=a;b.child.prev=a}
    b.degree++
  }
  push(k:K,v:V):FNode<K,V>{
    const n=this.mk(k,v)
    if(!this.min){this.min=n}else{
      n.next=this.min;n.prev=this.min.prev;this.min.prev.next=n;this.min.prev=n
      if(this.cmp(k,this.min.k)<0)this.min=n
    }
    this.n++;return n
  }
  peek():V|undefined{return this.min?.v}
  pop():V|undefined{
    const z=this.min;if(!z)return undefined
    if(z.child){let c=z.child;do{const nx=c.next;c.parent=null;c.prev=z.prev;c.next=z;z.prev.next=c;z.prev=c;c=nx}while(c!==z.child)}
    z.prev.next=z.next;z.next.prev=z.prev
    if(z===z.next){this.min=null}else{this.min=z.next;this._consolidate()}
    this.n--;return z.v
  }
  private _consolidate():void{
    const A:Array<FNode<K,V>|undefined>=new Array(Math.ceil(Math.log2(this.n+1))+1)
    const roots:FNode<K,V>[]=[];let r=this.min!;do{roots.push(r);r=r.next}while(r!==this.min)
    for(let w of roots){let d=w.degree;while(A[d]){let y=A[d]!;if(this.cmp(w.k,y.k)>0)[w,y]=[y,w];this.link(y,w);A[d]=undefined;d++}A[d]=w}
    this.min=null
    for(const n of A)if(n){n.prev=n;n.next=n;if(!this.min){this.min=n}else{n.next=this.min;n.prev=this.min.prev;this.min.prev.next=n;this.min.prev=n;if(this.cmp(n.k,this.min.k)<0)this.min=n}}
  }
  size():number{return this.n}
}
`
registerSkill({
  id: 'fibonacci-heap',
  summary: 'Fibonacci heap: O(1) insert/decrease-key, O(log n) amortised deleteMin.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bfibonacci.?heap\b/i)) sc += 0.7
    if (s.has(/\bdecrease.?key\b/i)) sc += 0.3
    if (s.has(/\bo\(1\)\b/i) && s.has(/\binsert\b/i) && s.has(/\bheap\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/fibonacciHeap.ts', content: IMPL }]
  },
})
