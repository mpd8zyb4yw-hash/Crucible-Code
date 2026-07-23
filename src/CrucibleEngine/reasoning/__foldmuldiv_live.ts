// ═══════════════════════════════════════════════════════════════════════════════
// LIVE isolation diagnostic — the foldMulDiv rung (the basicCalculator cornered kernel).
// Run:  npx tsx src/CrucibleEngine/reasoning/__foldmuldiv_live.ts   (needs a head on :8080)
// ═══════════════════════════════════════════════════════════════════════════════
//
// The precedence-aware decompose template carves basicCalculator into four helpers; live probes
// show tokenizeExpr + parseTokens certify in 1-2 calls each but foldMulDiv anchors ("duplicate
// proposal (stuck)") and never certifies strict-offline. This runs foldMulDiv ALONE as a
// solveCodeTask and DUMPS the best attempt's code + the exact per-case failure signals, so the
// wall can be diagnosed (real capability ceiling vs. a fixable spec/harness artifact) instead of
// inferred from "stuck" thoughts. Reads the helper's spec verbatim from precedenceTemplatePlan.

import { solveCodeTask } from './solve'
import { precedenceTemplatePlan } from './fmPlanner'
import type { CodeAcceptance } from './codeVerifier'

async function main(): Promise<void> {
  const fold = precedenceTemplatePlan().find((h) => h.name === 'foldMulDiv')!
  const cases = fold.cases as CodeAcceptance['cases']
  console.log(`# foldMulDiv isolation — ${cases.length} seed case(s), budget ${process.env.FMD_CALLS || 16} calls\n`)
  console.log(`# GOAL:\n${fold.goal}\n`)

  const t0 = Date.now()
  const r = await solveCodeTask(
    { goal: `${fold.goal}\n\nImplement the function \`foldMulDiv\`.`, entry: 'foldMulDiv', cases },
    {
      maxModelCalls: Number(process.env.FMD_CALLS || 16),
      beamWidth: Number(process.env.FMD_BEAM || 3),
      emit: (e: any) => { if (e?.type === 'thought') console.log(`  · ${e.text}`) },
    },
  )
  console.log(`\n# RESULT: ${r.status} in ${r.modelCalls} call(s) [${((Date.now() - t0) / 1000).toFixed(0)}s]`)
  const best = r.best
  if (best) {
    console.log(`\n# BEST attempt (score ${best.verdict.score}):`)
    console.log('```\n' + best.candidate.value + '\n```')
    console.log('# failure signals:')
    for (const s of best.verdict.signals.slice(0, 8)) console.log(`  - ${s}`)
  }
  console.log('\n' + JSON.stringify({ foldmuldiv: true, status: r.status, calls: r.modelCalls, score: best?.verdict.score ?? null }))
}

main().catch((e) => { console.error('foldMulDiv probe failed:', e); process.exit(1) })
