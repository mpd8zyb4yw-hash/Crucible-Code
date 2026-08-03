// Diagnostic: is web retrieval returning anything at all?
// researchDag abstained on every probe with "no source answered the question".
// That has two possible causes: (a) search returns zero results, (b) search works but
// page fetch or extraction fails. This separates them.
import { search as webSearch, fetch as fetchPage } from './retrieval/retrievalLayer'

async function main() {
  const queries = [
    'Node.js LTS version',
    'HTTP/3 QUIC head-of-line blocking',
  ]
  for (const q of queries) {
    console.log(`\n===== SEARCH: ${q}`)
    const t0 = Date.now()
    try {
      const results = await webSearch(q)
      console.log(`  ${results.length} results in ${Date.now() - t0}ms`)
      for (const r of results.slice(0, 5)) {
        console.log(`   - ${r.title?.slice(0, 70)}`)
        console.log(`     ${r.url}`)
        if (r.snippet) console.log(`     snippet: ${r.snippet.slice(0, 120)}`)
      }
      if (results.length) {
        const first = results[0]
        console.log(`\n  --- FETCH ${first.url}`)
        const t1 = Date.now()
        const page = await fetchPage(first.url)
        const text = typeof page === 'string' ? page : (page as any)?.text ?? ''
        console.log(`  fetched ${text.length} chars in ${Date.now() - t1}ms`)
        console.log(`  head: ${text.slice(0, 300).replace(/\s+/g, ' ')}`)
      }
    } catch (e: any) {
      console.log(`  THREW: ${String(e?.message ?? e).slice(0, 300)}`)
    }
  }
}
main().catch(e => { console.error(e); process.exit(1) })
