// Pure, offline bench for long-output truncation detection + continuation stitching.
// Run: npx tsx src/CrucibleEngine/answer/__longoutput_bench.ts  (npm run longout:bench)
//
// Guards two contracts: (1) truncation is detected on HIGH-PRECISION signals only (a finished
// answer is never flagged, so continuation can't make it ramble), and (2) stitching a resumed
// piece onto the draft removes repeated overlap without losing content.
import { detectTruncation, estimateTokens, buildContinuationMessages, stitchContinuation } from './longOutput'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

console.log('== an open code fence is always truncated ==')
{
  const t = 'Here is the function:\n```ts\nfunction add(a: number, b: number) {\n  return a +'
  const r = detectTruncation(t, 1100)
  check('open fence flagged', r.truncated && r.reason === 'open-code-fence', r.reason)
}

console.log('\n== a balanced, sentence-terminated answer is NOT truncated ==')
{
  const t = 'A hash map stores key-value pairs with O(1) average lookup. That is the core idea.'
  check('short finished prose not flagged', !detectTruncation(t, 1100).truncated)
  const code = 'Example:\n```ts\nconst x = 1\n```\nThat completes it.'
  check('closed code block not flagged', !detectTruncation(code, 1100).truncated)
}

console.log('\n== budget-capped mid-sentence prose is truncated ==')
{
  // Fill ~95% of a small budget and end mid-sentence (no terminator).
  const maxTokens = 100
  const filler = 'word '.repeat(90).trim()            // ~450 chars ≈ 113 tokens > 90% of 100
  const t = filler + ' and then the next step is to carefully consider the following important'
  const r = detectTruncation(t, maxTokens)
  check('budget-capped mid-sentence flagged', r.truncated && r.reason === 'budget-capped', `${r.reason} est=${estimateTokens(t)}`)
}

console.log('\n== budget-capped but ending on a boundary is NOT truncated ==')
{
  const maxTokens = 100
  const t = 'word '.repeat(95).trim() + ' and that is the final conclusion.'   // ends with '.'
  check('boundary-ending long answer not flagged', !detectTruncation(t, maxTokens).truncated)
}

console.log('\n== short answer well under budget is never flagged ==')
{
  check('tiny answer not flagged', !detectTruncation('Yes, that works', 1100).truncated)
  check('empty answer not flagged', !detectTruncation('', 1100).truncated)
}

console.log('\n== continuation messages seat the draft as the assistant turn ==')
{
  const base = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'explain X' }]
  const msgs = buildContinuationMessages(base, 'partial answer that stops here')
  check('draft appended as assistant', msgs[msgs.length - 2].role === 'assistant' && /partial answer/.test(msgs[msgs.length - 2].content))
  check('continue directive is the last user turn', msgs[msgs.length - 1].role === 'user' && /continue/i.test(msgs[msgs.length - 1].content))
}

console.log('\n== stitching drops repeated overlap the model re-emits ==')
{
  const draft = 'The algorithm works by first sorting the array and then'
  const cont = ' and then scanning it once to find duplicates in linear time.'
  const stitched = stitchContinuation(draft, cont)
  check('no duplicated "and then"', (stitched.match(/and then/g) ?? []).length === 1, stitched)
  check('tail content preserved', /scanning it once/.test(stitched))
}

console.log('\n== stitching with no overlap just concatenates cleanly ==')
{
  const stitched = stitchContinuation('First part.', 'Second part.')
  check('both parts present', /First part\./.test(stitched) && /Second part\./.test(stitched))
}

console.log('\n== stitching continues an open code block correctly ==')
{
  const draft = 'Code:\n```ts\nfunction f() {\n  return'
  const cont = ' 42\n}\n```'
  const stitched = stitchContinuation(draft, cont)
  check('fences now balanced', (stitched.match(/```/g) ?? []).length === 2, stitched)
  check('resulting block is complete', !detectTruncation(stitched, 1100).truncated)
}

console.log(`\n${pass}/${pass + fail} passed`)
if (fail > 0) process.exit(1)
