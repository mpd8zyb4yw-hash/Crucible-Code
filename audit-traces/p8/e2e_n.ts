import { answerWithWebGrounding } from '../../src/CrucibleEngine/answer/groundedAnswer'
import { writeFileSync } from 'node:fs'
async function main(){
  const N = Number(process.env.N ?? 3)
  for (let i=0;i<N;i++){
    const t0=Date.now(); let repaired=false
    const r = await answerWithWebGrounding('Write a Zod schema that validates an IPv4 address', {
      budgetMs: 90_000,
      emit: (ev:any) => { if (ev.type==='thought' && /Repairing|27B/.test(String(ev.text))) repaired=true },
    })
    const secs=((Date.now()-t0)/1000).toFixed(1)
    writeFileSync(`audit-traces/p8/e2e-run${i}.md`, r?.text ?? '')
    console.log(`run${i}  ${secs.padStart(6)}s  repaired=${repaired}  grounded=${!!r}`)
  }
}
main().then(()=>process.exit(0))
