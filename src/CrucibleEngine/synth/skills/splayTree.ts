import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Splay Tree: self-adjusting BST, O(log n) amortised.
interface SNode<K,V>{k:K;v:V;l:SNode<K,V>|null;r:SNode<K,V>|null;p:SNode<K,V>|null}
export class SplayTree<K=number,V=unknown>{
  private root:SNode<K,V>|null=null
  private cmp:(a:K,b:K)=>number
  constructor(cmp:(a:K,b:K)=>number=(a,b)=>a<b?-1:a>b?1:0){this.cmp=cmp}
  private rotR(x:SNode<K,V>):void{
    const y=x.l!;x.l=y.r;if(y.r)y.r.p=x;y.p=x.p
    if(!x.p)this.root=y;else if(x===x.p.l)x.p.l=y;else x.p.r=y
    y.r=x;x.p=y
  }
  private rotL(x:SNode<K,V>):void{
    const y=x.r!;x.r=y.l;if(y.l)y.l.p=x;y.p=x.p
    if(!x.p)this.root=y;else if(x===x.p.l)x.p.l=y;else x.p.r=y
    y.l=x;x.p=y
  }
  private splay(x:SNode<K,V>):void{
    while(x.p){
      const p=x.p,g=p.p
      if(!g){x===p.l?this.rotR(p):this.rotL(p)}
      else if(x===p.l&&p===g.l){this.rotR(g);this.rotR(p)}
      else if(x===p.r&&p===g.r){this.rotL(g);this.rotL(p)}
      else if(x===p.l){this.rotR(p);this.rotL(g)}
      else{this.rotL(p);this.rotR(g)}
    }
  }
  set(k:K,v:V):void{
    if(!this.root){this.root={k,v,l:null,r:null,p:null};return}
    let n=this.root,last=n
    while(n){last=n;const c=this.cmp(k,n.k);if(!c){n.v=v;this.splay(n);return}n=c<0?n.l:n.r}
    const nn:SNode<K,V>={k,v,l:null,r:null,p:last}
    this.cmp(k,last.k)<0?last.l=nn:last.r=nn;this.splay(nn)
  }
  get(k:K):V|undefined{
    let n=this.root
    while(n){const c=this.cmp(k,n.k);if(!c){this.splay(n);return n.v}n=c<0?n.l:n.r}
    return undefined
  }
}
`
registerSkill({
  id: 'splay-tree',
  summary: 'Splay tree: self-adjusting BST, O(log n) amortised set/get.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bsplay.?tree\b/i)) sc += 0.7
    if (s.has(/\bself.?adjust\w+\b/i) && s.has(/\btree\b/i)) sc += 0.3
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/splayTree.ts', content: IMPL }]
  },
})
