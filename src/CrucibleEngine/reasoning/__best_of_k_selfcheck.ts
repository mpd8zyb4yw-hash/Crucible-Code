// ═══════════════════════════════════════════════════════════════════════════════
// SELFCHECK for best-of-K plan selection (solve.ts bestOfKPlanner). No model — injected planner.
// Run:  npx tsx src/CrucibleEngine/reasoning/__best_of_k_selfcheck.ts
// ═══════════════════════════════════════════════════════════════════════════════
//
// This spends real model calls in production (k planner draws instead of 1), so the properties that
// justify it have to hold exactly: it must pick by SHAPE and not by draw order, it must cost
// exactly k calls, and k<=1 must be the identity so the default path is untouched. An injected
// planner makes all of that observable without a head.
//
// Selection is sound by construction — it only reorders which verifier-gated carve is ground first
// — so these checks are about COST and CORRECT CHOICE, not about safety.

import { bestOfKPlanner, type SubFunctionSpec } from './solve'

let passed = 0, failed = 0
const check = (n: string, c: boolean, d = '') => { if (c) { passed++; console.log(`  ✓ ${n}`) } else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`) } }

const SENT = String.fromCharCode(1)
const GOOD: SubFunctionSpec[] = [{ name: 'nextComma', goal: 'index', cases: [{ args: ['a,b', 0], expected: 1 }, { args: ['a', 0], expected: -1 }] }]
const BAD: SubFunctionSpec[] = [{ name: 'maskIt', goal: 'sentinel', cases: [{ args: ['a,b'], expected: `a${SENT}b` }, { args: ['x,y'], expected: `x${SENT}y` }] }]

const main = async () => {
  // 1) It picks the better-SHAPED plan regardless of draw order.
  for (const order of [[BAD, GOOD], [GOOD, BAD]]) {
    let i = 0
    const planner = async () => order[i++] ?? null
    const picked = await bestOfKPlanner(planner, 2)({ goal: 'g', entry: 'e', cases: [] })
    check(`picks the natural-value plan (order ${order[0] === GOOD ? 'good-first' : 'bad-first'})`, picked?.[0]?.name === 'nextComma', picked?.[0]?.name)
  }
  // 2) k<=1 is the identity — the default path must be untouched.
  let calls = 0
  const counting = async () => { calls++; return BAD }
  const same = bestOfKPlanner(counting, 1)
  const r = await same({ goal: 'g', entry: 'e', cases: [] })
  check('k=1 returns the planner unchanged (1 call, same plan)', calls === 1 && r?.[0]?.name === 'maskIt', `${calls} calls`)
  // 3) It costs exactly k planner calls.
  calls = 0
  await bestOfKPlanner(counting, 3)({ goal: 'g', entry: 'e', cases: [] })
  check('k=3 costs exactly 3 planner calls', calls === 3, String(calls))
  // 4) A planner that always declines still yields null, not a crash.
  check('all-null planner returns null', (await bestOfKPlanner(async () => null, 3)({ goal: 'g', entry: 'e', cases: [] })) === null)
  // 5) A partially-declining planner uses what it got.
  let j = 0
  const flaky = async () => (j++ === 0 ? null : GOOD)
  check('ignores declined samples and returns the rest', (await bestOfKPlanner(flaky, 2)({ goal: 'g', entry: 'e', cases: [] }))?.[0]?.name === 'nextComma')
  // 6) An aborted signal stops sampling early rather than burning k calls.
  calls = 0
  const ac = new AbortController(); ac.abort()
  await bestOfKPlanner(counting, 5)({ goal: 'g', entry: 'e', cases: [] }, ac.signal)
  check('an already-aborted signal costs 0 planner calls', calls === 0, String(calls))
  console.log(`\n${failed === 0 ? '✅' : '❌'} bestOfK: ${passed} passed, ${failed} failed`)
  if (failed) process.exit(1)
}
main()
