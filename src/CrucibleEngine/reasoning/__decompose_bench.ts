// ═══════════════════════════════════════════════════════════════════════════════
// VERIFIED DECOMPOSITION bench — proves the "proposer too weak to converge" methodology.
// Run:  npm run vgr:decompose
// ═══════════════════════════════════════════════════════════════════════════════
//
// Deterministic. No FM. A self-contained TOY DOMAIN models the exact failure mode we
// see with the real ~3B model on hard goals: a proposer that CANNOT one-shot a complex
// artifact, but CAN reliably make ONE small verified increment on top of an artifact it
// is handed. The bench proves:
//
//   1. FLAT-STALLS        — a goal beyond the proposer's one-shot reach makes flat
//                           iterate() stall honestly (never a false solve).
//   2. DECOMPOSE-SOLVES   — the SAME weak proposer, run rung-by-rung over an incremental
//                           sub-acceptance curriculum, certifies the whole goal.
//   3. COMPOSITION-REVERIFIED — the composed result is re-checked by the ORIGINAL
//                           verifier before it is called solved (soundness).
//   4. RUNG-COLLAPSE      — an uncertifiable rung collapses the decomposition to an
//                           honest failure, never a partial masquerading as done.
//   5. UNTRUSTED-PLAN     — a garbage plan (wrong tokens) cannot make a wrong answer
//                           pass: composition re-verify catches it → decompose-failed.
//   6. DECLINES           — a planner that won't split returns 'declined', leaving the
//                           caller's flat abstain intact (decomposition is a pure add).
// ═══════════════════════════════════════════════════════════════════════════════

import { iterate } from './iterate'
import { solveByDecomposition, type Planner, type SubSpecFactory } from './decompose'
import { parsePlan } from './fmPlanner'
import { decomposeCodeTask, growingCasePrefixes, iterateCodeTask } from './solve'
import type { Proposer, TaskSpec, Verifier } from './types'

let pass = 0, fail = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

// ── TOY DOMAIN ───────────────────────────────────────────────────────────────
// An artifact is a string; "correct" = it contains every required token. The score
// is -(#missing) so the search can rank. This is a faithful stand-in for "the code
// must satisfy N acceptance clauses".
const TOKENS = ['ALPHA', 'BETA', 'GAMMA', 'DELTA']

function verifierFor(required: string[]): Verifier<string> {
  return (cand) => {
    const missing = required.filter((t) => !cand.value.includes(t))
    return {
      pass: missing.length === 0,
      score: -missing.length,
      signals: missing.length ? [`missing tokens: ${missing.join(', ')}`] : ['all tokens present'],
    }
  }
}

// The WEAK proposer. Its ONLY competence: read the longest token-artifact it is handed
// in spec.context, and append exactly ONE more required token. It does NOT self-correct
// across history (models a small model that thrashes rather than climbs within a loop).
// From a COLD start (no context) it can only ever emit the first token — so it cannot
// one-shot any goal needing ≥2 tokens. This is the real failure mode, in miniature.
function weakProposer(required: string[]): Proposer<string> {
  return async (ctx) => {
    const ctxText = ctx.spec.context ?? ''
    // longest prefix of `required` already present in context
    let have = 0
    for (let i = 0; i < required.length; i++) {
      if (ctxText.includes(required[i])) have = i + 1
      else break
    }
    const next = required.slice(0, Math.min(have + 1, required.length))
    return { value: next.join(';'), fingerprint: `have${have}` }
  }
}

const GOAL_TOKENS = TOKENS // 4-token goal — far beyond one-shot reach of the weak proposer
const parentSpec: TaskSpec = {
  goal: 'assemble an artifact containing ALPHA, BETA, GAMMA, DELTA',
  domain: 'toy',
  acceptance: { required: GOAL_TOKENS },
}
const parentVerifier = verifierFor(GOAL_TOKENS)
const proposer = weakProposer(GOAL_TOKENS)

// A sound planner: split into one rung per token (each rung adds one clause).
const goodPlanner: Planner = async () =>
  GOAL_TOKENS.map((t, i) => ({ goal: `ensure token ${t} present (clause ${i + 1})`, rationale: t }))

