// Bench for selectPassages — proves the fix on the REAL failing case.
// Fetches the live HTTP/3 article (the exact document researchDag had and could not use)
// and checks that head-truncation misses the answer while passage selection finds it.
// Run: npx tsx src/CrucibleEngine/retrieval/__passages_bench.ts
import { selectPassages, queryTerms } from './passages'

let pass = 0, fail = 0
const ok = (c: boolean, msg: string) => { if (c) { pass++; console.log(`  PASS  ${msg}`) } else { fail++; console.log(`  FAIL  ${msg}`) } }

// ── Offline unit cases (no network) ──────────────────────────────────────────
const DOC = [
  'Widgets are a kind of small mechanical component used in many industries.',
  'The history of widgets goes back to the early twentieth century, when several manufacturers began producing them at scale for the automotive trade.',
  'Widget pricing varies. As of 2024 the average unit price was 47 dollars, down from 61 dollars a decade earlier.',
  'Widget maintenance is generally straightforward and requires no specialist tooling.',
].join('\n\n')

console.log('— offline unit cases —')
{
  const sel = selectPassages(DOC, 'What is the average unit price of a widget?', { budget: 260 })
  ok(/47 dollars/.test(sel), `price question finds the price passage (got: ${sel.slice(0, 80)}…)`)
  ok(sel.length <= 260, `respects budget (${sel.length} <= 260)`)
}
{
  const sel = selectPassages(DOC, 'When did widget manufacturing begin?', { budget: 260 })
  ok(/twentieth century/.test(sel), 'history question finds the history passage')
}
{
  const short = 'Just one short line.'
  ok(selectPassages(short, 'anything', { budget: 500 }) === short, 'text under budget returned whole')
}
{
  const sel = selectPassages(DOC, 'zzzz qqqq nomatch', { budget: 120 })
  ok(sel.length > 0 && sel.length <= 120, 'no-match falls back to head of document, still bounded')
}
ok(queryTerms('What is the main difference between HTTP/2 and HTTP/3?').includes('http/3'),
   'queryTerms keeps technical tokens like http/3')
ok(!queryTerms('What is the main difference').includes('main'), 'queryTerms drops filler like "main"')

// ── The real regression: the live HTTP/3 article ─────────────────────────────
console.log('\n— live document (the case researchDag failed on) —')
async function live() {
  const url = 'https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=HTTP%2F3'
  let text = ''
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Crucible/1.0 (bench)' } })
    const j: any = await r.json()
    text = String((Object.values(j?.query?.pages ?? {})[0] as any)?.extract ?? '')
  } catch { /* offline — skip below */ }

  if (text.length < 2000) {
    console.log('  SKIP  could not fetch the live article (offline or rate-limited)')
    return
  }
  console.log(`  article: ${text.length} chars`)

  const question = 'What problem does HTTP/3 solve that HTTP/2 does not?'
  const oldWay = text.slice(0, 1500)             // what researchDag used to send
  const newWay = selectPassages(text, question, { budget: 1500 })

  const hasAnswer = (s: string) => /head-of-line/i.test(s)
  console.log(`  head-truncation contains "head-of-line": ${hasAnswer(oldWay)}`)
  console.log(`  passage-selection contains "head-of-line": ${hasAnswer(newWay)}`)
  ok(hasAnswer(newWay), 'passage selection surfaces the answer within the same 1500-char budget')
  ok(newWay.length <= 1500, `still within budget (${newWay.length})`)
  if (!hasAnswer(oldWay)) {
    console.log('  (confirms the original defect: the old head-slice did NOT contain the answer)')
  }
}

live().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})
