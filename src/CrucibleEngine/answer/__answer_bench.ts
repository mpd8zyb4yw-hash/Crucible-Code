// Pure, offline bench for the answer engine's deterministic parts — facet classification and
// the critic pass. NO model calls, NO network (the FM draft is nondeterministic and slow, so
// live answer quality is verified separately via the JWT curl harness). Run:
//   npx tsx src/CrucibleEngine/answer/__answer_bench.ts
import { classifyFacets, ensureTrailingAnswer } from './answerEngine'
import { critiqueAnswer } from './verify'
import { normalizeAnswer } from './selfConsistency'
import { applyRecomputation, evalArithmeticExpr, evalSteps, evalWithEnv, recomputeMultiStep, recomputeWordProblem, type Completer } from './wordProblem'

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

  // Broadened computation detection: discount/percent/money-math now route to recomputation.
  const disc = classifyFacets('A shirt costs $40 and is discounted 25%. What is the sale price?')
  check('discount/percent problem → needsComputation (routes to recomputation)', disc.needsComputation, JSON.stringify(disc))
  const total = classifyFacets('You buy 3 notebooks at $4 each and 2 pens at $1.50 each. What is the total cost?')
  check('"what is the total cost" with numbers → needsComputation', total.needsComputation, JSON.stringify(total))
  // Guard: a numberless / non-quantitative question must NOT be misrouted as computation.
  const cap2 = classifyFacets('What is the capital of France?')
  check('lookup with no numbers → NOT needsComputation (no over-routing)', !cap2.needsComputation, JSON.stringify(cap2))
  const priceLookup = classifyFacets('What is the price of a Tesla Model 3?')
  check('bare price lookup (no numbers in Q) → NOT needsComputation', !priceLookup.needsComputation, JSON.stringify(priceLookup))
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

console.log('== word-problem recomputation: safe arithmetic evaluation (machine does the math) ==')
{
  check('evaluates a product (60 * 2.5 = 150)', evalArithmeticExpr('60 * 2.5') === 150)
  check('respects parentheses ((3 + 4) * 2 = 14)', evalArithmeticExpr('(3 + 4) * 2') === 14)
  check('division with a fraction (10 / 4 = 2.5)', evalArithmeticExpr('10 / 4') === 2.5)
  check('unicode × normalized (60 × 2.5 = 150)', evalArithmeticExpr('60 × 2.5') === 150)
  check('caret power (2 ^ 3 = 8)', evalArithmeticExpr('2 ^ 3') === 8)
  check('REJECTS a variable (60 * t → null, never evals identifiers)', evalArithmeticExpr('60 * t') === null)
  check('REJECTS a bare number (no operator → not a computation)', evalArithmeticExpr('150') === null)
}

// A completer that replays canned JSON extractions in order (proves the loop, no live model).
const replay = (jsons: string[]): Completer => {
  let i = 0
  return async () => jsons[Math.min(i++, jsons.length - 1)]
}

console.log('== word-problem recomputation: consensus over independent SETUPS ==')
{
  // All three setups agree → machine value 150 (the model never computes it).
  const agree = await recomputeWordProblem('A train travels 60 mph for 2.5 hours. How far?', {
    samples: 3, complete: replay(['{"expression":"60 * 2.5","unit":"miles"}', '{"expression":"60*2.5","unit":"miles"}', '{"expression":"(60)*(2.5)","unit":"mi"}']),
  })
  check('quorum of agreeing setups → value 150 miles', !!agree && agree.value === 150 && agree.unit === 'miles', JSON.stringify(agree))

  // A 2-of-3 majority still certifies; the odd wrong setup is outvoted.
  const majority = await recomputeWordProblem('x', {
    samples: 3, complete: replay(['{"expression":"60 * 2.5","unit":"miles"}', '{"expression":"60 * 2.5","unit":""}', '{"expression":"60 * 2","unit":"miles"}']),
  })
  check('2-of-3 setups agree → majority value 150 (odd wrong setup outvoted)', !!majority && majority.value === 150, JSON.stringify(majority))

  // No two setups agree → ABSTAIN (null), never fabricate an answer.
  const noquorum = await recomputeWordProblem('x', {
    samples: 3, complete: replay(['{"expression":"60 * 2.5"}', '{"expression":"60 * 2"}', '{"expression":"60 * 3"}']),
  })
  check('no two setups agree → abstains (null), never guesses', noquorum === null, JSON.stringify(noquorum))

  // A setup that smuggles a variable evaluates to null and contributes no vote → abstain.
  const novalue = await recomputeWordProblem('x', {
    samples: 3, complete: replay(['{"expression":"60 * t"}', '{"expression":"speed * time"}', '{"expression":""}']),
  })
  check('non-evaluable setups → abstains (machine refuses to guess)', novalue === null, JSON.stringify(novalue))
}

