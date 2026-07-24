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
import { decomposeCodeBySubFunction, decomposeCodeTask, growingCasePrefixes, iterateCodeTask, stripHelperRedefinitions, extractOwnFunction, type SubFunctionPlanner } from './solve'
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
