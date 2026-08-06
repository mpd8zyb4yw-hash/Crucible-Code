// Bench for the deterministic inbox-importance verifier (importance.ts, 2026-07-20).
// Locks the threshold: bulk mail is never flagged; a direct message that is unread OR asks
// a question is flagged with the exact contributing reasons; a single weak signal is not.
//
// Run: npx tsx src/CrucibleEngine/__importance_bench.ts

import { assessImportance, isAddressedToMe, asksQuestion } from './importance'

let pass = 0, fail = 0
const check = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}`) }
}

// — assessImportance thresholds —
const direct = { unread: true, addressedToMe: true, asksQuestion: false, bulk: false }
check('direct + unread → flagged, reason lists both', (() => {
  const v = assessImportance(direct)
  return v.important && v.reasons.includes('addressed directly to you') && v.reasons.includes('unread')
})())

check('direct + question (read) → flagged', assessImportance({ unread: false, addressedToMe: true, asksQuestion: true, bulk: false }).important)

check('unread but NOT addressed to me → not flagged (weak)', !assessImportance({ unread: true, addressedToMe: false, asksQuestion: false, bulk: false }).important)

check('question but NOT addressed to me → not flagged (weak)', !assessImportance({ unread: false, addressedToMe: false, asksQuestion: true, bulk: false }).important)

check('addressed to me but read + no question → not flagged (single weak signal)', !assessImportance({ unread: false, addressedToMe: true, asksQuestion: false, bulk: false }).important)

check('bulk mail is NEVER flagged even if it looks direct + asks a question',
  !assessImportance({ unread: true, addressedToMe: true, asksQuestion: true, bulk: true }).important)

check('not-flagged verdicts carry empty reasons', assessImportance(direct).important && assessImportance({ unread: false, addressedToMe: false, asksQuestion: false, bulk: false }).reasons.length === 0)

// — signal extractors —
check('isAddressedToMe matches address case-insensitively inside a To header',
  isAddressedToMe('Justin <SK8Kronicles@Gmail.com>, other@x.io', 'sk8kronicles@gmail.com'))
check('isAddressedToMe false when only cc\'d (not in To)', !isAddressedToMe('team@list.io', 'sk8kronicles@gmail.com'))
check('isAddressedToMe false on empty me', !isAddressedToMe('anyone@x.io', ''))
check('asksQuestion true from subject', asksQuestion('Can you review this?', 'body text'))
check('asksQuestion true from snippet only', asksQuestion('Update', 'are you free tomorrow?'))
check('asksQuestion false when neither has ?', !asksQuestion('Weekly update', 'here is the summary.'))

console.log(`\n${pass}/${pass + fail} passed`)
if (fail) process.exit(1)
