import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Statistics: descriptive stats, distributions, hypothesis tests.
export const mean   = (a:number[]) => a.reduce((s,v)=>s+v,0)/a.length
export const median = (a:number[]) => { const s=[...a].sort((x,y)=>x-y),n=s.length; return n%2?s[n>>1]:(s[(n>>1)-1]+s[n>>1])/2 }
export const variance=(a:number[],pop=false)=>{const m=mean(a);return a.reduce((s,v)=>s+(v-m)**2,0)/(a.length-(pop?0:1))}
export const std    = (a:number[],pop=false) => Math.sqrt(variance(a,pop))
export const mad    = (a:number[]) => { const m=median(a); return median(a.map(v=>Math.abs(v-m))) }
export const skewness=(a:number[])=>{const m=mean(a),s=std(a,true),n=a.length;return a.reduce((acc,v)=>acc+((v-m)/s)**3,0)/n}
export const kurtosis=(a:number[])=>{const m=mean(a),s=std(a,true),n=a.length;return a.reduce((acc,v)=>acc+((v-m)/s)**4,0)/n-3}
export const pearson=(x:number[],y:number[])=>{const mx=mean(x),my=mean(y),n=x.length;let num=0,dx=0,dy=0;for(let i=0;i<n;i++){num+=(x[i]-mx)*(y[i]-my);dx+=(x[i]-mx)**2;dy+=(y[i]-my)**2};return num/Math.sqrt(dx*dy)}
export const spearman=(x:number[],y:number[])=>{const rank=(a:number[])=>{const s=[...a].map((v,i)=>[v,i]).sort((p,q)=>p[0]-q[0]);const r=new Array(a.length);s.forEach(([,i],ri)=>r[i]=ri+1);return r};return pearson(rank(x),rank(y))}
export function tTest(a:number[],b:number[]):{t:number;df:number}{
  const ma=mean(a),mb=mean(b),va=variance(a),vb=variance(b),na=a.length,nb=b.length
  const t=(ma-mb)/Math.sqrt(va/na+vb/nb)
  const df=(va/na+vb/nb)**2/((va/na)**2/(na-1)+(vb/nb)**2/(nb-1))
  return{t,df}
}
export function normalPDF(x:number,mu=0,sigma=1):number{return Math.exp(-0.5*((x-mu)/sigma)**2)/(sigma*Math.sqrt(2*Math.PI))}
export function normalCDF(x:number,mu=0,sigma=1):number{const z=(x-mu)/(sigma*Math.SQRT2);return 0.5*(1+erf(z))}
function erf(x:number):number{const t=1/(1+0.3275911*Math.abs(x)),p=t*(0.254829592+t*(-0.284496736+t*(1.421413741+t*(-1.453152027+t*1.061405429))));const r=1-p*Math.exp(-x*x);return x>=0?r:-r}
`
registerSkill({
  id: 'statistics-lib',
  summary: 'Statistics: mean/median/variance/std, correlation, t-test, normal distribution.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bstatistic\w+\b/i) && s.has(/\blibrari\w+\b|\btoolkit\b|\bprimitive\b/i)) sc += 0.4
    if (s.has(/\bt.?test\b/i)) sc += 0.3
    if (s.has(/\bpearson\b|\bspearman\b/i)) sc += 0.3
    if (s.has(/\bkurtosis\b|\bskewness\b/i)) sc += 0.25
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/statistics.ts', content: IMPL }]
  },
})
