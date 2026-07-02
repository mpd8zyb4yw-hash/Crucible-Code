import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Strategy pattern: pluggable algorithms, context-driven dispatch.
export type Strategy<I,O> = (input: I) => O
export class Context<I,O>{
  private strategy:Strategy<I,O>
  constructor(strategy:Strategy<I,O>){this.strategy=strategy}
  setStrategy(s:Strategy<I,O>):void{this.strategy=s}
  execute(input:I):O{return this.strategy(input)}
}
export class SortContext{
  private strategies:Map<string,Strategy<number[],number[]>>=new Map([
    ['bubble',(a)=>{const r=[...a];for(let i=0;i<r.length;i++)for(let j=0;j<r.length-i-1;j++)if(r[j]>r[j+1])[r[j],r[j+1]]=[r[j+1],r[j]];return r}],
    ['selection',(a)=>{const r=[...a];for(let i=0;i<r.length;i++){let m=i;for(let j=i+1;j<r.length;j++)if(r[j]<r[m])m=j;[r[i],r[m]]=[r[m],r[i]]};return r}],
    ['insertion',(a)=>{const r=[...a];for(let i=1;i<r.length;i++){const k=r[i];let j=i-1;while(j>=0&&r[j]>k){r[j+1]=r[j];j--}r[j+1]=k};return r}],
    ['native',(a)=>[...a].sort((x,y)=>x-y)],
  ])
  sort(a:number[],strategy='native'):number[]{
    const s=this.strategies.get(strategy);if(!s)throw new Error(\`Unknown: \${strategy}\`);return s(a)
  }
  register(name:string,fn:Strategy<number[],number[]>):void{this.strategies.set(name,fn)}
}
`
registerSkill({
  id: 'strategy-pattern',
  summary: 'Strategy pattern: pluggable algorithms, context dispatch, sort strategies.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bstrategy.?pattern\b/i)) sc += 0.6
    if (s.has(/\bpluggable.?algorithm\b/i)) sc += 0.3
    if (s.has(/\binterchangeable\b/i) && s.has(/\balgorithm\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/strategy.ts', content: IMPL }]
  },
})
