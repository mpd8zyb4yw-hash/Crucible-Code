// Bench for the UI half of the one-sentence automation flow.
//
// SCOPE. Schedule parsing is NOT tested here — it lives in
// CrucibleEngine/automations/parseTrigger.ts and is covered by __schedule_bench.ts (70/70),
// including the two regressions this UI work surfaced (a part-of-day word beats the
// bare-hour PM guess; a quantity in the task is not a clock time). Duplicating those cases
// here would let the two suites disagree about what is correct. What this file covers is
// what the UI module actually owns: the derived title, the delivery cue, and rendering a
// Trigger back into the words shown on the confirmation chip.

import { parseAutomation, deriveName, parseDelivery, describeTrigger, type Trigger } from './automationParse'

let pass = 0, fail = 0
function check(label: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

console.log('\n== derived names ==')
const names: Array<[string, string]> = [
  ['summarise my inbox every morning', 'Inbox'],
  ['check my calendar every evening', 'Calendar'],
  ['review my open PRs every Monday', 'Open PRs'],
  ['keep an eye on the build every 30 minutes', 'Build'],
  ['notify me about new invoices daily', 'New invoices'],
]
for (const [sentence, expected] of names) {
  const got = deriveName(sentence)
  check(`"${sentence}" → "${expected}"`, got === expected, `got "${got}"`)
}
// A title is shown in the roster and posted to the API, which rejects an empty name —
// so it must be impossible to derive one, whatever the sentence.
check('never empty (schedule words only)', deriveName('every morning').length > 0, deriveName('every morning'))
check('never empty (blank)', deriveName('').length > 0)
check('never empty (punctuation only)', deriveName('...!?').length > 0, deriveName('...!?'))
check('capped at the API\'s 80 chars', deriveName('alpha '.repeat(60)).length <= 80)

console.log('\n== delivery ==')
check('plain sentence → digest', parseDelivery('summarise my inbox every morning').delivery === 'digest')
check('"notify me" → push', parseDelivery('notify me when a PR lands').delivery === 'push')
check('"alert me" → push', parseDelivery('alert me if the build breaks').delivery === 'push')
check('digest is not marked explicit', parseDelivery('summarise my inbox').explicit === false)
check('push IS marked explicit', parseDelivery('ping me hourly').explicit === true)

console.log('\n== chip wording (every Trigger kind renders) ==')
const triggers: Array<[Trigger, string]> = [
  [{ kind: 'daily', time: '08:00' }, 'every day at 8:00 AM'],
  [{ kind: 'weekly', day: 1, time: '09:00' }, 'every Monday at 9:00 AM'],
  [{ kind: 'weekdays', time: '07:30' }, 'every weekday at 7:30 AM'],
  [{ kind: 'interval', minutes: 30 }, 'every 30 min'],
  [{ kind: 'interval', minutes: 120 }, 'every 2 hours'],
  [{ kind: 'interval', minutes: 60 }, 'every 1 hour'],
]
for (const [t, expected] of triggers) {
  check(`${JSON.stringify(t)} → "${expected}"`, describeTrigger(t) === expected, describeTrigger(t))
}
// 'weekdays' exists on disk already; a missing case would render an empty chip.
check('no Trigger kind renders blank', triggers.every(([t]) => (describeTrigger(t) ?? '').length > 0))

console.log('\n== end to end: the fields actually posted to the API ==')
const p = parseAutomation('summarise my inbox every morning at 7')
check('brief is the user\'s own words, untouched', p.brief === 'summarise my inbox every morning at 7', p.brief)
check('schedule delegated correctly (07:00, not 19:00)', describeTrigger(p.trigger) === 'every day at 7:00 AM', describeTrigger(p.trigger))
check('name derived', p.name === 'Inbox', p.name)
check('schedule marked explicit', p.scheduleExplicit === true)

const q = parseAutomation('keep an eye on my open pull requests')
check('no schedule → marked as assumed', q.scheduleExplicit === false)
check('no schedule → still usable default', describeTrigger(q.trigger) === 'every day at 9:00 AM', describeTrigger(q.trigger))

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
