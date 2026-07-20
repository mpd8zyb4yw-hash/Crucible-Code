// Bench: implicit personal-data tool resolution (namedToolRouter).
// Fixtures include the FOUR REAL turns from the 2026-07-20 debug report in which the
// prose pipeline fabricated "your inbox is empty / calendar is empty" with zero tool
// calls. Positives must resolve to the right read-only tools with the right window;
// negatives (creation intent, generic knowledge, code asks) must NOT fire — a false
// fire here hijacks an ordinary chat turn, which is the verifier-two-directions rule.
// Run: npx tsx src/CrucibleEngine/agent/__implicitPersonal_bench.ts

import { resolveImplicitPersonalTools } from './namedToolRouter'

let pass = 0, fail = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`PASS — ${name}`) }
  else { fail++; console.log(`FAIL — ${name}${detail ? `  (${detail})` : ''}`) }
}

const tools = (msg: string) => (resolveImplicitPersonalTools(msg)?.calls ?? []).map(c => c.name)
const argOf = (msg: string, tool: string) =>
  resolveImplicitPersonalTools(msg)?.calls.find(c => c.name === tool)?.args as Record<string, unknown> | undefined

// ── The four real turns (debug report 2026-07-20) ────────────────────────────
{
  const t = tools('Summarize today\'s calendar and any inbox email from the last day that needs a reply.')
  check('real turn 1: brief-me resolves BOTH tools', t.includes('gmail_search') && t.includes('calendar_list'), t.join(','))
  const g = argOf('Summarize today\'s calendar and any inbox email from the last day that needs a reply.', 'gmail_search')
  check('real turn 1: 1-day window from "today\'s"/"last day"', String(g?.query ?? '').includes('newer_than:1d'), String(g?.query))
}
{
  const t = tools('show me the emails from the last few days')
  check('real turn 2: resolves gmail_search', t.includes('gmail_search'), t.join(',') || 'none')
  const g = argOf('show me the emails from the last few days', 'gmail_search')
  check('real turn 2: "few days" → 3d window', String(g?.query ?? '').includes('newer_than:3d'), String(g?.query))
}
{
  // Bare follow-up with no domain noun — cannot resolve without history; must abstain
  // (documented residual: history-aware follow-up routing).
  check('real turn 3: "just in general" abstains (no domain noun)', tools('just in general').length === 0)
}
{
  const t = tools('just show me my emails')
  check('real turn 4: "just show me my emails" resolves gmail_search', t.includes('gmail_search'), t.join(',') || 'none')
  const g = argOf('just show me my emails', 'gmail_search')
  check('real turn 4: bare ask defaults to 7d window', String(g?.query ?? '').includes('newer_than:7d'), String(g?.query))
}

// ── More positives ───────────────────────────────────────────────────────────
check('calendar only: "what meetings do I have this week"', tools('what meetings do I have this week').join(',') === 'calendar_list')
check('past-N-days window honored', String(argOf('any new mail in the past 2 days?', 'gmail_search')?.query).includes('newer_than:2d'))
check('unread counts as deixis', tools('list unread emails').includes('gmail_search'))
check('upcoming events resolve calendar', tools('upcoming events on my calendar').includes('calendar_list'))

// ── Negatives — must ABSTAIN ─────────────────────────────────────────────────
check('creation: "draft an email to Bob about the launch"', tools('draft an email to Bob about the launch').length === 0)
check('creation: "send my mom an email today"', tools('send my mom an email today').length === 0)
check('mutation: "delete the emails from last week"', tools('delete the emails from last week').length === 0)
check('mutation: "schedule a meeting with Ana tomorrow"', tools('schedule a meeting with Ana tomorrow').length === 0)
check('code ask: "write an email validator function"', tools('write an email validator function').length === 0)
check('generic knowledge: "how does email encryption work"', tools('how does email encryption work').length === 0)
check('generic knowledge: "what is a calendar year"', tools('what is a calendar year').length === 0)
check('no deixis: "emails can contain attachments"', tools('emails can contain attachments').length === 0)
check('build ask: "build me a calendar app"', tools('build me a calendar app').length === 0)
check('empty message abstains', tools('').length === 0)

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)
