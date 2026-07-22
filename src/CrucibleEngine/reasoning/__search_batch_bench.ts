// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH BATCH-PATH parity bench — proves W3 continuous batching is a PURE add.
// Run:  npx tsx src/CrucibleEngine/reasoning/__search_batch_bench.ts
// ═══════════════════════════════════════════════════════════════════════════════
//
// search() gained an optional batchProposer that draws a whole round's proposals
// concurrently (llama-server KV slots) instead of one-at-a-time. The RISK is that the
// batch path silently drifts from the tuned serial path's accounting — a different
// model-call count, a different abstain point, a different solution. These tests pin
// that it does NOT, using a DETERMINISTIC proposer (no model) and the real execution
// verifier, so the only variable is serial-vs-batch control flow:
//
//   1. EXHAUST-PARITY — a never-solving distinct sequence produces IDENTICAL status,
//      modelCalls, and attempt count on both paths (no early-exit ⇒ exact parity).
//   2. ROUND-0 SOLVE  — a first-proposal solve returns 'solved' with 1 model call on both.
//   3. CONCURRENCY     — the batchProposer is handed the whole round's slot count in ONE
//      call (proof the round actually batches, not a serial shim).
//   4. BUDGET-BOUND    — the batch path never draws more than maxModelCalls.
//   5. NULL-NO-CHARGE  — an empty draw does not consume the model-call budget.
// ═══════════════════════════════════════════════════════════════════════════════

import { search } from './search'
import { verifyCode } from './codeVerifier'
import type { Candidate, ProposeContext, Proposer, TaskSpec } from './types'

let pass = 0, fail = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

const CASES = [{ args: [0], expected: 0 }, { args: [1], expected: 2 }, { args: [3], expected: 6 }, { args: [-2], expected: -4 }]
const SPEC: TaskSpec = { goal: 'double', domain: 'code', acceptance: { entry: 'double', cases: CASES } as any }
const GOOD = `export function double(x){return x*2}`

/** A distinct FAILING candidate per draw (unique fingerprint, never certifies, never null). Both
 *  the serial proposer and the batch proposer pull from the SAME counter in the SAME order, so a
 *  never-solving run draws the identical sequence either way. */
function distinctFailing() {
  let i = 0
  const next = (): Candidate<string> => {
    const n = i++
    // n+1 wrong outputs → distinct source, distinct fingerprint, all fail every case.
    return { value: `export function double(x){return x*2+${n + 1}}`, fingerprint: `f${n}` }
  }
  const serial: Proposer<string> = async () => next()
  const batch = async (ctxs: ProposeContext<string>[]) => ctxs.map(() => next())
  return { serial, batch }
}

async function main() {
  console.log('\nSEARCH batch-path parity — continuous batching is a pure add\n')

  // 1. EXHAUST-PARITY — identical never-solve behaviour on both paths.
  const OPTS = { beamWidth: 3, maxModelCalls: 9, proposalsPerNode: 1, patience: 4 as number }
  const s = distinctFailing()
  const serialRes = await search(SPEC, s.serial, verifyCode, { ...OPTS })
  const b = distinctFailing()
  const batchRes = await search(SPEC, (async () => null) as Proposer<string>, verifyCode, { ...OPTS, batchProposer: b.batch })
  check('exhaust: same status', serialRes.status === batchRes.status, `${serialRes.status} vs ${batchRes.status}`)
  check('exhaust: same modelCalls', serialRes.modelCalls === batchRes.modelCalls, `${serialRes.modelCalls} vs ${batchRes.modelCalls}`)
  check('exhaust: same attempt count', serialRes.attempts.length === batchRes.attempts.length, `${serialRes.attempts.length} vs ${batchRes.attempts.length}`)
  check('exhaust: same best score', (serialRes.best?.verdict.score ?? null) === (batchRes.best?.verdict.score ?? null))

  // 2. ROUND-0 SOLVE — first proposal certifies on both paths, 1 model call.
  const solveSerial = await search(SPEC, (async () => ({ value: GOOD, fingerprint: 'g' })) as Proposer<string>, verifyCode, { ...OPTS })
  const solveBatch = await search(SPEC, (async () => null) as Proposer<string>, verifyCode, { ...OPTS, batchProposer: async (ctxs) => ctxs.map(() => ({ value: GOOD, fingerprint: 'g' })) })
  check('solve: serial solved in 1 call', solveSerial.status === 'solved' && solveSerial.modelCalls === 1, `${solveSerial.status}/${solveSerial.modelCalls}`)
  check('solve: batch solved in 1 call', solveBatch.status === 'solved' && solveBatch.modelCalls === 1, `${solveBatch.status}/${solveBatch.modelCalls}`)
  check('solve: same solution', solveSerial.solution?.value === solveBatch.solution?.value)

  // 3. CONCURRENCY — a round with 3 beam parents × 2 proposalsPerNode hands the batch proposer
  //    all 6 slots in ONE call (once the beam has filled). Capture the max batch size seen.
  let maxBatch = 0
  const cf = distinctFailing()
  await search(SPEC, (async () => null) as Proposer<string>, verifyCode, {
    beamWidth: 3, maxModelCalls: 30, proposalsPerNode: 2, patience: 6,
    batchProposer: async (ctxs) => { maxBatch = Math.max(maxBatch, ctxs.length); return cf.batch(ctxs) },
  })
  check('concurrency: a round batched > 1 proposal in one call', maxBatch > 1, `maxBatch=${maxBatch}`)

  // 4. BUDGET-BOUND — never draw more than maxModelCalls (count total draws requested).
  let totalDrawn = 0
  const cf2 = distinctFailing()
  const bounded = await search(SPEC, (async () => null) as Proposer<string>, verifyCode, {
    beamWidth: 4, maxModelCalls: 7, proposalsPerNode: 3, patience: 10,
    batchProposer: async (ctxs) => { totalDrawn += ctxs.length; return cf2.batch(ctxs) },
  })
  check('budget: total draws ≤ maxModelCalls', totalDrawn <= 7, `drew ${totalDrawn}`)
  check('budget: modelCalls ≤ maxModelCalls', bounded.modelCalls <= 7, `${bounded.modelCalls}`)

  // 5. NULL-NO-CHARGE — empty draws don't consume the model-call budget; a later real solve still lands.
  let calls = 0
  const nullThenGood = await search(SPEC, (async () => null) as Proposer<string>, verifyCode, {
    beamWidth: 1, maxModelCalls: 3, proposalsPerNode: 1, patience: 6,
    batchProposer: async (ctxs) => ctxs.map(() => (calls++ < 2 ? null : { value: GOOD, fingerprint: 'g' })),
  })
  check('null: empty draws did not exhaust the budget; solve still reached', nullThenGood.status === 'solved' && nullThenGood.modelCalls === 1, `${nullThenGood.status}/${nullThenGood.modelCalls}`)

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error('search-batch bench threw:', e); process.exit(1) })
