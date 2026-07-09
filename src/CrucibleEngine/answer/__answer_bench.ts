// Pure, offline bench for the answer engine's deterministic parts — facet classification and
// the critic pass. NO model calls, NO network (the FM draft is nondeterministic and slow, so
// live answer quality is verified separately via the JWT curl harness). Run:
//   npx tsx src/CrucibleEngine/answer/__answer_bench.ts
import { classifyFacets } from './answerEngine'
import { critiqueAnswer } from './verify'
import { normalizeAnswer } from './selfConsistency'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

console.log('== facet classification: routing ==')
{
  const cap = classifyFacets('What is the capital of France?')
  check('capital → lookup, NOT external-fact (timeless; DAG garbles it)', cap.intent === 'lookup' && !cap.needsExternalFact, JSON.stringify(cap))

  const news = classifyFacets('What is the latest news on the stock market today?')
  check('latest/news/today → needsExternalFact (volatile → retrieval)', news.needsExternalFact, JSON.stringify(news))

  const hash = classifyFacets('Explain how a hash map works in simple terms.')
  check('explain → explain intent (thorough depth), not external', hash.intent === 'explain' && !hash.needsExternalFact, JSON.stringify(hash))

  const train = classifyFacets('A train leaves at 3pm going 60mph. Another leaves at 4pm going 80mph in the same direction. When does the second catch up?')
  check('train word problem → reason intent + computation', train.intent === 'reason' && train.needsComputation, JSON.stringify(train))
  check('train word problem → multi-step', train.needsMultiStep, JSON.stringify(train))

  const code = classifyFacets('Write a Python function to sort a list of dicts by age.')
  check('code request → isCode (hand off to code path)', code.isCode, JSON.stringify(code))

  const chat = classifyFacets('I feel overwhelmed with work lately, any advice?')
  check('advice → converse (natural length), not external', chat.intent === 'converse' && !chat.needsExternalFact, JSON.stringify(chat))
}

console.log('== critic pass: arithmetic oracle fixes in place ==')
{
  const { text, issues } = critiqueAnswer('The total is 3 shirts * $23 = $70 for the order.', 'x')
  check('wrong product flagged as arithmetic issue', issues.some(i => i.kind === 'arithmetic'), JSON.stringify(issues))
  check('corrected value spliced in ($69)', /\$69\b/.test(text), text)
  check('arithmetic issue carries fixedText (no re-prompt needed)', issues.filter(i => i.kind === 'arithmetic').every(i => !!i.fixedText))
}

console.log('== critic pass: sanity signals ==')
{
  check('empty draft → empty issue', critiqueAnswer('', 'x').issues.some(i => i.kind === 'empty'))
  check('non-answer ack → nonanswer issue', critiqueAnswer('Sure, I can help with that!', 'How do I center a div?').issues.some(i => i.kind === 'nonanswer'))
  const good = critiqueAnswer('Paris is the capital of France.', 'What is the capital of France?')
  check('clean factual answer → no issues', good.issues.length === 0, JSON.stringify(good.issues))
}

console.log('== critic pass: clock arithmetic fixes in place ==')
{
  const a = critiqueAnswer('The first is 3 hours ahead, so 4:00 PM + 3 hours = 3:00 PM when it catches up.', 'x')
  check('wrong clock result flagged', a.issues.some(i => i.kind === 'clock'), JSON.stringify(a.issues))
  check('clock result corrected to 7:00 PM', /7:00 PM/.test(a.text), a.text)
  check('clock issue carries fixedText (no re-prompt)', a.issues.filter(i => i.kind === 'clock').every(i => !!i.fixedText))

  const b = critiqueAnswer('Adding 5 hours to 10:00 PM gives 3:00 AM.', 'x')
  check('correct clock statement (wrap past midnight) → no clock issue', !b.issues.some(i => i.kind === 'clock'), JSON.stringify(b.issues))

  const c = critiqueAnswer('Adding 5 hours to 10:00 PM gives 2:00 AM.', 'x')
  check('wrong wrap-past-midnight flagged + fixed to 3:00 AM', c.issues.some(i => i.kind === 'clock') && /3:00 AM/.test(c.text), c.text)

  // Subtraction, incl. the stray-negative form the FM emits ("= -4:00 PM").
  const f = critiqueAnswer('9:00 PM - 4 hours = -4:00 PM, so I arrive then.', 'x')
  check('subtraction w/ stray negative flagged', f.issues.some(i => i.kind === 'clock'), JSON.stringify(f.issues))
  check('subtraction corrected to 5:00 PM (no stray minus on result)', /=\s*5:00 PM/.test(f.text), f.text)

  const g = critiqueAnswer('Subtract 3 hours from 1:00 AM = 10:00 PM.', 'x')
  check('subtract-from wrap-before-midnight correct → no clock issue', !g.issues.some(i => i.kind === 'clock'), JSON.stringify(g.issues))
}

console.log('== critic pass: self-contradiction triggers repair ==')
{
  const d = critiqueAnswer('The value always goes up and never goes up over the interval.', 'x')
  check('contradiction flagged', d.issues.some(i => i.kind === 'contradiction'), JSON.stringify(d.issues))
  check('contradiction has no fixedText (needs FM repair)', d.issues.filter(i => i.kind === 'contradiction').every(i => !i.fixedText))
  const e = critiqueAnswer('The speed increases steadily throughout the trip.', 'x')
  check('consistent answer → no contradiction issue', !e.issues.some(i => i.kind === 'contradiction'), JSON.stringify(e.issues))
}

console.log('== self-consistency: final-answer normalization (voting key) ==')
{
  // Times in any format must collapse to one comparable token so votes aggregate.
  check('"7:00 PM" ≡ "7pm" ≡ "19:00"', normalizeAnswer('Answer: 7:00 PM') === normalizeAnswer('the answer is 7pm') && normalizeAnswer('7pm') === normalizeAnswer('at 19:00'),
    `${normalizeAnswer('Answer: 7:00 PM')} / ${normalizeAnswer('7pm')} / ${normalizeAnswer('at 19:00')}`)
  check('distinct times differ (7pm ≠ 5pm)', normalizeAnswer('Answer: 7:00 PM') !== normalizeAnswer('Answer: 5:00 PM'))
  check('prefers explicit Answer: line over earlier numbers', normalizeAnswer('First the head start is 60 miles.\nAnswer: 26') === 'n:26',
    String(normalizeAnswer('First the head start is 60 miles.\nAnswer: 26')))
  check('currency/commas stripped ($1,200 → 1200)', normalizeAnswer('Answer: $1,200') === 'n:1200', String(normalizeAnswer('Answer: $1,200')))
  check('empty / no answer → null', normalizeAnswer('   ') === null)
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)
