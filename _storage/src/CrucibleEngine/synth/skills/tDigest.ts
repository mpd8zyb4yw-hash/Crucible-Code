import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — t-Digest: online quantile estimation with compression.
interface Centroid{mean:number;count:number}
export class TDigest{
  private centroids:Centroid[]=[]
  private compression:number;private count=0
  constructor(compression=100){this.compression=compression}
  add(x:number,w=1):void{
    this.centroids.push({mean:x,count:w});this.count+=w
    if(this.centroids.length>this.compression*10)this._compress()
  }
  private _compress():void{
    this.centroids.sort((a,b)=>a.mean-b.mean)
    const merged:Centroid[]=[]
    let qLimit=0,soFar=0
    for(const c of this.centroids){
      const q=(soFar+c.count/2)/this.count
      const k=4*this.count*q*(1-q)/this.compression
      if(merged.length&&soFar-qLimit<k){const m=merged[merged.length-1];m.mean=(m.mean*m.count+c.mean*c.count)/(m.count+c.count);m.count+=c.count}
      else{qLimit=soFar;merged.push({...c})}
      soFar+=c.count
    }
    this.centroids=merged
  }
  quantile(q:number):number{
    this._compress();if(!this.centroids.length)return NaN
    const target=q*this.count;let soFar=0
    for(let i=0;i<this.centroids.length;i++){
      const c=this.centroids[i];const next=soFar+c.count
      if(target<=next){
        if(i===0)return c.mean
        const prev=this.centroids[i-1]
        const frac=(target-soFar)/c.count
        return prev.mean+(c.mean-prev.mean)*frac
      }
      soFar=next
    }
    return this.centroids[this.centroids.length-1].mean
  }
  merge(other:TDigest):void{other.centroids.forEach(c=>this.add(c.mean,c.count))}
  size():number{return this.count}
  centroidCount():number{return this.centroids.length}
}
`
registerSkill({
  id: 't-digest',
  summary: 't-Digest: online quantile estimation with compression, merge.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bt.?digest\b/i)) sc += 0.7
    if (s.has(/\bquantile.?estimat\b/i) && s.has(/\bonline\b/i)) sc += 0.3
    if (s.has(/\bpercentile\b/i) && s.has(/\bstream\w*\b/i) && s.has(/\bcompress\b/i)) sc += 0.25
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/tDigest.ts', content: IMPL }]
  },
})
