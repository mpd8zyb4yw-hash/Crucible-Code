// Does the fabricated DRAFT in context poison the repair? Standalone qwen = 3/3; in the loop it fails.
import { readFileSync } from 'node:fs'
const EV = readFileSync('audit-traces/p4/t9.evidence.txt','utf8')
const Q = 'Write a Zod schema that validates an IPv4 address'
const DRAFT = readFileSync('audit-traces/p8/e2e-run0.md','utf8')   // the real fabricated draft
const SYS = 'You are a precise coding assistant. Use ONLY APIs that appear in the EVIDENCE. Answer with one short code block and at most one sentence.'
const HINT = 'Your previous answer used `validate`, which does not appear in the evidence. Rewrite it using ONLY documented APIs. Do not hand-roll a regex.'
async function ask(msgs: any[], tag: string) {
  const t0 = Date.now()
  const r = await fetch('http://127.0.0.1:8080/v1/chat/completions', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ model:'m', messages: msgs, max_tokens: 300, temperature: 0.2, chat_template_kwargs:{enable_thinking:false} }),
    signal: AbortSignal.timeout(300000),
  })
  const j:any = await r.json()
  const t = j?.choices?.[0]?.message?.content ?? ''
  console.log(`${tag.padEnd(30)} ${((Date.now()-t0)/1000).toFixed(1)}s  ipv4=${/\.\s*ipv4\s*\(/.test(t)}  jsonSchema=${/\$schema/.test(t)}`)
  console.log('   ' + t.replace(/\n/g,'\n   ').slice(0,260) + '\n')
}
async function main(){
  // A: clean (what the A/B measured — 3/3)
  await ask([{role:'system',content:SYS},{role:'user',content:`Question: ${Q}\n\n## EVIDENCE\n${EV}`}], 'A clean (A/B shape)')
  // B: the REPAIR shape — draft + hint appended
  await ask([{role:'system',content:SYS},{role:'user',content:`Question: ${Q}\n\n## EVIDENCE\n${EV}`},
             {role:'assistant',content:DRAFT},{role:'user',content:HINT}], 'B with fabricated draft')
}
main()
