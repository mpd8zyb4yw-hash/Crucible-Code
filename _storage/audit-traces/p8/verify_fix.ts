import { fetchLibraryApiForQuery, extractPackageCandidates, namesExternalLibrary } from '../../src/CrucibleEngine/retrieval/retrievalLayer'
async function main(){
  const Q = 'Write a Zod schema that validates an IPv4 address'
  console.log('query           :', JSON.stringify(Q))
  console.log('namesExternalLib:', namesExternalLibrary(Q))
  console.log('candidates      :', extractPackageCandidates(Q))
  const t0=Date.now()
  const d = await fetchLibraryApiForQuery(Q)
  if(!d){ console.log('*** NO API DOCS — FIX DOES NOT WORK ***'); return }
  console.log(`resolved        : ${d.pkg}@${d.version}  (${Date.now()-t0}ms)`)
  console.log('files           :', d.files)
  console.log('text            :', d.text.length, 'chars')
  console.log('CONTAINS ipv4   :', /\bipv4\b/i.test(d.text), '  <- the identifier the FM could not find')
  console.log('leaked zod v3?  :', d.files.some(f=>f.startsWith('/v3/')), '(must be false — v3 would poison a v4 answer)')
  const i = d.text.toLowerCase().indexOf('ipv4')
  if(i>=0) console.log('\n--- real API surface in evidence ---\n' + d.text.slice(i-200,i+160))
}
main()
