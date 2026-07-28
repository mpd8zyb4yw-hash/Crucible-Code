// Bench for referent resolution (cont.118).
//
// `crucible-verifier-two-failure-directions` — HARD RULE: always test BOTH directions. A
// self-question classifier that is only tested on self-questions is half-tested; the way this
// class of fix breaks a system is by widening until it swallows world questions and sends
// "who won the world cup" to the self-model.
//
// Block 1 pins the OPEN tail that the old enumeration could never cover.
// Block 2 pins world questions that must NOT be captured — including the near-misses that a
//         naive "contains 'you'" test would wrongly swallow.
// Block 3 pins the shapes the old SELF_REF_RX already got right, so this is a strict superset.
//
// Run: npx tsx src/CrucibleEngine/answer/__referent_bench.ts

import { resolveReferent, isAboutSelf, isAboutUser } from './referent'
import { SELF_REF_RX } from './answerEngine'
import { composeSelfAnswer, selfModel } from './selfModel'

let pass = 0, fail = 0
const failures: string[] = []

function check(label: string, ok: boolean, detail = '') {
  if (ok) { pass++; return }
  fail++
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
}

// ── 1. THE OPEN TAIL — the whole reason this file exists ──────────────────────
// Not one of these is in SELF_REF_RX. Every one of them would web-search today.
console.log('\n== self-questions the enumeration never covered ==')
const OPEN_TAIL = [
  'are you made in china',            // ← the observed bug. "made BY" was in the regex; "made IN" was not.
  'are you made in the usa',
  'are you assembled in taiwan',
  'are you owned by google',
  'are you funded by openai',
  'are you running on my machine',
  'are you spying on me',
  'are you recording this',
  'are you cheaper than chatgpt',
  'are you going to replace my job',
  'are you open source',
  'are you free',
  'are you safe to use',
  'do you send my data anywhere',
  'do you work offline',
  'do you have access to my files',
  'can you see my screen',
  'how do you work',
  'how do you reason',
  'were you trained on reddit',
  'what language are you written in',
  'how much ram do you use',
  'how many parameters do you have',
  'where does your model come from',
  'who pays for you',
  'why are you so slow',
  'why do you get things wrong',
]
for (const q of OPEN_TAIL) {
  const r = resolveReferent(q)
  check(`"${q}" → self`, r.referent === 'self', `got ${r.referent} (${r.reason})`)
}

// The headline claim, stated as an assertion rather than a comment.
check(
  'the observed bug was invisible to the old enumeration',
  !SELF_REF_RX.test('are you made in china'),
  'SELF_REF_RX already matched it — the premise of this work is wrong, re-diagnose',
)
check('…and is caught now', isAboutSelf('are you made in china'))

// ── 2. WORLD QUESTIONS MUST NOT BE SWALLOWED ─────────────────────────────────
// The failure mode of a too-wide rule. Several of these contain "you" or "your".
console.log('\n== world questions stay on the world path ==')
const WORLD = [
  'who won the world cup in 1998',
  'what is the capital of australia',
  'who made the eiffel tower',
  'who built the pyramids',
  'what is a hash map',
  'how do i reverse a linked list in python',
  'what is the weather in london',
  'when did the berlin wall fall',
  'do you know who won the super bowl',        // knowledge frame → topic is the Super Bowl
  'can you tell me what the population of japan is',
  'could you look up the price of bitcoin',
  'tell me about the roman empire',
  'i was wondering what causes tides',
  'hey, what time does the sun set in oslo',
  'explain how photosynthesis works',
  'write a function to sort an array',
  'what does this error mean',
  'how much does a tesla model 3 cost',
  'which airport is closest to venice',
  'what are the side effects of ibuprofen',
  // GENERIC person. English uses both pronouns impersonally in how-to questions: neither of
  // these is about the assistant OR the user, and a naive pronoun rule gets both wrong.
  'how do you make bread',
  'how do i reverse a linked list in python',
  'how does one apply for a visa',
  'where can i buy a good knife',
]
for (const q of WORLD) {
  const r = resolveReferent(q)
  check(`"${q}" → world`, r.referent === 'world', `wrongly ${r.referent} via ${r.reason}`)
}

