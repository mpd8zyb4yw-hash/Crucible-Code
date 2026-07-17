import { fetchLibraryApiForQuery } from '../../src/CrucibleEngine/retrieval/retrievalLayer'
import { selectRelevantPassages } from '../../src/CrucibleEngine/answer/groundedAnswer'
import { bonsaiComplete } from '../../src/CrucibleEngine/localModels/bonsaiSidecar'
const SYS = 'You are a precise coding assistant. Use ONLY APIs that appear in the EVIDENCE. Answer with one short code block and at most one sentence.'
const TASKS = [
  ['zod schema for a uuid string', /\.\s*uuid\s*\(/],
  ['write a zod schema that validates an email address', /\.\s*email\s*\(/],
  ['format a date as yyyy-mm-dd with date-fns', /\bformat\s*\(/],
  ['generate a short unique id with nanoid', /nanoid\s*\(/],
] as const
async function main(){
  for (const [q, want] of TASKS) {
    const d = await fetchLibraryApiForQuery(q)
    if (!d) { console.log(`${q.slice(0,34).padEnd(36)} NO DOCS`); continue }
    const ev = `[S1] ${d.title} — ${d.url}\n${selectRelevantPassages(d.text, q, 1200)}`
    const t0 = Date.now()
    const out = await bonsaiComplete(
      [{role:'system',content:SYS},{role:'user',content:`Question: ${q}\n\n## EVIDENCE\n${ev}`}],
      { maxTokens: 300, timeoutMs: 120_000 })
    const ok = want.test(out)
    console.log(`${ok?'OK  ':'FAIL'} ${q.slice(0,34).padEnd(36)} ${((Date.now()-t0)/1000).toFixed(1)}s`)
    if (!ok) console.log('      ' + out.replace(/\n/g,' ').slice(0,150))
  }
}
main().then(()=>process.exit(0))
