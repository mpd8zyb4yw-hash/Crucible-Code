// Pure, offline bench for the answer engine's deterministic parts — facet classification and
// the critic pass. NO model calls, NO network (the FM draft is nondeterministic and slow, so
// live answer quality is verified separately via the JWT curl harness). Run:
//   npx tsx src/CrucibleEngine/answer/__answer_bench.ts
import { classifyFacets } from './answerEngine'
import { critiqueAnswer } from './verify'

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

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)
