// Pure, offline bench for grounded-source ranking. No model calls, no network.
// Run: npx tsx src/CrucibleEngine/answer/__ground_rank_bench.ts  (npm run ground:bench)
//
// Guards the canonical-title preference (cont.67): within one salient-overlap tier the base
// entity article must outrank its derivatives/sequels, and the top-1 must be the correct page.
import { rankResults, selectRelevantPassages, queryTerms } from './groundedAnswer'
import { namesExternalLibrary } from '../retrieval/retrievalLayer'
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

console.log('\n== off-topic media pages are demoted below the real phenomenon (northern lights) ==')
{
  // The exact live failure: a TV series and a film outrank the aurora because "Blue Lights"
  // contains "lights" and a "Northern Irish" snippet supplies "northern". No media verb/noun in
  // the query → the specific-work pages must lose to the concept article.
  const results = [
    S('Blue Lights (2023 TV series)', 'Blue Lights is a Northern Irish police procedural television drama series.'),
    S('Aurora', 'polar lights; in the Arctic they are called the northern lights, caused by solar wind.'),
    S('Genius (1999 film)', 'a film; the Northern Lights arrive with Charlie.'),
    S('Min Min light', 'an atmospheric light phenomenon.'),
  ]
  const ranked = rankResults(results, 'what causes the northern lights')
  const below = (t: string) => { const i = ranked.findIndex(r => r.title === t); return i === -1 || i > 0 }
  check('top-1 is the Aurora concept page', ranked[0]?.title === 'Aurora', ranked[0]?.title)
  check('the TV series is dropped or below Aurora', below('Blue Lights (2023 TV series)'))
  check('the film is dropped or below Aurora', below('Genius (1999 film)'))
}

console.log('\n== media-intent query still keeps the work page (penalty is inert) ==')
{
  // "who directed the Dune film" DOES want a work — the off-topic penalty must NOT fire, and the
  // film still wins via the intent tie-break.
  const results = [
    S('Dune (novel)', 'Dune is a 1965 epic science fiction novel by Frank Herbert.'),
    S('Dune (film)', 'Dune is a 2021 epic science fiction film directed by Denis Villeneuve.'),
  ]
  const ranked = rankResults(results, 'who directed the Dune film')
  check('film still top-1 when the query names a media type', ranked[0]?.title === 'Dune (film)', ranked[0]?.title)
}


