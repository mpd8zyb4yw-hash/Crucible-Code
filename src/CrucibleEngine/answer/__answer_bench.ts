// Pure, offline bench for the answer engine's deterministic parts — facet classification and
// the critic pass. NO model calls, NO network (the FM draft is nondeterministic and slow, so
// live answer quality is verified separately via the JWT curl harness). Run:
//   npx tsx src/CrucibleEngine/answer/__answer_bench.ts
import { classifyFacets, ensureTrailingAnswer } from './answerEngine'
import { critiqueAnswer } from './verify'
import { normalizeAnswer } from './selfConsistency'
import { applyRecomputation, evalArithmeticExpr, evalSteps, evalWithEnv, recomputeMultiStep, recomputeWordProblem, type Completer } from './wordProblem'
import { applyDateRecomputation, evalDateSetup, isDateQuestion, recomputeDate } from './dateTime'
import { checkConstraints } from './constraints'
import { corroborateFact, extractClaimKey } from './factConsensus'
import { convert, isConversionQuestion, parseConversion, recomputeConversion } from './unitConvert'

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

console.log('== date recomputation: detection (self-contained calendar questions only) ==')
{
  check('explicit-date offset question detected', isDateQuestion('What date is 45 days after March 3, 2026?'))
  check('days-between question detected', isDateQuestion('How many days are there between March 3, 2026 and July 11, 2026?'))
  check('weekday question detected', isDateQuestion('What day of the week is January 1, 2027?'))
  check('"today"-anchored question REFUSED (volatile, not self-contained)', !isDateQuestion('What date is 45 days after today?'))
  check('no explicit date → refused', !isDateQuestion('What day of the week is best for meetings?'))
  check('plain arithmetic question → refused (wordProblem lane)', !isDateQuestion('What is 40 * 25% discounted?'))
}

console.log('== date recomputation: deterministic calendar arithmetic (machine, not model) ==')
{
  const add = evalDateSetup({ base: '2026-03-03', op: 'add', amount: 45, unit: 'days' })
  check('45 days after 2026-03-03 → April 17, 2026', !!add && add.result === 'April 17, 2026', JSON.stringify(add))
  const leap = evalDateSetup({ base: '2024-02-28', op: 'add', amount: 2, unit: 'days' })
  check('leap year handled (2024-02-28 + 2 days → March 1, 2024)', !!leap && leap.result === 'March 1, 2024', JSON.stringify(leap))
  const wd = evalDateSetup({ base: '2026-07-11', op: 'weekday' })
  check('weekday of 2026-07-11 → Saturday', !!wd && wd.result === 'Saturday', JSON.stringify(wd))
  const diff = evalDateSetup({ base: '2026-03-03', op: 'diff', other: '2026-07-11' })
  check('days between 2026-03-03 and 2026-07-11 → 130 days', !!diff && diff.result === '130 days', JSON.stringify(diff))
  check('invalid rollover date (2026-02-30) REJECTED', evalDateSetup({ base: '2026-02-30', op: 'weekday' }) === null)
  check('negative offset REJECTED (setup invalid, not "close enough")', evalDateSetup({ base: '2026-01-01', op: 'add', amount: -3, unit: 'days' }) === null)
  const months = evalDateSetup({ base: '2026-01-31', op: 'add', amount: 1, unit: 'months' })
  check('month offset evaluates deterministically', !!months, JSON.stringify(months))
}

