import { selectRelevantPassages } from '../../src/CrucibleEngine/answer/groundedAnswer'
import { fetchLibraryApiForQuery } from '../../src/CrucibleEngine/retrieval/retrievalLayer'
const Q='Write a Zod schema that validates an IPv4 address'
async function main(){
  const api = await fetchLibraryApiForQuery(Q)
  if(!api){console.log('NULL');return}
  console.log(`raw d.ts: ${api.text.length} chars, ipv4 x${(api.text.match(/ipv4/gi)||[]).length}`)
  for (const budget of [1200, 3000]) {
    const sel = selectRelevantPassages(api.text, Q, budget)
    const n = (sel.match(/ipv4/gi)||[]).length
    console.log(`budget ${String(budget).padStart(4)} -> ${String(sel.length).padStart(4)}c  ipv4 x${n}  ${n>0?'PASS':'*** FAIL: identifier dropped ***'}`)
    if(n>0){ const i=sel.toLowerCase().indexOf('ipv4'); console.log('    ', sel.slice(Math.max(0,i-90),i+70).replace(/\n/g,' ⏎ ')) }
  }
}
main()
