// ============================================================================
// DAILY-DRIVER PROBE — the everyday surface, scored mechanically.
//
// The existing dogfood has 12 probes and 7 mechanical bars. That is enough to catch a
// regression on the things we already fixed and nowhere near enough to characterise "a
// broadly capable assistant a real person would use daily" (DOCTRINE §0). Seven probes cannot
// tell you what a person actually hits.
//
// So this is deliberately WIDE and deliberately boring: the questions people really ask, in
// the words they really use, each with a mechanical bar. Every probe here is a question whose
// correct answer is decidable — that is what makes the score meaningful, and it is also the
// doctrine's own bias (§5.1: formalize "correct" as a mechanical check first).
//
// It reports per-CATEGORY, because "18/24" hides the fact that a whole capability is missing
// while its neighbours carry the average.
//
// Run: LOCAL_INFERENCE_URL=http://127.0.0.1:8080 npx tsx src/CrucibleEngine/__daily_probe.ts
//      DAILY_ONLY=<category>   to run one slice
// ============================================================================
process.env.CRUCIBLE_NO_DISTILL = '1'

import { answerQuery } from './answer/answerEngine'

interface Probe {
  cat: string
  q: string
  must: RegExp[]
  mustNot?: RegExp[]
  /** Wall-clock this SHOULD take. A deterministic answer arriving in 9s is a routing defect
   *  even when the text is right — latency is a product property, not a footnote. */
  budgetMs?: number
  note?: string
}

const PROBES: Probe[] = [
  // ── Arithmetic people actually do ──────────────────────────────────────────
  { cat: 'math', q: 'What is 17 times 23?', must: [/\b391\b/], budgetMs: 200 },
  { cat: 'math', q: 'What is 15% of 240?', must: [/\b36\b/], budgetMs: 3000 },
  { cat: 'math', q: "What's a 20% tip on $84?", must: [/16\.8|16\.80/], budgetMs: 3000 },
  { cat: 'math', q: 'Split $137.50 three ways.', must: [/45\.83|45\.84/], budgetMs: 4000 },

  // ── Unit conversion ────────────────────────────────────────────────────────
  { cat: 'convert', q: 'Convert 100 km to miles.', must: [/62\.1|62\b/], budgetMs: 3000 },
  { cat: 'convert', q: 'How many cups is 500 ml?', must: [/2\.1|2\.11|2\b/], budgetMs: 4000 },
  { cat: 'convert', q: 'What is 180 degrees Fahrenheit in Celsius?', must: [/82\.2|82\b/], budgetMs: 3000 },
  { cat: 'convert', q: 'How many kilograms is 154 pounds?', must: [/69\.8|69\.9|70\b/], budgetMs: 3000 },

  // ── Date arithmetic ────────────────────────────────────────────────────────
  { cat: 'date', q: 'What is 90 days after 3 August 2026?', must: [/1 November 2026|November 1,? 2026|2026-11-01/i], budgetMs: 3000 },
  { cat: 'date', q: 'How many days are there between 1 January 2026 and 3 August 2026?', must: [/\b214\b/], budgetMs: 3000 },
  { cat: 'date', q: 'What day of the week was 4 July 1776?', must: [/Thursday/i], budgetMs: 3000 },

  // ── Schedule (deterministic solver) ────────────────────────────────────────
  { cat: 'schedule', q: 'My workday is 8am to 6pm. I have calls at 9am, 10:30am and 4pm, each 45 minutes. What is my longest free stretch?',
    must: [/11:15am/, /4 hours 45/i], budgetMs: 200 },
  { cat: 'schedule', q: 'I have meetings tomorrow at 9am, 11am and 2pm, each one hour long. Between 9am and 5pm, what is my longest free block?',
    must: [/12pm/, /3pm/, /2 hours/i], budgetMs: 200 },

  // ── Release / lifecycle (deterministic solver) ─────────────────────────────
  { cat: 'release', q: 'What is the current Long Term Support (LTS) version of Node.js?', must: [/\b24\b/, /endoflife\.date/], budgetMs: 2000 },
  { cat: 'release', q: 'Is Python 3.8 still supported?', must: [/\bNo\b/, /end of life|no longer/i], budgetMs: 2000 },
  { cat: 'release', q: 'What is the latest version of PostgreSQL?', must: [/\b18/], budgetMs: 2000 },

  // ── Factual lookup ─────────────────────────────────────────────────────────
  { cat: 'lookup', q: 'What is the capital of Australia?', must: [/Canberra/],
    mustNot: [/most populous city in each state/i], budgetMs: 9000 },
  { cat: 'lookup', q: 'What is the chemical symbol for tungsten?', must: [/\bW\b/], budgetMs: 9000 },
  { cat: 'lookup', q: 'Who wrote the novel Frankenstein?', must: [/Shelley/], budgetMs: 9000 },

  // ── Text work, the most common assistant task of all ───────────────────────
  { cat: 'text', q: 'Rewrite this as one sentence under 20 words, keeping the numbers exact: "We shipped 14 features in Q3, up from 9 in Q2, while cutting p99 latency from 840ms to 310ms."',
    must: [/\b14\b/, /\b9\b/, /840/, /310/], budgetMs: 6000 },
  { cat: 'text', q: 'Turn this into three bullet points: "The release adds offline search, fixes a crash on startup, and doubles export speed."',
    must: [/offline search/i, /crash/i, /export/i], budgetMs: 8000 },
  { cat: 'text', q: 'Write a one-line git commit message for: fixed a null pointer crash when loading an empty config file.',
    must: [/config/i], mustNot: [/^.{200,}/s], budgetMs: 8000 },

  // ── Honest refusal: the answer is "I do not know", and saying so is a PASS ──
  { cat: 'abstain', q: 'What did I have for breakfast yesterday?',
    must: [/\b(don'?t|do not|cannot|can'?t|no way|not able|unable|no record|no information)\b/i], budgetMs: 9000,
    note: 'Unknowable. Confabulating here is far worse than abstaining.' },
]

