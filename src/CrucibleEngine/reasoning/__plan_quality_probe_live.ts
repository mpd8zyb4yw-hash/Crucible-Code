// ═══════════════════════════════════════════════════════════════════════════════
// LIVE PLAN-QUALITY PROBE — what does the FM planner actually PROPOSE for a stuck rung?
// Run:  npx tsx src/CrucibleEngine/reasoning/__plan_quality_probe_live.ts   (live head :8080)
//   PQ_GOAL=splitCsvLine   which goal to sample plans for (see GOALS below).
//   PQ_SAMPLES=8           how many plans to draw (default 8).
// ═══════════════════════════════════════════════════════════════════════════════
//
// WHY THIS EXISTS. 2026-08-02 established two facts that only matter together:
//   • `splitCsvLine` cannot be filled by the head — 290 model calls across 12 attempts at a
//     correct hand-written carve, 0 certifications;
//   • the SAME rung certifies in 12 calls when carved one level finer into `splitCsvRaw`
//     (quote-aware split, no unescaping) + `unquoteCsvField` (unescape one field, no splitting).
// `solve.ts` already re-decomposes a stuck rung (helper recursion) — so the whole question is
// whether the FM planner, asked to carve THAT rung, proposes something with the same shape. If it
// does, recursion is one prompt away from converting the hard set; if it never does, the finer
// carve is a fact about humans and the fix has to put the concern-separation somewhere mechanical.
//
// This costs ONE model call per sample and grinds nothing, which is the point: the expensive probes
// answered "can the head fill this rung" and this cheap one answers "can the head ask for the right
// rung" — a question that was previously entangled with 300 seconds of grinding per data point.
//
// WHAT IS SCORED, and why each is mechanical rather than a judgement call. Every check below is
// either an EXISTING production gate (imported, not reimplemented — a probe that scores plans with
// its own private copy of the rules measures the copy) or a structural property of the plan text:
//   • rebake / degenerate / non-composing — the three gates `solve.ts` applies to a real plan.
//   • SEPARATION — do two distinct helpers exist such that one's goal talks about splitting and the
//     other's about quotes/escaping, without either doing both? That is the property the working
//     carve has and the failing one lacks, stated as a keyword test over the planner's own words.
//     It is a HEURISTIC and is reported as one; the plans are printed in full underneath so the
//     reader can overrule it.

import { fmComplete, headModelName } from '../agent/fmReact'
import { makeFmSubFunctionPlanner } from './fmPlanner'
import { isDegenerateSubFnCarve, isRebakedHelper, isNonComposingCarve } from './solve'
import type { CodeAcceptance } from './codeVerifier'

interface PlanGoal {
  entry: string
  goal: string
  cases: CodeAcceptance['cases']
  /** Words that mark the STRUCTURE concern in a helper goal (splitting the line into fields). */
  structure: RegExp
  /** Words that mark the ESCAPING concern (quotes, unescaping a field). */
  escaping: RegExp
}

const GOALS: PlanGoal[] = [
  {
    // Byte-identical to the hand-carve probe's rung, so the two probes are talking about the same
    // problem. If this text drifts, the plans sampled here stop being evidence about that result.
    entry: 'splitCsvLine',
    goal:
      'Write splitCsvLine(line: string): string[] splitting one line of CSV into its fields. ' +
      'Fields are separated by commas. A field may be wrapped in double quotes, in which case ' +
      'commas inside it are literal text and a doubled double-quote ("") is one literal ' +
      'double-quote character; the wrapping quotes are not part of the returned value. A field ' +
      'that is not quoted is returned as-is. The line contains no newline.',
    cases: [
      { args: ['a,b'], expected: ['a', 'b'] },
      { args: ['a'], expected: ['a'] },
      { args: ['a,,b'], expected: ['a', '', 'b'] },
      { args: ['"x,y",z'], expected: ['x,y', 'z'] },
      { args: ['"he said ""hi""",z'], expected: ['he said "hi"', 'z'] },
    ],
    structure: /split|separat|comma|field|token|part/i,
    escaping: /quote|escap|unescap|strip|doubl/i,
  },
]

