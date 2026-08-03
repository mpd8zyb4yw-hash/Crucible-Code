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

async function runAnswer(p: Probe) {
  const t0 = Date.now()
  try {
    const r = await answerQuery(p.q, { history: [] })
    const ms = Date.now() - t0
    console.log(`\n--- ANSWER [${p.id}] ${ms}ms  verified=${r.verified} abstained=${r.abstained} retrieval=${r.usedRetrieval} sources=${r.sources?.length ?? 0}`)
    console.log(`Q: ${p.q}`)
    console.log(`BAR: ${p.bar}`)
    console.log(`--- output ---\n${r.text}`)
  } catch (e: any) {
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
    console.log(`\n--- RESEARCH [${p.id}] ${ms}ms  steps=${steps}  phases=${phases.join('->') || 'none'}`)
    console.log(`Q: ${p.q}`)
    console.log(`BAR: ${p.bar}`)
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
  hr(`DONE in ${Math.round((Date.now() - started) / 1000)}s`)
}

main().catch(e => { console.error('HARNESS THREW:', e); process.exit(1) })