console.log('== word-problem recomputation: reconcile the machine value with the draft ==')
{
  const recomp = { value: 150, unit: 'miles', expression: '60 * 2.5', agreement: 1, samples: 3 }
  // THE gap: the draft states a WRONG bare answer with no equation to critique — corrected anyway.
  const wrong = applyRecomputation('The train travels 140 miles in that time.', recomp)
  check('wrong bare answer (140) corrected to the machine value (150)', wrong.corrected && /150 miles|travels 150/.test(wrong.text), wrong.text)
  const right = applyRecomputation('So the distance is 150 miles.', recomp)
  check('a correct stated answer is CONFIRMED, not altered', right.confirmed && right.text.includes('150'), JSON.stringify(right))
  const none = applyRecomputation('The train is quite fast on that route.', recomp)
  check('a draft with no number gets an explicit machine Answer appended', /Answer:\s*150 miles/.test(none.text), none.text)

  // SAFETY: a computed elapsed-hours value must NOT overwrite a correct time-of-day answer.
  const clockDraft = 'The second train catches up 3 hours later.\nAnswer: 7:00 PM'
  const guarded = applyRecomputation(clockDraft, { value: 3, unit: 'hours', expression: '(80-60)', agreement: 1, samples: 3 })
  check('time-of-day answer is NOT corrupted by a bare-quantity recomputation (7:00 PM preserved)',
    !guarded.corrected && guarded.text === clockDraft && guarded.guarded === true, guarded.text)

  // The verified value is stated cleanly at the end even when the derivation is truncated…
  const truncated = 'Step 1: the discount is 25% of 40 which is 10. Step 2: subtract to get the'
  const capped = ensureTrailingAnswer(truncated, recomp)
  check('a truncated derivation gets a clean trailing **Answer: 150 miles** line', /\*\*Answer: 150 miles\*\*\s*$/.test(capped), capped)
  // …but a draft already ending in a clean answer line is NOT duplicated.
  const clean = 'Work it out.\nAnswer: 150 miles'
  check('an existing clean answer line is not duplicated', ensureTrailingAnswer(clean, recomp) === clean, ensureTrailingAnswer(clean, recomp))
}

console.log('== multi-step recomputation: variable-resolving DAG evaluation ==')
{
  check('evalWithEnv resolves known vars ((a)-(b) with a=80,b=60 → 20)', evalWithEnv('a - b', { a: 80, b: 60 }) === 20)
  check('evalWithEnv composes signs correctly (a + b with b=-5 → 5)', evalWithEnv('a + b', { a: 10, b: -5 }) === 5)
  check('evalWithEnv REJECTS an unknown var (→ null, no guessing)', evalWithEnv('a * c', { a: 2 }) === null)
  // Catch-up problem: head start / relative speed → hours to catch up.
  const steps = [
    { var: 'head_start', expr: '60 * 1' },   // train A's 1-hour lead distance
    { var: 'rel_speed', expr: '80 - 60' },   // B closes at 20 mph
    { var: 'catch', expr: 'head_start / rel_speed' },
  ]
  check('evalSteps evaluates a step DAG (catch-up → 3 hours)', evalSteps(steps, 'catch') === 3)
  check('evalSteps returns null when the answer var is undefined', evalSteps(steps, 'nope') === null)
}

console.log('== multi-step recomputation: consensus over independent step DAGs ==')
{
  const dag = '{"steps":[{"var":"h","expr":"60*1"},{"var":"r","expr":"80-60"},{"var":"c","expr":"h/r"}],"answer":"c","unit":"hours"}'
  const dagAlt = '{"steps":[{"var":"lead","expr":"60"},{"var":"gain","expr":"80-60"},{"var":"t","expr":"lead/gain"}],"answer":"t","unit":"hours"}'
  const agree = await recomputeMultiStep('A train leaves at 3pm at 60mph; another leaves at 4pm at 80mph. Hours until it catches up?', {
    samples: 3, complete: replay([dag, dagAlt, dag]),
  })
  check('independent step DAGs agree → 3 hours (machine computes, model only sets up)', !!agree && agree.value === 3, JSON.stringify(agree))

  const badDag = '{"steps":[{"var":"c","expr":"h / r"}],"answer":"c"}' // references undefined vars → unevaluable
  const noquorum = await recomputeMultiStep('x', { samples: 3, complete: replay([badDag, badDag, badDag]) })
  check('unevaluable step DAGs (undefined vars) → abstains', noquorum === null, JSON.stringify(noquorum))
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)
