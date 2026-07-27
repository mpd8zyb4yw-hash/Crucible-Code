// ═══════════════════════════════════════════════════════════════════════════════
// LADDER + CARVE-PROBE bench — hermetic. No model, no network.
// Run:  npx tsx src/CrucibleEngine/reasoning/__ladder_bench.ts     (npm run ladder:bench)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Two mechanisms landed 2026-07-26/27, both of which can only ever change WHAT IS SPENT, never
// what is certified. That is precisely why they need a hermetic bench: a change that cannot make a
// wrong answer look right can still silently make the system slower, or — worse — make it REPORT
// something it did not check. Every assertion below is about spend and about honesty of reporting.
//
// The carve probe's live behaviour (does the derived spec beat the invented one on a real head?) is
// NOT measurable here and is not claimed here; it belongs to the live scorecard.

import {
  groundPlan, isUsableDerivation, pickWitnessed, probeCarve, skewRungBudget, type PlannedRung,
} from './traceCarve'
import { declaredHelpers, type TraceRun } from './traceSpec'
import { rungSpecKey, tier0Draws } from './solve'
import type { Candidate, ProposeContext } from './types'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const run = (over: Partial<TraceRun> = {}): TraceRun =>
  ({ casePassed: [], calls: [], neverCalled: [], error: null, ...over })

