// ═══════════════════════════════════════════════════════════════════════════════
// RETRIEVAL bench — proves the pure snippet-selection scorers (no network).
// Run:  npm run retrieval:bench
// ═══════════════════════════════════════════════════════════════════════════════
//
// snippetQuality/selectBestSnippet decide WHICH fetched code block leads the FM
// grounding block. Token-cosine alone ranks a one-line fragment that shares the
// query's tokens above a real function body; these scorers fix that so the weak
// proposer sees one sharp, well-formed PRIMARY REFERENCE. All deterministic.
//
//   1. QUALITY   — a real impl outscores a fragment / prose-in-<pre> / giant dump.
//   2. LANG      — TS/JS reference gets the code-path bonus.
//   3. SELECT    — best snippet is BOTH on-topic and well-formed; noise → null.
//   4. RANK      — retrieveForTask-style ordering leads with the best impl.
// ═══════════════════════════════════════════════════════════════════════════════

import type { RouterTask } from '../router/capabilityRouter'
import { snippetQuality, selectBestSnippet, stripBoilerplate, extractCodeBlocks, type CodeBlock } from './retrievalLayer'

let pass = 0, fail = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

const task = (goal: string): RouterTask => ({ goal } as unknown as RouterTask)

const REAL_IMPL = `export function debounce(fn, ms) {
  let t
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms) }
}`
const FRAGMENT = `import { debounce } from 'lodash'`
const PROSE = `Debounce delays invoking a function until after some wait time has elapsed since the last call. It is commonly used for search input and window resize handlers to improve performance.`

async function main() {
  console.log('\nRETRIEVAL bench — snippet-selection scorers\n')

  // 1. QUALITY — real impl beats fragment and prose.
  const qImpl = snippetQuality(REAL_IMPL, 'ts')
  const qFrag = snippetQuality(FRAGMENT, 'ts')
  const qProse = snippetQuality(PROSE)
  check('1 real implementation scores high', qImpl >= 0.6, `q=${qImpl.toFixed(2)}`)
  check('1 one-line import fragment scores low', qFrag < qImpl, `frag=${qFrag.toFixed(2)} impl=${qImpl.toFixed(2)}`)
  check('1 prose-in-<pre> is penalised below the impl', qProse < qImpl, `prose=${qProse.toFixed(2)}`)
  check('1 empty snippet is zero', snippetQuality('') === 0)

  // 2. LANG — TS/JS gets the code-path bonus over an unknown-lang identical body.
  const qTs = snippetQuality(REAL_IMPL, 'ts')
  const qUnknown = snippetQuality(REAL_IMPL)
  check('2 TS/JS lang bonus applies', qTs > qUnknown, `ts=${qTs.toFixed(2)} unk=${qUnknown.toFixed(2)}`)
  check('2 a 5000-char dump is penalised vs the sweet-spot impl',
    snippetQuality('x'.repeat(5000).replace(/x/g, 'a; '), 'ts') < qTs)

  // 3. SELECT — picks the on-topic, well-formed block; rejects pure noise.
  const blocks: CodeBlock[] = [
    { code: FRAGMENT, lang: 'ts', source: 'a' },
    { code: REAL_IMPL, lang: 'ts', source: 'b' },
    { code: PROSE, source: 'c' },
  ]
  const best = selectBestSnippet(blocks, task('implement a debounce function in typescript'))
  check('3 selects the real debounce impl as PRIMARY', best?.source === 'b', `got=${best?.source}`)
  check('3 empty candidate list → null', selectBestSnippet([], task('anything')) === null)
  const junkOnly = selectBestSnippet([{ code: PROSE, source: 'c' }], task('quantum chromodynamics lattice'))
  check('3 off-topic prose-only → null (leads with a real ref or nothing)', junkOnly === null, `got=${junkOnly?.source}`)

  // 4. RANK — a relevant fragment does NOT outrank a relevant impl (the core bug).
  const relFragment: CodeBlock = { code: `const debounce = null // debounce typescript function`, lang: 'ts', source: 'f' }
  const pick = selectBestSnippet([relFragment, { code: REAL_IMPL, lang: 'ts', source: 'b' }],
    task('debounce typescript function'))
  check('4 relevant one-liner loses to the relevant impl', pick?.source === 'b', `got=${pick?.source}`)

  // 5. BLOCK BOUNDARIES — block-level tags must leave a separator behind.
  // Regression: stripTags deleted every tag with no delimiter, so a docs table collapsed into
  // one run-on token. Measured live on deepwiki's zod page (cont.82): the API the user asked
  // for was PRESENT in the evidence and illegible — `ValidatorRegexipv4()regexes.ipv4`.
  const TABLE =
    '<table><tr><th>Validator</th><th>Regex</th></tr>' +
    '<tr><td>ipv4()</td><td>regexes.ipv4</td></tr>' +
    '<tr><td>ipv6()</td><td>regexes.ipv6</td></tr></table>'
  const tbl = stripBoilerplate(TABLE)
  check('5a table cells do not concatenate', !/ipv4\(\)regexes/.test(tbl), JSON.stringify(tbl))
  check('5b cells are delimited', /ipv4\(\)\s*\|\s*regexes\.ipv4/.test(tbl), JSON.stringify(tbl))
  check('5c rows are on separate lines', /regexes\.ipv4\n\s*ipv6\(\)/.test(tbl), JSON.stringify(tbl))

  const para = stripBoilerplate('<p>First sentence.</p><p>Second sentence.</p>')
  check('5d adjacent blocks do not weld', !/sentence\.Second/.test(para), JSON.stringify(para))
  const li = stripBoilerplate('<ul><li>alpha</li><li>beta</li></ul>')
  check('5e list items separate', !/alphabeta/.test(li), JSON.stringify(li))
  check('5f <br> breaks the line', stripBoilerplate('<div>a<br>b</div>').includes('\n'), '')
  // Prose still reads as prose: no stray delimiter, no intra-sentence break.
  const prose = stripBoilerplate('<div><p>Zod is a validation library.</p></div>')
  check('5g plain prose is unchanged', prose === 'Zod is a validation library.', JSON.stringify(prose))

  // 5h GUARD — the fix is prose-path ONLY. extractCodeBlocks shares stripTags, and injecting
  // delimiters there would corrupt the code it lifts. Code must come back byte-clean.
  const codeHtml = '<pre><code class="language-ts">const s = z.ipv4();\nconst t = a || b;</code></pre>'
  // (`a || b` is legitimate code containing '|', so assert the exact expected text rather than
  // "contains no pipe" — that naive check fails on valid code and would be a false reject.)
  const codeOut = extractCodeBlocks(codeHtml)
  check('5h code extraction is byte-identical (no boundary markers leak into code)',
    codeOut[0]?.code === 'const s = z.ipv4(); const t = a || b;', JSON.stringify(codeOut[0]?.code))

  console.log(`\n${pass}/${pass + fail} passed\n`)
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
