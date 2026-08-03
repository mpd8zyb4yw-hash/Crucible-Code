// ============================================================================
// ASSISTANT DOGFOOD — the first honest quality measurement of the NEW scope.
//
// Every capability number in this repo before 2026-08-03 describes the abandoned
// coding bar. This harness measures what a real person actually gets when they ask
// the assistant something, on the LIVE path (answerQuery / runResearchDag — both
// confirmed reachable from server.ts by `npm run audit:reach`).
//
// It does NOT score automatically. Auto-scoring an assistant answer needs a judge,
// and a judge is just another unverified model. Instead it prints each answer in
// full with its latency and its own claimed verification state, so a human (or the
// session driving it) reads them and records a verdict. Honest measurement first,
// automation later.
//
// Run: LOCAL_INFERENCE_URL=http://127.0.0.1:8080 npx tsx src/CrucibleEngine/__assistant_dogfood.ts
//      DOGFOOD_ONLY=answer|research   to run one half
// ============================================================================
process.env.CRUCIBLE_NO_DISTILL = '1'

import { answerQuery } from './answer/answerEngine'
import { runResearchDag } from './research/researchDag'

interface Probe {
  id: string
  kind: 'answer' | 'research'
  q: string
  /** What a correct answer must contain / do. Judged by a human reading the output. */
  bar: string
  /**
   * MECHANICAL bar, when one exists. Every regex must match for an automatic pass.
   *
   * This is not auto-scoring the assistant — it is the doctrine applied to our own harness:
   * where "correct" can be formalised as a check, formalise it, and only fall back to human
   * reading where it genuinely cannot. Probes without `must` still print for hand-scoring,
   * and the summary counts them separately so a mechanical number is never quietly inflated
   * by unscored rows.
   */
  must?: RegExp[]
  /** Patterns that must NOT appear — measured failures we never want back. */
  mustNot?: RegExp[]
}

