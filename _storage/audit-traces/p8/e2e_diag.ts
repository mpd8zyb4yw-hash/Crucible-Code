import { answerWithWebGrounding } from '../../src/CrucibleEngine/answer/groundedAnswer'
import { debugBus } from '../../src/CrucibleEngine/debug/bus'
const T0=Date.now(); const t=()=>((Date.now()-T0)/1000).toFixed(1).padStart(6)
const anyBus: any = debugBus
for (const m of ['on','subscribe','addListener']) {
  if (typeof anyBus[m] === 'function') { try { anyBus[m]('pipeline', (e:any)=>console.log(`${t()}s [bus] ${e?.event??e?.name} ${JSON.stringify(e?.data??e).slice(0,150)}`)) } catch {} ; break }
}
async function main(){
  const r = await answerWithWebGrounding('Write a Zod schema that validates an IPv4 address', {
    budgetMs: 90_000,
    emit: (ev:any) => { if (ev.type==='thought') console.log(`${t()}s [thought] ${String(ev.text).slice(0,96)}`) },
  })
  console.log(`${t()}s DONE. answer uses .ipv4(): ${/\.\s*ipv4\s*\(/.test(r?.text ?? '')}`)
  console.log((r?.text ?? '').slice(0,220))
}
main().then(()=>process.exit(0))
