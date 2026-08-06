import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — AVL Tree: height-balanced BST, O(log n) ops.
interface AVLNode<K,V>{k:K;v:V;h:number;l:AVLNode<K,V>|null;r:AVLNode<K,V>|null}
const ht=<K,V>(n:AVLNode<K,V>|null)=>n?n.h:0
const upH=<K,V>(n:AVLNode<K,V>)=>{n.h=1+Math.max(ht(n.l),ht(n.r))}
const bf=<K,V>(n:AVLNode<K,V>)=>ht(n.l)-ht(n.r)
function rotR<K,V>(y:AVLNode<K,V>):AVLNode<K,V>{const x=y.l!;y.l=x.r;x.r=y;upH(y);upH(x);return x}
function rotL<K,V>(x:AVLNode<K,V>):AVLNode<K,V>{const y=x.r!;x.r=y.l;y.l=x;upH(x);upH(y);return y}
function bal<K,V>(n:AVLNode<K,V>):AVLNode<K,V>{
  upH(n)
  if(bf(n)>1){if(bf(n.l!)< 0)n.l=rotL(n.l!);return rotR(n)}
  if(bf(n)<-1){if(bf(n.r!)>0)n.r=rotR(n.r!);return rotL(n)}
  return n
}
export class AVLTree<K=number,V=unknown>{
  private root:AVLNode<K,V>|null=null
  private cmp:(a:K,b:K)=>number
  constructor(cmp:(a:K,b:K)=>number=(a,b)=>a<b?-1:a>b?1:0){this.cmp=cmp}
  private _ins(n:AVLNode<K,V>|null,k:K,v:V):AVLNode<K,V>{
    if(!n)return{k,v,h:1,l:null,r:null}
    const c=this.cmp(k,n.k)
    if(c<0)n.l=this._ins(n.l,k,v)
    else if(c>0)n.r=this._ins(n.r,k,v)
    else n.v=v
    return bal(n)
  }
  set(k:K,v:V):void{this.root=this._ins(this.root,k,v)}
  get(k:K):V|undefined{let n=this.root;while(n){const c=this.cmp(k,n.k);if(!c)return n.v;n=c<0?n.l:n.r}return undefined}
  height():number{return ht(this.root)}
  *inOrder():IterableIterator<[K,V]>{
    const st:AVLNode<K,V>[]=[];let n=this.root
    while(n||st.length){while(n){st.push(n);n=n.l}n=st.pop()!;yield[n.k,n.v];n=n.r}
  }
}
`
registerSkill({
  id: 'avl-tree',
  summary: 'AVL tree: height-balanced BST, O(log n) insert/search.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bavl\b/i)) sc += 0.7
    if (s.has(/\bheight.?balanc\w+\b/i) && s.has(/\btree\b/i)) sc += 0.3
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/avlTree.ts', content: IMPL }]
  },
})
