// ═══════════════════════════════════════════════════════════════════════════════
// SELF-VERIFYING BENCH — consensus-fuzz as a post-acceptance gate for ARBITRARY functions
//
// Proves the no-reference extension of the "certified-but-edge-case-wrong" catch:
//   (1) a candidate that PASSES its fixed cases but disagrees with a QUORUM of independent impls
//       on a fuzzed input is REJECTED at the consensus-fuzz rung (hard gate);
//   (2) a correct candidate passes the whole ladder;
//   (3) soundness — when the impls DISAGREE among themselves (no quorum), the stage NEVER rejects
//       (FUZZ_ABSTAIN path), even for a candidate that matches neither;
//   (4) inertness — <2 loadable impls → no stage is built (no blind reject);
//   (5) throw-consensus — a quorum that REJECTS an input is enforced (a candidate returning a value
//       where the consensus throws is caught);
//   (6) FUZZ_ABSTAIN wiring in coverageFuzz itself (a declining reference → clean run);
//   (7) end-to-end through solveCodeTask({ fuzzGate:true, consensusImpls }) with a live search.
//
//   run:  npx tsx src/CrucibleEngine/reasoning/__consensusfuzz_bench.ts
// ═══════════════════════════════════════════════════════════════════════════════

import { buildConsensusReference, makeConsensusFuzzStage, inferMutator } from './consensusFuzz'
import { coverageFuzz, intArrayMutator, FUZZ_ABSTAIN } from './coverageFuzz'
import { runLadder } from './verifierLadder'
import { verifyCode } from './codeVerifier'
import { solveCodeTask } from './solve'
import type { Candidate, Proposer, TaskSpec } from './types'

const src = (...lines: string[]) => lines.join('\n')
const impl = (source: string): { source: string; fingerprint: string } => {
  const norm = source.replace(/\s+/g, ' ').trim()
  let h = 5381
  for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) | 0
  return { source, fingerprint: `i${(h >>> 0).toString(36)}` }
}
const cand = (code: string): Candidate<string> => ({ value: code, fingerprint: 'x' })

