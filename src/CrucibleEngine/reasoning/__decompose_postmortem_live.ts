// ═══════════════════════════════════════════════════════════════════════════════
// LIVE RUNG-GRANULARITY POST-MORTEM on ONE scorecard row.
// Run:  npx tsx src/CrucibleEngine/reasoning/__decompose_postmortem_live.ts   (live head :8080)
//   PM_ENTRY=intToRoman     which scorecard row (core or hard set) to dissect. Default intToRoman.
//   PM_WALL_MS=300000       whole-task wall ceiling, matching the scorecard's. 0 = uncapped.
//   PM_CALL_BUDGET=0        shared call ledger handed to the carve. >0 also runs the LEDGER CHECK.
//   PM_RUNS=1               draws.
//   PM_PLAN_ATTEMPTS=3      passed through to decomposeCodeBySubFunction.
// ═══════════════════════════════════════════════════════════════════════════════
//
// WHY THIS EXISTS. The general scorecard prints one word per failed row (`decompose-failed`) and
// one call/wall pair, and the 2026-08-01 control run showed that word covering two unrelated
// diseases: `romanToInt` died in 10s and 3 calls (the plan never survived the quality gates — no
// rung was ever ground), while `intToRoman` burned 43 calls and the entire 300s ceiling (the plan
// was fine and a rung ground to death). Those want opposite fixes — better planning versus better
// per-rung search — and no output in the repo separated them. `SubFunctionResult.attempts` and
// `SubFunctionRung.wallMs/phase` were added for exactly this, and this probe is their reader.
//
// WHAT IT REPORTS, and what each part is evidence FOR:
//   • per plan attempt, every rung with its phase, status, calls and seconds — so "where did the
//     300s go" has an answer with a line number rather than a hypothesis;
//   • a per-attempt CLASSIFICATION (plan-death / grind / rung-failure) using only observed fields;
//   • wall and calls rolled up BY PHASE — probe vs helper vs compose vs recursion vs glue;
//   • the carry-forward tally (item 5): hits, stale keys, and the calls reuse actually avoided;
//   • the LEDGER CHECK (item 4): with PM_CALL_BUDGET set, whether total spend respected the shared
//     ledger through the real planAttempts × recursion × glue path — the injected-proposer bench
//     proved the arithmetic, not the threading.
//
// Nothing here changes what gets certified: every field printed is reporting-only, and the run is
// the same `decomposeCodeBySubFunction` the scorecard's control arm calls.

import { decomposeCodeBySubFunction, type SubFunctionAttempt, type SubFunctionRung } from './solve'
import { decomposePerRungBudget, hasDecomposeTemplate } from './fmPlanner'
import { TASKS, HARD_TASKS } from './__decompose_general_scorecard_live'
import { headModelName } from '../agent/fmReact'

const GROUND_PHASES = new Set<SubFunctionRung['phase']>(['helper', 'compose', 'recursion', 'glue'])

/**
 * Which disease killed this attempt, decided from observed rung fields alone.
 *
 *   plan-death   — not one rung was GROUND. The planner declined, or a quality gate (re-bake,
 *                  degeneracy, non-composing, the grounded-plan re-run) rejected the carve, or the
 *                  probe pruned it below viability. Cost is a handful of calls and seconds.
 *   grind        — a rung hit a reality ceiling (`budget`) or the attempt ran out the wall clock.
 *                  The plan was accepted and the search could not close it.
 *   rung-failure — a rung stalled honestly inside its budget: not out of time, just stuck.
 *
 * `solved` short-circuits all three. The ordering matters: an attempt that ground nothing cannot be
 * a grind no matter how long the planner took, so plan-death is checked first.
 */
function classify(a: SubFunctionAttempt, wallCeilingMs: number): string {
  if (a.status === 'solved') return 'solved'
  if (a.status === 'aborted') return 'aborted (ceiling/cancel)'
  const ground = a.rungs.filter(r => GROUND_PHASES.has(r.phase))
  if (!ground.length) return 'PLAN-DEATH (no rung was ever ground)'
  if (ground.some(r => r.status === 'budget')) return 'GRIND (a rung hit a reality ceiling)'
  if (wallCeilingMs > 0 && a.wallMs >= wallCeilingMs * 0.9) return 'GRIND (attempt consumed the wall ceiling)'
  return 'RUNG-FAILURE (a rung stalled inside its budget)'
}

const s = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

