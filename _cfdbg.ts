// Quick semantic-retrieval smoke test — run after reembed.ts completes
// npx tsx _cfdbg.ts
import { queryLivingCorpus } from './src/CrucibleEngine/corpus/query.js'

const tests = [
  { q: 'What did Kant say about the categorical imperative?', expectDomain: 'philosophy' },
  { q: 'What is entropy in thermodynamics?',                  expectDomain: 'physics' },
  { q: 'How did the Roman Empire fall?',                      expectDomain: 'history' },
  { q: 'How does TCP handle packet loss?',                    expectDomain: 'networking' },
]

for (const { q, expectDomain } of tests) {
  const hits = await queryLivingCorpus(q, { topK: 3, minSimilarity: 0.2 })
  const top = hits[0]
  const pass = top?.chunk.domain === expectDomain
  console.log(`${pass ? '✓' : '✗'} [${expectDomain}] ${q.slice(0, 50)}`)
  if (top) console.log(`   → top hit: domain=${top.chunk.domain} sim=${top.similarity.toFixed(3)}  "${top.chunk.content.slice(0, 80)}…"`)
  else console.log('   → NO HITS')
}
