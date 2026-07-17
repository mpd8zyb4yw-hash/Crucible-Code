import { readFileSync } from 'node:fs'
import { fetchLibraryApiForQuery } from '../../src/CrucibleEngine/retrieval/retrievalLayer'
import { selectRelevantPassages } from '../../src/CrucibleEngine/answer/groundedAnswer'
import { certifyAnswer } from '../../src/CrucibleEngine/reasoning/executionVerify'
import { repairHint } from '../../src/CrucibleEngine/reasoning/apiFaithfulness'
async function main(){
  const q='write a zod schema that validates an email address'
  const d=await fetchLibraryApiForQuery(q)
  const ev=`[S1] ${d!.title} — ${d!.url}\n${selectRelevantPassages(d!.text,q,1200)}`
  const ans=readFileSync('audit-traces/p8/gen-zod-email.md','utf8')
  const v=certifyAnswer(ans,ev,{codeRequested:true})
  console.log('verdict:',v.status,'|',v.reason.slice(0,80))
  console.log('violation kinds:', v.violations.map((x:any)=>x.kind))
  console.log('HINT the engine receives:'); console.log(repairHint(v).split('\n').map(l=>'  '+l).join('\n'))
}
main()
