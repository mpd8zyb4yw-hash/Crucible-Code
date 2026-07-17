import { fetchLibraryApiForQuery } from '../../src/CrucibleEngine/retrieval/retrievalLayer'
import { selectRelevantPassages } from '../../src/CrucibleEngine/answer/groundedAnswer'
import { bonsaiComplete } from '../../src/CrucibleEngine/localModels/bonsaiSidecar'
import { certifyAnswer } from '../../src/CrucibleEngine/reasoning/executionVerify'
const SYS = 'You are a precise coding assistant. Use ONLY APIs that appear in the EVIDENCE. Answer with one short code block and at most one sentence.'
const CON = 'Do NOT emit JSON Schema or a hand-rolled regex. Use only zod APIs named in the EVIDENCE (for example z.email()).'
async function main(){
  const q = 'write a zod schema that validates an email address'
  const d = await fetchLibraryApiForQuery(q)
  const ev = `[S1] ${d!.title} — ${d!.url}\n${selectRelevantPassages(d!.text, q, 1200)}`
  for (let i=0;i<3;i++){
    const out = await bonsaiComplete([{role:'system',content:SYS},{role:'user',content:`Question: ${q}\n\n## EVIDENCE\n${ev}\n\n## CONSTRAINTS\n${CON}`}], {maxTokens:300,timeoutMs:60000})
    const v = certifyAnswer(out, ev, {codeRequested:true})
    console.log(`run${i}: certify=${v.status.padEnd(11)} emailUsed=${/\.\s*email\s*\(/.test(out)} jsonSchema=${/\$schema/.test(out)}`)
    if (v.status!=='certified') console.log('   ' + out.replace(/\n/g,' ').slice(0,120))
  }
}
main().then(()=>process.exit(0))
