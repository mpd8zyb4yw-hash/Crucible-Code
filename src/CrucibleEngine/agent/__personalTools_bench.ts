// Bench for resolveImplicitPersonalTools — the fix for the 2026-07-20 fabrication class
// (personal-data asks fell through to the prose pipeline, which invented "your inbox is
// empty" with zero tool calls). POSITIVES must resolve to the right read-only tools;
// NEGATIVES must return null so ordinary prose/code asks never trigger a Google call.

import { resolveImplicitPersonalTools } from './namedToolRouter'

let pass = 0, fail = 0
const ok = (cond: boolean, label: string) => { if (cond) { pass++ } else { fail++; console.log('FAIL —', label) } }

function tools(msg: string): string[] | null {
  const r = resolveImplicitPersonalTools(msg)
  return r ? r.calls.map(c => c.name) : null
}
function gmailQuery(msg: string): string | undefined {
  const r = resolveImplicitPersonalTools(msg)
  const c = r?.calls.find(x => x.name === 'gmail_search')
  return c ? String((c.args as any).query) : undefined
}
function calDays(msg: string): number | undefined {
  const r = resolveImplicitPersonalTools(msg)
  const c = r?.calls.find(x => x.name === 'calendar_list')
  return c ? Number((c.args as any).days) : undefined
}

// ── The four turns from the live debug report — every one MUST now fetch real data ──
ok(JSON.stringify(tools("Summarize today's calendar and any inbox email from the last day that needs a reply.")) === JSON.stringify(['gmail_search', 'calendar_list']),
  'report#1: calendar + email both resolve')
ok(JSON.stringify(tools('show me the emails from the last few days')) === JSON.stringify(['gmail_search']),
  'report#2: emails last few days → gmail only')
ok(JSON.stringify(tools('just show me my emails')) === JSON.stringify(['gmail_search']),
  'report#4: my emails → gmail')

// ── Positives — other natural phrasings ──
ok(tools('what does my schedule look like today')?.includes('calendar_list') ?? false, 'my schedule today → calendar')
ok(tools('any new email in my inbox') ?? false ? true : false, 'new email in my inbox → fires')
ok(tools("what's on my calendar this week")?.includes('calendar_list') ?? false, 'my calendar this week → calendar')
ok(tools('do I have any unread mail') !== null, 'unread mail → fires')
ok(tools('summarize my meetings and emails for today')?.length === 2, 'meetings + emails today → both')

// ── Day-window mapping is deterministic and honest ──
ok(gmailQuery('show me my emails from the last 3 days') === 'newer_than:3d in:inbox', 'last 3 days → 3d')
ok(gmailQuery('my emails from the last few days') === 'newer_than:3d in:inbox', 'last few days → 3d')
ok(gmailQuery('my inbox from the last day') === 'newer_than:1d in:inbox', "today's/last-day → 1d")
ok(gmailQuery('just show me my emails') === 'newer_than:7d in:inbox', 'no window stated → 7d default')
ok(calDays("today's calendar for me") === 1, "today's calendar → 1 day")

// ── NEGATIVES — must NOT fire (return null) ──
ok(tools('write an email validator function in typescript') === null, 'code ask: email validator → no fire')
ok(tools('how do calendars handle timezones') === null, 'general knowledge: calendars → no fire')
ok(tools('send an email to my boss about the delay') === null, 'mutation: send email → no fire')
ok(tools('draft a reply to the last email') === null, 'mutation: draft reply → no fire')
ok(tools('schedule a meeting for tomorrow') === null, 'mutation: schedule meeting → no fire')
ok(tools('explain how gmail search operators work') === null, 'docs ask: gmail operators → no fire')
ok(tools('just in general') === null, 'contentless follow-up → no fire (no domain noun)')
ok(tools('what is the capital of France') === null, 'off-topic → no fire')
ok(tools('add a calendar feature to my app') === null, 'mutation+build: add calendar feature → no fire')

console.log(`\n${pass}/${pass + fail} passed`)
if (fail) process.exit(1)
