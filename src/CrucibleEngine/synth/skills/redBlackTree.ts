import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Red-Black Tree: self-balancing BST, O(log n) insert/delete/search.
type Color = 'R' | 'B'
interface RBNode<K,V> { k:K; v:V; c:Color; l:RBNode<K,V>|null; r:RBNode<K,V>|null }
const isRed = <K,V>(n:RBNode<K,V>|null) => n !== null && n.c === 'R'
function rotL<K,V>(h:RBNode<K,V>): RBNode<K,V> {
  const x=h.r!; h.r=x.l; x.l=h; x.c=h.c; h.c='R'; return x
}
function rotR<K,V>(h:RBNode<K,V>): RBNode<K,V> {
  const x=h.l!; h.l=x.r; x.r=h; x.c=h.c; h.c='R'; return x
}
function flip<K,V>(h:RBNode<K,V>): void {
  h.c = h.c==='R'?'B':'R'
  if(h.l) h.l.c = h.l.c==='R'?'B':'R'
  if(h.r) h.r.c = h.r.c==='R'?'B':'R'
}
function bal<K,V>(h:RBNode<K,V>): RBNode<K,V> {
  if(isRed(h.r)&&!isRed(h.l)) h=rotL(h)
  if(isRed(h.l)&&isRed(h.l?.l??null)) h=rotR(h)
  if(isRed(h.l)&&isRed(h.r)) flip(h)
  return h
}
export class RedBlackTree<K=number,V=unknown> {
  private root: RBNode<K,V>|null = null
  private cmp: (a:K,b:K)=>number
  constructor(cmp:(a:K,b:K)=>number=(a,b)=>a<b?-1:a>b?1:0){this.cmp=cmp}
  private _ins(h:RBNode<K,V>|null,k:K,v:V):RBNode<K,V> {
    if(!h) return {k,v,c:'R',l:null,r:null}
    const c=this.cmp(k,h.k)
    if(c<0) h.l=this._ins(h.l,k,v)
    else if(c>0) h.r=this._ins(h.r,k,v)
    else h.v=v
    return bal(h)
  }
  set(k:K,v:V):void { this.root=this._ins(this.root,k,v); this.root.c='B' }
  get(k:K):V|undefined {
    let n=this.root
    while(n){const c=this.cmp(k,n.k);if(c===0)return n.v;n=c<0?n.l:n.r}
    return undefined
  }
  *inOrder():IterableIterator<[K,V]>{
    const st:RBNode<K,V>[]=[];let n=this.root
    while(n||st.length){while(n){st.push(n);n=n.l}n=st.pop()!;yield[n.k,n.v];n=n.r}
  }
}
`
registerSkill({
  id: 'red-black-tree',
  summary: 'Red-Black tree: self-balancing BST, O(log n) insert/search/iterate.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bred.?black\b/i)) sc += 0.7
    if (s.has(/\bself.?balanc\w+\b/i) && s.has(/\bbst\b/i)) sc += 0.2
    if (s.has(/\brotation\b/i) && s.has(/\btree\b/i)) sc += 0.1
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/redBlackTree.ts', content: IMPL }]
  },
})