// ── Query-relevance windowing (audit cont.81 regression guard) ────────────────
// The live bug: a 1200-char HEAD slice of the zod DeepWiki page held only the nav
// sidebar, so `ipv4` (at offset 6370 of 7955) never reached the model — which then
// grafted an unrelated zipCode regex it DID find. These lock the windowing fix.
console.log('\n== query-relevance windowing ==')
{
  const NAV = 'Index your code with Devin DeepWiki Overview Installation and Setup Basic Usage Examples Core Architecture Package Structure. '.repeat(40)
  const ANSWER = 'Network Address Formats: use z.ipv4() to validate an IPv4 address string. '
  const TAIL = 'Unrelated trailing prose about error handling and pipelines. '.repeat(40)
  const page = NAV + ANSWER + TAIL

  check('head-slice baseline would MISS the answer (bug reproduced)',
    !page.slice(0, 1200).includes('ipv4'))

  const sel = selectRelevantPassages(page, 'what is the exact method to validate an IPv4 address in zod', 1200)
  check('windowing SURFACES the answer within budget', sel.includes('ipv4'), sel.slice(0, 90))
  check('windowing respects the char budget', sel.length <= 1200 + 8, String(sel.length))

  // Universality: no query-term hits anywhere → must behave exactly like the old head slice.
  const noHit = selectRelevantPassages(page, 'kubernetes helm chart rollout', 1200)
  check('no-match query falls back to head slice (no behaviour change)',
    noHit === page.slice(0, 1200))

  // Short pages are returned intact.
  check('page under budget returned whole', selectRelevantPassages('tiny page', 'anything', 1200) === 'tiny page')

  // Rare terms must outweigh common ones: 'ipv4' is rarer than 'zod' on this page.
  const zodHeavy = 'zod zod zod zod zod. '.repeat(120) + 'the ipv4 validator lives here. ' + 'zod zod. '.repeat(120)
  const selRare = selectRelevantPassages(zodHeavy, 'zod ipv4 validator', 600)
  check('rare term (ipv4) beats frequent term (zod) for window selection', selRare.includes('ipv4'))

  check('queryTerms drops stopwords, keeps content tokens',
    queryTerms('what is the exact method to validate an IPv4 address').includes('ipv4') &&
    !queryTerms('what is the exact method to validate an IPv4 address').includes('the'))

  // DEPRECATED declarations are down-weighted (cont.89). A .d.ts often documents the API twice —
  // a live top-level function and a `@deprecated` method note pointing at it. MEASURED on zod's
  // email surface: the passage filled with `@deprecated Use z.email() instead` and taught the
  // model the deprecated method, which then shipped. A window carrying the query term behind
  // `@deprecated` must lose to an equal window without it, so the live API wins evidence space.
  const dep = '@deprecated use the new email api. email() old note. '.repeat(12)
  const live = 'export declare function email(params) { return validator }. '.repeat(12)
  const both = dep + 'PADDING. '.repeat(200) + live
  const selDep = selectRelevantPassages(both, 'email validator', 600)
  check('live API window is preferred over an equal @deprecated one',
    selDep.includes('export declare function email'), JSON.stringify(selDep.slice(0, 80)))
  // But not EXCLUDED: a deprecated window still beats an off-topic one (z.string().ipv4() is
  // deprecated yet works), so deprecated-but-relevant must still be selected when it's all there is.
  const onlyDep = '@deprecated email() note here. '.repeat(8) + 'UNRELATED. '.repeat(200)
  check('a deprecated-but-relevant window is still selected when it is the only match',
    selectRelevantPassages(onlyDep, 'email', 300).includes('email'))
}


// ── Library-vs-algorithmic routing (audit cont.81 §2.3 regression guard) ──────
// The live bug: grounding was gated on QUESTION shape, so "Write a Zod schema…" got
// 0 sources and returned JSON Schema — the wrong library. Library asks must reach the
// web (an API surface can only be looked up); algorithmic asks must NOT (VGR certifies
// them, and a needless lookup diverts work away from the verifier).
console.log('\n== library-vs-algorithmic routing ==')
{
  const LIB = [
    'Write a Zod schema that validates a string is a valid IPv4 address.',
    'Build a React component that fetches users',
    'How do I use Express middleware for auth',
    'write a function using the lodash library to deep clone',
    "import { z } from 'zod' — how do I add a refinement?",
    'use z.string() to validate an email',
    'npm package for parsing dates',
  ]
  const ALGO = [
    'Write a function to reverse a linked list',
    'write a TypeScript function to reverse a linked list',
    'implement quicksort in Python',
    'write a regex to match an IPv4 address',   // IPv4 is a standard, not a library
    'create a function that returns the nth fibonacci number',
    'write a method to check if a string is a palindrome',
    'implement a binary search algorithm in Java',
    'write a class that models a stack with push and pop',
  ]
  for (const q of LIB) check(`grounds (library): ${q.slice(0, 44)}`, namesExternalLibrary(q))
  // False POSITIVES are the costly direction — they divert verifiable algorithmic work
  // away from VGR, which would have CERTIFIED it. Guard all of them.
  for (const q of ALGO) check(`skips (algorithmic): ${q.slice(0, 44)}`, !namesExternalLibrary(q))

  // Language names are a closed grammatical class, not third-party libraries.
  check('language name alone is not a library', !namesExternalLibrary('write a Python function to sort a list'))
  // Known limitation, asserted so it is visible rather than silently assumed fixed:
  // an all-lowercase library name has no structural signal to key on.
  check('KNOWN GAP: lowercase library name is missed (documented, not fixed)',
    !namesExternalLibrary('create a pandas dataframe from a csv'))
}

console.log(`\n${pass}/${pass + fail} passed`)
if (fail > 0) process.exit(1)