// ── 2b. BLENDED cases — the property that matters is "never the open web" ────
// "what happens to my data" is simultaneously about the assistant's behaviour and the user's
// data; reasonable people route it either way. What is NOT defensible is web-searching the
// literal string, which is the entire bug class. Pin the property, not an arbitrary side.
console.log('\n== blended personal questions never reach the web ==')
for (const q of [
  'what happens to my data',
  'can you see my screen',
  'do you have access to my files',
  'where is my data stored',
  'did you read my emails',
]) {
  const r = resolveReferent(q)
  check(`"${q}" → not world`, r.referent !== 'world', `would web-search: ${r.reason}`)
}

// ── 3. STRICT SUPERSET OF THE OLD BEHAVIOUR ──────────────────────────────────
// Everything SELF_REF_RX caught must still be caught. A regression here means the "universal"
// rule is narrower than the list it replaces, which would be strictly worse.
console.log('\n== every shape the old regex caught is still caught ==')
const LEGACY = [
  'who are you',
  'what are you',
  'how smart are you',
  'how intelligent are you',
  'who made you',
  'who created you',
  'who trained you',
  'what model are you',
  'what kind of ai are you',
  'are you conscious',
  'are you sentient',
  'are you human',
  'are you an llm',
  'do you have feelings',
  'do you have a memory',
  "what's your iq",
  'what is your architecture',
  'what is your context window',
  'what is your knowledge cutoff',
  'when were you trained',
  'what data were you trained on',
  'tell me about yourself',
  'what can you do',
  'what are your limitations',
  'are you smarter than chatgpt',
]
for (const q of LEGACY) {
  check(`"${q}" → self`, isAboutSelf(q), `REGRESSION: old regex caught this, new rule does not`)
}
// Anything the legacy regex matched, the new resolver must also match.
const legacyMisses = [...OPEN_TAIL, ...LEGACY].filter(q => SELF_REF_RX.test(q) && !isAboutSelf(q))
check('no legacy shape lost', legacyMisses.length === 0, legacyMisses.join(' | '))

// ── 4. THE USER REFERENT ─────────────────────────────────────────────────────
// Questions about the person asking route to the user's own world, not the web. This is the
// hook that makes "what's on my calendar" a personal-data lookup instead of a search.
console.log('\n== first-person questions resolve to the user ==')
const USER = [
  'what is on my calendar today',
  'what did i say earlier',
  'do i have any meetings tomorrow',
  'what are my unread emails',
  'when is my next flight',
  'what did we decide last time',
  'how many emails do i have',
]
for (const q of USER) {
  const r = resolveReferent(q)
  check(`"${q}" → user`, r.referent === 'user', `got ${r.referent} (${r.reason})`)
}
check('user ≠ self', !isAboutSelf('what is on my calendar today'))
check('isAboutUser positive', isAboutUser('what did i say earlier'))

// SCHEDULING beats person. These have textbook second-person subjects and are NOT about the
// assistant — the self-model holds no facts that vary by Thursday, so a question with a time
// adjunct cannot be answered from it. `__abstention_bench.ts` pinned the first of these as a
// must-not-be-self case before this file existed.
console.log('\n== scheduling questions beat the second-person subject ==')
for (const q of [
  'are you free tomorrow for the meeting',
  'are you free tomorrow',
  'are you busy this afternoon',
  'are you available next tuesday',
  'are you around on friday',
]) {
  const r = resolveReferent(q)
  check(`"${q}" → not self`, r.referent !== 'self', `got self via ${r.reason}`)
}
// …but availability WITHOUT a time is still about the assistant's nature, and a self-question
// that merely mentions a day is not a scheduling question.
check('"are you open source" stays self', isAboutSelf('are you open source'))
check('"were you trained today" stays self', isAboutSelf('were you trained today'))

