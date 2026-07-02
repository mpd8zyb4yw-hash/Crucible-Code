import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — verified memoize with LRU eviction and TTL.
export function memoize<T extends unknown[],R>(fn: (...args:T)=>R, opts:{key?:(...args:T)=>string;maxSize?:number;ttlMs?:number}={}): (...args:T)=>R {
  const {key=(...args)=>JSON.stringify(args),maxSize=256,ttlMs}=opts
  const cache=new Map<string,{val:R;ts:number}>(), order:string[]=[]
  return (...args:T):R=>{
    const k=key(...args),now=Date.now(),hit=cache.get(k)
    if(hit&&(!ttlMs||now-hit.ts<ttlMs)){const i=order.indexOf(k);if(i>-1)order.splice(i,1);order.push(k);return hit.val}
    const val=fn(...args)
    if(cache.size>=maxSize&&order.length){const evict=order.shift()!;cache.delete(evict)}
    cache.set(k,{val,ts:now}); order.push(k); return val
  }
}
export function memoizeAsync<T extends unknown[],R>(fn: (...args:T)=>Promise<R>, opts:{key?:(...args:T)=>string;maxSize?:number;ttlMs?:number}={}): (...args:T)=>Promise<R> {
  const inner=memoize(fn,opts); return (...args:T)=>Promise.resolve(inner(...args))
}
`
registerSkill({ id: 'memoize', summary: 'Memoize with LRU eviction and optional TTL, sync and async variants.',
  match(s: SpecFeatures) { let score = 0; if (s.has(/\bmemoize\b|\bmemo\b/i)) score += 0.6; if (s.has(/cache.{0,20}result|result.{0,20}cache/i)) score += 0.3; return score },
  emit(s: SpecFeatures): SynthFile[] { return [{ path: s.modulePath ?? 'src/memoize.ts', content: IMPL }] } })