let pass = 0
const fails: string[] = []
const check = (name: string, ok: boolean, note = '') => {
  if (ok) pass++; else fails.push(name)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${note ? `\n         ${note}` : ''}`)
}

async function main() {
  console.log('── Consensus-fuzz — no-reference post-acceptance gate self-verification ──\n')

  // countEven(xs): three INDEPENDENT correct impls (filter+length / imperative loop / recursion). A
  // correct impl counts 0 as even. The buggy candidate drops 0 — it disagrees with the consensus
  // the moment a 0 appears (0 changes the COUNT), but passes fixed cases that contain no 0.
  const sumEvenImpls = [
    impl('export function countEven(xs){ return xs.filter(v => v % 2 === 0).length }'),
    impl(src(
      'export function countEven(xs){',
      '  let n = 0',
      '  for (const v of xs) { if (v % 2 === 0) n++ }',
      '  return n',
      '}',
    )),
    impl(src(
      'export function countEven(xs){',
      '  if (xs.length === 0) return 0',
      '  const [h, ...r] = xs',
      '  return (h % 2 === 0 ? 1 : 0) + countEven(r)',
      '}',
    )),
  ]
  const buggySumEven = src(
    'export function countEven(xs){',
    '  let n = 0',
    '  for (const v of xs) { if (v % 2 === 0 && v !== 0) n++ }',  // bug: drops 0
    '  return n',
    '}',
  )
  const correctSumEven = 'export function countEven(xs){ return xs.filter(v => v % 2 === 0).length }'
  const sumEvenSpec: TaskSpec = {
    goal: 'count the even numbers in the array', domain: 'code',
    acceptance: { entry: 'countEven', cases: [
      { args: [[2, 4, 6]], expected: 3 },
      { args: [[1, 3, 5]], expected: 0 },
      { args: [[2, 3, 4]], expected: 2 },
    ] } as Record<string, unknown>,
  }

  // ── 1) reference machinery: consensus returns the agreed value, or FUZZ_ABSTAIN ──────────
  {
    const built = buildConsensusReference(sumEvenImpls, 'countEven')
    check('buildConsensusReference loads ≥2 independent impls', !!built && built!.loaded === 3)
    if (built) {
      check('consensus agrees on a value where all impls agree', built.ref([0, 2, 3]) === 2,
        `ref([0,2,3])=${String(built.ref([0, 2, 3]))}`)
    }
  }

  // ── 2) the gate REJECTS a certified-but-edge-case-wrong candidate ────────────────────────
  {
    const stage = makeConsensusFuzzStage({
      entry: 'countEven', impls: sumEvenImpls, family: 'countEven',
      seeds: (sumEvenSpec.acceptance as any).cases.map((c: any) => c.args),
    })
    check('makeConsensusFuzzStage builds a stage from ≥2 impls', !!stage)
    const acceptanceStage = { name: 'acceptance', cost: 2, verify: verifyCode }
    const vWrong = await runLadder([acceptanceStage, stage!], cand(buggySumEven), sumEvenSpec)
    check('ladder rejects certified-but-edge-case-wrong candidate at the consensus-fuzz rung',
      !vWrong.pass && vWrong.decidedBy === 'consensus-fuzz',
      `decidedBy=${vWrong.decidedBy} signals=${vWrong.signals.join(' | ')}`)

    const vOk = await runLadder([acceptanceStage, stage!], cand(correctSumEven), sumEvenSpec)
    check('ladder passes a correct candidate through the consensus-fuzz rung', vOk.pass && vOk.decidedBy === 'consensus-fuzz',
      `decidedBy=${vOk.decidedBy} signals=${vOk.signals.join(' | ')}`)

    // Acceptance-failing candidate must short-circuit — the costly consensus rung never runs.
    const brokenParse = 'export function sumEven(xs){ return xs.filter((v =>'
    const vShort = await runLadder([acceptanceStage, stage!], cand(brokenParse), sumEvenSpec)
    const ran = vShort.trace.find(t => t.name === 'consensus-fuzz')?.ran
    check('acceptance failure short-circuits — consensus rung never runs', !vShort.pass && ran === false,
      `ran=${ran}`)
  }

  // ── 3) SOUNDNESS: impls that DISAGREE among themselves → no quorum → NEVER reject ─────────
  // Two impls that return different things on every non-trivial input. Quorum (=2) can never form,
  // so the reference abstains everywhere and no candidate is ever rejected.
  {
    const disagreeing = [
      impl('export function f(x){ return x + 1 }'),
      impl('export function f(x){ return x + 2 }'),  // differs from +1 on EVERY input (no coincidental quorum)
    ]
    const built = buildConsensusReference(disagreeing, 'f')
    check('disagreeing impls: consensus abstains (no quorum)', !!built && built!.ref(5) === FUZZ_ABSTAIN,
      built ? `ref(5)=${String(built.ref(5))}` : 'no ref')
    const stage = makeConsensusFuzzStage({ entry: 'f', impls: disagreeing, seeds: [[3], [5], [0]] })!
    const spec: TaskSpec = { goal: 'f', domain: 'code', acceptance: { entry: 'f', cases: [{ args: [3], expected: 4 }] } as Record<string, unknown> }
    // A candidate matching neither impl on the seed shape — must still PASS (no consensus to violate).
    const weird = await Promise.resolve(stage.verify(cand('export function f(x){ return x - 100 }'), spec))
    check('no-quorum consensus never rejects (sound abstain)', weird.pass, `signals=${weird.signals.join(' | ')}`)
  }

  // ── 4) INERTNESS: fewer than two loadable impls → no stage ───────────────────────────────
  {
    const one = makeConsensusFuzzStage({ entry: 'g', impls: [impl('export function g(x){ return x }')], seeds: [[1]] })
    check('a single impl builds NO stage (no blind reject)', one === null)
    const brokenPair = makeConsensusFuzzStage({
      entry: 'g',
      impls: [impl('export function g(x){ return x'), impl('this is not code {{{')],  // neither loads
      seeds: [[1]],
    })
    check('two non-loadable impls build NO stage', brokenPair === null)
  }

  // ── 5) THROW-CONSENSUS: a quorum that REJECTS an input is enforced ───────────────────────
  // Two impls that throw on a negative arg; a candidate that returns a value there is wrong.
  {
    const throwers = [
      impl('export function h(n){ if (n < 0) throw new Error("neg"); return n * n }'),
      impl(src('export function h(n){', '  if (n < 0) { throw new RangeError("no negatives") }', '  return n ** 2', '}')),
    ]
    const built = buildConsensusReference(throwers, 'h')
    let threw = false
    try { built!.ref(-3) } catch { threw = true }
    check('throw-consensus: reference throws where a quorum of impls throw', threw)
    const stage = makeConsensusFuzzStage({ entry: 'h', impls: throwers, seeds: [[4], [-1], [-2], [0], [-5]] })!
    const spec: TaskSpec = { goal: 'square, reject negatives', domain: 'code', acceptance: { entry: 'h', cases: [{ args: [4], expected: 16 }] } as Record<string, unknown> }
    // Candidate returns 0 for negatives instead of throwing → must be caught on a negative input.
    const lenient = 'export function h(n){ if (n < 0) return 0; return n * n }'
    const v = await Promise.resolve(stage.verify(cand(lenient), spec))
    check('throw-consensus: candidate that returns where consensus throws is REJECTED', !v.pass,
      `signals=${v.signals.join(' | ')}`)
  }

  // ── 6) FUZZ_ABSTAIN wiring in coverageFuzz (a declining reference yields a clean run) ─────
  {
    const alwaysAbstain = (..._a: unknown[]) => FUZZ_ABSTAIN
    const r = coverageFuzz(
      'export function k(xs){ return xs.length }', 'k',
      [[[1]], [[1, 2]]], intArrayMutator,
      { reference: alwaysAbstain as any, iterations: 50, seed: 1 },
    )
    check('coverageFuzz: an always-abstaining reference produces no counterexample', r.status === 'clean',
      `status=${r.status}`)
  }

  // ── 7) inferMutator picks a shape from real seeds ────────────────────────────────────────
  {
    const m1 = inferMutator([[[1, 2, 3]]])   // single number[] arg
    const out1 = m1([[1, 2, 3]], () => 0.1)
    check('inferMutator: number[] seed → array mutator', Array.isArray(out1[0]))
    const m2 = inferMutator([['hello']])      // single string arg
    const out2 = m2(['hello'], () => 0.1)
    check('inferMutator: string seed → string mutator', typeof out2[0] === 'string')
    const m3 = inferMutator([['abc', 2]])     // (string, number) tuple
    const out3 = m3(['abc', 2], () => 0.1)
    check('inferMutator: tuple seed → 2-position tuple mutator', out3.length === 2)
  }

  // ── 8) END-TO-END through solveCodeTask({ fuzzGate:true, consensusImpls }) ────────────────
  // A deterministic proposer offers the edge-case-wrong candidate first, then a correct one. The
  // consensus-fuzz rung must reject the first (so search keeps climbing) and certify the second.
  {
    let i = 0
    const proposer: Proposer<string> = async () => {
      const code = i++ === 0 ? buggySumEven : correctSumEven
      return { value: code, fingerprint: `c${i}` }
    }
    const res = await solveCodeTask(
      { goal: 'sum the even numbers in the array', entry: 'countEven',
        cases: (sumEvenSpec.acceptance as any).cases, fuzzGate: true, consensusImpls: sumEvenImpls },
      { maxModelCalls: 4 },
      proposer,
    )
    check('solveCodeTask fuzzGate+consensusImpls certifies the correct impl, not the edge-wrong one',
      res.status === 'solved' && res.solution?.value === correctSumEven,
      `status=${res.status} chosen=${res.solution?.value?.slice(0, 40)}`)
  }

  const ok = fails.length === 0
  console.log(`\n  ${ok ? 'PASS' : 'FAIL'} — ${pass}/${pass + fails.length} checks passed`)
  if (fails.length) console.log(`  failing: ${fails.join('; ')}`)
  process.exit(ok ? 0 : 1)
}

main()
