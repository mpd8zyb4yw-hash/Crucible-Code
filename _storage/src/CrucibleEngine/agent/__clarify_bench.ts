// Bench for clarification continuity (pendingClarify.ts + goalSpec). Run:
//   npx tsx src/CrucibleEngine/agent/__clarify_bench.ts
//
// THE LIVE FAILURE (2026-07-29). We asked "What should the flashcard set cover?", the user
// answered "i already told you", and the debug event for that turn reads {"goal":"i already told
// you"} — the flashcard request had ceased to exist. Everything after it (a Wikipedia fetch for
// the capitals of France, cards titled "Question: i already told you") is a model doing its best
// with a goal that is literally those four words.
//
// Asking a question is not a stateless act. Two things must hold:
//   1. the reply is folded back into the goal it answers, never treated as a new goal;
//   2. the result is still a GOAL the spec parser can read — an answered question that leaves the
//      request unbuildable is the same dead end with extra steps.
import { mergeClarificationReply } from './pendingClarify'
import { specForGoal } from './goalSpec'

let pass = 0, fail = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'OK ' : 'XX '} ${name}${ok ? '' : ` — ${detail}`}`)
  ok ? pass++ : fail++
}

const GOAL = 'make me some flash cards'

// The question we asked was about `subject`, so the reply IS the subject.
console.log('  — an answer closes the loop and the goal becomes buildable —')
for (const [reply, want] of [
  ['italian grammar', 'italian grammar'],
  ['the krebs cycle', 'the krebs cycle'],
  ['about spanish verbs', 'spanish verbs'],
  ["it's photosynthesis", 'photosynthesis'],
] as Array<[string, string]>) {
  const merged = mergeClarificationReply(GOAL, reply, ['subject'])
  const spec = specForGoal(merged)
  const subject = spec?.slots.find(s => s.key === 'subject')
  check(`${JSON.stringify(reply)} -> buildable`,
    spec?.ready === true && !!subject?.value && subject.value.toLowerCase().includes(want),
    `merged=${JSON.stringify(merged)} ready=${spec?.ready} subject=${JSON.stringify(subject?.value)}`)
}

console.log('  — a protest adds nothing and must not become the subject —')
for (const reply of ['i already told you', 'I already said', 'told you', 'as i said']) {
  const merged = mergeClarificationReply(GOAL, reply, ['subject'])
  check(`${JSON.stringify(reply)} leaves the goal untouched`, merged === GOAL, JSON.stringify(merged))
}

// The original request must survive regardless — this is the whole point.
console.log('  — the original request always survives —')
for (const reply of ['italian grammar', 'i already told you', '']) {
  const merged = mergeClarificationReply(GOAL, reply, ['subject'])
  check(`${JSON.stringify(reply)} keeps the original request`, merged.startsWith(GOAL), JSON.stringify(merged))
}

// A goal that already states a subject must not have a second one grafted on.
const alreadyAbout = mergeClarificationReply('make me flash cards about the krebs cycle', 'make it harder', ['subject'])
check('a goal that already names a subject is not given another',
  !/about the krebs cycle about/.test(alreadyAbout), JSON.stringify(alreadyAbout))

console.log(`\nTOTAL: ${pass}/${pass + fail}`)
if (fail) process.exit(1)
