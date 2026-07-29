// Bench for goal specification (goalSpec.ts). Run:
//   npx tsx src/CrucibleEngine/agent/__goalspec_bench.ts
//
// THE LIVE REPRO (2026-07-29, user debug report). "build me a quizlet flashcard set with simple
// grammatical italian terms" was answered with "What should the flashcard set cover?" — the
// subject was stated plainly, joined by a preposition that happened not to be in the list
// (`about|on the topic of|covering|for`). The user's reply, "i already told you", was then treated
// as a brand-new goal and the run produced garbage.
//
// This is the cont.118 shape a third time: a correct gate fed by an enumeration, where the gap
// between working and broken is ONE PREPOSITION. The rule these cases enforce is that a subject
// stated in ANY grammatical form must be read, while a goal with no subject anywhere must still
// ask — because over-correcting into never asking is the same bug pointed the other way.
import { specForGoal, elicitation, briefFor } from './goalSpec'

let pass = 0, fail = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'OK ' : 'XX '} ${name}${ok ? '' : ` — ${detail}`}`)
  ok ? pass++ : fail++
}

/** A subject IS present, in varied grammatical forms — none may trigger a question. */
const STATED: Array<[string, string]> = [
  ['build me a quizlet flashcard set with simple grammatical italian terms', 'simple grammatical italian terms'],
  ['make me flashcards of italian grammar', 'italian grammar'],
  ['create a flashcard deck about the krebs cycle', 'the krebs cycle'],
  ['build me a quiz containing world war 2 dates', 'world war 2 dates'],
  ['make me 20 flash cards on spanish verbs', 'spanish verbs'],
  ['put together a study guide covering photosynthesis', 'photosynthesis'],
  ['make me flashcards to learn japanese hiragana', 'japanese hiragana'],
  ['generate a quiz that covers the periodic table', 'periodic table'],
  ['write me a summary regarding the treaty of versailles', 'the treaty of versailles'],
  ['prepare notes including mitosis and meiosis', 'mitosis and meiosis'],
]

/** No subject anywhere — asking the ONE blocking question is correct here. */
const UNSTATED = [
  'make me some flash cards',
  'build me a quiz',
  'create a flashcard set for my exam',
  'make me a study guide',
]

console.log('  — a stated subject must never be asked about —')
for (const [goal, want] of STATED) {
  const spec = specForGoal(goal)
  if (!spec) { check(JSON.stringify(goal), false, 'specForGoal returned null'); continue }
  const subject = spec.slots.find(s => s.key === 'subject')
  const ok = spec.ready === true && !!subject?.value && subject.value.toLowerCase().includes(want.toLowerCase())
  check(JSON.stringify(goal), ok, `ready=${spec.ready} subject=${JSON.stringify(subject?.value)} asked=${JSON.stringify(spec.ask.map(a => a.key))}`)
}

console.log('  — a missing subject must still be asked about, with a NON-EMPTY question —')
for (const goal of UNSTATED) {
  const spec = specForGoal(goal)
  if (!spec) { check(JSON.stringify(goal), false, 'specForGoal returned null'); continue }
  const ask = elicitation(spec)
  // The empty-answer half of the same report: an elicitation that fires must actually SAY
  // something. A blocking question rendered as 0 characters is a dead turn.
  const ok = spec.ready === false && spec.ask.some(a => a.key === 'subject') && !!ask?.question?.trim()
  check(JSON.stringify(goal), ok, `ready=${spec.ready} question=${JSON.stringify(ask?.question)}`)
}

console.log('  — a URL is a SOURCE, not a subject: read it rather than ask —')
for (const goal of [
  'make me a set of flash cards to study from https://en.wikipedia.org/wiki/Krebs_cycle',
  'write a summary of https://example.com/article',
]) {
  const spec = specForGoal(goal)
  if (!spec) { check(JSON.stringify(goal), false, 'specForGoal returned null'); continue }
  const subject = spec.slots.find(s => s.key === 'subject')
  check(JSON.stringify(goal), spec.ready === true && subject?.source === 'derived',
    `ready=${spec.ready} subject=${JSON.stringify(subject)}`)
}

// ── Destination (cont.119) ────────────────────────────────────────────────────
// "it never signed into quizlet or attempted to make the flashcards at all" — the service name
// was read as an adjective and dropped, so the run produced text in chat and called that done.
console.log('  — a named service is a DESTINATION, and the brief must say so —')
for (const [goal, host] of [
  ['build me a quizlet flashcard set with simple grammatical italian terms', 'quizlet.com'],
  // Only hosts the reused AUTH_WALLED list matches BARE become destinations. "notion page"
  // does not (the list carries `notion.so`), and "page" is excluded as an app build anyway —
  // both correct, and worth stating so the next reader does not "fix" it.
  ['put together a chegg study guide covering photosynthesis', 'chegg.com'],
] as Array<[string, string]>) {
  const spec = specForGoal(goal)
  if (!spec) { check(JSON.stringify(goal), false, 'specForGoal returned null'); continue }
  const dest = spec.slots.find(s => s.key === 'destination')
  const brief = briefFor(spec)
  check(`destination ${host} for ${JSON.stringify(goal.slice(0, 40))}`,
    dest?.value === host && dest.source === 'stated' && dest.blocking === false,
    JSON.stringify(dest))
  // Naming the destination is not enough — the brief must name the ACTION and the tools, or the
  // executor emits pseudo-code instead of a call (the same failure the URL branch already fixed).
  check(`brief directs the agent INTO ${host} and names the tools`,
    brief.includes(host) && brief.includes('web_open') && brief.includes('web_act')
      && brief.includes('browser_sign_in') && brief.includes('say plainly'),
    brief.slice(-320))
  // ORDER matters, not just presence. With "no lookup needed" and "deliver into <site>" merely
  // co-present, the model reconciled them by hunting the web for CONTENT — inventing
  // italian-grammar.com, failing on ERR_CONNECTION_REFUSED, and abandoning the task.
  check(`brief SEQUENCES write-then-deliver for ${host}`,
    brief.indexOf('Write the content first') !== -1
      && brief.indexOf('Write the content first') < brief.indexOf('deliver it'),
    brief.slice(-320))
  // ...and states that order in PROSE. Enumerated markers get read as plan steps: the planner
  // built a step literally named "WRITE IT FIRST" and tried to execute it as a tool action.
  check(`brief does not look like a numbered plan`, !/\bSTEP \d/.test(brief), brief.slice(-320))
  // A failed delivery must not be allowed to eat the content.
  check(`a failed delivery to ${host} still yields the content`,
    /does not fail the task/.test(brief) && /Never imply it was/.test(brief), brief.slice(-200))
  // Emphasis in CAPS is classification poison: "CONTENT" is 7 chars, too long for the acronym
  // skip, so it reads as a library name to the very heuristics a brief gets fed to.
  check(`brief carries no all-caps emphasis for ${host}`,
    !/\b[A-Z]{6,}\b/.test(brief), (brief.match(/\b[A-Z]{6,}\b/g) || []).join(','))
  // Never blocking: content in chat beats a refusal.
  check(`a destination never blocks the build`, spec.ready === true, `ready=${spec.ready}`)
}

// No service named -> no destination instruction cluttering the brief.
const plain = specForGoal('make me flashcards about the krebs cycle')!
check('no destination instruction when none was named',
  !briefFor(plain).includes('Deliver INTO'), briefFor(plain))

// ── The fallback must not invent a contract (cont.120) ──────────────────────
//
// LIVE REPRO: "Draft a reply to the email from Google …" resolved its deliverable to "reply",
// fell through every named branch of `defaultsFor`, and inherited the old catch-all default of
// ten titled sections. The answer — a correct four-line email — shipped under "**This does not
// match what you asked for.** You asked for 10 reply". Nobody asked for ten of anything.
//
// The rule: a deliverable we do not recognise is ONE piece of writing with no asserted count and
// no asserted length. The floor stays in place for deliverables whose kind we DO know, because
// over-correcting into never checking is the same bug pointed the other way.
console.log('  — an unrecognised deliverable gets no invented count —')
for (const goal of [
  'Draft a reply to the email from Google with subject "Security alert for fjord414@gmail.com"',
  'write a response to sarah about the meeting',
  'draft a message to my landlord about the leak',
  'write a cover letter for the analyst role',
]) {
  const spec = specForGoal(goal)
  if (!spec) { check(JSON.stringify(goal.slice(0, 44)), false, 'specForGoal returned null'); continue }
  const e = spec.expectation
  check(JSON.stringify(goal.slice(0, 44)),
    e.count === 1 && e.shape === 'prose' && e.minWords === 0,
    `count=${e.count} shape=${e.shape} minWords=${e.minWords}`)
}
// The other direction: a deliverable we DO recognise keeps its real contract.
const knownSummary = specForGoal('make me a summary of the krebs cycle')!
check('a known prose deliverable keeps its thinness floor',
  knownSummary.expectation.shape === 'prose' && (knownSummary.expectation.minWords ?? 40) === 40,
  `minWords=${knownSummary.expectation.minWords}`)
const knownDeck = specForGoal('make me flashcards about the krebs cycle')!
check('a known set deliverable keeps its count',
  knownDeck.expectation.shape === 'pair' && knownDeck.expectation.count === 20,
  `shape=${knownDeck.expectation.shape} count=${knownDeck.expectation.count}`)

console.log(`\nTOTAL: ${pass}/${pass + fail}`)
if (fail) process.exit(1)
