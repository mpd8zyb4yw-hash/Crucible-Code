import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Persistent array via path-copying: O(log n) update, O(1) snapshot.
interface PNode<T>{val:T;l:PNode<T>|null;r:PNode<T>|null}
function build<T>(a:T[],lo:number,hi:number):PNode<T>|null{
  if(lo>hi)return null
  const mid=(lo+hi)>>1
  return{val:a[mid],l:build(a,lo,mid-1),r:build(a,mid+1,hi)}
}
function update<T>(n:PNode<T>|null,lo:number,hi:number,i:number,val:T):PNode<T>{
  if(lo===hi)return{val,l:null,r:null}
  const mid=(lo+hi)>>1
  if(i<=mid)return{val:n!.val,l:update(n?.l??null,lo,mid,i,val),r:n?.r??null}
  return{val:n!.val,l:n?.l??null,r:update(n?.r??null,mid+1,hi,i,val)}
}
function query<T>(n:PNode<T>|null,lo:number,hi:number,i:number):T{
  if(lo===hi)return n!.val
  const mid=(lo+hi)>>1
  return i<=mid?query(n?.l??null,lo,mid,i):query(n?.r??null,mid+1,hi,i)
}
export class PersistentArray<T>{
  private roots:Array<PNode<T>|null>=[]
  private n:number
  constructor(a:T[]){this.n=a.length;this.roots.push(build(a,0,a.length-1))}
  get(version:number,i:number):T{return query(this.roots[version],0,this.n-1,i)}
  set(version:number,i:number,val:T):number{this.roots.push(update(this.roots[version],0,this.n-1,i,val));return this.roots.length-1}
  versions():number{return this.roots.length}
}
`
registerSkill({
  id: 'persistent-array',
  summary: 'Persistent array: path-copying, O(log n) update, versioned snapshots.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bpersistent.?array\b/i)) sc += 0.7
    if (s.has(/\bpath.?copy\w+\b/i)) sc += 0.3
    if (s.has(/\bversion\w*\b/i) && s.has(/\bimmutable\b/i) && s.has(/\barray\b/i)) sc += 0.25
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/persistentArray.ts', content: IMPL }]
  },
})
