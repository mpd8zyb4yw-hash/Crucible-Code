import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Count-Min Sketch: sub-linear frequency estimation.
export class CountMinSketch{
  private table:Uint32Array[]
  private w:number;private d:number
  private seeds:number[]
  constructor(epsilon=0.01,delta=0.01){
    this.w=Math.ceil(Math.E/epsilon)
    this.d=Math.ceil(Math.log(1/delta))
    this.seeds=Array.from({length:this.d},(_,i)=>i*0x9e3779b9+1)
    this.table=Array.from({length:this.d},()=>new Uint32Array(this.w))
  }
  private _hash(item:string,seed:number):number{
    let h=seed>>>0
    for(let i=0;i<item.length;i++)h=Math.imul(h^item.charCodeAt(i),0x01000193)>>>0
    return h%this.w
  }
  add(item:string,count=1):void{for(let i=0;i<this.d;i++)this.table[i][this._hash(item,this.seeds[i])]+=count}
  estimate(item:string):number{return Math.min(...this.table.map((row,i)=>row[this._hash(item,this.seeds[i])]))}
  merge(other:CountMinSketch):CountMinSketch{
    const r=new CountMinSketch();r.w=this.w;r.d=this.d;r.seeds=[...this.seeds]
    r.table=this.table.map((row,i)=>row.map((v,j)=>v+other.table[i][j]))
    return r
  }
}
`
registerSkill({
  id: 'count-min-sketch',
  summary: 'Count-Min Sketch: sub-linear frequency estimation, merge.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bcount.?min.?sketch\b/i)) sc += 0.7
    if (s.has(/\bcms\b/i) && s.has(/\bfrequency\b/i)) sc += 0.3
    if (s.has(/\bsub.?linear\b/i) && s.has(/\bfrequency.?estimat\b/i)) sc += 0.25
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/countMinSketch.ts', content: IMPL }]
  },
})