const ONLY = process.env.DAILY_ONLY ?? ''

interface Row { cat: string; q: string; ms: number; pass: boolean; slow: boolean; why: string; got: string }
const ROWS: Row[] = []

async function run(p: Probe) {
  const t0 = Date.now()
  let text = ''
  let err = ''
  try {
    const r = await answerQuery(p.q, { history: [] })
    text = r.text ?? ''
  } catch (e: any) {
    err = String(e?.message ?? e).slice(0, 120)
  }
  const ms = Date.now() - t0
  const missing = err ? [] : p.must.filter(re => !re.test(text))
  const banned = err ? [] : (p.mustNot ?? []).filter(re => re.test(text))
  const pass = !err && missing.length === 0 && banned.length === 0
  const slow = p.budgetMs !== undefined && ms > p.budgetMs
  ROWS.push({
    cat: p.cat, q: p.q, ms, pass, slow,
    why: err ? `THREW ${err}`
      : [missing.length ? `missing ${missing.map(String).join(' ')}` : '',
         banned.length ? `FORBIDDEN ${banned.map(String).join(' ')}` : ''].filter(Boolean).join('; '),
    got: text.replace(/\s+/g, ' ').slice(0, 180),
  })
  const tag = pass ? (slow ? 'SLOW' : 'PASS') : 'FAIL'
  console.log(`[${tag}] ${String(ms).padStart(6)}ms  ${p.cat.padEnd(9)} ${p.q.slice(0, 62)}`)
  if (!pass) {
    console.log(`         why: ${ROWS[ROWS.length - 1].why}`)
    console.log(`         got: ${ROWS[ROWS.length - 1].got}`)
  } else if (slow) {
    console.log(`         budget ${p.budgetMs}ms — right answer, wrong path (should be deterministic)`)
  }
}

async function main() {
  const started = Date.now()
  console.log(`DAILY-DRIVER PROBE — ${PROBES.length} everyday questions\n${'='.repeat(78)}`)
  for (const p of PROBES) {
    if (ONLY && p.cat !== ONLY) continue
    await run(p)
  }

  const cats = [...new Set(ROWS.map(r => r.cat))]
  console.log(`\n${'='.repeat(78)}\nBY CATEGORY`)
  for (const c of cats) {
    const rs = ROWS.filter(r => r.cat === c)
    const ok = rs.filter(r => r.pass).length
    const slow = rs.filter(r => r.pass && r.slow).length
    const med = rs.map(r => r.ms).sort((a, b) => a - b)[Math.floor(rs.length / 2)]
    console.log(`  ${c.padEnd(10)} ${ok}/${rs.length}${slow ? `  (${slow} over budget)` : ''}   median ${med}ms`)
  }

  const ok = ROWS.filter(r => r.pass).length
  const overBudget = ROWS.filter(r => r.pass && r.slow).length
  const all = ROWS.map(r => r.ms).sort((a, b) => a - b)
  console.log(`\nTOTAL: ${ok}/${ROWS.length} correct` +
    `   ${overBudget} correct-but-over-budget` +
    `   median ${all[Math.floor(all.length / 2)]}ms   max ${all[all.length - 1]}ms` +
    `   ${Math.round((Date.now() - started) / 1000)}s`)

  const fails = ROWS.filter(r => !r.pass)
  if (fails.length) {
    console.log('\nFAILURES')
    for (const f of fails) console.log(`  ${f.cat.padEnd(9)} ${f.q.slice(0, 70)}\n    ${f.why}`)
  }
}

main().catch(e => { console.error('PROBE THREW:', e); process.exit(1) })
