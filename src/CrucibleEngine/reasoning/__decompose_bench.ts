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
import { parsePlan, parseSubFunctionPlan, isArithmeticExprGoal, precedenceTemplatePlan, makeFmSubFunctionPlanner, isRpnGoal, rpnTemplatePlan, isEditDistanceGoal, editDistanceTemplatePlan, isShuntingYardGoal, shuntingYardTemplatePlan, composeHintFor, templateFor } from './fmPlanner'
import { decomposeCodeBySubFunction, decomposeCodeTask, growingCasePrefixes, iterateCodeTask, stripHelperRedefinitions, extractOwnFunction, isDegenerateSubFnCarve, isNonComposingCarve, isRebakedHelper, subLevelIterateBudget, type SubFunctionPlanner } from './solve'
import { structuralFingerprint, fingerprintCode } from './codeProposer'
import { subFunctionPlanGrammar } from '../agent/grammars'
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

  // ── 6c. PLAN-QUALITY GATE — the FM general path rejects a degenerate single-helper carve. ──
  // A 1-helper carve on the template-free path is a re-bake (the helper is the whole task); fail
  // fast so planAttempts resamples. Template classes and caller-supplied planners are exempt.
  check('6c1 FM single-helper carve fires the re-bake gate', isDegenerateSubFnCarve(false, 1, false) === true)
  check('6c2 two-helper carve is a real decomposition', isDegenerateSubFnCarve(false, 2, false) === false)
  check('6c3 custom-planner (test) is exempt', isDegenerateSubFnCarve(true, 1, false) === false)
  check('6c4 trusted template class is exempt', isDegenerateSubFnCarve(false, 1, true) === false)

  // ── 6d. PLAN-QUALITY GATE #2 — a multi-helper carve with NO ENTRY POINT is rejected too. ──
  // The live case: numberToWords(1234) drew removeCommas/removeAnd, helpers that consume STRINGS
  // while the entry is only ever handed a NUMBER. Four rungs certified, nothing composable.
  const junkCarve = [
    { name: 'removeCommas', goal: 'strip commas', cases: [{ args: ['1,234'], expected: '1234' }] },
    { name: 'removeAnd', goal: 'strip the word and', cases: [{ args: ['one and two'], expected: 'one two' }] },
  ]
  const numCases = [{ args: [1234], expected: 'one thousand two hundred thirty four' }]
  check('6d1 no helper consumes the entry input → non-composing',
    isNonComposingCarve(false, junkCarve, numCases, false) === true)
  const goodCarve = [
    { name: 'splitGroups', goal: 'split into 3-digit groups', cases: [{ args: [1234], expected: [1, 234] }] },
    { name: 'groupToWords', goal: 'words for one group', cases: [{ args: [234], expected: 'two hundred thirty four' }] },
  ]
  check('6d2 a helper taking the entry\'s number type passes',
    isNonComposingCarve(false, goodCarve, numCases, false) === false)
  check('6d3 custom-planner (test) is exempt', isNonComposingCarve(true, junkCarve, numCases, false) === false)
  check('6d4 trusted template class is exempt', isNonComposingCarve(false, junkCarve, numCases, true) === false)
  check('6d5 no entry cases → cannot judge, allow', isNonComposingCarve(false, junkCarve, [], false) === false)
  check('6d6 plan with no example args → cannot judge, allow',
    isNonComposingCarve(false, [{ name: 'x', goal: 'g', cases: [] }] as any, numCases, false) === false)
  check('6d7 array element shape is compared, not just "array"',
    isNonComposingCarve(false, [{ name: 'x', goal: 'g', cases: [{ args: [['a', 'b']], expected: 1 }] }],
      [{ args: [[1, 2]], expected: 3 }], false) === true)

  // ── 6g. ALIAS RE-BAKE — a helper SPECIFIED with one of the entry's own cases is the whole task. ──
  const entryCasesRb = [{ args: [1994], expected: 'MCMXCIV' }, { args: [58], expected: 'LVIII' }]
  check('6g1 a helper carrying an entry case verbatim is a re-bake',
    isRebakedHelper([{ args: [1994], expected: 'MCMXCIV' }], entryCasesRb) === true)
  check('6g2 a genuine sub-step is NOT a re-bake',
    isRebakedHelper([{ args: [900], expected: 'CM' }], entryCasesRb) === false)
  check('6g3 same args but a DIFFERENT expected is not a re-bake (it is a different spec)',
    isRebakedHelper([{ args: [1994], expected: [1000, 900, 90, 4] }], entryCasesRb) === false)
  check('6g4 missing evidence on either side never fires',
    isRebakedHelper([], entryCasesRb) === false && isRebakedHelper([{ args: [1994], expected: 'MCMXCIV' }], []) === false)
  check('6g5 naming is IGNORED — only the spec is evidence (romanToIntHelper solved live)',
    isRebakedHelper([{ args: ['IX'], expected: 9 }], [{ args: ['MCMXCIV'], expected: 1994 }]) === false)

  // ── 6e. STRUCTURAL FINGERPRINT — collapses the model's cosmetic renames, keeps semantics. ──
  const sfA = 'export function solve(nums){ let total = 0; for (const n of nums) total += n; return total }'
  const sfRenamed = 'export function solve(xs){\n  // sum them\n  let acc = 0\n  for (const x of xs) acc += x\n  return acc\n}'
  const sfDifferentOp = 'export function solve(nums){ let total = 0; for (const n of nums) total -= n; return total }'
  const sfDifferentShape = 'export function solve(nums){ return nums.reduce((a, b) => a + b, 0) }'
  check('6e1 a pure rename/reflow/comment change is the SAME structure',
    structuralFingerprint(sfA) === structuralFingerprint(sfRenamed))
  check('6e2 exact-text fingerprint MISSES that (which is why this exists)',
    fingerprintCode(sfA) !== fingerprintCode(sfRenamed))
  check('6e3 a changed operator is a DIFFERENT structure',
    structuralFingerprint(sfA) !== structuralFingerprint(sfDifferentOp))
  check('6e4 loop vs reduce is a DIFFERENT structure',
    structuralFingerprint(sfA) !== structuralFingerprint(sfDifferentShape))

  // ── 6f. PLAN GRAMMAR — the sampler-level pin on the plan schema is well-formed GBNF. ──
  const planGrammar = subFunctionPlanGrammar()
  check('6f1 plan grammar declares a root', /^root ::= /m.test(planGrammar))
  check('6f2 every referenced rule is defined', (() => {
    const defined = new Set([...planGrammar.matchAll(/^([a-z0-9]+) ::=/gm)].map(m => m[1]))
    const used = [...planGrammar.matchAll(/(?:::=|\||\(|\s)\s*([a-z][a-z0-9]*)\b/g)].map(m => m[1])
    return used.every(u => defined.has(u))
  })())
  check('6f3 the 2–4 helper cardinality is structural (two required, two optional)',
    /helper ( ws "," ws helper )\? ( ws "," ws helper )\?/.test(planGrammar.replace(/\\/g, '')) ||
    planGrammar.includes('ws helper ws "," ws helper'))
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

  // ── 9. SUB-FUNCTION (logic) DECOMPOSITION — the axis for STRUCTURALLY-hard functions.
  //       Target f(x) = g(x) + h(x) with g(x)=2x, h(x)=x+1  → f(x)=3x+1. The weak proposer
  //       can write g or h alone, and can write f ONLY when BOTH helper sources are visible
  //       in context — modeling a model that can't structure the whole but can wire parts. ──
  const F_CASES = [{ args: [1], expected: 4 }, { args: [2], expected: 7 }, { args: [3], expected: 10 }]
  const subWeak: Proposer<string> = async (ctx) => {
    const acc = ctx.spec.acceptance as { entry: string }
    const ctxt = ctx.spec.context ?? ''
    if (acc.entry === 'g') return { value: 'export function g(x) { return x * 2; }', fingerprint: 'g' }
    if (acc.entry === 'h') return { value: 'export function h(x) { return x + 1; }', fingerprint: 'h' }
    if (acc.entry === 'f') {
      const wired = ctxt.includes('function g') && ctxt.includes('function h')
      return wired
        ? { value: 'export function f(x) { return g(x) + h(x); }', fingerprint: 'f-ok' }
        : { value: 'export function f(x) { return x; }', fingerprint: 'f-bad' } // structurally wrong from cold
    }
    return { value: 'export function f(x){return x}', fingerprint: 'na' }
  }
  const fInput = { goal: 'compute f(x) = double(x) plus increment(x)', entry: 'f', cases: F_CASES }

  // Flat can't: from cold context it can only emit the wrong f and thrashes.
  const flatF = await iterateCodeTask(fInput, { maxEpochs: 3, stallLimit: 2, baseModelCalls: 4, globalModelCalls: 16 }, subWeak)
  check('9 flat iterate cannot one-shot a structurally-composed function', flatF.status !== 'solved', `status=${flatF.status}`)

  const plan: SubFunctionPlanner = async () => [
    { name: 'g', goal: 'double x', cases: [{ args: [2], expected: 4 }, { args: [5], expected: 10 }] },
    { name: 'h', goal: 'increment x', cases: [{ args: [2], expected: 3 }, { args: [0], expected: 1 }] },
  ]
  const decF = await decomposeCodeBySubFunction(fInput, { planner: plan, iterate: { maxEpochs: 2, baseModelCalls: 3, globalModelCalls: 8 } }, subWeak)
  check('9b sub-function decomposition SOLVES the structural task flat could not',
    decF.status === 'solved' && !!decF.code, decF.detail)
  check('9c both helpers certified + composition rung certified',
    decF.rungs.length === 3 && decF.rungs.every((r) => r.certified), decF.rungs.map((r) => `${r.name}:${r.certified}`).join(' '))
  check('9d certified module contains helpers AND the composed top-level fn',
    !!decF.code && decF.code.includes('function g') && decF.code.includes('function h') && /f\(x\)\s*{\s*return g\(x\)/.test(decF.code!))

  // 9e SOUNDNESS: an UNTRUSTED plan with a WRONG helper example (h should be x+1, claim x+5)
  //    lets h "certify" a wrong helper, but the composition then fails the ORIGINAL f cases. ──
  const wrongPlan: SubFunctionPlanner = async () => [
    { name: 'g', goal: 'double x', cases: [{ args: [2], expected: 4 }] },
    { name: 'h', goal: 'increment x', cases: [{ args: [2], expected: 7 }] }, // WRONG: weak proposer emits x+1 → h can't even certify this
  ]
  const badF = await decomposeCodeBySubFunction(fInput, { planner: wrongPlan, iterate: { maxEpochs: 2, baseModelCalls: 3, globalModelCalls: 8 } }, subWeak)
  check('9e a wrong helper example collapses honestly, never a false solve',
    badF.status === 'decompose-failed' && badF.code === null, badF.detail)

  // 9f/9g CARRY-FORWARD across planAttempts. Plan [gg, kk]: gg certifies immediately; kk fails
  //   the first attempt's budget and only certifies once its proposer has been called >3 times
  //   (i.e. on the SECOND plan attempt). With carry-forward, gg (already certified attempt 0) is
  //   REUSED on attempt 1 at zero cost rather than re-ground — the exact waste the DP-fold
  //   scorecard exposed. We assert (a) it still solves and (b) the reuse path actually fired.
  let ggCalls = 0, kkCalls = 0
  const carryProposer: Proposer<string> = async (ctx) => {
    const acc = ctx.spec.acceptance as { entry: string }
    const ctxt = ctx.spec.context ?? ''
    if (acc.entry === 'gg') { ggCalls++; return { value: 'export function gg(x) { return x * 2; }', fingerprint: 'gg' } }
    if (acc.entry === 'kk') { kkCalls++; return { value: kkCalls > 3 ? 'export function kk(x) { return x * 3; }' : 'export function kk(x) { return x; }', fingerprint: `kk${kkCalls}` } }
    if (acc.entry === 'ff') {
      const wired = ctxt.includes('function gg') && ctxt.includes('function kk')
      return wired ? { value: 'export function ff(x) { return gg(x) + kk(x); }', fingerprint: 'ff-ok' } : { value: 'export function ff(x) { return x; }', fingerprint: 'ff-bad' }
    }
    return { value: 'export function ff(x){return x}', fingerprint: 'na' }
  }
  const ffInput = { goal: 'compute ff(x) = gg(x) + kk(x)', entry: 'ff', cases: [{ args: [1], expected: 5 }, { args: [2], expected: 10 }] }
  const carryPlan: SubFunctionPlanner = async () => [
    { name: 'gg', goal: 'double x', cases: [{ args: [2], expected: 4 }, { args: [5], expected: 10 }] },
    { name: 'kk', goal: 'triple x', cases: [{ args: [2], expected: 6 }, { args: [1], expected: 3 }] },
  ]
  const carryEvents: string[] = []
  const carried = await decomposeCodeBySubFunction(
    ffInput,
    // maxDepth 0 isolates the plan-RETRY + carry mechanism from recursive decomposition: this test's
    // planner is not goal-aware, so we exercise the outer planAttempts path deliberately, not recursion.
    { planner: carryPlan, planAttempts: 3, maxDepth: 0, iterate: { maxEpochs: 3, baseModelCalls: 3, globalModelCalls: 3 },
      emit: (e: any) => { if (e?.type === 'thought' && typeof e.text === 'string') carryEvents.push(e.text) } },
    carryProposer,
  )
  check('9h carry-forward: task solves on a later plan attempt', carried.status === 'solved' && !!carried.code, carried.detail)
  check('9i carry-forward: the already-certified helper was reused (0 calls), not re-ground',
    carryEvents.some((t) => /gg` reused from a prior attempt/.test(t)) && ggCalls === 1, `ggCalls=${ggCalls} events=${carryEvents.filter(t => /reused/.test(t)).length}`)

  // 9j/9k/9l RECURSIVE DECOMPOSITION. The top plan carves ONE helper `hard(x) = sq(x)+1` that the
  //   proposer CANNOT one-shot (with no `sq` in context it returns the identity → flat iterate stalls).
  //   Instead of collapsing, the loop re-decomposes `hard` itself: a sub-plan carves `sq`, the proposer
  //   one-shots it, and `hard` composes from `sq`. The whole thing then composes into `mainf = hard*2`.
  //   Models the real failure mode: a helper that is STILL too hard until subdivided one level further.
  const recProposer: Proposer<string> = async (ctx) => {
    const entry = (ctx.spec.acceptance as { entry: string }).entry
    const ctxt = ctx.spec.context ?? ''
    if (entry === 'sq') return { value: 'export function sq(x) { return x * x; }', fingerprint: 'sq' }
    if (entry === 'hard') {
      return ctxt.includes('function sq')
        ? { value: 'export function hard(x) { return sq(x) + 1; }', fingerprint: 'hard-ok' }
        : { value: 'export function hard(x) { return x; }', fingerprint: 'hard-bad' } // can't one-shot without sq
    }
    if (entry === 'mainf') {
      return ctxt.includes('function hard')
        ? { value: 'export function mainf(x) { return hard(x) * 2; }', fingerprint: 'mainf-ok' }
        : { value: 'export function mainf(x) { return x; }', fingerprint: 'mainf-bad' }
    }
    return { value: 'export function f(x){return x}', fingerprint: 'na' }
  }
  // Goal-keyed planner: the TOP goal carves `hard`; `hard`'s OWN goal carves `sq`.
  const recPlan: SubFunctionPlanner = async (inp) => {
    if (inp.entry === 'mainf') return [{ name: 'hard', goal: 'compute hard(x) = sq(x) + 1', cases: [{ args: [2], expected: 5 }, { args: [3], expected: 10 }] }]
    if (inp.entry === 'hard') return [{ name: 'sq', goal: 'square x', cases: [{ args: [2], expected: 4 }, { args: [3], expected: 9 }] }]
    return null
  }
  const recInput = { goal: 'compute mainf(x) = 2*(x*x + 1)', entry: 'mainf', cases: [{ args: [2], expected: 10 }, { args: [3], expected: 20 }] }
  const recEvents: string[] = []
  const recOpts = { planner: recPlan, planAttempts: 1, iterate: { maxEpochs: 3, baseModelCalls: 3, globalModelCalls: 3 },
    emit: (e: any) => { if (e?.type === 'thought' && typeof e.text === 'string') recEvents.push(e.text) } }
  const recursed = await decomposeCodeBySubFunction(recInput, { ...recOpts, maxDepth: 1 }, recProposer)
  check('9j recursion: a helper too hard to one-shot solves when re-decomposed one level deeper',
    recursed.status === 'solved' && !!recursed.code, recursed.detail)
  check('9k recursion: the recursive path actually fired (not a flat solve)',
    recEvents.some((t) => /recursing \(depth 1/.test(t)) && recEvents.some((t) => /certified via recursion/.test(t)), recEvents.filter(t => /recurs/.test(t)).join(' | '))
  check('9l recursion: the sub-helper `sq` is carried into the final composed module (not dropped)',
    !!recursed.code && /function sq/.test(recursed.code) && /function hard/.test(recursed.code) && /function mainf/.test(recursed.code), (recursed.code ?? '').slice(0, 80))
  // 9m SOUNDNESS/CONTROL: with recursion DISABLED (maxDepth 0) the SAME setup fails honestly — proving
  //   it is recursion, not the flat path, that earned the solve, and that the depth bound is respected.
  const noRec = await decomposeCodeBySubFunction(recInput, { ...recOpts, maxDepth: 0 }, recProposer)
  check('9m recursion bound: maxDepth 0 makes the same task fail honestly (no false solve)',
    noRec.status === 'decompose-failed' && noRec.code === null, noRec.detail)

  // 9n/9o/9p COMPOSE-RUNG RECOVERY. The live FM-general run (numberToWords, 2026-07-25) failed in the
  //   shape recursion did NOT cover: every helper certified in one call, and the COMPOSITION stalled —
  //   the planner left the difficulty in the glue. Here `easy` certifies, but `mainf` cannot be written
  //   from `easy` alone (the proposer needs a `dbl` that no one planned). The compose stall must now
  //   re-decompose the task one level deeper (glue plan) instead of throwing the certified helper away.
  const glueProposer: Proposer<string> = async (ctx) => {
    const entry = (ctx.spec.acceptance as { entry: string }).entry
    const ctxt = ctx.spec.context ?? ''
    if (entry === 'easy') return { value: 'export function easy(x) { return x * x; }', fingerprint: 'easy' }
    if (entry === 'dbl') return { value: 'export function dbl(x) { return x * 2; }', fingerprint: 'dbl' }
    if (entry === 'mainf') {
      return ctxt.includes('function dbl')
        ? { value: 'export function mainf(x) { return dbl(easy(x)) + 2; }', fingerprint: 'mainf-ok' }
        : { value: 'export function mainf(x) { return easy(x); }', fingerprint: 'mainf-bad' } // glue missing
    }
    return { value: 'export function f(x){return x}', fingerprint: 'na' }
  }
  // The glue re-decomposition appends a "do NOT re-plan" note naming the certified helpers — key on it.
  const gluePlan: SubFunctionPlanner = async (inp) => {
    if (/do NOT re-plan/.test(inp.goal)) return [{ name: 'dbl', goal: 'double x', cases: [{ args: [4], expected: 8 }, { args: [9], expected: 18 }] }]
    return [{ name: 'easy', goal: 'square x', cases: [{ args: [2], expected: 4 }, { args: [3], expected: 9 }] }]
  }
  const glueInput = { goal: 'compute mainf(x) = 2*(x*x) + 2', entry: 'mainf', cases: [{ args: [2], expected: 10 }, { args: [3], expected: 20 }] }
  const glueEvents: string[] = []
  const glueOpts = { planner: gluePlan, planAttempts: 1, iterate: { maxEpochs: 3, baseModelCalls: 3, globalModelCalls: 3 },
    emit: (e: any) => { if (e?.type === 'thought' && typeof e.text === 'string') glueEvents.push(e.text) } }
  const glued = await decomposeCodeBySubFunction(glueInput, { ...glueOpts, maxDepth: 1 }, glueProposer)
  check('9n compose-stall: a plan whose difficulty is in the GLUE now solves via re-decomposition',
    glued.status === 'solved' && !!glued.code, glued.detail)
  check('9o compose-stall: the glue path actually fired and its rungs are attributed',
    glueEvents.some((t) => /re-decomposing the glue \(depth 1/.test(t)) && glued.rungs.some((r) => r.name.startsWith('glue/')),
    glued.rungs.map((r) => r.name).join(','))
  check('9p compose-stall: the certified module really contains helper + glue + top (verified whole)',
    !!glued.code && /function easy/.test(glued.code) && /function dbl/.test(glued.code) && /function mainf/.test(glued.code),
    (glued.code ?? '').slice(0, 80))
  // 9q CONTROL: with maxDepth 0 the identical setup fails honestly — the glue recovery, not the flat
  //   compose rung, is what earned the solve, and the depth bound is respected.
  const noGlue = await decomposeCodeBySubFunction(glueInput, { ...glueOpts, maxDepth: 0 }, glueProposer)
  check('9q compose-stall bound: maxDepth 0 makes the same task fail honestly (no false solve)',
    noGlue.status === 'decompose-failed' && noGlue.code === null, noGlue.detail)

  // 9r SUB-LEVEL BUDGET. A recovery level is a smaller problem and must get a smaller purse, or a
  //   stuck rung's cost compounds with depth (live: 595s on ONE pinned rung before recursion began).
  const scaled = subLevelIterateBudget({ globalModelCalls: 40, wallClockMs: 420_000, maxEpochs: 12 })
  check('9r sub-level budget scales the child down, never up',
    scaled.globalModelCalls === 24 && scaled.wallClockMs === 252_000 && scaled.maxEpochs === 7, JSON.stringify(scaled))
  const floored = subLevelIterateBudget({ globalModelCalls: 2, wallClockMs: 5_000, maxEpochs: 1 })
  check('9r2 sub-level budget floors keep a scaled child usable (a 1-call rung can only abstain)',
    floored.globalModelCalls === 3 && floored.wallClockMs === 30_000 && floored.maxEpochs === 2, JSON.stringify(floored))
  check('9r3 sub-level budget leaves unset knobs unset (no invented caps)',
    Object.keys(subLevelIterateBudget(undefined)).length === 0 && subLevelIterateBudget({ maxEpochs: 10 }).globalModelCalls === undefined)

  // 9s/9t/9u PLAN DEDUPE. The live FM-general carve (numberToWords, 2026-07-25) repeated a helper
  //   name — `convertToWords, pluralize, convertToWordsHelper, convertToWordsHelper`. Each copy used
  //   to be ground as its own rung (a full per-rung budget spent twice on one goal) and both certified
  //   sources landed in the module, where the second `function` declaration silently shadows the first.
  const dupSeen: string[] = []
  const dupProposer: Proposer<string> = async (ctx) => {
    const entry = (ctx.spec.acceptance as { entry: string }).entry
    dupSeen.push(entry)
    if (entry === 'sq') return { value: 'export function sq(x) { return x * x; }', fingerprint: 'sq' }
    if (entry === 'inc') return { value: 'export function inc(x) { return x + 1; }', fingerprint: 'inc' }
    return { value: 'export function topf(x) { return inc(sq(x)); }', fingerprint: 'topf' }
  }
  const dupCases = [{ args: [2], expected: 5 }, { args: [3], expected: 10 }]
  const dupPlan: SubFunctionPlanner = async () => [
    { name: 'sq', goal: 'square x', cases: [{ args: [2], expected: 4 }, { args: [3], expected: 9 }] },
    { name: 'sq', goal: 'square x again (planner repeat)', cases: [{ args: [4], expected: 16 }, { args: [5], expected: 25 }] },
    { name: 'inc', goal: 'add one to x', cases: [{ args: [4], expected: 5 }, { args: [9], expected: 10 }] },
  ]
  const dupEvents: string[] = []
  const deduped = await decomposeCodeBySubFunction(
    { goal: 'compute topf(x) = x*x + 1', entry: 'topf', cases: dupCases },
    { planner: dupPlan, planAttempts: 1, iterate: { maxEpochs: 3, baseModelCalls: 3, globalModelCalls: 6 },
      emit: (e: any) => { if (e?.type === 'thought' && typeof e.text === 'string') dupEvents.push(e.text) } },
    dupProposer,
  )
  check('9s plan dedupe: a repeated helper name is ground ONCE, not once per copy',
    dupSeen.filter((e) => e === 'sq').length === 1, `sq rungs: ${dupSeen.filter((e) => e === 'sq').length} (${dupSeen.join(',')})`)
  check('9t plan dedupe: the certified module declares the repeated helper exactly once',
    deduped.status === 'solved' && !!deduped.code && (deduped.code.match(/function sq\b/g) ?? []).length === 1,
    `${deduped.status} / ${(deduped.code ?? '').match(/function sq\b/g)?.length ?? 0} decls`)
  check('9u plan dedupe: the announced carve lists each helper name once',
    dupEvents.some((t) => /^subfn: 2 helper\(s\) — sq, inc$/.test(t)), dupEvents.find((t) => /^subfn: \d+ helper/.test(t)) ?? '(none)')

  // 9v–9y PARTIAL-PLAN SALVAGE. Live `isBalanced` (general scorecard, 2026-07-25b) declined at ZERO
  //   model calls in 17s: the whole-array JSON.parse is all-or-nothing, so one bad character from the
  //   1.5B discarded a four-helper plan including the well-formed siblings. The reply below is the
  //   REAL captured shape — on a bracket-matching goal the model emitted unbalanced brackets itself
  //   (`]},` for `],`, and `{")]` for `{"]`).
  const malformed = `[
  { "name": "isPair", "purpose": "pair check",
    "examples": [ {"args":["(","("], "expected":true}, {"args":["(","]"], "expected":false} ] },
  { "name": "isBracket", "purpose": "bracket check",
    "examples": [ {"args":["(","{"]}, "expected":true}, {"args":["(","}"], "expected":false} ] },
  { "name": "isNested", "purpose": "nesting check",
    "examples": [ {"args":["(","(","{")], "expected":true} ] },
  { "name": "isOpen", "purpose": "open check",
    "examples": [ {"args":["("], "expected":true}, {"args":[")"], "expected":false} ] }
]`
  const salvagedNames = parseSubFunctionPlan(malformed).map((h) => h.name)
  check('9v salvage: a malformed sibling no longer discards the whole plan (0 helpers → some)',
    salvagedNames.length > 0, `got ${JSON.stringify(salvagedNames)}`)
  check('9w salvage: exactly the well-formed helpers survive; the broken ones are dropped',
    salvagedNames.join(',') === 'isPair,isOpen', salvagedNames.join(','))
  // The happy path must be untouched — salvage is a FALLBACK, only reached when JSON.parse throws.
  const wellFormed = `[{"name":"a","purpose":"p","examples":[{"args":[1],"expected":2}]},
                       {"name":"b","purpose":"q","examples":[{"args":[2],"expected":3}]}]`
  check('9x salvage: a fully-valid array parses exactly as before (fallback not engaged)',
    parseSubFunctionPlan(wellFormed).map((h) => h.name).join(',') === 'a,b')
  // String-awareness matters precisely because the PAYLOADS here are brace/bracket characters: a
  // `{` inside a JSON string literal must not open a span, or the scan desynchronises on this class.
  const braceInString = `[{"name":"c","purpose":"handles } and { chars","examples":[{"args":["{"],"expected":true}]},` +
                        `{"name":"d","purpose":"broken sibling","examples":[{"args":["("]}, "expected":true}]}]`
  check('9y salvage is string-aware: braces inside string literals do not break the span',
    parseSubFunctionPlan(braceInString).map((h) => h.name).join(',') === 'c',
    JSON.stringify(parseSubFunctionPlan(braceInString)))

  // 9f DECLINES when the planner offers nothing / only the top-level name.
  const noPlan = await decomposeCodeBySubFunction(fInput, { planner: async () => null }, subWeak)
  check('9f planner with no helpers → declined', noPlan.status === 'declined', noPlan.detail)
  const selfPlan = await decomposeCodeBySubFunction(fInput, { planner: async () => [{ name: 'f', goal: 'self', cases: F_CASES }] }, subWeak)
  check('9g a helper colliding with the top-level name is dropped → declined', selfPlan.status === 'declined', selfPlan.detail)

  // 9h PLAN-RETRY: the first plan is bad (a helper the weak proposer can't certify), the
  //    second plan is good. decomposeCodeBySubFunction must resample and solve. Mirrors the
  //    live finding that decomposition QUALITY is high-variance but one good sample suffices. ──
  let planCall = 0
  const flakyPlan: SubFunctionPlanner = async () => {
    planCall++
    return planCall === 1
      ? [{ name: 'g', goal: 'double', cases: [{ args: [2], expected: 4 }] },
         { name: 'z', goal: 'impossible', cases: [{ args: [1], expected: 999 }] }] // weak proposer can't make z
      : [{ name: 'g', goal: 'double', cases: [{ args: [2], expected: 4 }] },
         { name: 'h', goal: 'increment', cases: [{ args: [2], expected: 3 }] }]
  }
  const retried = await decomposeCodeBySubFunction(fInput,
    { planner: flakyPlan, planAttempts: 3, iterate: { maxEpochs: 2, baseModelCalls: 3, globalModelCalls: 8 } }, subWeak)
  check('9h plan-retry resamples a bad plan and solves on a good one',
    retried.status === 'solved' && planCall >= 2, `status=${retried.status} plans=${planCall}`)

  // ── 10. SUB-FUNCTION PLAN PARSING — tolerate fences, prose, bad identifiers, missing examples. ──
  check('10 parses a clean JSON helper array',
    parseSubFunctionPlan('[{"name":"parseSuffix","purpose":"get am/pm","examples":[{"args":["1:00pm"],"expected":"pm"}]}]').length === 1)
  check('10b strips ```json fences and leading prose',
    parseSubFunctionPlan('Here you go:\n```json\n[{"name":"a","examples":[{"args":[1],"expected":2}]}]\n```').length === 1)
  check('10c drops helpers with no checkable examples',
    parseSubFunctionPlan('[{"name":"a","purpose":"x"},{"name":"b","examples":[{"args":[1],"expected":2}]}]').length === 1)
  check('10d rejects invalid identifiers',
    parseSubFunctionPlan('[{"name":"2bad","examples":[{"args":[1],"expected":2}]}]').length === 0)
  check('10e non-JSON prose yields nothing', parseSubFunctionPlan('just try harder').length === 0)

  // ── 11. PRECEDENCE-AWARE TEMPLATE — the algorithm-shaped carve for the arithmetic class. ──
  // The live probe (2026-07-22k) proved the FM planner re-bakes basicCalculator's whole
  // precedence problem into one un-certifiable helper. The template forces the textbook
  // two-pass carve instead. These checks are hermetic (no FM): they verify the CLASS DETECTOR
  // fires only where it should, the plan has the right shape, and — critically — that the three
  // helper interfaces COMPOSE to a correct calculator on the 5 adversarial cases, so the plan
  // the decomposer proposes is genuinely solvable (soundness is owned by re-verify regardless).
  const calcGoal =
    'Write basicCalculator(s: string): number evaluating an arithmetic expression string ' +
    'containing non-negative integers and the operators + - * / with standard precedence ' +
    '(* and / before + and -) and no parentheses. Division truncates toward zero.'
  check('11 class detector fires on the calculator goal', isArithmeticExprGoal(calcGoal, 'basicCalculator'))
  check('11b class detector fires on a parenless "order of operations" phrasing',
    isArithmeticExprGoal('evaluate the expression respecting order of operations for + - * /', 'evalExpr'))
  check('11c class detector does NOT fire on an unrelated goal',
    !isArithmeticExprGoal('reverse a linked list in place', 'reverseList') &&
    !isArithmeticExprGoal('return the sum of an array of numbers', 'sumArray'))
  const tpl = precedenceTemplatePlan()
  const NAMES = 'tokenizeExpr,parseTokens,foldMulDiv,foldAddSub'
  check('11d template proposes the four-helper carve tokenize/parseTokens/foldMulDiv/foldAddSub',
    tpl.length === 4 && tpl.map((h) => h.name).join(',') === NAMES, tpl.map((h) => h.name).join(','))
  check('11e default sub-function planner returns the template for the calculator class (0 model calls)',
    (await makeFmSubFunctionPlanner()(calcGoal, 'basicCalculator', [], undefined))?.map((h) => h.name).join(',') === NAMES)
  // Reference impls following each helper's declared NATURAL-TYPED interface EXACTLY.
  type Tok = number | string
  const refTok = (s: string): string[] => s.replace(/\s+/g, '').match(/\d+|[-+*/]/g) ?? []
  const refParse = (tok: string[]): Tok[] => tok.map((t) => ('+-*/'.includes(t) ? t : Number(t)))
  const refMD = (it: Tok[]): Tok[] => { const o: Tok[] = [it[0]]; for (let i = 1; i < it.length; i += 2) { const op = it[i], b = it[i + 1] as number; if (op === '*') o[o.length - 1] = (o[o.length - 1] as number) * b; else if (op === '/') o[o.length - 1] = Math.trunc((o[o.length - 1] as number) / b); else { o.push(op); o.push(b) } } return o }
  const refAS = (it: Tok[]): number => { let a = it[0] as number; for (let i = 1; i < it.length; i += 2) { a = it[i] === '+' ? a + (it[i + 1] as number) : a - (it[i + 1] as number) } return a }
  const eqj = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  // Each helper's SEED cases must be satisfiable by a correct impl of that helper (else the rung
  // is impossible to certify and the template is broken).
  const implFor: Record<string, (...a: unknown[]) => unknown> = {
    tokenizeExpr: refTok as never, parseTokens: refParse as never, foldMulDiv: refMD as never, foldAddSub: refAS as never,
  }
  const seedOk = tpl.every((h) => h.cases.every((c) => eqj(implFor[h.name](...c.args), c.expected)))
  check('11f every template seed case is satisfied by a correct impl of that helper', seedOk)
  // COMPOSITION: foldAddSub(foldMulDiv(parseTokens(tokenizeExpr(s)))) must equal the calculator.
  const compCases: [string, number][] = [['3+2*2', 7], [' 3/2 ', 1], ['3+5 / 2', 5], ['14-3*2', 8], ['2*3+4*5', 26], ['6/2*3', 9], ['2+3*4-6/2', 11]]
  const compOk = compCases.every(([s, e]) => refAS(refMD(refParse(refTok(s)))) === e)
  check('11g the four helpers compose to a correct calculator on all adversarial cases', compOk)

  // ── 12. RPN / postfix template — the SECOND 0%-by-sampling class (generalization proof). ──
  // Same doctrine: applyOp isolates the two traps the flat 1.5B fails (operand order + trunc div),
  // the composition wires the stack. These checks verify the detector, dispatch precedence (RPN is
  // more specific than arithmetic and must win), and that applyOp + a stack fold compose correctly.
  const rpnGoal = 'Write evalRPN(tokens: string[]): number evaluating a Reverse Polish Notation expression. Operators are + - * /. Division truncates toward zero.'
  check('12 RPN detector fires on the evalRPN goal', isRpnGoal(rpnGoal, 'evalRPN'))
  check('12b RPN detector does NOT fire on the infix calculator goal', !isRpnGoal(calcGoal, 'basicCalculator'))
  check('12c templateFor dispatches RPN goal to the isOperator+applyOp carve (RPN wins over arithmetic)',
    templateFor(rpnGoal, 'evalRPN')?.map((h) => h.name).join(',') === 'isOperator,applyOp',
    templateFor(rpnGoal, 'evalRPN')?.map((h) => h.name).join(','))
  check('12d templateFor still dispatches the infix calculator to the four-helper carve',
    templateFor(calcGoal, 'basicCalculator')?.map((h) => h.name).join(',') === NAMES)
  const rpnTpl = rpnTemplatePlan()
  const refIsOp = (t: string): boolean => t.length === 1 && '+-*/'.includes(t)
  const refApply = (op: string, a: number, b: number): number => op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : Math.trunc(a / b)
  const rpnImplFor: Record<string, (...a: any[]) => unknown> = { isOperator: refIsOp, applyOp: refApply }
  check('12e every RPN helper seed case is satisfied by a correct impl',
    rpnTpl.every((h) => h.cases.every((c) => rpnImplFor[h.name](...c.args) === c.expected)))
  const refRpn = (tokens: string[]): number => { const s: number[] = []; for (const t of tokens) { if (refIsOp(t)) { const b = s.pop()!, a = s.pop()!; s.push(refApply(t, a, b)) } else s.push(Number(t)) } return s[0] }
  const rpnCases: [string[], number][] = [[['2', '1', '+', '3', '*'], 9], [['4', '13', '5', '/', '+'], 6], [['6', '-4', '/'], -1], [['-7'], -7], [['10', '2', '-', '3', '*'], 24], [['10', '3', '-'], 7]]
  check('12f applyOp + a stack fold compose to a correct RPN evaluator on all adversarial cases',
    rpnCases.every(([t, e]) => refRpn(t) === e))

  // ── 13. EDIT-DISTANCE template — the THIRD 0%-by-sampling class (a genuinely NEW family: DP). ──
  // Flat solveCodeTask EXHAUSTS on editDistance (the 2D recurrence is beyond one-shot); the carve
  // splits it into three idiom-bearing helpers (subCost, nextRow, editRow) whose composition is a
  // one-line index. These checks verify the detector, dispatch disjointness, that the three helper
  // interfaces COMPOSE to a correct Levenshtein on adversarial cases, and that composeHintFor supplies
  // the last-cell index the compose rung can't infer from signatures.
  const edGoal = 'Write editDistance(a: string, b: string): number returning the Levenshtein edit distance between a and b: the minimum number of single-character insertions, deletions, or substitutions to turn a into b.'
  check('13 edit-distance detector fires on the editDistance goal', isEditDistanceGoal(edGoal, 'editDistance'))
  check('13b edit-distance detector fires on a "levenshtein" phrasing',
    isEditDistanceGoal('compute the levenshtein distance between two words', 'lev'))
  check('13c edit-distance detector does NOT fire on unrelated distance goals',
    !isEditDistanceGoal('return the euclidean distance between two points', 'dist') &&
    !isEditDistanceGoal('edit the record in place', 'editRecord'))
  check('13d edit-distance detector does NOT fire on the infix calculator or RPN goals',
    !isEditDistanceGoal(calcGoal, 'basicCalculator') && !isEditDistanceGoal(rpnGoal, 'evalRPN'))
  check('13e templateFor dispatches the edit-distance goal to the subCost/nextRow/editRow carve',
    templateFor(edGoal, 'editDistance')?.map((h) => h.name).join(',') === 'subCost,nextRow,editRow',
    templateFor(edGoal, 'editDistance')?.map((h) => h.name).join(','))
  check('13f templateFor still routes RPN and infix correctly after adding the edit-distance class',
    templateFor(rpnGoal, 'evalRPN')?.map((h) => h.name).join(',') === 'isOperator,applyOp' &&
    templateFor(calcGoal, 'basicCalculator')?.map((h) => h.name).join(',') === NAMES)
  const edTpl = editDistanceTemplatePlan()
  const refSub = (x: string, y: string): number => (x === y ? 0 : 1)
  const refNext = (prev: number[], ca: string, b: string): number[] => { const cur = [prev[0] + 1]; for (let j = 0; j < b.length; j++) cur.push(Math.min(prev[j + 1] + 1, cur[j] + 1, prev[j] + refSub(ca, b[j]))); return cur }
  const refEditRow = (a: string, b: string): number[] => { let row: number[] = []; for (let j = 0; j <= b.length; j++) row.push(j); for (const ch of a) row = refNext(row, ch, b); return row }
  const edImplFor: Record<string, (...a: any[]) => unknown> = { subCost: refSub, nextRow: refNext, editRow: refEditRow }
  const eqj2 = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  check('13g every edit-distance helper seed case is satisfied by a correct impl',
    edTpl.every((h) => h.cases.every((c) => eqj2(edImplFor[h.name](...c.args), c.expected))))
  const refEdit = (a: string, b: string): number => refEditRow(a, b)[b.length]
  const edCases: [string, string, number][] = [
    ['kitten', 'sitting', 3], ['flaw', 'lawn', 2], ['', 'abc', 3], ['abc', '', 3], ['abc', 'abc', 0],
    ['sunday', 'saturday', 3], ['intention', 'execution', 5], ['ab', 'ba', 2],
  ]
  check('13h subCost + nextRow + editRow compose to a correct Levenshtein on all adversarial cases',
    edCases.every(([a, b, e]) => refEdit(a, b) === e))
  check('13i composeHintFor supplies the last-cell index for edit-distance, null for the others',
    /editRow\(a, b\)\[b\.length\]/.test(composeHintFor(edGoal, 'editDistance') ?? '') &&
    composeHintFor(calcGoal, 'basicCalculator') === null && composeHintFor(rpnGoal, 'evalRPN') === null)

  // ── 14. COMPOSITION HYGIENE — the two helpers that unblocked the edit-distance composition. ──
  // A weak model, told to "return the full module", re-declares the certified helpers; and a helper
  // certified as a whole module carries the prior helpers it was grounded with. Both would collide
  // (`Multiple exports with the same name`) when the sources are concatenated for the composition.
  const fullModule =
    'export function subCost(x, y) { return x === y ? 0 : 1 }\n\n' +
    'export function nextRow(prev, ca, b) { const cur = [prev[0] + 1]; for (let j = 0; j < b.length; j++) { cur.push(1) } return cur }\n\n' +
    'export function editDistance(a, b) { return editRow(a, b)[b.length] }'
  check('14 extractOwnFunction keeps only the named function',
    extractOwnFunction(fullModule, 'subCost') === 'export function subCost(x, y) { return x === y ? 0 : 1 }')
  check('14b extractOwnFunction returns src unchanged when the name is absent',
    extractOwnFunction('export function foo() { return 1 }', 'bar') === 'export function foo() { return 1 }')
  check('14c stripHelperRedefinitions removes redefined helpers, leaving the entry',
    stripHelperRedefinitions(fullModule, ['subCost', 'nextRow']) === 'export function editDistance(a, b) { return editRow(a, b)[b.length] }')
  check('14d stripHelperRedefinitions is a no-op when nothing matches',
    stripHelperRedefinitions('export function editDistance(a, b) { return 0 }', ['subCost', 'nextRow']) === 'export function editDistance(a, b) { return 0 }')
  check('14e a helper-block from extracted own-functions has each helper exactly once (no collision)',
    (() => {
      // Model the real failure: each helper is certified as a WHOLE module that also redefines the
      // prior helpers it was grounded with. Extracting each helper's OWN function must dedupe them.
      const subMod = 'export function subCost(x, y) { return x === y ? 0 : 1 }'
      const nextMod = subMod + '\n\nexport function nextRow(prev, ca, b) { return [prev[0] + 1] }'
      const editRowMod = nextMod + '\n\nexport function editRow(a, b) { let row = [0]; return nextRow(row, a, b) }'
      const captured = [['subCost', subMod], ['nextRow', nextMod], ['editRow', editRowMod]] as const
      const block = captured.map(([name, src]) => extractOwnFunction(src, name)).join('\n\n')
      return (block.match(/function subCost/g) ?? []).length === 1 &&
        (block.match(/function nextRow/g) ?? []).length === 1 &&
        (block.match(/function editRow/g) ?? []).length === 1
    })())

  // ── 15. SHUNTING-YARD parenthesised-calculator template — the FOURTH class, and the one that
  //       forces GENERATION on the cold agent path: the parenless two-pass fold provably cannot
  //       evaluate grouping, so a parens calculator is a genuinely distinct algorithm (an operator
  //       stack that reorders to postfix). These checks verify the detector (fires on parens, DECLINES
  //       the parenless basicCalculator so it doesn't steal that class), dispatch precedence (parens
  //       must be routed to shunting-yard, NOT the fold), that the four helpers COMPOSE to a correct
  //       calculator on parenthesised adversarial cases, and that composeHintFor hands the compose rung
  //       the exact `evalPostfix(toPostfix(tokenize(s)))` wiring. ──
  const syGoal =
    'Write calc(s: string): number evaluating an arithmetic expression string containing non-negative ' +
    'integers, the operators + - * / with standard precedence (* and / before + and -), AND parentheses ' +
    'for grouping. Division truncates toward zero.'
  check('15 shunting-yard detector fires on the parenthesised calculator goal', isShuntingYardGoal(syGoal, 'calc'))
  check('15b shunting-yard detector fires when the algorithm is named',
    isShuntingYardGoal('evaluate the expression using the shunting-yard algorithm', 'eval'))
  check('15c shunting-yard detector DECLINES the parenless basicCalculator goal (negated parens)',
    !isShuntingYardGoal(calcGoal, 'basicCalculator'))
  check('15d shunting-yard detector does NOT fire on RPN, edit-distance, or unrelated goals',
    !isShuntingYardGoal(rpnGoal, 'evalRPN') && !isShuntingYardGoal(edGoal, 'editDistance') &&
    !isShuntingYardGoal('reverse a linked list in place', 'reverseList'))
  check('15e the parenless basicCalculator still routes to the two-pass fold (not stolen by shunting-yard)',
    templateFor(calcGoal, 'basicCalculator')?.map((h) => h.name).join(',') === NAMES)
  const SY_NAMES = 'tokenize,precedence,toPostfix,evalPostfix'
  check('15f templateFor dispatches the parens goal to the shunting-yard carve (parens wins over the fold)',
    templateFor(syGoal, 'calc')?.map((h) => h.name).join(',') === SY_NAMES,
    templateFor(syGoal, 'calc')?.map((h) => h.name).join(','))
  check('15g templateFor still routes RPN, infix, and edit-distance correctly after adding shunting-yard',
    templateFor(rpnGoal, 'evalRPN')?.map((h) => h.name).join(',') === 'isOperator,applyOp' &&
    templateFor(calcGoal, 'basicCalculator')?.map((h) => h.name).join(',') === NAMES &&
    templateFor(edGoal, 'editDistance')?.map((h) => h.name).join(',') === 'subCost,nextRow,editRow')
  const syTpl = shuntingYardTemplatePlan()
  check('15h template proposes the four-helper carve tokenize/precedence/toPostfix/evalPostfix',
    syTpl.length === 4 && syTpl.map((h) => h.name).join(',') === SY_NAMES, syTpl.map((h) => h.name).join(','))
  // Reference impls following each helper's declared interface EXACTLY (mirrors the Write-exactly idioms).
  const refSyTok = (s: string): string[] => (s.replace(/\s+/g, '').match(/\d+|[-+*/()]/g)) ?? []
  const refPrec = (op: string): number => (op === '*' || op === '/' ? 2 : 1)
  const refToPost = (tokens: string[]): string[] => {
    const out: string[] = []; const ops: string[] = []
    for (const t of tokens) {
      if (t === '(') ops.push(t)
      else if (t === ')') { while (ops.length && ops[ops.length - 1] !== '(') out.push(ops.pop()!); ops.pop() }
      else if (t.length === 1 && '+-*/'.includes(t)) {
        while (ops.length && ops[ops.length - 1] !== '(' && refPrec(ops[ops.length - 1]) >= refPrec(t)) out.push(ops.pop()!)
        ops.push(t)
      } else out.push(t)
    }
    while (ops.length) out.push(ops.pop()!)
    return out
  }
  const refEvalPost = (postfix: string[]): number => {
    const st: number[] = []
    for (const t of postfix) {
      if (t.length === 1 && '+-*/'.includes(t)) { const b = st.pop()!, a = st.pop()!; st.push(t === '+' ? a + b : t === '-' ? a - b : t === '*' ? a * b : Math.trunc(a / b)) }
      else st.push(Number(t))
    }
    return st[0]
  }
  const syImplFor: Record<string, (...a: any[]) => unknown> = { tokenize: refSyTok, precedence: refPrec, toPostfix: refToPost, evalPostfix: refEvalPost }
  const eqj3 = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  check('15i every shunting-yard helper seed case is satisfied by a correct impl',
    syTpl.every((h) => h.cases.every((c) => eqj3(syImplFor[h.name](...c.args), c.expected))))
  const refCalc = (s: string): number => refEvalPost(refToPost(refSyTok(s)))
  const syCases: [string, number][] = [
    ['3+2*2', 7], ['(1+2)*3', 9], ['2*(3+4)', 14], ['10-2*3', 4], ['(2+3)*(4-1)', 15],
    ['100/(2+3)', 20], ['2*(3+(4-1))', 12], ['((1+1))', 2], ['1+2+3+4', 10], ['(7-2)/2', 2],
  ]
  check('15j the four helpers compose to a correct parenthesised calculator on all adversarial cases',
    syCases.every(([s, e]) => refCalc(s) === e), syCases.filter(([s, e]) => refCalc(s) !== e).map(([s]) => s).join(' '))
  check('15k composeHintFor supplies the evalPostfix(toPostfix(tokenize(s))) wiring for shunting-yard, null for the fold',
    /evalPostfix\(toPostfix\(tokenize\(s\)\)\)/.test(composeHintFor(syGoal, 'calc') ?? '') &&
    composeHintFor(calcGoal, 'basicCalculator') === null)

  console.log(`\n${fail === 0 ? '✅' : '❌'} decompose bench: ${pass} passed, ${fail} failed\n`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
