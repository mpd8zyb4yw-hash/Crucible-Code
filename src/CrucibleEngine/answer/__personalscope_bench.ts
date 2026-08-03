// Hermetic bench for the private-fact scope gate.
//
// The gate's cost of a false positive is high — refusing a question it could have answered —
// so most of these cases are things it must NOT intercept: imperatives about the user's own
// data ("summarize my email"), meta questions, and world questions that happen to contain "I".
import { isPrivateFactQuestion, refusePrivateFact } from './personalScope'

let pass = 0, fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

// ── Must refuse: private facts with nothing on record. The first two are the measured ones. ──
const REFUSE = [
  'What did I have for breakfast yesterday?',
  'Where did I go on holiday last year?',
  "What is my sister's name?",
  'When is my dentist appointment?',
  'How old is my nephew?',
  'Who did I meet on Tuesday?',
  'What was my first car?',
  'Which gym do I go to?',
]
for (const q of REFUSE) {
  const r = refusePrivateFact(q, [])
  check(`refuses: ${q}`, !!r && /nothing in this conversation records it/.test(r.text), r ? 'wrong text' : 'null')
}

// ── Must NOT intercept ───────────────────────────────────────────────────────────────
const ALLOW: Array<[string, string]> = [
  ['Summarize my unread email.', 'imperative — this is the product working'],
  ['Draft a reply to my landlord.', 'imperative'],
  ['Add my 3pm meeting to the calendar.', 'imperative'],
  ['What can you do for me?', 'meta capability question'],
  ['What is the capital of Australia?', 'world fact'],
  ['How many days are there between 1 January 2026 and 3 August 2026?', 'calendar arithmetic'],
  ['Convert 100 km to miles.', 'conversion'],
  ['I have meetings at 9am and 2pm, when am I free?', 'the user supplied the facts in the question'],
  ['What is 17 times 23?', 'arithmetic'],
  ['Why does my Python script throw a KeyError?', 'imperative-free but a code question, not a life fact'],
]
for (const [q, why] of ALLOW) {
  const r = refusePrivateFact(q, [])
  check(`passes through (${why}): ${q}`, r === null, r ? 'INTERCEPTED' : '')
}

// ── Defers when the conversation actually discussed it ───────────────────────────────
const hist = [
  { role: 'user', content: 'I had porridge for breakfast this morning and it was excellent.' },
  { role: 'assistant', content: 'Noted.' },
]
check('defers to recall when the transcript mentions the subject',
  refusePrivateFact('What did I have for breakfast yesterday?', hist) === null)
check('still refuses an unrelated private fact with that same history',
  refusePrivateFact("What is my sister's name?", hist) !== null)

// ── Detection is independent of the refusal decision ─────────────────────────────────
check('detects a private-fact question', isPrivateFactQuestion('Where did I park my car?'))
check('does not detect an imperative', !isPrivateFactQuestion('Find my car keys in the notes.'))

console.log(`\nPERSONAL SCOPE BENCH: ${pass}/${pass + fail}`)
if (fail) process.exit(1)
