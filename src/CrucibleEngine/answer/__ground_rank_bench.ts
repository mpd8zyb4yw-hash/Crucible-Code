// Pure, offline bench for grounded-source ranking. No model calls, no network.
// Run: npx tsx src/CrucibleEngine/answer/__ground_rank_bench.ts  (npm run ground:bench)
//
// Guards the canonical-title preference (cont.67): within one salient-overlap tier the base
// entity article must outrank its derivatives/sequels, and the top-1 must be the correct page.
import { rankResults } from './groundedAnswer'
import type { SearchResult } from '../retrieval/retrievalLayer'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

const S = (title: string, snippet = '', url = ''): SearchResult => ({
  title,
  snippet: snippet || title,
  url: url || `https://en.wikipedia.org/wiki/${title.replace(/ /g, '_')}`,
})

console.log('== who wrote Dune: the base novel beats the sequels ==')
{
  // Wikipedia's own order (sequels first) — the exact failure the handoff described.
  const results = [
    S('Dune Messiah', 'Dune Messiah is a 1969 science fiction novel by Frank Herbert, the sequel to Dune.'),
    S('Children of Dune', 'Children of Dune is a 1976 science fiction novel by Frank Herbert.'),
    S('Dune (novel)', 'Dune is a 1965 epic science fiction novel by American author Frank Herbert.'),
    S('God Emperor of Dune', 'God Emperor of Dune is a 1981 science fiction novel by Frank Herbert.'),
  ]
  const ranked = rankResults(results, 'who wrote Dune')
  check('top-1 is Dune (novel)', ranked[0]?.title === 'Dune (novel)', ranked[0]?.title)
  check('novel ranked above Dune Messiah',
    ranked.findIndex(r => r.title === 'Dune (novel)') < ranked.findIndex(r => r.title === 'Dune Messiah'))
}

console.log('\n== sky blue: the color article beats the club/qualified pages ==')
{
  const results = [
    S('Sky Blue FC', "Sky Blue FC was an American professional women's soccer club."),
    S('Sky blue', 'Sky blue is a colour that resembles the colour of the clear sky.'),
    S('Baby blue', 'Baby blue is a shade of blue.'),
  ]
  const ranked = rankResults(results, 'what colour is sky blue')
  check('top-1 is Sky blue (colour)', ranked[0]?.title === 'Sky blue', ranked[0]?.title)
}

console.log('\n== a genuinely more-relevant page still wins over a shorter base title ==')
{
  // The penalty must NOT override a real overlap difference. "python asyncio gather" — the
  // page whose title matches TWO salient tokens beats a one-token base page even if longer.
  const results = [
    S('Python (programming language)', 'General-purpose programming language.'),
    S('asyncio gather documentation guide', 'asyncio.gather runs awaitables concurrently in Python.'),
  ]
  const ranked = rankResults(results, 'python asyncio gather')
  check('two-token-overlap page ranks first',
    ranked[0]?.title === 'asyncio gather documentation guide', ranked[0]?.title)
}

console.log('\n== authorship verb is not treated as an entity token ==')
{
  // "wrote" must not penalize titles nor count as overlap — only "hamlet" is the entity.
  const results = [
    S('Hamlet', 'The Tragedy of Hamlet, a tragedy by William Shakespeare.'),
    S('Hamlet (place)', 'A hamlet is a small human settlement.'),
  ]
  const ranked = rankResults(results, 'who wrote Hamlet')
  check('the play Hamlet is top-1', ranked[0]?.title === 'Hamlet', ranked[0]?.title)
}

console.log('\n== intent tie-break: "who wrote Dune" prefers (novel) over (franchise) ==')
{
  // Both strip to {dune} with equal overlap and zero extras — a pure disambiguator tie. The
  // creation verb "wrote" implies the written work, so the novel must win.
  const results = [
    S('Dune (franchise)', 'Dune is an American science fiction media franchise.'),
    S('Dune (novel)', 'Dune is a 1965 epic science fiction novel by Frank Herbert.'),
  ]
  const ranked = rankResults(results, 'who wrote Dune')
  check('novel outranks franchise on an authorship query', ranked[0]?.title === 'Dune (novel)', ranked[0]?.title)
}

console.log('\n== intent tie-break: "who directed Dune" prefers (film) over (novel) ==')
{
  const results = [
    S('Dune (novel)', 'Dune is a 1965 epic science fiction novel by Frank Herbert.'),
    S('Dune (film)', 'Dune is a 2021 epic science fiction film directed by Denis Villeneuve.'),
  ]
  const ranked = rankResults(results, 'who directed Dune')
  check('film outranks novel on a directing query', ranked[0]?.title === 'Dune (film)', ranked[0]?.title)
}

console.log('\n== intent tie-break stays inert without a creation verb ==')
{
  // No verb → no bonus; the pages tie and original order is preserved (stable sort).
  const results = [
    S('Dune (franchise)', 'Dune is an American science fiction media franchise.'),
    S('Dune (novel)', 'Dune is a 1965 epic science fiction novel by Frank Herbert.'),
  ]
  const ranked = rankResults(results, 'Dune')
  check('order preserved when no intent verb present', ranked[0]?.title === 'Dune (franchise)', ranked[0]?.title)
}

console.log('\n== bare-title tie: exact-base article beats the qualified same-base page ==')
{
  // No disambiguator, equal overlap — the page titled EXACTLY the entity is canonical.
  const results = [
    S('Mercury Records', 'Mercury Records is an American record label.'),
    S('Mercury', 'Mercury is the smallest planet in the Solar System.'),
  ]
  const ranked = rankResults(results, 'Mercury')
  check('exact-base Mercury is top-1', ranked[0]?.title === 'Mercury', ranked[0]?.title)
}

console.log('\n== intent bonus still outranks a bare exact-base match ==')
{
  // "who wrote Dune": (novel) gets the 0.25 intent bonus; bare "Dune" gets only the 0.15
  // exact-base bonus — the intent-matched work must still win.
  const results = [
    S('Dune', 'Dune is a media franchise.'),
    S('Dune (novel)', 'Dune is a 1965 novel by Frank Herbert.'),
  ]
  const ranked = rankResults(results, 'who wrote Dune')
  check('novel (intent) beats bare Dune (exact-base)', ranked[0]?.title === 'Dune (novel)', ranked[0]?.title)
}

console.log('\n== no-salient-token query is passed through untouched ==')
{
  const results = [S('A'), S('B')]
  const ranked = rankResults(results, 'the of a an')
  check('order preserved when nothing is salient', ranked[0]?.title === 'A' && ranked.length === 2)
}

console.log('\n== off-topic tail is still dropped (relative threshold intact) ==')
{
  const results = [
    S('Water cycle', 'The water cycle describes the continuous movement of water.'),
    S('Rock cycle', 'The rock cycle is a basic concept in geology.'),
    S('Air cycle machine', 'An air cycle machine is a refrigeration device.'),
  ]
  const ranked = rankResults(results, 'water cycle')
  check('Water cycle is top-1', ranked[0]?.title === 'Water cycle', ranked[0]?.title)
  check('Water cycle outranks the tangential cycle pages',
    ranked.indexOf(ranked.find(r => r.title === 'Water cycle')!) === 0 &&
    ranked.findIndex(r => r.title === 'Rock cycle') > 0)
}

console.log(`\n${pass}/${pass + fail} passed`)
if (fail > 0) process.exit(1)
