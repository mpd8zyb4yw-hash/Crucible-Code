// Hermetic bench for the Tier-1 conversion fast path.
//
// Two obligations, and the second is the dangerous one:
//   1. every phrasing the daily probe measured must parse to the right number, and
//   2. parseConversion must NOT intercept questions that merely look numeric, because a
//      false positive here silently steals a question from the schedule solver, the code
//      path, or retrieval and answers it with a conversion nobody asked for.
import { parseConversion } from './unitConvert'

let pass = 0, fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

// ── Must parse, and to the exact value ──────────────────────────────────────────────
const HITS: Array<[string, number]> = [
  ['Convert 100 km to miles.', 62.137119],
  ['How many cups is 500 ml?', 2.113376],
  ['What is 180 degrees Fahrenheit in Celsius?', 82.222222],
  ['How many kilograms is 154 pounds?', 69.853225],
  ['60 mph in km/h', 96.56064],
  ['convert 2.5 hours to minutes', 150],
  ['1,500 meters in feet', 4921.259843],
  ['0 celsius to fahrenheit', 32],
  ['-40 F to C', -40],
  ['how many ounces are 2 pounds', 32],
]
for (const [q, want] of HITS) {
  const got = parseConversion(q)
  check(`parses: ${q}`, !!got && Math.abs(got.result - want) < 1e-4, got ? String(got.result) : 'null')
}

// ── Must NOT parse — these belong to other lanes ────────────────────────────────────
const MISSES = [
  'I have 3 meetings today, when am I free?',
  'My workday is 8am to 6pm with a 1 hour call at 10.',
  'Convert this function to Python.',
  'Write a script to rename 200 files in a folder.',
  'I ran 5 miles in 30 minutes, what was my pace?',   // cross-family: a rate, not a conversion
  'Convert 2 cups of flour to grams.',                // volume->mass needs a density we do not have
  'What is the capital of Australia?',
  'Summarize this 400 word email in 2 sentences.',
  'How many people live in Canberra?',
  'Book 30 minutes with Dana tomorrow.',
]
for (const q of MISSES) {
  const got = parseConversion(q)
  check(`refuses: ${q}`, got === null, got ? JSON.stringify(got) : '')
}

console.log(`\nCONVERT FAST-PATH BENCH: ${pass}/${pass + fail}`)
if (fail) process.exit(1)
