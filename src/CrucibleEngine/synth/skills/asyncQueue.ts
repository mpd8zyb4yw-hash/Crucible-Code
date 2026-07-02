import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — verified async queue with concurrency limiting.
export class AsyncQueue {
  private running = 0; private queue: (()=>void)[] = []
  constructor(private concurrency: number = 1) {}
  async add<T>(fn: ()=>Promise<T>): Promise<T> {
    return new Promise<T>((resolve,reject)=>{
      const run=async()=>{this.running++;try{resolve(await fn())}catch(e){reject(e)}finally{this.running--;if(this.queue.length)this.queue.shift()!()}}
      if(this.running<this.concurrency)run();else this.queue.push(run)
    })
  }
  get pending(){return this.queue.length}
  get active(){return this.running}
}
export async function mapConcurrent<T,R>(items: T[], fn: (item:T,i:number)=>Promise<R>, concurrency: number): Promise<R[]> {
  const q=new AsyncQueue(concurrency); return Promise.all(items.map((item,i)=>q.add(()=>fn(item,i))))
}
`
registerSkill({ id: 'async-queue', summary: 'Async queue with concurrency limiting and mapConcurrent utility.',
  match(s: SpecFeatures) { let score = 0; if (s.has(/concurren(cy|t).{0,30}limit/i)) score += 0.5; if (s.has(/async.?queue/i)) score += 0.5; if (s.has(/mapConcurrent|p-limit|p-queue/i)) score += 0.4; return score },
  emit(s: SpecFeatures): SynthFile[] { return [{ path: s.modulePath ?? 'src/asyncQueue.ts', content: IMPL }] } })