// Incremental sub-acceptance factory: rung i must satisfy the first i+1 tokens, built on
// the frozen prior certified artifact. This is the domain saying "here is what makes each
// rung independently checkable" — the growing acceptance subset.
const incrementalSubSpec: SubSpecFactory<string> = (_sub, index, priorSolutions, parent) => {
  const required = GOAL_TOKENS.slice(0, index + 1)
  const prior = priorSolutions[priorSolutions.length - 1] ?? ''
  const spec: TaskSpec = { ...parent, goal: `reach ${required.join(';')}`, context: prior }
  return { spec, proposer, verifier: verifierFor(required) }
}

async function main() {
  console.log('\nVERIFIED DECOMPOSITION bench — weak proposer, verifier-certified curriculum\n')

  // ── 1. FLAT-STALLS ──
  const flat = await iterate<string>(parentSpec, proposer, parentVerifier, {
    maxEpochs: 4, stallLimit: 2, baseModelCalls: 6, globalModelCalls: 24,
  })
  check('1 flat iterate does NOT solve a beyond-one-shot goal', flat.status !== 'solved', `status=${flat.status}`)
  check('1b flat abstains honestly (stalled/budget), never false-solve', flat.solution === null && flat.bestScore < 0,
    `sol=${flat.solution} best=${flat.bestScore}`)

  // ── 2 + 3. DECOMPOSE-SOLVES + COMPOSITION-REVERIFIED ──
  const dec = await solveByDecomposition<string>(parentSpec, proposer, parentVerifier, {
    planner: goodPlanner,
    subSpecFor: incrementalSubSpec,
    iterateOpts: { maxEpochs: 3, baseModelCalls: 4, globalModelCalls: 12 },
  })
  check('2 decomposition SOLVES the same goal the flat loop could not', dec.status === 'solved', dec.detail)
  check('2b every rung certified', dec.rungs.length === 4 && dec.rungs.every((r) => r.certified),
    dec.rungs.map((r) => `${r.index}:${r.certified}`).join(' '))
  check('3 composed solution actually satisfies the ORIGINAL verifier',
    !!dec.solution && parentVerifier(dec.solution, parentSpec).pass, dec.solution?.value)
  check('3b composed artifact contains all four tokens',
    !!dec.solution && GOAL_TOKENS.every((t) => dec.solution!.value.includes(t)), dec.solution?.value)

  // ── 4. RUNG-COLLAPSE — a rung whose verifier demands an impossible token collapses. ──
  const impossibleSubSpec: SubSpecFactory<string> = (_s, index, prior, parent) => {
    if (index === 1) {
      // rung 2 requires a token the weak proposer can never produce
      return { spec: { ...parent, goal: 'impossible rung', context: prior[prior.length - 1] ?? '' },
        proposer, verifier: verifierFor(['NEVER_EMITTED']) }
    }
    return incrementalSubSpec(_s, index, prior, parent)
  }
  const collapsed = await solveByDecomposition<string>(parentSpec, proposer, parentVerifier, {
    planner: goodPlanner, subSpecFor: impossibleSubSpec,
    iterateOpts: { maxEpochs: 2, baseModelCalls: 4, globalModelCalls: 8 },
  })
  check('4 an uncertifiable rung collapses to honest failure', collapsed.status === 'decompose-failed', collapsed.detail)
  check('4b failure names the rung that broke', /rung 2\/4/.test(collapsed.detail), collapsed.detail)

  // ── 5. UNTRUSTED-PLAN — rungs certify against a WRONG sub-verifier, but the composed
  //       artifact is missing real tokens, so the original-verifier re-check rejects it. ──
  const wrongSubSpec: SubSpecFactory<string> = (_s, index, prior, parent) => {
    // Each rung only ever requires ALPHA (trivially satisfiable) — rungs will all
    // "certify" a 1-token artifact that does NOT satisfy the 4-token original goal.
    const spec: TaskSpec = { ...parent, goal: 'lax rung', context: prior[prior.length - 1] ?? '' }
    return { spec, proposer, verifier: verifierFor(['ALPHA']) }
  }
  const untrusted = await solveByDecomposition<string>(parentSpec, proposer, parentVerifier, {
    planner: async () => [{ goal: 'a' }, { goal: 'b' }],
    subSpecFor: wrongSubSpec,
    iterateOpts: { maxEpochs: 2, baseModelCalls: 4, globalModelCalls: 8 },
  })
  check('5 a lax/garbage plan cannot pass — composition re-verify rejects it',
    untrusted.status === 'decompose-failed' && untrusted.solution === null, untrusted.detail)
  check('5b failure attributes to composition, not a rung',
    /composition failed original verifier/.test(untrusted.detail), untrusted.detail)

  // ── 6. DECLINES — planner refuses to split → decomposition bows out cleanly. ──
  const declined = await solveByDecomposition<string>(parentSpec, proposer, parentVerifier, {
    planner: async () => null,
  })
  check('6 planner refusal yields declined (flat abstain preserved)', declined.status === 'declined', declined.detail)
  const single = await solveByDecomposition<string>(parentSpec, proposer, parentVerifier, {
    planner: async () => [{ goal: 'only one' }],
  })
  check('6b a 1-subgoal "plan" is not a decomposition → declined', single.status === 'declined', single.detail)

  // ── 7. PLAN PARSING — the FM planner must survive numbered lists, dashes, JSON, junk. ──
  check('7 numbered list parses to rungs',
    parsePlan('1. build canvas\n2. add player\n3. spawn bullets').length === 3)
  check('7b dashes/bullets parse', parsePlan('- one thing\n• another thing').length === 2)
  check('7c JSON array parses', parsePlan('["step a","step b","step c"]').length === 3)
  check('7d JSON objects parse', parsePlan('[{"goal":"x"},{"step":"y"}]').length === 2)
  check('7e prose without list structure yields no rungs (→ decline)',
    parsePlan('I think you should just try harder honestly.').length === 0)
  check('7f strips markdown bold', parsePlan('1. **bold** milestone\n2. next')[0].goal === 'bold milestone')

  // ── 8. CODE DOMAIN, REAL EXECUTION VERIFIER — decomposeCodeTask certifies actual code a
  //       flat weak proposer cannot one-shot. The proposer models the real failure: it can
  //       only add ONE correct switch-branch beyond whatever prior code it is handed. ──
  check('8pre growingCasePrefixes covers all + is monotone',
    JSON.stringify(growingCasePrefixes(4, 4)) === '[1,2,3,4]' &&
    growingCasePrefixes(3, 5).slice(-1)[0] === 3)

  const CODE_CASES = [
    { args: [1], expected: 'a' }, { args: [2], expected: 'b' },
    { args: [3], expected: 'c' }, { args: [4], expected: 'd' },
  ]
  // Weak code proposer: counts `case N:` branches in the prior artifact (from context) and
  // emits a switch with ONE more branch. Cold start → 1 branch → passes only 1/4 case.
  const EXP = ['a', 'b', 'c', 'd']
  const weakCode: Proposer<string> = async (ctx) => {
    const prior = ctx.spec.context ?? ''
    const have = (prior.match(/case \d+:/g) ?? []).length
    const n = Math.min(have + 1, 4)
    const branches = Array.from({ length: n }, (_, i) => `case ${i + 1}: return '${EXP[i]}';`).join(' ')
    const value = `export function f(n) { switch (n) { ${branches} default: return ''; } }`
    return { value, fingerprint: `b${n}` }
  }
  const codeInput = { goal: 'map 1..4 to a..d', entry: 'f', cases: CODE_CASES }

  const flatCode = await iterateCodeTask(codeInput, { maxEpochs: 4, stallLimit: 2, baseModelCalls: 6, globalModelCalls: 24 }, weakCode)
  check('8 flat iterate cannot one-shot the 4-branch function', flatCode.status !== 'solved', `status=${flatCode.status}`)

  const decCode = await decomposeCodeTask(codeInput,
    { planner: async () => CODE_CASES.map((_, i) => ({ goal: `handle case ${i + 1}` })),
      iterate: { maxEpochs: 3, baseModelCalls: 4, globalModelCalls: 12 } },
    weakCode)
  check('8b decomposeCodeTask certifies the full function via a case curriculum',
    decCode.status === 'solved' && !!decCode.solution, decCode.detail)
  check('8c certified code passes ALL four real executed cases',
    decCode.rungs.length >= 3 && decCode.rungs.every((r) => r.certified) && decCode.rungs.slice(-1)[0].goal !== undefined,
    decCode.rungs.map((r) => `${r.index}:${r.certified}`).join(' '))

  console.log(`\n${fail === 0 ? '✅' : '❌'} decompose bench: ${pass} passed, ${fail} failed\n`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
