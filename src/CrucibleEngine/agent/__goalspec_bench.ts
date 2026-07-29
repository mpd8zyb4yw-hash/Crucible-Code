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
import { specForGoal, elicitation } from './goalSpec'

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

console.log(`\nTOTAL: ${pass}/${pass + fail}`)
if (fail) process.exit(1)
