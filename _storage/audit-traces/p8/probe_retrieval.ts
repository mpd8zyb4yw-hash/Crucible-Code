import { search } from '../../src/CrucibleEngine/retrieval/retrievalLayer'
async function main() {
  const QUERIES = [
    'Write a Zod schema that validates an IPv4 address',
    'zod schema validate IPv4 address',
  ]
  for (const q of QUERIES) {
    console.log('\n=== QUERY: ' + JSON.stringify(q))
    try {
      const r = await search(q)
      console.log('  results:', r.length)
      r.slice(0, 8).forEach((x, i) => console.log(`  ${i + 1}. ${x.url}`))
    } catch (e) { console.log('  ERROR', (e as Error).message) }
  }
}
main()
