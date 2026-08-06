// Bench for entity-scoped inbox retrieval — "surface all emails from/about X" (Phase 4).
// Locks the NL-relation → gmail_search query mapping: from:X, content term, from+about
// compound, time-window stripping, conservative firing (statements don't fire), and the
// bare-recency fall-through to the existing recency resolver.
//
// Run: npx tsx src/CrucibleEngine/agent/__entityMail_bench.ts

import { resolveImplicitPersonalTools } from './namedToolRouter'

let pass = 0, fail = 0
const check = (name: string, cond: boolean, got?: string) => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${got !== undefined ? `  (got: ${got})` : ''}`) }
}
const q = (msg: string): string | undefined => {
  const c = resolveImplicitPersonalTools(msg)?.calls
  const g = c?.find(x => x.name === 'gmail_search')
  return g ? String((g.args as any).query) : undefined
}

// — sender-scoped —
check('surface all emails from Dana → from:Dana', q('surface all emails from Dana') === 'from:Dana', q('surface all emails from Dana'))
check('multi-word sender is quoted', q('find all emails from Dana Rivera') === 'from:"Dana Rivera"', q('find all emails from Dana Rivera'))
check('email address sender', q('show me everything from john@acme.com') === 'from:john@acme.com', q('show me everything from john@acme.com'))

// — content-scoped —
check('emails about the Q3 forecast → phrase term', q('find all emails about the Q3 forecast') === '"Q3 forecast"', q('find all emails about the Q3 forecast'))
check('single-word topic is bare', q('surface emails regarding invoices') === 'invoices', q('surface emails regarding invoices'))

// — compound from + about —
check('from X about Y → from:X "Y"', q('show me emails from my accountant about taxes') === 'from:accountant taxes', q('show me emails from my accountant about taxes'))

// — time window stripping —
check('time tail becomes newer_than, not part of from:',
  q('find all emails from Dana in the last week') === 'from:Dana newer_than:7d', q('find all emails from Dana in the last week'))
check('yesterday → newer_than:1d, stripped from topic',
  q('surface all emails about the merger from yesterday') === '"the merger" newer_than:1d' || q('surface all emails about the merger from yesterday') === 'merger newer_than:1d',
  q('surface all emails about the merger from yesterday'))

// — conservative firing —
check('a statement does NOT fire an entity search', q('the email from Dana was rude about the deadline') === undefined, q('the email from Dana was rude about the deadline'))
check('question form fires without a frame verb', q('any emails from legal?') === 'from:legal', q('any emails from legal?'))

// — bare recency still falls through to the recency resolver (not entity) —
check('emails from last week → recency query, not from:last', q('show me my emails from last week') === 'newer_than:7d in:inbox', q('show me my emails from last week'))

// — mutation guard still wins —
check('send an email to Dana → no search (mutation)', resolveImplicitPersonalTools('send an email to Dana about lunch') === null)

console.log(`\n${pass}/${pass + fail} passed`)
if (fail) process.exit(1)
