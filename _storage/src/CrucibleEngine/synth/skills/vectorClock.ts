import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Vector clock: happens-before, concurrent, merge, lamport.
export class VectorClock{
  private clock:Map<string,number>=new Map()
  readonly id:string
  constructor(id:string){this.id=id}
  tick():void{this.clock.set(this.id,(this.clock.get(this.id)??0)+1)}
  send():Record<string,number>{this.tick();return Object.fromEntries(this.clock)}
  receive(remote:Record<string,number>):void{
    for(const[k,v]of Object.entries(remote))this.clock.set(k,Math.max(this.clock.get(k)??0,v))
    this.tick()
  }
  happensBefore(other:VectorClock):boolean{
    const a=this.clock,b=other.clock
    const allLeq=[...a.entries()].every(([k,v])=>(b.get(k)??0)>=v)
    const someL=[...a.entries()].some(([k,v])=>(b.get(k)??0)>v)
    return allLeq&&someL
  }
  concurrent(other:VectorClock):boolean{return!this.happensBefore(other)&&!other.happensBefore(this)}
  merge(other:VectorClock):void{other.clock.forEach((v,k)=>this.clock.set(k,Math.max(this.clock.get(k)??0,v)))}
  state():Record<string,number>{return Object.fromEntries(this.clock)}
}
export class LamportClock{
  private t=0;readonly id:string
  constructor(id:string){this.id=id}
  tick():number{return++this.t}
  send():number{return this.tick()}
  receive(remote:number):void{this.t=Math.max(this.t,remote)+1}
  time():number{return this.t}
}
`
registerSkill({
  id: 'vector-clock',
  summary: 'Vector clock: happens-before, concurrent detection, merge, Lamport clock.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bvector.?clock\b/i)) sc += 0.7
    if (s.has(/\bhappens.?before\b/i)) sc += 0.3
    if (s.has(/\blamport.?clock\b/i)) sc += 0.3
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/vectorClock.ts', content: IMPL }]
  },
})
