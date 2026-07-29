// Two-direction bench for the prose de-loop (deloopProse.ts). Run:
//   npx tsx src/CrucibleEngine/answer/__deloopprose_bench.ts
//
// Anchored on the 2026-07-29 report: a 4,179-character answer that was one email draft repeated
// five times, separated by `---`.
//
// The second half matters more than the first. A de-looper that is too eager deletes part of a
// correct answer, and that failure ships silently — the user just gets less than they asked for.
// So the "must not touch" cases below are written to be genuinely hard: repeated headings,
// worked examples that differ only in their numbers, refrains, and repeated table rows.
import { deloopProse } from './deloopProse'

let pass = 0, fail = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'OK ' : 'XX '} ${name}${ok ? '' : ` — ${detail}`}`)
  ok ? pass++ : fail++
}

const DRAFT = `Hi Google,

Thank you for bringing this to my attention. I checked my account, and everything looks normal. I never granted access to creatorbase-api.workers.dev, so I'll definitely look into this activity and secure my account.

Please let me know if there's anything else I need to do.

Best regards,

[Your Name]`

console.log('  — THE SHIPPED ANSWER: one draft, five times —')
{
  const looped = Array(5).fill(DRAFT).join('\n\n---\n\n')
  const r = deloopProse(looped)
  check('repetition is detected', r.removed > 0, `removed=${r.removed}`)
  check('the result is one copy, not five',
    r.text.split('Thank you for bringing this').length - 1 === 1,
    `${r.text.split('Thank you for bringing this').length - 1} copies remain`)
  check('the surviving copy is intact',
    r.text.includes('Hi Google,') && r.text.includes('creatorbase-api.workers.dev') && r.text.includes('Best regards,'))
  check('the answer shrank substantially', r.text.length < looped.length / 3,
    `${looped.length} → ${r.text.length}`)
}

console.log('  — separated by blank lines rather than rules —')
{
  const body = 'The Krebs cycle is a series of chemical reactions used by all aerobic organisms to release stored energy through the oxidation of acetyl-CoA.'
  const r = deloopProse([body, body, body].join('\n\n'))
  check('blank-line repetition is caught', r.removed === 2, `removed=${r.removed}`)
  check('one copy survives', r.text === body, JSON.stringify(r.text))
}

console.log('  — MUST NOT TOUCH a legitimate answer —')
{
  const cases: Array<[string, string]> = [
    ['ordinary prose', 'Italian nouns have gender.\n\nMost masculine nouns end in -o, and most feminine nouns end in -a.\n\nPlurals change the final vowel: -o becomes -i, and -a becomes -e. There are irregular forms too, which have to be learned individually rather than derived.'],
    ['repeated short headings', '## Overview\n\nThe engine has three stages that run in order and share no state between them.\n\n## Overview\n\nThe second section repeats the heading deliberately, and its body is entirely different from the first one above it.'],
    ['worked examples differing only in numbers', 'Example 1: if the principal is 100 and the rate is 5 percent, then the interest for one year comes to exactly five units of currency.\n\nExample 2: if the principal is 200 and the rate is 5 percent, then the interest for one year comes to exactly ten units of currency.'],
    ['a repeated one-line refrain', 'Verse one runs for a while and says something reasonably substantial about the subject at hand.\n\nAnd so it goes.\n\nVerse two runs for a while and says something else reasonably substantial about the very same subject.\n\nAnd so it goes.'],
    ['short duplicate lines', 'Yes.\n\nYes.\n\nThe reason both answers are yes is that the two conditions are independent of one another and each is satisfied.'],
  ]
  for (const [name, text] of cases) {
    const r = deloopProse(text)
    check(`untouched: ${name}`, r.text === text && r.removed === 0,
      `removed=${r.removed} — deleting part of a correct answer is the expensive direction`)
  }
}

console.log('  — the final copy is usually TRUNCATED by the token limit —')
{
  const looped = [DRAFT, DRAFT, 'Hi Google,\n\nThank you for bringing this to my att'].join('\n\n---\n\n')
  const r = deloopProse(looped)
  check('a clipped trailing copy is still recognised', r.removed > 0, `removed=${r.removed}`)
  check('one clean copy survives',
    r.text.split('Thank you for bringing this').length - 1 === 1, r.text.slice(0, 80))
  check('the clipped fragment is gone', !r.text.includes('to my att\n') && !r.text.endsWith('to my att'), r.text.slice(-40))
}

console.log('  — a mid-answer near-repeat must not trigger a whole-text cut —')
{
  // Periodicity is required. One duplicated paragraph inside an otherwise varied answer is not a
  // loop, and cutting there would delete the rest of a correct answer.
  const t = [
    'Italian nouns carry grammatical gender, and the ending of the noun is usually the clue you need to identify it.',
    'Most masculine nouns end in -o and most feminine nouns end in -a, though there are well-known exceptions to both.',
    'Italian nouns carry grammatical gender, and the ending of the noun is usually the clue you need to identify it.',
    'Adjectives must agree with the noun they modify in both gender and number, which is why the endings shift around.',
  ].join('\n\n')
  const r = deloopProse(t)
  check('a single duplicated paragraph is left alone', r.text === t && r.removed === 0,
    `removed=${r.removed} — this would have deleted the final paragraph`)
}

console.log('  — total on odd input —')
{
  check('empty', deloopProse('').text === '')
  check('short', deloopProse('Yes.').text === 'Yes.')
  check('single block', deloopProse(DRAFT).text === DRAFT)
  check('no crash on only separators', typeof deloopProse('---\n\n---\n\n---').text === 'string')
  const looped = Array(3).fill(DRAFT).join('\n\n---\n\n')
  check('idempotent', deloopProse(deloopProse(looped).text).text === deloopProse(looped).text)
}

console.log(`\nTOTAL: ${pass}/${pass + fail}`)
if (fail) process.exit(1)
