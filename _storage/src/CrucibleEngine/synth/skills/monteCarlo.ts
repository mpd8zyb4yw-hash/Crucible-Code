import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Monte Carlo toolkit: integration, Pi estimation, MCMC Metropolis-Hastings.
export function mcIntegrate(f:(x:number)=>number,a:number,b:number,n=1e6):number{
  let sum=0;for(let i=0;i<n;i++)sum+=f(a+Math.random()*(b-a));return(b-a)*sum/n
}
export function estimatePi(n=1e6):number{
  let inside=0;for(let i=0;i<n;i++){const x=Math.random(),y=Math.random();if(x*x+y*y<=1)inside++}
  return 4*inside/n
}
export function metropolisHastings(
  logTarget:(x:number)=>number,
  init:number,
  steps:number,
  stepSize=0.5
):number[]{
  const samples:number[]=[init];let cur=init,logCur=logTarget(cur)
  for(let i=1;i<steps;i++){
    const prop=cur+(Math.random()-0.5)*2*stepSize
    const logProp=logTarget(prop)
    if(Math.log(Math.random())<logProp-logCur){cur=prop;logCur=logProp}
    samples.push(cur)
  }
  return samples
}
export function bootstrapCI(data:number[],stat:(s:number[])=>number,B=1000,alpha=0.05):[number,number]{
  const boots=Array.from({length:B},()=>stat(Array.from({length:data.length},()=>data[Math.random()*data.length|0])))
  boots.sort((a,b)=>a-b)
  return[boots[Math.floor(B*alpha/2)],boots[Math.floor(B*(1-alpha/2))]]
}
`
registerSkill({
  id: 'monte-carlo',
  summary: 'Monte Carlo: integration, Pi estimation, Metropolis-Hastings MCMC, bootstrap CI.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bmonte.?carlo\b/i)) sc += 0.5
    if (s.has(/\bmetropolis.?hastings\b|\bmcmc\b/i)) sc += 0.4
    if (s.has(/\bbootstrap\b/i) && s.has(/\bconfidence.?interval\b/i)) sc += 0.25
    if (s.has(/\bmc.?integrat\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/monteCarlo.ts', content: IMPL }]
  },
})
