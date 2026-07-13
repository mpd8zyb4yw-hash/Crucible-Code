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
import { snippetQuality, selectBestSnippet, type CodeBlock } from './retrievalLayer'

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

  console.log(`\n${pass}/${pass + fail} passed\n`)
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
