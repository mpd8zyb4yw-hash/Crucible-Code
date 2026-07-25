// ═══════════════════════════════════════════════════════════════════════════════
// LIVE probe — RECURSIVE decomposition on a NOVEL (no-template) task.
// Run:  npx tsx src/CrucibleEngine/reasoning/__decompose_recursive_live.ts   (live head on :8080)
// ═══════════════════════════════════════════════════════════════════════════════
//
// THE QUESTION. Tests 9j–9m prove recursion SOUND against a toy proposer. They do not prove it
// EARNS anything against the live 1.5B. This probe is the honest measurement: a task matching NO
// decompose detector (so `hasDecomposeTemplate` is false and the FM planner must invent the carve),
// whose natural carve hides a sub-helper the weak head still cannot one-shot. `numberToWords` is
// the shape: the FM will reliably propose a "three-digit chunk → words" helper, and THAT helper is
// itself a multi-branch problem (hundreds / teens / tens+ones) the 1.5B rarely writes correctly in
// one sample — exactly the rung that used to collapse the whole plan, and now gets subdivided.
//
// The measurement is a CONTRAST, not a single run: the same task at `maxDepth: 0` (recursion off)
// and at `maxDepth: 1`. Recursion earns its keep only if depth-1 certifies where depth-0 does not.
// A depth-0 solve is NOT a failure of the probe — it means the carve was easy enough and the probe
// needs a harder helper; report it honestly rather than reading it as a win.
//
//   REC_SKIP_CONTROL=1   skip the maxDepth:0 control arm (faster, but no contrast)
//   REC_PLAN_ATTEMPTS    planAttempts per arm (default 2)
//   REC_RUNG_CALLS       per-rung global model calls (default 24)
//   REC_RUNG_TIMEOUT     per-rung wall clock ms (default 240000)

import { decomposeCodeBySubFunction, type SubFunctionPlanner } from './solve'
import { hasDecomposeTemplate } from './fmPlanner'
import type { CodeAcceptance } from './codeVerifier'

const ENTRY = 'numberToWords'
const GOAL =
  'Write numberToWords(n: number): string converting a non-negative integer below 1000000 into ' +
  'its English words, lowercase, words separated by single spaces, no commas and no "and" ' +
  '(e.g. 0 -> "zero", 13 -> "thirteen", 70 -> "seventy", 105 -> "one hundred five", ' +
  '342 -> "three hundred forty two", 12345 -> "twelve thousand three hundred forty five").'
const CASES: CodeAcceptance['cases'] = [
  { args: [0], expected: 'zero' },
  { args: [13], expected: 'thirteen' },
  { args: [70], expected: 'seventy' },
  { args: [105], expected: 'one hundred five' },
  { args: [342], expected: 'three hundred forty two' },
  { args: [1000], expected: 'one thousand' },
  { args: [12345], expected: 'twelve thousand three hundred forty five' },
  { args: [999999], expected: 'nine hundred ninety nine thousand nine hundred ninety nine' },
]

const rungIterate = {
  globalModelCalls: Number(process.env.REC_RUNG_CALLS || 24),
  wallClockMs: Number(process.env.REC_RUNG_TIMEOUT || 240_000),
  maxEpochs: Number(process.env.REC_RUNG_EPOCHS || 6),
}

// PLAN-PINNED planner. The FM's carve is high-variance: across runs it sometimes lands a plan
// whose helpers are all easy and whose COMPOSITION carries the difficulty — and a compose-rung
// failure is not a recursion trigger (recursion fires on a stuck HELPER rung). To measure the
// recursion MECHANISM against the live head rather than the planner's luck, this planner pins the
// carve to one deliberately-hard helper (`chunkToWords`, 0..999 → words: hundreds + teens +
// tens/ones, which the 1.5B does not one-shot) plus a trivial `scaleWord`. When recursion re-invokes
// it on the stuck helper's own goal, it returns the SUB-carve. Everything else — every proposal and
// every certification — is still the real live head against real verifiers; only the plan is pinned.
const pinnedPlanner: SubFunctionPlanner = async (input) => {
  if (input.entry === 'chunkToWords') {
    return [
      { name: 'tensToWords', goal: 'Write tensToWords(n: number): string converting an integer 0..99 to English words, lowercase, single spaces, no hyphens (0 -> "", 7 -> "seven", 13 -> "thirteen", 40 -> "forty", 42 -> "forty two").', cases: [ { args: [0], expected: '' }, { args: [7], expected: 'seven' }, { args: [13], expected: 'thirteen' }, { args: [40], expected: 'forty' }, { args: [42], expected: 'forty two' } ] },
      { name: 'hundredsToWords', goal: 'Write hundredsToWords(n: number): string returning "" for an integer 0..99, and for 100..999 the hundreds part only, e.g. 342 -> "three hundred", 900 -> "nine hundred", 42 -> "".', cases: [ { args: [42], expected: '' }, { args: [342], expected: 'three hundred' }, { args: [900], expected: 'nine hundred' }, { args: [105], expected: 'one hundred' } ] },
    ]
  }
  return [
    { name: 'chunkToWords', goal: 'Write chunkToWords(n: number): string converting an integer 0..999 to English words, lowercase, words separated by single spaces, no hyphens and no "and" (0 -> "", 7 -> "seven", 13 -> "thirteen", 70 -> "seventy", 105 -> "one hundred five", 342 -> "three hundred forty two").', cases: [ { args: [0], expected: '' }, { args: [7], expected: 'seven' }, { args: [13], expected: 'thirteen' }, { args: [70], expected: 'seventy' }, { args: [105], expected: 'one hundred five' }, { args: [342], expected: 'three hundred forty two' } ] },
    { name: 'scaleWord', goal: 'Write scaleWord(i: number): string returning "" for 0 and "thousand" for 1.', cases: [ { args: [0], expected: '' }, { args: [1], expected: 'thousand' } ] },
  ]
}