async function main(): Promise<void> {
  console.log('\n── tier0Draws: the blind-draw budget split ───────────────────────────')

  delete process.env.CRUCIBLE_LADDER_K
  check('1 defaults to 4 draws when the caller sets no flat budget', tier0Draws(undefined) === 4, String(tier0Draws(undefined)))
  check('1b never takes more than HALF the caller\'s flat budget', tier0Draws(6) === 3, String(tier0Draws(6)))
  check('1c a tiny budget still gets one draw, never zero', tier0Draws(1) === 1 && tier0Draws(0) === 1)
  process.env.CRUCIBLE_LADDER_K = '8'
  check('1d CRUCIBLE_LADDER_K raises the ceiling but the half-budget clamp still wins',
    tier0Draws(64) === 8 && tier0Draws(6) === 3)
  delete process.env.CRUCIBLE_LADDER_K

  console.log('\n── pickWitnessed: a spread, not the first N ──────────────────────────')

  // 20 recorded calls, only two distinct outputs, the SECOND output appearing only at the very end.
  // Taking "the first 10" would yield an all-`true` set — the exact `isBracket` failure the probe
  // exists to eliminate — so distinct outputs must be taken FIRST.
  const lopsided = [
    ...Array.from({ length: 19 }, (_, i) => ({ args: [`x${i}`], expected: true })),
    { args: ['z'], expected: false },
  ]
  const picked = pickWitnessed(lopsided)
  check('2 keeps a case for each distinct output before filling', picked.some(c => c.expected === false),
    `outputs: ${[...new Set(picked.map(c => String(c.expected)))].join(',')}`)
  check('2b respects the cap', picked.length === 10, String(picked.length))
  check('2c is a no-op below the cap', pickWitnessed([{ args: [1], expected: 2 }]).length === 1)

  console.log('\n── isUsableDerivation: only specs with teeth may replace invented ones ')

  check('3 rejects an all-true derivation (a constant satisfies it)',
    !isUsableDerivation({ helper: 'isBracket', witnesses: 3, inconsistent: false,
      cases: [{ args: ['('], expected: true }, { args: ['{'], expected: true }, { args: ['['], expected: true }] }))
  check('3b rejects a single-case derivation', !isUsableDerivation({ helper: 'h', witnesses: 1, inconsistent: false, cases: [{ args: [1], expected: 2 }] }))
  check('3c rejects an INCONSISTENT helper (stateful — no pure spec describes it)',
    !isUsableDerivation({ helper: 'h', witnesses: 4, inconsistent: true, cases: [] }))
  check('3d rejects identity-on-first-arg (identity satisfies it)',
    !isUsableDerivation({ helper: 'h', witnesses: 2, inconsistent: false, cases: [{ args: [1], expected: 1 }, { args: [2], expected: 2 }] }))
  check('3e ACCEPTS a discriminating derivation', isUsableDerivation({ helper: 'isOpen', witnesses: 6, inconsistent: false,
    cases: [{ args: ['('], expected: true }, { args: [')'], expected: false }] }))
  check('3f rejects a missing derivation', !isUsableDerivation(undefined))

  console.log('\n── groundPlan: witnessed cases in, invented cases kept where we cannot ')

  const plan: PlannedRung[] = [
    { name: 'isOpen', goal: 'is c an opening bracket', cases: [{ args: ['('], expected: true }, { args: ['['], expected: true }] },
    { name: 'matches', goal: 'do a and b pair', cases: [{ args: ['(', ')'], expected: true }] },
  ]
  const draft = 'export function isOpen(c) { return "([{".includes(c) }\nexport function matches(a,b) { return true }\nexport function isBalanced(s) { return isOpen(s[0]) }'
  const traced = run({
    casePassed: [true, true, false],
    calls: [
      { helper: 'isOpen', args: ['('], returned: true, caseIndex: 0 },
      { helper: 'isOpen', args: ['a'], returned: false, caseIndex: 1 },
      { helper: 'isOpen', args: ['?'], returned: false, caseIndex: 2 },
    ],
    neverCalled: ['matches'],
  })
  const g = groundPlan(plan, traced, draft)
  check('4 the well-witnessed rung is REGROUNDED on gold-derived I/O', g.grounded.join(',') === 'isOpen', g.grounded.join(','))
  check('4b its acceptance set is the DERIVED one, not the planner\'s invented one',
    JSON.stringify(g.plan[0].cases) === JSON.stringify([{ args: ['('], expected: true }, { args: ['a'], expected: false }]),
    JSON.stringify(g.plan[0].cases))
  check('4c the derived set EXCLUDES the call recorded on a FAILING entry case',
    !g.plan[0].cases.some(c => JSON.stringify(c.args) === '["?"]'))
  check('4d a rung with no usable derivation KEEPS the planner\'s cases (no regression)',
    JSON.stringify(g.plan[1].cases) === JSON.stringify(plan[1].cases))
  check('4e the declared-but-uncalled rung is reported DEAD', g.dead.join(',') === 'matches', g.dead.join(','))
  check('4f goals and names are preserved verbatim — only cases move',
    g.plan.map(h => `${h.name}:${h.goal}`).join('|') === plan.map(h => `${h.name}:${h.goal}`).join('|'))

  // ── THE FALSE-DEAD-RUNG TRAP. This is the assertion that protects every hermetic decompose test:
  //    a cold draw that ignores the plan entirely marks EVERY helper never-called, and treating that
  //    as "dead carve" would reject good carves on the strength of one lazy draw.
  const lazyDraft = 'export function isBalanced(s) { return s === "" }'
  const lazyRun = run({ casePassed: [true, false, false], neverCalled: ['isOpen', 'matches'], calls: [] })
  check('5 a draft that never DECLARED the helpers reports NO dead rungs (undeclared ≠ dead)',
    groundPlan(plan, lazyRun, lazyDraft).dead.length === 0)
  check('5b …and declaredHelpers is what makes that distinction, not a guess',
    declaredHelpers(lazyDraft, ['isOpen', 'matches']).length === 0 &&
    declaredHelpers(draft, ['isOpen', 'matches']).length === 2)
  check('5c ZERO passing entry cases ⇒ no dead-rung claim at all (nothing to be absent from)',
    groundPlan(plan, run({ casePassed: [false, false], neverCalled: ['matches'], calls: [] }), draft).dead.length === 0)
  check('5d …and zero passing cases derives NO specs either (witnesses only come from gold passes)',
    groundPlan(plan, run({ casePassed: [false, false], calls: [{ helper: 'isOpen', args: ['('], returned: false, caseIndex: 0 }] }), draft).grounded.length === 0)

  console.log('\n── skewRungBudget: spend where the fault is ──────────────────────────')

  const base = { globalModelCalls: 40, wallClockMs: 200_000, maxEpochs: 8 }
  const suspects = [
    { helper: 'guilty', suspicion: 0.9, failingCases: 3, passingCases: 0 },
    { helper: 'innocent', suspicion: 0.1, failingCases: 0, passingCases: 5 },
    { helper: 'unclear', suspicion: 0.5, failingCases: 2, passingCases: 2 },
  ]
  const guilty = skewRungBudget(base, suspects, 'guilty')
  const innocent = skewRungBudget(base, suspects, 'innocent')
  check('6 the SUSPECT rung gets a bigger purse', guilty.globalModelCalls === 60 && guilty.wallClockMs === 300_000,
    JSON.stringify(guilty))
  check('6b a rung the draft already got right gets a smaller one',
    innocent.globalModelCalls === 24 && innocent.wallClockMs === 120_000, JSON.stringify(innocent))
  check('6c an ambiguous rung is left alone', JSON.stringify(skewRungBudget(base, suspects, 'unclear')) === JSON.stringify(base))
  check('6d an unranked rung is left alone', JSON.stringify(skewRungBudget(base, suspects, 'nobody')) === JSON.stringify(base))
  check('6e a scaled-down budget never falls below a usable floor',
    (skewRungBudget({ globalModelCalls: 3, wallClockMs: 30_000, maxEpochs: 2 }, suspects, 'innocent').globalModelCalls ?? 0) >= 3)
  check('6f skew NEVER MUTATES the caller\'s base budget object',
    base.globalModelCalls === 40 && base.wallClockMs === 200_000)
  check('6g an absent field stays absent (we never invent a budget the caller did not set)',
    !('wallClockMs' in skewRungBudget({ globalModelCalls: 40 }, suspects, 'guilty')))

  console.log('\n── rungSpecKey: carry-forward may not cross a spec change ────────────')

  const rung = { goal: 'is c an opening bracket', cases: [{ args: ['('], expected: true }] }
  check('7 identical goal AND cases ⇒ same key (reuse is allowed)', rungSpecKey(rung) === rungSpecKey({ ...rung }))
  check('7b SAME goal, DIFFERENT cases ⇒ different key — this is the carve probe\'s rewrite, and a rung ' +
    'must not be reported certified under a spec nothing checked it against',
    rungSpecKey(rung) !== rungSpecKey({ ...rung, cases: [{ args: ['('], expected: true }, { args: [')'], expected: false }] }))
  check('7c different goal ⇒ different key', rungSpecKey(rung) !== rungSpecKey({ ...rung, goal: 'other' }))

  console.log('\n── probeCarve: end-to-end with an injected proposer (still no model) ──')

  const CASES = [{ args: ['()'], expected: true }, { args: ['('], expected: false }, { args: [''], expected: true }]
  const input = { goal: 'balanced brackets', entry: 'bal', cases: CASES }
  const fixed = (value: string): Candidate<string> => ({ value, fingerprint: value.slice(0, 12) })

  const solvedProbe = await probeCarve(input, plan,
    async () => fixed('export function isOpen(c){return c==="("}\nexport function matches(a,b){return a==="("&&b===")"}\n' +
      'export function bal(s){let d=0;for(const c of s){if(isOpen(c))d++;else if(c===")")d--;if(d<0)return false}return d===0}'),
    {})
  check('8 a probe draft that passes the ORIGINAL cases is reported SOLVED',
    solvedProbe.status === 'solved' && !!solvedProbe.certified, solvedProbe.detail)
  check('8b …and it is charged exactly ONE model call', solvedProbe.modelCalls === 1, String(solvedProbe.modelCalls))

  const groundedProbe = await probeCarve(input, plan,
    // Correct helpers, WRONG entry (never returns false for an unclosed bracket) → some gold cases
    // pass, so helper I/O on those is witnessed even though the whole is wrong.
    async () => fixed('export function isOpen(c){return c==="("}\nexport function matches(a,b){return a==="("&&b===")"}\n' +
      'export function bal(s){for(const c of s){isOpen(c)}return true}'),
    {})
  check('9 a FAILING draft still grounds rungs from the cases it DID pass',
    groundedProbe.status === 'grounded' && groundedProbe.grounded.includes('isOpen'), groundedProbe.detail)
  check('9b the grounded rung\'s cases are witnessed, not invented',
    (groundedProbe.plan.find(h => h.name === 'isOpen')?.cases.length ?? 0) >= 2)
  check('9c it is NOT reported as solved (verifyCode owns that judgement)', groundedProbe.certified === null)

  const nullProbe = await probeCarve(input, plan, async () => null, {})
  check('10 a proposer that returns nothing is UNINFORMATIVE and keeps the plan verbatim',
    nullProbe.status === 'uninformative' && nullProbe.plan === plan, nullProbe.detail)

  const throwProbe = await probeCarve(input, plan, async () => { throw new Error('head down') }, {})
  check('10b a THROWING proposer never propagates — a probe is an optimisation, not a dependency',
    throwProbe.status === 'uninformative' && throwProbe.modelCalls === 0, throwProbe.detail)

  const junkProbe = await probeCarve(input, plan, async () => fixed('this is not javascript {{{'), {})
  check('10c an uncompilable draft degrades to uninformative, not a crash', junkProbe.status === 'uninformative', junkProbe.detail)

  const modelFree = await probeCarve(input, plan,
    async (_c: ProposeContext<string>) => ({ ...fixed('export function bal(s){return true}'), modelFree: true }), {})
  check('10d a MODEL-FREE candidate is not charged to the model budget', modelFree.modelCalls === 0)

  const aborted = await probeCarve(input, plan, async () => fixed('x'), { signal: AbortSignal.abort() })
  check('10e an aborted probe draws nothing', aborted.status === 'uninformative' && aborted.modelCalls === 0)

  console.log(`\n${fail === 0 ? '✅' : '❌'} ladder + carve-probe bench: ${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error('ladder bench failed:', e); process.exit(1) })
