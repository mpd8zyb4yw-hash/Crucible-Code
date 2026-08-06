// Role-bleed critic — two-direction bench (cont.85 rule: a verifier must be fed the KNOWN-GOOD
// artifact and asked to PASS it, not only the broken one and asked to fail it. A false reject here
// is worse than a miss: 'rolebleed' is fatal-if-unrepaired, so a false positive abstains on a
// perfectly good answer).
import { looksRoleBled } from './verify'

// MUST FLAG — replies written in the user's voice. The first three are verbatim live drafts from
// the 2026-07-19 4/4 repro (history ending in our own clarify + the fragment "something totally unique").
const BLED = [
  "I'd like to build a game that combines elements of puzzle-solving and strategy, with a unique twist that challenges players in unexpected ways.",
  "I'd like to create a game that combines elements of puzzle-solving, strategy, and a touch of adventure. It could involve navigating through a series of interconnected levels.",
  "I'd like to create a unique puzzle game that combines elements of logic, strategy, and creativity.",
  'I want a web app that tracks my expenses and shows a monthly chart.',
  "I'm looking for a tool that converts markdown to PDF.",
  'I need an app that reminds me to take breaks.',
  'Could you build me a small arcade game in the browser?',
  'Please create a script that renames all the files in a folder.',
  'My idea is a game where the rules change every level.',
  'And I would like to make a dashboard showing live metrics.',
  // Live miss, 2026-07-19: shipped from a repair round on the cont.97d history. The desire's object
  // is "you", so neither the direct-creation nor the article-artifact branch caught it originally.
  "I'd like you to create a unique puzzle game that combines elements of logic, strategy, and creativity.",
  'I want you to build a small arcade game in the browser.',
]

// MUST PASS — legitimate assistant replies. Several deliberately contain "I'd like to …" in its
// meta/dialogue-act sense, or quote the user's request later in the body.
const CLEAN = [
  "I'll build a puzzle game where the rules shift each level. Starting with the board and the input loop now.",
  "Here's a browser game that combines puzzle-solving and strategy. Run it by opening index.html.",
  "I'd like to clarify one thing before I build: should it run in the browser or the terminal?",
  "I'd like to confirm the scope — a single-player game, or two players on one keyboard?",
  "I'd like to know whether you want scores saved between sessions.",
  "I'd like to suggest a simpler approach: start with one level, then add the twist.",
  "I'd like to point out that a dynamic ruleset will make the difficulty hard to tune.",
  'I need a bit more detail before I can build this — what should it do?',
  'You said you would like a game that combines puzzle-solving and strategy, so I built exactly that.',
  'To make this work I need to create a game loop that redraws every frame.',
  'I can build that. Do you want it in the browser or the terminal?',
  'The answer is 42, computed by evaluating the expression directly.',
  "I'd love to help — tell me what the app should do and I'll write it.",
]

let fail = 0
for (const t of BLED) {
  if (!looksRoleBled(t)) { console.log(`MISS (should flag): ${t.slice(0, 80)}`); fail++ }
}
for (const t of CLEAN) {
  if (looksRoleBled(t)) { console.log(`FALSE REJECT (should pass): ${t.slice(0, 80)}`); fail++ }
}
const total = BLED.length + CLEAN.length
console.log(`rolebleed bench: ${total - fail}/${total} (${BLED.length} bled, ${CLEAN.length} clean)`)
if (fail) process.exit(1)