async function arm(label: string, maxDepth: number, planner?: SubFunctionPlanner) {
  process.stdout.write(`\n── arm: ${label} (maxDepth ${maxDepth}) ──\n`)
  const t0 = Date.now()
  const d = await decomposeCodeBySubFunction(
    { goal: GOAL, nl: GOAL, entry: ENTRY, cases: CASES },
    {
      planAttempts: Number(process.env.REC_PLAN_ATTEMPTS || 2),
      maxDepth,
      planner,
      iterate: rungIterate,
      emit: (e: any) => { if (e?.type === 'thought') console.log(`    · ${e.text}`) },
    },
  )
  const wall = Math.round((Date.now() - t0) / 1000)
  console.log(`\n  RESULT ${d.status} — ${d.detail}`)
  console.log(`  helpers: ${d.helpers.map(h => h.name).join(', ') || '(none)'}`)
  console.log(`  rungs: ${d.rungs.map(r => `${r.name}:${r.certified ? 'OK' : r.status}`).join('  ')}`)
  console.log(`  calls ${d.modelCalls}, wall ${wall}s`)
  return { status: d.status, rungs: d.rungs.map(r => r.name), recursed: d.rungs.some(r => r.name.includes('/')), modelCalls: d.modelCalls, wall, code: d.code }
}

async function main(): Promise<void> {
  console.log(`# LIVE recursive-decomposition probe — ${ENTRY} (novel, no template)\n`)
  const templated = hasDecomposeTemplate(GOAL, ENTRY)
  console.log(`# hasDecomposeTemplate: ${templated}${templated ? '  <-- INVALID PROBE: recursion is gated off for template classes' : '  (FM-general path — recursion is live)'}`)
  if (templated) { process.exit(1) }

  // ARMS 1-2: the FM invents the carve (end-to-end general path, planner luck included).
  const fmControl = process.env.REC_SKIP_FM === '1' ? null : await arm('FM carve, recursion OFF', 0)
  const fmRec = process.env.REC_SKIP_FM === '1' ? null : await arm('FM carve, recursion ON', 1)
  // ARMS 3-4: carve pinned to a known-hard helper, so the recursion TRIGGER is deterministic and
  // what is being measured is the mechanism against the live head, not the planner's variance.
  const pinControl = process.env.REC_SKIP_PINNED === '1' ? null : await arm('pinned carve, recursion OFF', 0, pinnedPlanner)
  const pinRec = process.env.REC_SKIP_PINNED === '1' ? null : await arm('pinned carve, recursion ON', 1, pinnedPlanner)

  console.log('\n# VERDICT')
  for (const [k, a] of [['FM depth 0', fmControl], ['FM depth 1', fmRec], ['pinned depth 0', pinControl], ['pinned depth 1', pinRec]] as const) {
    if (a) console.log(`#   ${k}: ${a.status} (${a.modelCalls} calls, ${a.wall}s)${a.recursed ? ' [recursion fired]' : ''}`)
  }
  const earned = (c: typeof pinControl, r: typeof pinRec) => !!c && !!r && c.status !== 'solved' && r.status === 'solved' && r.recursed
  if (earned(fmControl, fmRec)) console.log('#   => RECURSION EARNED A LIVE SOLVE on the full FM-general path.')
  else if (earned(pinControl, pinRec)) console.log('#   => RECURSION EARNED A LIVE SOLVE on the pinned carve (mechanism proven live; FM planner variance still unproven).')
  else console.log('#   => no arm shows recursion converting a non-solve into a solve. Honest miss.')
  const solved = [fmRec, pinRec].find(a => a?.status === 'solved' && a.code)
  if (solved?.code) console.log('\n# CERTIFIED module:\n\n' + solved.code)
  console.log('\n' + JSON.stringify({
    decompose_recursive_live: true,
    fm: { control: fmControl?.status ?? null, recursion: fmRec?.status ?? null, recursed: fmRec?.recursed ?? null },
    pinned: { control: pinControl?.status ?? null, recursion: pinRec?.status ?? null, recursed: pinRec?.recursed ?? null },
  }))
}

main().catch(e => { console.error('recursive decompose probe failed:', e); process.exit(1) })
