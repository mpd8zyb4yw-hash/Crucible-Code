import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Semaphore + Mutex + ReadWriteLock for async concurrency control.
export class Semaphore{
  private count:number;private queue:Array<()=>void>=[]
  constructor(count:number){this.count=count}
  async acquire():Promise<void>{
    if(this.count>0){this.count--;return}
    return new Promise(r=>this.queue.push(r))
  }
  release():void{
    if(this.queue.length){const next=this.queue.shift()!;next()}else this.count++
  }
  async run<T>(fn:()=>Promise<T>):Promise<T>{await this.acquire();try{return await fn()}finally{this.release()}}
  available():number{return this.count}
}
export class Mutex extends Semaphore{constructor(){super(1)}}
export class ReadWriteLock{
  private readers=0;private writing=false
  private rq:Array<()=>void>=[];private wq:Array<()=>void>=[]
  async acquireRead():Promise<void>{
    if(!this.writing){this.readers++;return}
    return new Promise(r=>this.rq.push(r))
  }
  releaseRead():void{
    this.readers--;if(!this.readers&&this.wq.length){this.writing=true;this.wq.shift()!()}
  }
  async acquireWrite():Promise<void>{
    if(!this.readers&&!this.writing){this.writing=true;return}
    return new Promise(r=>this.wq.push(r))
  }
  releaseWrite():void{
    this.writing=false
    if(this.wq.length){this.writing=true;this.wq.shift()!()}
    else{this.readers+=this.rq.length;const q=this.rq.splice(0);q.forEach(r=>r())}
  }
}
`
registerSkill({
  id: 'semaphore',
  summary: 'Semaphore, Mutex, ReadWriteLock for async concurrency control.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bsemaphore\b/i)) sc += 0.5
    if (s.has(/\bmutex\b/i)) sc += 0.35
    if (s.has(/\bread.?write.?lock\b/i)) sc += 0.35
    if (s.has(/\bconcurren\w+.?control\b/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/semaphore.ts', content: IMPL }]
  },
})
