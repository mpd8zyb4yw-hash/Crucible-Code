import { answerWithWebGrounding } from '../../src/CrucibleEngine/answer/groundedAnswer'
import { debugBus } from '../../src/CrucibleEngine/debug/bus'
debugBus.on?.('pipeline', (e: any) => {
  if (/bonsai|faith|grounding_library/i.test(e?.event ?? e?.name ?? '')) console.log('  [bus]', e?.event ?? e?.name, JSON.stringify(e?.data ?? {}).slice(0,180))
})
async function main(){
  const t0=Date.now()
  const r = await answerWithWebGrounding('Write a Zod schema that validates an IPv4 address', {
    budgetMs: 90_000,
    emit: (ev:any) => { if (ev.type==='thought') console.log('  [thought]', String(ev.text).slice(0,120)) },
  })
  console.log(`\ngrounded=${!!r}  ${((Date.now()-t0)/1000).toFixed(1)}s`)
  if(r){
    const hasZipv4 = /\bz\s*\.\s*ipv4\s*\(|\.\s*ipv4\s*\(/.test(r.text)
    console.log('ANSWER uses .ipv4():', hasZipv4)
    console.log('---\n' + r.text.slice(0, 700))
  }
}
main().then(()=>process.exit(0))