console.log('== date recomputation: consensus + reconciliation ==')
{
  const setup = '{"base":"2026-03-03","op":"add","amount":45,"unit":"days"}'
  const agree = await recomputeDate('What date is 45 days after March 3, 2026?', { samples: 3, complete: replay([setup, setup, '{"base":"2026-03-03","op":"add","amount":45,"unit":"day"}']) })
  check('agreeing setups → April 17, 2026 certified', !!agree && agree.result === 'April 17, 2026', JSON.stringify(agree))
  const noq = await recomputeDate('x', { samples: 3, complete: replay(['{"base":""}', 'not json', '{"base":"2026-13-99","op":"weekday"}']) })
  check('no evaluable quorum → abstains (null)', noq === null, JSON.stringify(noq))
  const rec = agree ? applyDateRecomputation('It lands sometime in mid-April.', agree) : null
  check('draft without the date gets a verified Answer line appended', !!rec && rec.corrected && /\*\*Answer: April 17, 2026\*\*/.test(rec.text), rec?.text)
  const conf = agree ? applyDateRecomputation('Counting forward, that is April 17th.', agree) : null
  check('draft already stating the date (ordinal form) is CONFIRMED unaltered', !!conf && conf.confirmed && !conf.corrected, conf?.text)
  // A CONTRADICTING date in the prose is spliced out; the question's given date survives.
  const splice = agree ? applyDateRecomputation('March 3, 2026, plus 45 days equals June 1, 2026.', agree, 'What date is 45 days after March 3, 2026?') : null
  check('wrong asserted date spliced to the machine date; question date preserved',
    !!splice && !/June 1, 2026/.test(splice.text) && /March 3, 2026/.test(splice.text) && /April 17, 2026/.test(splice.text), splice?.text)
}

console.log('== constraint critics: the question refutes a bad setup ==')
{
  check('percent > 100 violates "what percent" ask', checkConstraints('What percent of 50 is 10?', 500).some(v => v.kind === 'percent-range'), JSON.stringify(checkConstraints('What percent of 50 is 10?', 500)))
  check('percent within [0,100] passes', checkConstraints('What percent of 50 is 10?', 20).length === 0)
  check('negative count violates "how many apples"', checkConstraints('How many apples are left?', -3).some(v => v.kind === 'count-negative'))
  check('fractional count violates "how many people"', checkConstraints('How many people fit in the elevator?', 6.5).some(v => v.kind === 'count-not-integer'))
  check('fractional value OK for continuous units (how many hours → 2.5)', checkConstraints('How many hours does the trip take?', 2.5).length === 0, JSON.stringify(checkConstraints('How many hours does the trip take?', 2.5)))
  check('fractional value OK under rate/average phrasing', checkConstraints('What is the average number of goals per game?', 2.4).length === 0)
  check('part-of-whole: answer cannot exceed the stated whole (30 of the 20)', checkConstraints('How many of the 20 students passed?', 30).some(v => v.kind === 'exceeds-whole'))
  check('part-of-whole within bounds passes', checkConstraints('How many of the 20 students passed?', 14).length === 0)
  check('unit mismatch across recognized families flagged (asked hours, answered miles)', checkConstraints('How many hours will it take?', 3, 'miles').some(v => v.kind === 'unit-mismatch'))
  check('same-family unit passes (asked hours, answered hours)', checkConstraints('How many hours will it take?', 3, 'hours').length === 0)
  check('unrecognized unit never flags (open-ended unit words unpoliced)', checkConstraints('How many hours will it take?', 3, 'widgets').length === 0)
}

console.log('== unit conversion: deterministic table (Tier 1, zero model) ==')
{
  const mph = parseConversion('How fast is 60 mph in km/h?')
  check('60 mph → km/h ≈ 96.56064', !!mph && Math.abs(mph.result - 96.56064) < 1e-6, JSON.stringify(mph))
  const kg = parseConversion('Convert 5 kg to pounds.')
  check('5 kg → pounds ≈ 11.0231', !!kg && Math.abs(kg.result - 11.0231) < 1e-3, JSON.stringify(kg))
  const temp = parseConversion('What is 100 celsius in fahrenheit?')
  check('100 °C → 212 °F (affine, not linear)', !!temp && Math.abs(temp.result - 212) < 1e-9, JSON.stringify(temp))
  const back = parseConversion('What is 32 fahrenheit in celsius?')
  check('32 °F → 0 °C', !!back && Math.abs(back.result) < 1e-9, JSON.stringify(back))
  const hm = parseConversion('How many minutes is 2.5 hours?')
  check('"how many minutes is 2.5 hours" → 150', !!hm && hm.result === 150, JSON.stringify(hm))
  check('cross-family conversion refused (kg → miles)', convert(5, 'kg', 'miles') === null)
  check('unknown unit refused', convert(5, 'blorps', 'kg') === null)
}