const PROBES: Probe[] = [
  // ── Things a normal person actually asks ────────────────────────────────────
  {
    id: 'meta-capability',
    kind: 'answer',
    q: 'What can you do for me?',
    bar: 'Concrete, honest list of real capabilities. Not marketing, not hallucinated features.',
  },
  {
    id: 'simple-fact',
    kind: 'answer',
    q: 'What is the capital of Australia?',
    bar: 'Canberra. Should be fast and not require a web round trip.',
  },
  {
    id: 'scheduling-reasoning',
    kind: 'answer',
    q: 'I have meetings tomorrow at 9am, 11am and 2pm, each one hour long. Between 9am and 5pm, what is my longest free block?',
    bar: 'Two hours. Either 12pm-2pm or 3pm-5pm (it is a tie). Mechanically checkable — a wrong answer here is a reasoning failure, not a knowledge gap.',
  },
  {
    id: 'multi-constraint',
    kind: 'answer',
    q: 'Rewrite this as one sentence under 20 words, keeping the numbers exact: "We shipped 14 features in Q3, up from 9 in Q2, while cutting p99 latency from 840ms to 310ms."',
    bar: 'Under 20 words, all four numbers (14, 9, 840, 310) intact. Mechanically checkable.',
    // No trailing \b: the answer writes "840ms", and \b needs a word/non-word transition —
    // between "0" and "m" there is none, so /\b840\b/ never matches. Measured: this scored the
    // probe FAIL on an answer that was completely correct. A harness bug that reads as a
    // product defect is worse than no harness, so the bar is stated the way the text is written.
    must: [/\b14\b/, /\b9\b/, /840/, /310/],
  },

  // ── Release / lifecycle: the class that had NO ground truth before 2026-08-03c ──
  {
    id: 'release-lts',
    kind: 'answer',
    q: 'What is the current Long Term Support (LTS) version of Node.js?',
    bar: 'A specific LTS line with a source. Was an abstention until the release table was wired in.',
    must: [/\b24\b/, /endoflife\.date/],
    mustNot: [/\b26\b.*\bis the current.*LTS/i],
  },
  {
    id: 'release-supported',
    kind: 'answer',
    q: 'Is Node 18 still supported?',
    bar: 'No — Node 18 went EOL 2025-04-30. Must not hedge or guess.',
    must: [/\bNo\b/, /end of life|no longer/i],
  },
  {
    id: 'release-eol',
    kind: 'answer',
    q: 'When does Ubuntu 22.04 reach end of life?',
    bar: 'A specific date from the published lifecycle table, with the source.',
    must: [/20\d\d/, /endoflife\.date/],
  },

  // ── Arithmetic and units: deterministic, must never spend a model call ──────
  {
    id: 'arithmetic',
    kind: 'answer',
    q: 'What is 17 times 23?',
    bar: '391, computed exactly. Should be near-instant.',
    must: [/\b391\b/],
  },
  {
    id: 'schedule-tie',
    kind: 'answer',
    q: 'My workday is 8am to 6pm. I have calls at 9am, 10:30am and 4pm, each 45 minutes. What is my longest free stretch?',
    bar: 'Longest gap is 11:15am-4pm (4h45m). Mechanically checkable interval arithmetic.',
    must: [/11:15am/, /4pm/, /4 hours 45|4h45|4 hours and 45/i],
  },

  // ── Grounded lookup where a superlative can be fabricated ──────────────────
  {
    id: 'superlative-trap',
    kind: 'answer',
    q: 'What is the capital of Australia?',
    bar: 'Canberra. Must NOT claim Canberra is the most populous city in each state — the measured 2026-08-03 hallucination.',
    must: [/Canberra/],
    mustNot: [/most populous city in each state/i],
  },
  // ── The spine, end to end ───────────────────────────────────────────────────
  {
    id: 'research-comparative',
    kind: 'research',
    q: 'What are the main differences between HTTP/2 and HTTP/3, and what problem does HTTP/3 solve that HTTP/2 does not?',
    bar: 'Should name QUIC/UDP, head-of-line blocking at the transport layer, and connection migration. Stable, verifiable technical content with sources.',
  },
  {
    id: 'research-current',
    kind: 'research',
    q: 'What is the current Long Term Support (LTS) version of Node.js?',
    bar: 'A specific version number with a source. This is the class of question where a stale parametric answer is WRONG and retrieval must win.',
  },
]

const ONLY = process.env.DOGFOOD_ONLY ?? ''
const started = Date.now()

function hr(s: string) { console.log(`\n${'='.repeat(78)}\n${s}\n${'='.repeat(78)}`) }

interface Row { id: string; ms: number; verified: boolean; scored: boolean; pass: boolean; why: string }
const ROWS: Row[] = []

/**
 * Apply the mechanical bar. Returns `scored: false` when the probe has no `must` — those rows
 * still print for hand-scoring but never count toward the automatic number in either
 * direction. Silently scoring an unscoreable probe as a pass is how a harness starts lying.
 */
function score(p: Probe, text: string): { scored: boolean; pass: boolean; why: string } {
  if (!p.must && !p.mustNot) return { scored: false, pass: false, why: 'hand-scored' }
  const missing = (p.must ?? []).filter(re => !re.test(text))
  const banned = (p.mustNot ?? []).filter(re => re.test(text))
  if (missing.length === 0 && banned.length === 0) return { scored: true, pass: true, why: '' }
  return {
    scored: true, pass: false,
    why: [
      missing.length ? `missing ${missing.map(String).join(' ')}` : '',
      banned.length ? `FORBIDDEN ${banned.map(String).join(' ')}` : '',
    ].filter(Boolean).join('; '),
  }
}

