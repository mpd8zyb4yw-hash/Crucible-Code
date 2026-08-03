// Hermetic bench for the deterministic date solver (no model, no clock dependence).
//
// The two measured failures are the first two cases: the model read "90 days after 3 August
// 2026" as March 22, 2027 and the Jan 1 -> Aug 3 span as 125 days. Both are decidable by
// calendar arithmetic, so both belong here rather than in a quorum.
import { solveDate, parseDateSetup } from './dateTime'

let pass = 0, fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

const HITS: Array<[string, RegExp]> = [
  ['What is 90 days after 3 August 2026?', /November 1, 2026/],
  ['How many days are there between 1 January 2026 and 3 August 2026?', /\b214 days\b/],
  ['What day of the week was 4 July 1776?', /Thursday/],
  ['What date is 45 days after March 3, 2026?', /April 17, 2026/],
  ['What is 2 weeks before December 25, 2026?', /December 11, 2026/],
  ['What is 6 months after 2026-01-31?', /July 31, 2026/],
  ['What is 1 year after 29 February 2024?', /March 1, 2025|February 28, 2025/],
  ['What day of the week is 2026-11-01?', /Sunday/],
  ['How many days are there between 2026-01-01 and 2026-01-01?', /\b0 days\b/],
  ['What date is 10 days before 5 March 2026?', /February 23, 2026/],
]
for (const [q, want] of HITS) {
  const got = solveDate(q)
  check(`solves: ${q}`, !!got && want.test(got.text), got ? got.text : 'null')
}

// Leap-year correctness, checked independently of phrasing.
check('leap day exists in 2024', !!parseDateSetup('What day of the week was 29 February 2024?'))
check('Feb 30 is refused as a literal', parseDateSetup('What day of the week was 30 February 2024?') === null)

// ── Must NOT solve: the parser has to hand these back rather than guess ─────────────
const MISSES: Array<[string, string]> = [
  ['What is 90 days from now?', 'relative anchor — needs the clock, not this lane'],
  ['How many days until Christmas?', 'relative anchor'],
  ['What is 30 days from 1 March 2026 to 5 April 2026?', 'two dates plus an offset — ambiguous'],
  ['How many months are there between 1 January 2026 and 3 August 2026?', 'month spans are not exact'],
  ['What is the capital of Australia?', 'not a date question'],
  ['Convert 100 km to miles.', 'not a date question'],
  ['I have meetings at 9am and 2pm, when am I free?', 'schedule lane'],
  ['What happened on 4 July 1776?', 'a lookup, not arithmetic'],
]
for (const [q, why] of MISSES) {
  const got = solveDate(q)
  check(`refuses (${why}): ${q}`, got === null, got ? got.text : '')
}

console.log(`\nDATE FAST-PATH BENCH: ${pass}/${pass + fail}`)
if (fail) process.exit(1)