// ── 4b. THE SELF-MODEL ANSWERS DETERMINISTICALLY ─────────────────────────────
// MEASURED (2026-07-28, live on :3011): referent resolution correctly kept "are you made in
// china" off the web — and the FM, handed the six ranked facts, answered "Yes, I am made in
// China." False, and false by collapsing structure it was given, exactly as in cont.105b.
// Facts about Crucible are fixed; a 1.5B paraphrase of ground truth is a lossy channel.
console.log('\n== self-questions are answered from derived facts, not paraphrased ==')

const china = composeSelfAnswer('are you made in china')
check('"are you made in china" composes an answer', !!china)
// The nuance the model destroyed: the weights and the system have DIFFERENT provenance, and
// saying only one of them is what makes "yes" wrong.
check('…names who actually trained the weights', /alibaba/i.test(china?.text ?? ''))
check('…and that they were trained in China', /china/i.test(china?.text ?? ''))
check('…AND that the system itself was built independently',
  /independent project|my developer/i.test(china?.text ?? ''),
  'stating only the weights origin is what makes a bare "yes" wrong')
check('…and denies corporate operation', /no company operates me/i.test(china?.text ?? ''))
check('…is not a bare yes/no collapse', (china?.text.length ?? 0) > 200,
  'a one-line answer to a provenance question has dropped the distinction that matters')

// Derived, not typed: the claim must name the model actually resolved on disk.
check('the model fact names the real resolved GGUF',
  /qwen/i.test(composeSelfAnswer('what model are you')?.text ?? ''))

// A world question must not be answered from the self-model at all.
for (const q of ['what is the capital of france', 'who won the world cup in 1998', 'how do you make bread']) {
  check(`"${q}" → no self-answer`, composeSelfAnswer(q) === null,
    'reciting identity boilerplate at an unrelated question is not an answer')
}

// FIRST PERSON, everywhere. An earlier draft converted third-person claims with a pile of
// regexes and produced "no company operates I", "running I", "I backtracks", "how smart I is".
// Pin the property so the string-surgery approach cannot come back.
//
// The test is for UNGRAMMATICAL output — "I" in object position, or a third-person verb on a
// first-person subject — NOT for the word "it". A bare "it" is legitimate when it refers to
// something other than Crucible: the model fact says "The language model I run is qwen…​ It is
// deliberately small", where "it" is the model. An earlier version of this guard flagged exactly
// that line, which would have pushed the fix in the wrong direction.
const THIRD_PERSON = new RegExp(
  '\\b(?:' +
    // "I" in object position — only ever produced by a botched pronoun swap.
    '(?:operates|running|running\\s+of|about|for|with|to|beats)\\s+I\\b' +
    // Third-person agreement on a first-person subject.
    '|I\\s+(?:has|backtracks|runs|prefers|is)\\b' +
    // "how smart I is"
    '|\\bI\\s+is\\b' +
  ')',
  'i',
)
for (const f of selfModel()) {
  check(`fact "${f.id}" is clean first person`, !THIRD_PERSON.test(f.claim),
    `mangled pronoun in: ${f.claim.slice(0, 90)}`)
  check(`fact "${f.id}" carries provenance`, f.provenance.length > 3)
  check(`fact "${f.id}" has topics to rank on`, f.topics.length > 0)
}

// ── 5. TOTALITY ──────────────────────────────────────────────────────────────
// The resolver is called on every turn. It must never throw and never return undefined.
console.log('\n== resolver is total ==')
const NASTY = ['', '   ', '?', 'you', 'your', 'i', '你好', '```', 'a'.repeat(5000), '\n\n\n', 'hey', 'ok so']
for (const q of NASTY) {
  let ok = true
  try {
    const r = resolveReferent(q)
    ok = r != null && ['self', 'user', 'world'].includes(r.referent) && typeof r.reason === 'string'
  } catch (e: any) { ok = false }
  check(`resolves ${JSON.stringify(q.slice(0, 20))}`, ok)
}

// ── REPORT ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`)
console.log(`referent bench: ${pass}/${pass + fail} passed`)
if (failures.length) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log(`  ✗ ${f}`)
}
process.exit(fail === 0 ? 0 : 1)
