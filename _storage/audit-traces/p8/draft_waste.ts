// How often does the FM draft need repair for a library ask? If ~always, the FM draft is pure
// latency and qwen should draft directly.
import { fetchLibraryApiForQuery } from '../../src/CrucibleEngine/retrieval/retrievalLayer'
import { selectRelevantPassages } from '../../src/CrucibleEngine/answer/groundedAnswer'
import { certifyAnswer } from '../../src/CrucibleEngine/reasoning/executionVerify'
import { fmComplete } from '../../src/CrucibleEngine/agent/fmReact'
const SYS='You are Crucible. Answer using the EVIDENCE. Cite [S1]. Be direct.'
async function main(){
  const Q=['zod schema to validate an ipv4 address','zod schema for a uuid string','generate a short unique id with nanoid']
  for (const q of Q){
    const d=await fetchLibraryApiForQuery(q); if(!d)continue
    const ev=`[S1] ${d.title} — ${d.url}\n${selectRelevantPassages(d.text,q,1200)}`
    const t0=Date.now()
    let draft=''
    try{ draft=await fmComplete([{role:'system',content:SYS},{role:'user',content:`Question: ${q}\n\n## EVIDENCE\n${ev}`}],{priority:'high',timeoutMs:30000,maxTokens:400}) }catch(e){ draft='(FM failed)' }
    const v=certifyAnswer(draft,ev,{codeRequested:true})
    console.log(`FM draft: ${v.status.padEnd(11)} ${((Date.now()-t0)/1000).toFixed(1)}s  ${q.slice(0,36)}`)
  }
}
main().then(()=>process.exit(0))
