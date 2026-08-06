import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Treap: randomized BST satisfying heap on priority, O(log n) expected.
interface TNode<K,V>{k:K;v:V;pri:number;l:TNode<K,V>|null;r:TNode<K,V>|null}
function mk<K,V>(k:K,v:V):TNode<K,V>{return{k,v,pri:Math.random(),l:null,r:null}}
function rotL<K,V>(n:TNode<K,V>):TNode<K,V>{const r=n.r!;n.r=r.l;r.l=n;return r}
function rotR<K,V>(n:TNode<K,V>):TNode<K,V>{const l=n.l!;n.l=l.r;l.r=n;return l}
function ins<K,V>(n:TNode<K,V>|null,k:K,v:V,cmp:(a:K,b:K)=>number):TNode<K,V>{
  if(!n)return mk(k,v)
  const c=cmp(k,n.k)
  if(!c){n.v=v;return n}
  if(c<0){n.l=ins(n.l,k,v,cmp);if(n.l.pri>n.pri)n=rotR(n)}
  else{n.r=ins(n.r,k,v,cmp);if(n.r.pri>n.pri)n=rotL(n)}
  return n
}
export class Treap<K=number,V=unknown>{
  private root:TNode<K,V>|null=null
  private cmp:(a:K,b:K)=>number
  constructor(cmp:(a:K,b:K)=>number=(a,b)=>a<b?-1:a>b?1:0){this.cmp=cmp}
  set(k:K,v:V):void{this.root=ins(this.root,k,v,this.cmp)}
  get(k:K):V|undefined{
    let n=this.root;while(n){const c=this.cmp(k,n.k);if(!c)return n.v;n=c<0?n.l:n.r}return undefined
  }
  *inOrder():IterableIterator<[K,V]>{
    const st:TNode<K,V>[]=[];let n=this.root
    while(n||st.length){while(n){st.push(n);n=n.l}n=st.pop()!;yield[n.k,n.v];n=n.r}
  }
}
`
registerSkill({
  id: 'treap',
  summary: 'Treap: randomized BST + heap priority, O(log n) expected ops.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\btreap\b/i)) sc += 0.7
    if (s.has(/\brandomized\b/i) && s.has(/\bbst\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/treap.ts', content: IMPL }]
  },
})
