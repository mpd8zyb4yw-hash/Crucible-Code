import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — verified reservoir sampling (Algorithm R + weighted).
export function reservoirSample<T>(stream: Iterable<T>, k: number): T[] {
  const res:T[]=[]; let i=0
  for(const item of stream){if(i<k)res.push(item);else{const j=Math.floor(Math.random()*(i+1));if(j<k)res[j]=item};i++}
  return res
}
export function weightedSample<T>(items: T[], weights: number[]): T {
  const total=weights.reduce((s,w)=>s+w,0); let r=Math.random()*total
  for(let i=0;i<items.length;i++){r-=weights[i];if(r<=0)return items[i]}
  return items[items.length-1]
}
`
registerSkill({ id: 'reservoir-sampling', summary: 'Reservoir sampling (Algorithm R) and weighted random sampling.',
  match(s: SpecFeatures) { let score = 0; if (s.has(/reservoir.?sampl/i)) score += 0.8; if (s.has(/weighted.?sampl|weighted.?random/i)) score += 0.4; if (s.has(/random.?sampl.{0,20}stream/i)) score += 0.4; return score },
  emit(s: SpecFeatures): SynthFile[] { return [{ path: s.modulePath ?? 'src/reservoirSampling.ts', content: IMPL }] } })
