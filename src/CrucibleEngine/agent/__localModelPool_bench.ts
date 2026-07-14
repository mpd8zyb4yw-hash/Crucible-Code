// Pure bench for truncateRepetition — the safety net that cuts a small local model's
// degenerate repeat-loop tail (the "MiniCPM repeats indefinitely" bug). No model calls.
// Run: npx tsx src/CrucibleEngine/agent/__localModelPool_bench.ts  (npm run localpool:bench)
import { truncateRepetition } from './localModelPool'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

console.log('== degenerate loops are collapsed ==')
{
  const lineLoop = 'The capital of France is Paris.\n' + 'I cannot help with that.\n'.repeat(12)
  const r = truncateRepetition(lineLoop)
  check('12 identical trailing lines → one', (r.match(/I cannot help with that\./g) || []).length === 1, r.slice(0, 80))
  check('the real answer before the loop is kept', /capital of France is Paris/.test(r))
}
{
  const sentLoop = 'Here is the answer. ' + 'The answer is 42. '.repeat(8)
  const r = truncateRepetition(sentLoop)
  check('8 repeated sentences → one', (r.match(/The answer is 42\./g) || []).length === 1, r.slice(0, 80))
}
{
  const wordLoop = 'Sure!\n' + 'yes yes yes yes yes yes yes\n'.repeat(6)
  const r = truncateRepetition(wordLoop)
  check('repeated single-word line collapses', (r.match(/yes yes yes yes yes yes yes/g) || []).length === 1)
}

console.log('\n== legitimate text is untouched ==')
{
  const clean = 'Paris is the capital of France. It has about 2 million residents.'
  check('a normal answer is unchanged', truncateRepetition(clean) === clean)
  const list = '- apple\n- banana\n- cherry'
  check('a bullet list is unchanged (distinct items)', truncateRepetition(list) === list)
  const shortDup = 'ok ok'  // below the length floor — untouched
  check('short input untouched', truncateRepetition(shortDup) === shortDup)
  const twice = 'Thanks for asking. Thanks for asking.'  // only 2× → not a loop, left alone
  check('a phrase repeated only twice is NOT collapsed', truncateRepetition(twice) === twice)
  check('empty/whitespace → empty', truncateRepetition('   ') === '')
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
