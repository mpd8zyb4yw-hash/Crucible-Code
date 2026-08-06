import { answerWithWebGrounding } from '../../src/CrucibleEngine/answer/groundedAnswer'
async function main(){
  const t0=Date.now()
  const r = await answerWithWebGrounding('Write a Zod schema that validates an IPv4 address', { budgetMs: 90_000 })
  console.log('grounded:', !!r, `${((Date.now()-t0)/1000).toFixed(1)}s`)
  if(r) console.log('sources:', (r as any).sources)
}
main()
