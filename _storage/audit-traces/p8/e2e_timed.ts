import { answerWithWebGrounding } from '../../src/CrucibleEngine/answer/groundedAnswer'
const T0=Date.now(); const t=()=>((Date.now()-T0)/1000).toFixed(1).padStart(6)
async function main(){
  const r = await answerWithWebGrounding('Write a Zod schema that validates an IPv4 address', {
    budgetMs: 90_000,
    emit: (ev:any) => { if (ev.type==='thought') console.log(`${t()}s  ${String(ev.text).slice(0,88)}`) },
  })
  console.log(`${t()}s  DONE grounded=${!!r}`)
}
main().then(()=>process.exit(0))
