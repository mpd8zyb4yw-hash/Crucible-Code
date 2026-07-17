import { readFileSync } from 'node:fs'
const EV = readFileSync('audit-traces/p4/t9.evidence.txt','utf8')
const Q = 'Write a Zod schema that validates an IPv4 address'
const DRAFT = readFileSync('audit-traces/p8/e2e-run0.md','utf8')
const SYS = 'You are a precise coding assistant. Use ONLY APIs that appear in the EVIDENCE. Answer with one short code block and at most one sentence.'
const HINT = 'Your previous answer used `validate`, which does not appear in the evidence. Rewrite it using ONLY documented APIs. Do not hand-roll a regex.'
const CONSTRAINT = 'Do NOT use `validate` — it does not appear in the evidence. Do NOT hand-roll a regex or emit JSON Schema. Use only APIs named in the EVIDENCE.'
async function ask(msgs: any[], tag: string, n = 3) {
  let ok = 0, ms = 0
  for (let i = 0; i < n; i++) {
    const t0 = Date.now()
    const r = await fetch('http://127.0.0.1:8080/v1/chat/completions', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ model:'m', messages: msgs, max_tokens: 300, temperature: 0.2, seed: 7000+i, chat_template_kwargs:{enable_thinking:false} }),
      signal: AbortSignal.timeout(300000) })
    const j:any = await r.json(); const t = j?.choices?.[0]?.message?.content ?? ''
    ms += Date.now()-t0
    if (/\.\s*ipv4\s*\(/.test(t) && !/\$schema/.test(t)) ok++
  }
  console.log(`${tag.padEnd(42)} correct=${ok}/${n}  avg=${(ms/n/1000).toFixed(1)}s`)
}
async function main(){
  const base = [{role:'system',content:SYS},{role:'user',content:`Question: ${Q}\n\n## EVIDENCE\n${EV}`}]
  await ask(base, 'A clean, no hint (the A/B shape)')
  await ask([...base,{role:'assistant',content:DRAFT},{role:'user',content:HINT}], 'B draft-in-context + hint (CURRENT)')
  await ask([{role:'system',content:SYS},{role:'user',content:`Question: ${Q}\n\n## EVIDENCE\n${EV}\n\n## CONSTRAINTS\n${CONSTRAINT}`}],
            'C clean + constraint, NO draft (PROPOSED)')
}
main()
