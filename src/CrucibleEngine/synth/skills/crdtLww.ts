import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — CRDTs: LWW-Register, G-Counter, PN-Counter, OR-Set.
export class LWWRegister<T>{
  private val:T|undefined;private ts=0;readonly id:string
  constructor(id:string){this.id=id}
  set(val:T,ts=Date.now()):void{if(ts>this.ts){this.val=val;this.ts=ts}}
  get():T|undefined{return this.val}
  merge(other:LWWRegister<T>):void{if(other.ts>this.ts){this.val=other.val;this.ts=other.ts}}
  state():{val:T|undefined;ts:number}{return{val:this.val,ts:this.ts}}
}
export class GCounter{
  private counts:Map<string,number>=new Map()
  readonly id:string
  constructor(id:string){this.id=id}
  increment(n=1):void{this.counts.set(this.id,(this.counts.get(this.id)??0)+n)}
  value():number{let s=0;this.counts.forEach(v=>s+=v);return s}
  merge(other:GCounter):void{other.counts.forEach((v,k)=>{if(v>(this.counts.get(k)??0))this.counts.set(k,v)})}
  state():Record<string,number>{return Object.fromEntries(this.counts)}
}
export class PNCounter{
  private p:GCounter;private n:GCounter
  constructor(id:string){this.p=new GCounter(id);this.n=new GCounter(id)}
  increment(v=1):void{this.p.increment(v)}
  decrement(v=1):void{this.n.increment(v)}
  value():number{return this.p.value()-this.n.value()}
  merge(other:PNCounter):void{this.p.merge(other.p);this.n.merge(other.n)}
}
export class ORSet<T>{
  private adds=new Map<T,Set<string>>()
  private removes=new Map<T,Set<string>>()
  add(val:T):void{if(!this.adds.has(val))this.adds.set(val,new Set());this.adds.get(val)!.add(Math.random().toString(36))}
  remove(val:T):void{const tags=this.adds.get(val);if(tags){if(!this.removes.has(val))this.removes.set(val,new Set());tags.forEach(t=>this.removes.get(val)!.add(t))}}
  has(val:T):boolean{const a=this.adds.get(val)??new Set(),r=this.removes.get(val)??new Set();return[...a].some(t=>!r.has(t))}
  merge(other:ORSet<T>):void{
    other.adds.forEach((tags,v)=>{if(!this.adds.has(v))this.adds.set(v,new Set());tags.forEach(t=>this.adds.get(v)!.add(t))})
    other.removes.forEach((tags,v)=>{if(!this.removes.has(v))this.removes.set(v,new Set());tags.forEach(t=>this.removes.get(v)!.add(t))})
  }
}
`
registerSkill({
  id: 'crdt',
  summary: 'CRDTs: LWW-Register, G-Counter, PN-Counter, OR-Set.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bcrdt\b/i)) sc += 0.6
    if (s.has(/\blww\b|last.?write.?wins/i)) sc += 0.3
    if (s.has(/\bg.?counter\b|\bpn.?counter\b/i)) sc += 0.3
    if (s.has(/\bor.?set\b/i)) sc += 0.25
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/crdt.ts', content: IMPL }]
  },
})