async function preflightHead(): Promise<void> {
  const name = headModelName()
  console.log(`# head: ${name}`)
  if (/apple/i.test(name)) { console.error(`ABORT: head is '${name}' (TRAP 2)`); process.exit(1) }
  const t0 = Date.now()
  const text = await fmComplete([{ role: 'user', content: 'Write a JS function add(a,b) that returns a+b. Code only.' }], { maxTokens: 64 })
  if (!text.trim()) { console.error(`ABORT: head returned an EMPTY completion (${Date.now() - t0}ms) — TRAP 5`); process.exit(1) }
  console.log(`# head preflight ok (${text.trim().length} chars in ${Date.now() - t0}ms)\n`)
}

async function main(): Promise<void> {
  await preflightHead()
  const which = process.env.PQ_GOAL ?? 'splitCsvLine'
  const g = GOALS.find(x => x.entry === which)
  if (!g) { console.error(`no plan goal named ${which}`); process.exit(1) }
  const samples = Math.max(1, Number(process.env.PQ_SAMPLES || 8))

  console.log(`# PLAN-QUALITY PROBE — ${g.entry}, ${samples} plan sample(s), 1 model call each\n`)
  // `template: false` — this rung matches no template and the point is what the PLANNER invents.
  const planner = makeFmSubFunctionPlanner({ template: false })

  let declined = 0, rebaked = 0, degenerate = 0, nonComposing = 0, separated = 0, usable = 0
  for (let i = 0; i < samples; i++) {
    const plan = await planner(g.goal, g.entry, g.cases.map(c => ({ args: c.args, expected: c.expected })))
    if (!plan || !plan.length) { declined++; console.log(`── sample ${i + 1}: DECLINED (no checkable helpers)\n`); continue }

    console.log(`── sample ${i + 1}: ${plan.length} helper(s)`)
    for (const h of plan) console.log(`     ${h.name.padEnd(24)} ${h.goal.slice(0, 120)}`)

    // The production gates, imported rather than re-implemented.
    const isRebake = plan.some(h => isRebakedHelper(h.cases as never, g.cases as never))
    const kept = plan.filter(h => !isRebakedHelper(h.cases as never, g.cases as never))
    const isDegen = isDegenerateSubFnCarve(false, kept.length, false)
    const isNonComp = isNonComposingCarve(false, kept as never, g.cases, false)

    // The property the WORKING carve has: two different helpers, one owning structure and one
    // owning escaping, neither owning both. Reported as a heuristic over the planner's own words.
    const structOnly = plan.filter(h => g.structure.test(h.goal) && !g.escaping.test(h.goal))
    const escapeOnly = plan.filter(h => g.escaping.test(h.goal) && !g.structure.test(h.goal))
    const isSeparated = structOnly.length > 0 && escapeOnly.length > 0 &&
      structOnly[0].name !== escapeOnly[0].name

    if (isRebake) rebaked++
    if (isDegen) degenerate++
    if (isNonComp) nonComposing++
    if (isSeparated) separated++
    const ok = !isRebake && !isDegen && !isNonComp
    if (ok) usable++
    console.log(`     → ${[
      isRebake ? 'REBAKE' : null,
      isDegen ? 'DEGENERATE' : null,
      isNonComp ? 'NON-COMPOSING' : null,
      ok ? 'passes the gates' : null,
      isSeparated ? 'SEPARATES structure from escaping' : 'does NOT separate the two concerns',
    ].filter(Boolean).join(' · ')}\n`)
  }

  console.log('── summary ─────────────────────────────────────')
  console.log(`   declined                       ${declined}/${samples}`)
  console.log(`   rebakes the entry              ${rebaked}/${samples}`)
  console.log(`   degenerate (single helper)     ${degenerate}/${samples}`)
  console.log(`   non-composing                  ${nonComposing}/${samples}`)
  console.log(`   PASSES ALL PRODUCTION GATES    ${usable}/${samples}`)
  console.log(`   separates structure/escaping   ${separated}/${samples}   <- the shape that certifies`)
  console.log(`\n   ${separated === 0
    ? 'The planner never proposes the carve that works. Recursion cannot rescue this rung by resampling — ' +
      'the concern-separation has to come from somewhere other than an unaided planner draw.'
    : `The planner CAN propose the working shape (${separated}/${samples}). Recursion + enough attempts is a ` +
      'live path, and raising this rate is a prompt problem rather than a capability one.'}`)
  console.log(JSON.stringify({ plan_quality_probe: true, entry: g.entry, samples, declined, rebaked, degenerate, nonComposing, usable, separated }))
}

main().catch(e => { console.error('plan-quality probe failed:', e); process.exit(1) })
