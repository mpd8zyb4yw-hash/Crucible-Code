import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Observer / reactive store: subscribe, notify, derived values.
export type Unsubscribe = () => void
export class Observable<T>{
  private val:T;private subs=new Set<(v:T)=>void>()
  constructor(init:T){this.val=init}
  get():T{return this.val}
  set(v:T):void{this.val=v;this.subs.forEach(s=>s(v))}
  update(fn:(v:T)=>T):void{this.set(fn(this.val))}
  subscribe(fn:(v:T)=>void,immediate=false):Unsubscribe{
    this.subs.add(fn);if(immediate)fn(this.val);return()=>this.subs.delete(fn)
  }
}
export function computed<T>(deps:Observable<unknown>[],fn:()=>T):Observable<T>{
  const out=new Observable(fn())
  deps.forEach(d=>d.subscribe(()=>out.set(fn())))
  return out
}
export class Store<S extends Record<string,unknown>>{
  private state:S;private obs:Map<keyof S,Observable<unknown>>=new Map()
  constructor(init:S){
    this.state={...init}
    for(const k in init)this.obs.set(k,new Observable(init[k]))
  }
  get<K extends keyof S>(k:K):S[K]{return this.state[k]}
  set<K extends keyof S>(k:K,v:S[K]):void{this.state[k]=v;(this.obs.get(k) as Observable<S[K]>).set(v)}
  watch<K extends keyof S>(k:K,fn:(v:S[K])=>void):Unsubscribe{return(this.obs.get(k) as Observable<S[K]>).subscribe(fn)}
  snapshot():S{return{...this.state}}
}
`
registerSkill({
  id: 'observer-pattern',
  summary: 'Observer / reactive store: Observable, computed, Store with typed watchers.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bobserver.?pattern\b/i)) sc += 0.5
    if (s.has(/\breactive.?store\b/i)) sc += 0.4
    if (s.has(/\bcomputed\b/i) && s.has(/\bsubscribe\b/i)) sc += 0.25
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/observable.ts', content: IMPL }]
  },
})