async function main(): Promise<void> {
  const entry = process.env.PM_ENTRY ?? 'intToRoman'
  const probe = [...TASKS, ...HARD_TASKS].find(t => t.entry === entry)
  if (!probe) { console.error(`no scorecard row named ${entry}`); process.exit(1) }
  if (hasDecomposeTemplate(probe.goal, probe.entry)) {
    console.error(`${entry} now matches a decompose template — this post-mortem would dissect the TEMPLATE path`)
    process.exit(1)
  }
  const wallMs = Number(process.env.PM_WALL_MS ?? 300_000)
  const callBudget = Number(process.env.PM_CALL_BUDGET || 0)
  const runs = Math.max(1, Number(process.env.PM_RUNS || 1))
  const planAttempts = Math.max(1, Number(process.env.PM_PLAN_ATTEMPTS || 3))
  const iterate = decomposePerRungBudget(probe.goal, probe.entry)

  console.log(`# RUNG POST-MORTEM — ${probe.label}`)
  console.log(`# head ${headModelName()} · ${runs} draw(s) · planAttempts ${planAttempts} · ` +
    `wall ceiling ${wallMs > 0 ? s(wallMs) : 'none'} · call ledger ${callBudget > 0 ? callBudget : 'none'}\n`)

  for (let run = 0; run < runs; run++) {
    const t0 = Date.now()
    const ac = wallMs > 0 ? new AbortController() : null
    const timer = ac ? setTimeout(() => ac.abort(), wallMs) : null
    // `left()` reports what the CALLER has left, NOT minus the carve's own spend — the carve
    // subtracts its running `modelCalls` itself (solve.ts `callsLeft`) and the retry loop subtracts
    // earlier attempts. A closure that also decremented would double-count. For a fresh carve
    // holding the whole ledger that makes the honest answer a constant.
    const d = await decomposeCodeBySubFunction(
      { goal: probe.goal, nl: probe.goal, entry: probe.entry, cases: probe.cases },
      {
        planAttempts, iterate,
        ...(ac ? { signal: ac.signal } : {}),
        ...(callBudget > 0 ? { budget: { left: () => callBudget } } : {}),
      },
    )
    const wall = Date.now() - t0
    console.log(`── draw ${run + 1}/${runs}: ${d.status} — ${d.modelCalls} calls, ${s(wall)}`)
    console.log(`   ${d.detail}`)

    const attempts = d.attempts ?? []
    if (!attempts.length) console.log('   (no attempt trace — this build predates SubFunctionResult.attempts)')
    const byPhase = new Map<string, { calls: number; wallMs: number; rungs: number }>()
    for (const a of attempts) {
      console.log(`\n   attempt ${a.attempt}: ${a.status} — ${a.modelCalls} calls, ${s(a.wallMs)}`)
      console.log(`     ${classify(a, wallMs)}`)
      console.log(`     ${a.detail}`)
      for (const r of a.rungs) {
        const p = r.phase ?? 'unknown'
        const agg = byPhase.get(p) ?? { calls: 0, wallMs: 0, rungs: 0 }
        agg.calls += r.modelCalls; agg.wallMs += r.wallMs ?? 0; agg.rungs++
        byPhase.set(p, agg)
        console.log(`       ${p.padEnd(9)} ${r.name.padEnd(28)} ${(r.certified ? 'OK' : r.status).padEnd(9)} ` +
          `${String(r.modelCalls).padStart(3)}c ${(r.wallMs === undefined ? '   —' : s(r.wallMs)).padStart(7)}`)
      }
    }

    // WHERE THE SECONDS WENT. The rung walls do not have to sum to the task wall — planning, the
    // static gates and the final re-verify sit between rungs — so the shortfall is printed too
    // rather than being quietly absorbed into whichever phase happens to be biggest.
    console.log('\n   ── spend by phase ─────────────────────────────')
    let sumCalls = 0, sumWall = 0
    for (const [p, agg] of [...byPhase.entries()].sort((a, b) => b[1].wallMs - a[1].wallMs)) {
      sumCalls += agg.calls; sumWall += agg.wallMs
      console.log(`     ${p.padEnd(9)} ${String(agg.rungs).padStart(2)} rung(s)  ${String(agg.calls).padStart(3)}c  ${s(agg.wallMs).padStart(7)}`)
    }
    console.log(`     ${'unaccounted'.padEnd(9)}            ${String(d.modelCalls - sumCalls).padStart(3)}c  ${s(Math.max(0, wall - sumWall)).padStart(7)}   (planner draws, gates, final re-verify)`)

    // ITEM 5 — the carry-forward payoff, counted rather than argued.
    const c = d.carryStats
    if (c) {
      const looked = c.hits + c.stale + c.misses
      console.log('\n   ── carry-forward (rungSpecKey) ────────────────')
      console.log(`     ${c.hits} hit / ${c.stale} stale-key / ${c.misses} never-certified  of ${looked} rung lookup(s)`)
      console.log(`     ${c.callsAvoided} model call(s) avoided by reuse` +
        (c.stale ? ` · ${c.stale} stale key(s) re-ground instead of composing against a dead dependency` : ''))
      if (looked && !c.hits) console.log('     NOTE: zero hits — on this row carry-forward paid nothing, so its cost/benefit is untested here')
    }

    // ITEM 4 — the ledger check on the REAL path (recursion + glue included), not a stub proposer.
    if (callBudget > 0) {
      const ok = d.modelCalls <= callBudget
      console.log('\n   ── ledger check ───────────────────────────────')
      console.log(`     ${ok ? 'PASS' : 'FAIL'}: spent ${d.modelCalls} of a ${callBudget}-call ledger` +
        (ok ? '' : ` — OVERSPENT by ${d.modelCalls - callBudget}`))
      const recursed = attempts.some(a => a.rungs.some(r => r.phase === 'recursion'))
      const glued = attempts.some(a => a.rungs.some(r => r.phase === 'glue'))
      // A pass proves nothing about the nested path if the nested path never ran, so say so.
      console.log(`     paths exercised — planAttempts ${attempts.length}, recursion ${recursed ? 'yes' : 'NO'}, glue ${glued ? 'yes' : 'NO'}` +
        (recursed && glued ? '' : '  (an unexercised path is NOT covered by this verdict)'))
    }
    if (timer) clearTimeout(timer)
    console.log('')
  }
  console.log(JSON.stringify({ decompose_postmortem: true, entry, wallMs, callBudget, planAttempts }))
}

main().catch(e => { console.error('rung post-mortem failed:', e); process.exit(1) })
