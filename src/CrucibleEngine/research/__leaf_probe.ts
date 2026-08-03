// Trace ONE research leaf end to end: decomposition -> search -> fetch -> passage -> extract.
// The DAG abstains with "no source answered the question"; this shows exactly which stage
// produces nothing, instead of guessing.
// Run: LOCAL_INFERENCE_URL=http://127.0.0.1:8080 npx tsx src/CrucibleEngine/research/__leaf_probe.ts
import { search, fetch as fetchPage, stripBoilerplate, rankByRelevance } from '../retrieval/retrievalLayer'
import { selectPassages } from '../retrieval/passages'
import { snippetAnswers, decomposeQuestion, defaultFmCall, pingLocalFm } from './leafPrimitives'

// FmCall is (system, user, maxMs) — NOT (messages, opts). Using the wrong shape here made an
// earlier run of this probe report verdict=no in 0ms, which looked like a model failure and
// was actually a probe bug. Use the module's own default caller.
const fmCall = defaultFmCall

const QUESTION = process.argv[2] ?? 'What problem does HTTP/3 solve that HTTP/2 does not?'

async function main() {
  console.log(`QUESTION: ${QUESTION}\n`)
  console.log(`FM url: ${process.env.LOCAL_INFERENCE_URL ?? 'http://127.0.0.1:11435 (default)'}`)
  console.log(`FM reachable: ${await pingLocalFm(fmCall)}\n`)

  console.log('── decompose ──')
  try {
    const { subQuestions } = await decomposeQuestion(QUESTION, fmCall as any)
    subQuestions.forEach((q: string, i: number) => console.log(`  ${i + 1}. ${JSON.stringify(q)}`))
  } catch (e: any) { console.log('  THREW', String(e?.message ?? e).slice(0, 200)) }

  console.log('\n── search ──')
  const results = await search(QUESTION)
  console.log(`  ${results.length} results`)
  for (const r of results.slice(0, 6)) console.log(`   - ${r.title.slice(0, 60)}  ${r.url.slice(0, 70)}`)
  if (!results.length) { console.log('  STOP: search returned nothing'); return }

  const ranked = rankByRelevance(results, { goal: QUESTION }, (r: any) => `${r.title} ${r.snippet}`).slice(0, 3)
  console.log(`\n── fetch + passage (top ${ranked.length} ranked) ──`)
  for (const { item } of ranked) {
    const html = await fetchPage(item.url)
    const text = stripBoilerplate(html ?? '')
    const excerpt = selectPassages(text, QUESTION, { budget: 1200 })
    console.log(`\n  ${item.title.slice(0, 60)}`)
    console.log(`    raw=${(html ?? '').length}  stripped=${text.length}  excerpt=${excerpt.length}`)
    console.log(`    excerpt head: ${excerpt.slice(0, 220).replace(/\s+/g, ' ')}`)
    if (!text) { console.log('    (no text — fetch produced nothing)'); continue }

    const t0 = Date.now()
    try {
      const sa = await snippetAnswers(QUESTION, excerpt, fmCall as any)
      console.log(`    snippetAnswers -> verdict=${sa.verdict}  answer=${JSON.stringify(String(sa.extractedAnswer).slice(0, 160))}  (${Date.now() - t0}ms)`)
    } catch (e: any) {
      console.log(`    snippetAnswers THREW: ${String(e?.message ?? e).slice(0, 200)}`)
    }
  }
}
main().catch(e => { console.error(e); process.exit(1) })
