import { fetchLibraryApiForQuery, extractPackageCandidates } from '../../src/CrucibleEngine/retrieval/retrievalLayer'
async function main(){
  const CASES: Array<[string,string,RegExp]> = [
    ['Write a Zod schema that validates an IPv4 address', 'zod', /\bipv4\b/i],
    ['How do I use React useEffect with a cleanup function?', 'react', /useEffect/],
    ['express middleware for error handling', 'express', /RequestHandler|Middleware/i],
  ]
  for (const [q, expectPkg, expectRe] of CASES) {
    const t0=Date.now()
    const d = await fetchLibraryApiForQuery(q)
    const ms=Date.now()-t0
    if(!d){ console.log(`NULL   ${ms}ms  cands=${JSON.stringify(extractPackageCandidates(q))}  <- ${q.slice(0,42)}`); continue }
    const okPkg = d.pkg===expectPkg, okContent = expectRe.test(d.text)
    console.log(`${okPkg&&okContent?'OK  ':'FAIL'}  ${String(ms).padStart(5)}ms  ${d.pkg}@${d.version}  ${d.text.length}c  matches=${okContent}  files=${JSON.stringify(d.files)}`)
  }
}
main()
