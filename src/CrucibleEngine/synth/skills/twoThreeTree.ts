import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — 2-3 Tree: perfectly balanced search tree, O(log n) ops.
type T23Node<K,V>={keys:K[];vals:V[];children:T23Node<K,V>[];leaf:boolean}
function mk<K,V>():T23Node<K,V>{return{keys:[],vals:[],children:[],leaf:true}}
export class TwoThreeTree<K=number,V=unknown>{
  private root:T23Node<K,V>=mk()
  private cmp:(a:K,b:K)=>number
  constructor(cmp:(a:K,b:K)=>number=(a,b)=>a<b?-1:a>b?1:0){this.cmp=cmp}
  get(k:K):V|undefined{
    let n=this.root
    while(true){
      let i=0;while(i<n.keys.length&&this.cmp(k,n.keys[i])>0)i++
      if(i<n.keys.length&&this.cmp(k,n.keys[i])===0)return n.vals[i]
      if(n.leaf)return undefined
      n=n.children[i]
    }
  }
  set(k:K,v:V):void{
    const res=this._ins(this.root,k,v)
    if(res){const nr=mk<K,V>();nr.keys=[res[0]];nr.vals=[res[1]];nr.children=[this.root,res[2]];nr.leaf=false;this.root=nr}
  }
  private _ins(n:T23Node<K,V>,k:K,v:V):[K,V,T23Node<K,V>]|null{
    if(n.leaf){
      let i=0;while(i<n.keys.length&&this.cmp(k,n.keys[i])>0)i++
      if(i<n.keys.length&&this.cmp(k,n.keys[i])===0){n.vals[i]=v;return null}
      n.keys.splice(i,0,k);n.vals.splice(i,0,v)
      if(n.keys.length<=2)return null
      return this._split(n)
    }
    let i=0;while(i<n.keys.length&&this.cmp(k,n.keys[i])>0)i++
    if(i<n.keys.length&&this.cmp(k,n.keys[i])===0){n.vals[i]=v;return null}
    const res=this._ins(n.children[i],k,v)
    if(!res)return null
    n.keys.splice(i,0,res[0]);n.vals.splice(i,0,res[1]);n.children.splice(i+1,0,res[2])
    if(n.keys.length<=2)return null
    return this._split(n)
  }
  private _split(n:T23Node<K,V>):[K,V,T23Node<K,V>]{
    const mid=1,rn=mk<K,V>()
    rn.keys=n.keys.splice(mid+1);rn.vals=n.vals.splice(mid+1);rn.leaf=n.leaf
    if(!n.leaf)rn.children=n.children.splice(mid+1)
    const mk2=n.keys.pop()!,mv=n.vals.pop()!
    return[mk2,mv,rn]
  }
}
`
registerSkill({
  id: 'two-three-tree',
  summary: '2-3 tree: perfectly balanced search tree, O(log n) get/set.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\b2.?3.?tree\b|two.?three.?tree/i)) sc += 0.7
    if (s.has(/\bperfectly.?balanc/i) && s.has(/\btree\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/twoThreeTree.ts', content: IMPL }]
  },
})
