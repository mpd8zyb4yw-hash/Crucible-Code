// Bench for namesExternalLibrary (retrievalLayer.ts). Run:
//   npx tsx src/CrucibleEngine/retrieval/__libdetect_bench.ts
//
// THE LIVE FAILURE (cont.119). "build me a quizlet flashcard set with simple grammatical italian
// terms" was answered with TypeScript declarations for the `abstract-level` npm package.
//
// The request itself is clean. What tripped the detector was the BRIEF built from it:
//
//     Build: quizlet flashcard set.
//     Subject: simple grammatical italian terms.
//     ...
//     Fill in every remaining detail yourself. Do not ask the user for anything else.
//
// Rule 4 skips "sentence-initial" capitals, but only checked token index 0 of the whole string.
// That holds for a one-line question and collapses on everything else: in multi-line or
// multi-sentence text EVERY sentence begins with a capital by grammar, so "Subject", "Format",
// "Level" and "Do" all read as library names. Fixed by iterating per line and skipping any token
// whose predecessor ended a sentence.
//
// Both directions are asserted, per crucible-verifier-two-failure-directions: releasing prose
// must not cost the real library detections the function exists for.
import { namesExternalLibrary } from './retrievalLayer'
import { specForGoal, briefFor, contentBriefFor } from '../agent/goalSpec'

let pass = 0, fail = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'OK ' : 'XX '} ${name}${ok ? '' : ` — ${detail}`}`)
  ok ? pass++ : fail++
}

/** Prose, briefs and multi-sentence instructions are not library asks. */
const NOT_LIBRARY = [
  'build me a quizlet flashcard set with simple grammatical italian terms',
  'Summarise this article. Do not include opinions.',
  'Write a haiku about otters. Keep it short.',
  'Build: quiz.\nSubject: italian grammar.\nDo not ask the user for anything else.',
  'Make me 20 flash cards. Keep them simple. Do not ask me anything.',
]

/** Real library asks must still be detected. */
const IS_LIBRARY = [
  'how do I use Zod to validate input',
  'show me an example with React hooks',
  'parse a csv with Pandas',
  'which npm package should I use for dates',
  "import { z } from 'zod'",
  'I want to use Express. Show me a route.',
]

console.log('  — prose and briefs are not library asks —')
for (const q of NOT_LIBRARY) check(JSON.stringify(q.slice(0, 52)), namesExternalLibrary(q) === false)

console.log('  — real library asks still detected —')
for (const q of IS_LIBRARY) check(JSON.stringify(q.slice(0, 52)), namesExternalLibrary(q) === true)

// ── The generated BRIEF must never look like a library ask ────────────────────
// The brief is written by us and then fed to heuristics designed for USER QUESTIONS, so every
// word put in it becomes classification signal. Both regressions here were self-inflicted: the
// labelled `Level:`/`Format:` block, and later an all-caps `CONTENT` used for emphasis (7 chars —
// too long for the acronym skip, so it read as a package name).
console.log('  — generated briefs are not library asks —')
for (const goal of [
  'build me a quizlet flashcard set with simple grammatical italian terms',
  'make me 20 flash cards on spanish verbs',
  'put together a chegg study guide covering photosynthesis',
]) {
  const spec = specForGoal(goal)
  if (!spec?.ready) { check(`spec for ${JSON.stringify(goal.slice(0, 40))}`, false, 'not ready'); continue }
  check(`briefFor ${JSON.stringify(goal.slice(0, 40))}`, namesExternalLibrary(briefFor(spec)) === false, briefFor(spec).slice(0, 200))
  check(`contentBriefFor ${JSON.stringify(goal.slice(0, 40))}`, namesExternalLibrary(contentBriefFor(spec)) === false, contentBriefFor(spec).slice(0, 200))
}

// ── Known, PRE-EXISTING limitation, deliberately reported rather than asserted ──
// Any capitalized proper noun mid-sentence reads as a library ("...capital of France"). That is
// the same open-class-enumeration weakness as the rest of this session's findings and predates
// the fix above. It is latent rather than live because answerEngine.ts:674 gates the call behind
// `isGenRequest || isCodingQuery`, both false for a geography question — but groundedAnswer.ts:441
// does NOT gate it, so this is a real lead, not a curiosity. Printed every run so it cannot be
// quietly forgotten; not counted, because failing the suite on a known-open issue trains people
// to ignore red.
const KNOWN_OPEN = ['what is the capital of France', 'who is the president of Brazil']
console.log('  — KNOWN OPEN (not asserted): proper nouns still read as libraries —')
for (const q of KNOWN_OPEN) {
  console.log(`  ..  ${JSON.stringify(q)} -> ${namesExternalLibrary(q)}${namesExternalLibrary(q) ? '  (false positive)' : ''}`)
}

console.log(`\nTOTAL: ${pass}/${pass + fail}`)
if (fail) process.exit(1)
