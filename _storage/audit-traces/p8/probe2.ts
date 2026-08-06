import { search } from '../../src/CrucibleEngine/retrieval/retrievalLayer'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function main() {
  const QUERIES = [
    'zod schema validate IPv4 address',                    // 0 results a moment ago
    'Write a Zod schema that validates an IPv4 address',   // 10 results a moment ago
    'zod schema validate IPv4 address',                    // repeat #1 — deterministic?
  ]
  for (const q of QUERIES) {
    const t0 = Date.now()
    let r: any[] = []; let err = ''
    try { r = await search(q) } catch (e) { err = (e as Error).message }
    console.log(`${String(r.length).padStart(2)} results  ${((Date.now()-t0)/1000).toFixed(1)}s  ${err ? 'ERR:'+err : ''}  <- ${JSON.stringify(q)}`)
    if (r.length) console.log('     top:', r[0].url)
    await sleep(3000)
  }
}
main()