console.log('== unit conversion: gating (no false positives on prose) ==')
{
  check('conversion question detected', isConversionQuestion('How fast is 60 mph in km/h?'))
  check('"convert X kg to pounds" detected', isConversionQuestion('Convert 5 kg to pounds'))
  check('plain factual question NOT detected', !isConversionQuestion('What is the capital of France?'))
  check('"I\'m going in a minute" NOT detected (ambiguous in/m don\'t count)', !isConversionQuestion("I'm going in 1 minute, ok?"))
  const rate = 'A train travels 60 mph for 2.5 hours. How far does it go?'
  check('rate word problem may gate as conversion…', isConversionQuestion(rate))
  const nores = await recomputeConversion(rate, { samples: 3, complete: replay(['{"value":null}', '{"value":null}', '{"value":null}']) })
  check('…but recomputeConversion abstains on it (falls through to wordProblem lane)', nores === null, JSON.stringify(nores))
}

console.log('== unit conversion: Tier 2 model-setup quorum (odd phrasings) ==')
{
  const setup = '{"value":26.2,"from":"miles","to":"km"}'
  const agree = await recomputeConversion('A marathon covers 26.2 of those American miles — what is that in the metric distance unit?', {
    samples: 3, complete: replay([setup, setup, '{"value":26.2,"from":"mi","to":"kilometers"}']),
  })
  check('quorum on the CONVERTED value → ≈42.16 km', !!agree && Math.abs(agree.value - 42.164813) < 1e-3 && agree.unit === 'km', JSON.stringify(agree))
  const noq = await recomputeConversion('what about that thing?', { samples: 3, complete: replay(['{"value":1,"from":"kg","to":"lb"}', '{"value":2,"from":"kg","to":"lb"}', '{"value":3,"from":"kg","to":"lb"}']) })
  check('no quorum → abstains', noq === null, JSON.stringify(noq))
}

console.log('== fact consensus: claim-key extraction ==')
{
  check('number is the key claim', extractClaimKey('It is 8,849 meters tall.') === '8849', String(extractClaimKey('It is 8,849 meters tall.')))
  check('proper noun is the key claim (question entity excluded)', extractClaimKey('The capital of Australia is Canberra.', 'What is the capital of Australia?') === 'canberra', String(extractClaimKey('The capital of Australia is Canberra.', 'What is the capital of Australia?')))
  check('multiword proper noun preferred', extractClaimKey('It was written by Gabriel Garcia Marquez in exile.') === 'gabriel garcia marquez', String(extractClaimKey('It was written by Gabriel Garcia Marquez in exile.')))
  check('empty → null', extractClaimKey('   ') === null)
}

console.log('== fact consensus: quorum stamps, disagreement ships unverified ==')
{
  const agree = await corroborateFact('What is the capital of Australia?', 'The capital of Australia is Canberra.', {
    samples: 3, complete: replay(['Canberra.', 'The capital is Canberra.']),
  })
  check('resamples agree → confirmed', !!agree && agree.confirmed && agree.votes >= 3, JSON.stringify(agree))
  const drift = await corroborateFact('Who invented the zipper?', 'It was invented by Whitcomb Judson.', {
    samples: 3, complete: replay(['Gideon Sundback invented it.', 'Elias Howe.']),
  })
  check('resamples drift → NOT confirmed (ships with unverified note)', !!drift && !drift.confirmed, JSON.stringify(drift))
  const nokey = await corroborateFact('x', '???', { samples: 3, complete: replay(['a', 'b']) })
  check('draft with no extractable claim → null (nothing to corroborate)', nokey === null)
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)
