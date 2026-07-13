// ============================================================================
// Committed bench for src/server/textVector.ts — the response-cache paraphrase
// similarity (stem / vectorize / cosineSim), extracted from server.ts. Proves the
// precision the cache relies on: paraphrases score high, a single differing key
// noun drops below the 0.82 bar, stopwords/morphology don't inflate similarity.
// Run: npx tsx src/server/__textVector_bench.ts
// ============================================================================
import { stem, vectorize, cosineSim } from './textVector'

const checks: Array<{ name: string; pass: boolean }> = []
const ok = (name: string, pass: boolean) => checks.push({ name, pass })
const sim = (a: string, b: string) => cosineSim(vectorize(a), vectorize(b))
const THRESH = 0.82

ok('stem strips a trailing plural s but not ss / short words',
  stem('strings') === 'string' && stem('reverses') === 'reverse' && stem('class') === 'class' && stem('is') === 'is')

ok('identical messages → cosine 1', Math.abs(sim('reverse a string', 'reverse a string') - 1) < 1e-9)

ok('paraphrase with stopword/morphology noise stays ABOVE the 0.82 bar',
  sim('please reverse a string', 'reverse the strings') >= THRESH)

ok('a single differing key noun drops BELOW the bar (reverse string vs reverse list)',
  sim('reverse a string', 'reverse a list') < THRESH)

ok('unrelated messages → low similarity',
  sim('reverse a string', 'compute a fibonacci sequence') < 0.2)

ok('empty / stopword-only vectors → 0 similarity',
  sim('the a of to', 'reverse a string') === 0 && cosineSim(vectorize(''), vectorize('x')) === 0)

ok('vectorize drops stopwords and counts term frequency',
  (() => { const v = vectorize('add and add the numbers'); return v.get('add') === 2 && !v.has('the') && !v.has('and') })())

const pass = checks.filter(c => c.pass).length
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'} — ${c.name}`)
console.log(`\n${pass}/${checks.length} passed`)
if (pass !== checks.length) process.exit(1)