async function runAnswer(p: Probe) {
  const t0 = Date.now()
  try {
    const r = await answerQuery(p.q, { history: [] })
    const ms = Date.now() - t0
    const s = score(p, r.text)
    ROWS.push({ id: p.id, ms, verified: r.verified, ...s })
    const tag = s.scored ? (s.pass ? 'PASS' : 'FAIL') : 'hand'
    console.log(`\n--- ANSWER [${p.id}] ${tag} ${ms}ms  verified=${r.verified} abstained=${r.abstained} retrieval=${r.usedRetrieval} sources=${r.sources?.length ?? 0}`)
    console.log(`Q: ${p.q}`)
    console.log(`BAR: ${p.bar}`)
    if (s.scored && !s.pass) console.log(`WHY: ${s.why}`)
    console.log(`--- output ---\n${r.text}`)
  } catch (e: any) {
    ROWS.push({ id: p.id, ms: Date.now() - t0, verified: false, scored: true, pass: false, why: 'threw' })
    console.log(`\n--- ANSWER [${p.id}] THREW after ${Date.now() - t0}ms: ${String(e?.message ?? e).slice(0, 300)}`)
  }
}

async function runResearch(p: Probe) {
  const t0 = Date.now()
  let final = ''
  let steps = 0
  const phases: string[] = []
  try {
    for await (const ev of runResearchDag(p.q, { maxLeafNodes: 4, maxWebPages: 8, maxMs: 120_000 })) {
      if (ev.type === 'research_step') {
        steps++
        if (ev.phase && !phases.includes(ev.phase)) phases.push(ev.phase)
      }
      if (ev.type === 'research_done') final = ev.text ?? ''
      if (ev.type === 'research_error') final = `ERROR: ${ev.detail}`
    }
    const ms = Date.now() - t0
    const s = score(p, final)
    ROWS.push({ id: p.id, ms, verified: false, ...s })
    console.log(`\n--- RESEARCH [${p.id}] ${s.scored ? (s.pass ? 'PASS' : 'FAIL') : 'hand'} ${ms}ms  steps=${steps}  phases=${phases.join('->') || 'none'}`)
    console.log(`Q: ${p.q}`)
    console.log(`BAR: ${p.bar}`)
    if (s.scored && !s.pass) console.log(`WHY: ${s.why}`)
    console.log(`--- output ---\n${final || '(empty)'}`)
  } catch (e: any) {
    console.log(`\n--- RESEARCH [${p.id}] THREW after ${Date.now() - t0}ms: ${String(e?.message ?? e).slice(0, 400)}`)
  }
}

async function main() {
  hr('ASSISTANT DOGFOOD — live path, new scope. Read every answer; score by hand.')
  for (const p of PROBES) {
    if (ONLY && p.kind !== ONLY) continue
    if (p.kind === 'answer') await runAnswer(p)
    else await runResearch(p)
  }
  const scored = ROWS.filter(r => r.scored)
  const passed = scored.filter(r => r.pass)
  hr(`DONE in ${Math.round((Date.now() - started) / 1000)}s`)
  console.log(`\nMECHANICAL SCORE: ${passed.length}/${scored.length}` +
    `   (${ROWS.length - scored.length} further probe(s) printed for hand-scoring)`)
  console.log('\n id                    result     ms   verified')
  for (const r of ROWS) {
    console.log(`  ${r.id.padEnd(20)} ${(r.scored ? (r.pass ? 'PASS' : 'FAIL') : 'hand').padEnd(8)} ${String(r.ms).padStart(6)}   ${r.verified}`)
    if (r.scored && !r.pass) console.log(`    ^ ${r.why}`)
  }
  // Latency is a product property, not a footnote — a right answer nobody waits for is not a
  // right answer. Median rather than mean so one 30s research probe doesn't hide the rest.
  const sortedMs = ROWS.map(r => r.ms).sort((a, b) => a - b)
  if (sortedMs.length) {
    console.log(`\nlatency: median ${sortedMs[Math.floor(sortedMs.length / 2)]}ms, max ${sortedMs[sortedMs.length - 1]}ms`)
  }
}

main().catch(e => { console.error('HARNESS THREW:', e); process.exit(1) })
