import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — HyperLogLog: cardinality estimation with configurable precision.
export class HyperLogLog{
  private m:number;private b:number;private regs:Uint8Array;private alpha:number
  constructor(precision=10){
    this.b=Math.max(4,Math.min(16,precision));this.m=1<<this.b
    this.regs=new Uint8Array(this.m)
    this.alpha=this.m>=128?0.7213/(1+1.079/this.m):this.m>=64?0.709:this.m>=32?0.697:0.673
  }
  add(item:string):void{
    let h=0x811c9dc5>>>0
    for(let i=0;i<item.length;i++)h=Math.imul(h^item.charCodeAt(i),0x01000193)>>>0
    const idx=h>>>(32-this.b)
    const w=h<<this.b|((1<<this.b)-1)
    const rho=w===0?32-this.b+1:Math.clz32(w)+1
    if(rho>this.regs[idx])this.regs[idx]=rho
  }
  count():number{
    let Z=0;for(const r of this.regs)Z+=1/(1<<r);Z=1/Z
    let E=this.alpha*this.m*this.m*Z
    if(E<=2.5*this.m){let z=0;for(const r of this.regs)if(!r)z++;if(z)E=this.m*Math.log(this.m/z)}
    else if(E>2**32/30)E=-(2**32)*Math.log(1-E/2**32)
    return Math.round(E)
  }
  merge(o:HyperLogLog):void{for(let i=0;i<this.m;i++)if(o.regs[i]>this.regs[i])this.regs[i]=o.regs[i]}
}
`
registerSkill({
  id: 'hyperloglog',
  summary: 'HyperLogLog: cardinality estimation with small/large range correction and merge.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bhyperloglog\b(?!\+\+)/i)) sc += 0.7
    if (s.has(/\bhll\b/i) && !s.has(/\bhll\+\+\b/i)) sc += 0.3
    if (s.has(/\bcardinality.?estimat\b/i) && !s.has(/\bbias.?correction\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/hyperLogLog.ts', content: IMPL }]
  },
})
