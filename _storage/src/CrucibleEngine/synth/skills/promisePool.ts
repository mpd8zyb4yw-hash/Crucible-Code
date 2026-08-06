import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Promise pool: bounded concurrency, map, settle, queue drain.
export async function promisePool<T,R>(
  items:T[],
  concurrency:number,
  fn:(item:T,idx:number)=>Promise<R>
):Promise<R[]>{
  const results:R[]=new Array(items.length)
  let idx=0
  async function worker():Promise<void>{
    while(idx<items.length){const i=idx++;results[i]=await fn(items[i],i)}
  }
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},worker))
  return results
}
export async function promiseAllSettled<T>(
  items:T[],
  concurrency:number,
  fn:(item:T)=>Promise<unknown>
):Promise<Array<{status:'fulfilled';value:unknown}|{status:'rejected';reason:unknown}>>{
  return promisePool(items,concurrency,item=>fn(item).then(v=>({status:'fulfilled' as const,value:v}),r=>({status:'rejected' as const,reason:r})))
}
export class AsyncQueue<T>{
  private queue:T[]=[];private running=0;private concurrency:number;private fn:(item:T)=>Promise<void>
  constructor(concurrency:number,fn:(item:T)=>Promise<void>){this.concurrency=concurrency;this.fn=fn}
  push(item:T):void{this.queue.push(item);this._drain()}
  private async _drain():Promise<void>{
    while(this.running<this.concurrency&&this.queue.length){
      const item=this.queue.shift()!;this.running++
      this.fn(item).finally(()=>{this.running--;this._drain()})
    }
  }
  get pending():number{return this.queue.length}
  get active():number{return this.running}
}
`
registerSkill({
  id: 'promise-pool',
  summary: 'Promise pool: bounded concurrency map, allSettled, async queue drain.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bpromise.?pool\b/i)) sc += 0.6
    if (s.has(/\bbounded.?concurren\w+\b/i)) sc += 0.35
    if (s.has(/\bconcurren\w+.?limit\b/i)) sc += 0.25
    if (s.has(/\basync.?queue\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/promisePool.ts', content: IMPL }]
  },
})
