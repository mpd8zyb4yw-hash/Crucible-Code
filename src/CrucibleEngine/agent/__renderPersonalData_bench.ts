// Bench for renderPersonalData — the fix for the 2026-07-20 "utterly broken" report:
// a weak FM summarizing real gmail_search/calendar_list output collapsed a full inbox to
// one sender address, fabricated "your inbox is empty", and twice shipped a 0-char answer.
// The renderer formats the already-structured tool output losslessly instead.
//
// Run: npx tsx src/CrucibleEngine/agent/__renderPersonalData_bench.ts

import { renderPersonalData } from './namedToolRouter'

let pass = 0, fail = 0
const check = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}`) }
}

// Exact gmail_search output format: "[id] From: …\nDate: …\nSubject: …\nSnippet: …"
const gmail = [
  '[18f2a] From: Alice <alice@work.com>\nDate: Mon, 20 Jul 2026 09:00\nSubject: Q3 numbers\nSnippet: Here are the figures you asked for',
  '[18f2b] From: utenze.acqua@larioreti.it\nDate: Sun, 19 Jul 2026 22:00\nSubject: Fattura acqua\nSnippet: La tua bolletta è pronta',
  '[18f2c] From: Bob <bob@x.com>\nDate: Sun, 19 Jul 2026 18:00\nSubject: Lunch?\nSnippet: Free tomorrow?',
].join('\n\n---\n\n')

const cal = '• Standup\n  When: 2026-07-21T09:30:00Z\n  Location: none\n  '

// 1. All three emails survive — the exact turn-1 collapse-to-one-address bug.
const r1 = renderPersonalData([{ tool: 'gmail_search', ok: true, output: gmail }])
check('renders all 3 emails (no collapse)', !!r1 && r1.includes('Q3 numbers') && r1.includes('Fattura acqua') && r1.includes('Lunch?'))
check('never empty when mail present', !!r1 && r1.trim().length > 50)
check('drops internal [id] noise', !!r1 && !r1.includes('[18f2a]'))

// 2. Empty inbox is stated honestly, never as a 0-char answer.
const r2 = renderPersonalData([{ tool: 'gmail_search', ok: true, output: 'No emails found matching that query.' }])
check('empty inbox → honest non-empty message', !!r2 && /no emails found/i.test(r2))

// 3. Calendar renders.
const r3 = renderPersonalData([{ tool: 'calendar_list', ok: true, output: cal }])
check('calendar renders event', !!r3 && r3.includes('Standup'))

// 4. Combined calendar + email (turn-2 shape) shows BOTH — no fabricated "all empty".
const r4 = renderPersonalData([
  { tool: 'calendar_list', ok: true, output: cal },
  { tool: 'gmail_search', ok: true, output: gmail },
])
check('combined shows calendar AND email', !!r4 && r4.includes('Standup') && r4.includes('Q3 numbers'))

// 5. Errored outputs are not rendered (caller handles errors); non-personal tools → null.
check('all-errored → null', renderPersonalData([{ tool: 'gmail_search', ok: false, output: 'No Google access token' }]) === null)
check('non-personal tool → null', renderPersonalData([{ tool: 'web_search', ok: true, output: 'stuff' }]) === null)

console.log(`\n${pass}/${pass + fail} passed`)
if (fail) process.exit(1)
