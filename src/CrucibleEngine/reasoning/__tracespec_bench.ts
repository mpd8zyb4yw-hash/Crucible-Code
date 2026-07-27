// ═══════════════════════════════════════════════════════════════════════════════
// OFFLINE bench for trace-derived helper specs + fault localization. ZERO model calls.
// Run:  npx tsx src/CrucibleEngine/reasoning/__tracespec_bench.ts
// ═══════════════════════════════════════════════════════════════════════════════
//
// The claim under test is the one that matters for soundness: helper specs DERIVED by executing
// the entry's gold cases are grounded in ground truth, where the planner's INVENTED cases are
// not. So the bench uses the very carve the live head produced for `isBalanced` — the one whose
// invented spec let `() => true` certify `isBracket` — and shows the derived spec instead.
//
// It also tests the negative direction, which is where a fault-localization scheme usually
// cheats: a correct helper must NOT be blamed, and a helper the composition never reaches must
// be reported as dead rather than merely unlucky.

import {
  instrumentForTrace, traceEntryCases, deriveHelperSpecs, localizeFault,
  isNonDiscriminating, describeLocalization, declaredHelpers,
} from './traceSpec'
import type { CodeAcceptance } from './codeVerifier'

const BAL_CASES: CodeAcceptance['cases'] = [
  { args: [''], expected: true }, { args: ['abc'], expected: true }, { args: ['({[]})'], expected: true },
  { args: ['(]'], expected: false }, { args: ['([)]'], expected: false },
  { args: ['a(b[c]{d})e'], expected: true }, { args: ['((('], expected: false },
]
const BAL_ACC: CodeAcceptance = { entry: 'isBalanced', cases: BAL_CASES }

// A CORRECT carve: three helpers, all reached, entry passes every gold case.
const CORRECT = `
export function isOpen(ch) { return ch === '(' || ch === '[' || ch === '{' }
export function isClose(ch) { return ch === ')' || ch === ']' || ch === '}' }
export function matches(open, close) {
  return (open === '(' && close === ')') || (open === '[' && close === ']') || (open === '{' && close === '}')
}
export function isBalanced(s) {
  const st = []
  for (const ch of s) {
    if (isOpen(ch)) st.push(ch)
    else if (isClose(ch)) { if (!st.length || !matches(st.pop(), ch)) return false }
  }
  return st.length === 0
}
`

// The LIVE failure mode: the entry forgets that non-bracket characters are ignored, so it
// returns false for "abc" and "a(b[c]{d})e". The bug is in the ENTRY, not in the helpers —
// localization must not blame a correct helper.
const BUGGY_ENTRY = `
export function isOpen(ch) { return ch === '(' || ch === '[' || ch === '{' }
export function isClose(ch) { return ch === ')' || ch === ']' || ch === '}' }
export function matches(open, close) {
  return (open === '(' && close === ')') || (open === '[' && close === ']') || (open === '{' && close === '}')
}
export function isBalanced(s) {
  const st = []
  for (const ch of s) {
    if (isOpen(ch)) st.push(ch)
    else if (isClose(ch)) { if (!st.length || !matches(st.pop(), ch)) return false }
    else return false          // ← the bug: every other character is supposed to be IGNORED
  }
  return st.length === 0
}
`

// A carve with a DEAD rung — `isBracketPair` is planned and implemented but never reached. This
// is the shape the live planner produced (isBracket / isOpenBracket / isClosingBracket /
// isBracketPair for what is one set-membership test).
const DEAD_RUNG = `
export function isOpen(ch) { return ch === '(' || ch === '[' || ch === '{' }
export function isClose(ch) { return ch === ')' || ch === ']' || ch === '}' }
export function matches(open, close) {
  return (open === '(' && close === ')') || (open === '[' && close === ']') || (open === '{' && close === '}')
}
export function isBracketPair(a, b) { return matches(a, b) }
export function isBalanced(s) {
  const st = []
  for (const ch of s) {
    if (isOpen(ch)) st.push(ch)
    else if (isClose(ch)) { if (!st.length || !matches(st.pop(), ch)) return false }
  }
  return st.length === 0
}
`

const HELPERS = ['isOpen', 'isClose', 'matches']

let pass = 0, total = 0
const check = (name: string, ok: boolean, detail = '') => {
  total++
  if (ok) pass++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`)
}

async function main(): Promise<void> {
  console.log('# trace-spec bench — gold ground truth flows DOWN the carve. ZERO model calls.\n')

  // ── 1. instrumentation preserves behaviour and records internal calls ──────────
  const inst = instrumentForTrace(CORRECT, HELPERS)
  check('instrumentation renames every helper definition and adds a wrapper',
    HELPERS.every(h => inst.includes(`__crucible_orig_${h}`) && inst.includes(`export function ${h}(...a)`)))

  // ── 2. a CORRECT carve: every gold case passes, specs derive from gold ─────────
  const good = await traceEntryCases(CORRECT, HELPERS, BAL_ACC)
  check('correct carve: no trace error', good.error === null, good.error ?? '')
  check('correct carve: all 7 gold entry cases pass',
    good.casePassed.length === 7 && good.casePassed.every(Boolean),
    `casePassed = ${JSON.stringify(good.casePassed)}`)
  check('correct carve: internal helper calls WERE recorded (the rename-and-wrap works)',
    good.calls.length > 0 && good.neverCalled.length === 0,
    `${good.calls.length} calls recorded, neverCalled=${JSON.stringify(good.neverCalled)}`)

  const derived = deriveHelperSpecs(good)
  const isOpenSpec = derived.find(d => d.helper === 'isOpen')
  check('derived spec for isOpen exists and is gold-witnessed', !!isOpenSpec && isOpenSpec.witnesses > 0,
    isOpenSpec ? `${isOpenSpec.cases.length} case(s) from ${isOpenSpec.witnesses} gold entry case(s)` : 'missing')

  // THE HEADLINE ASSERTION. The live planner's invented isBracket spec was all-true, so
  // `() => true` certified it. The DERIVED spec contains both outcomes, because gold inputs
  // contain both brackets and non-brackets — so a constant cannot satisfy it.
  const outs = new Set((isOpenSpec?.cases ?? []).map(c => JSON.stringify(c.expected)))
  check('derived isOpen spec DISCRIMINATES (contains both true and false) — a constant cannot pass it',
    outs.has('true') && outs.has('false'),
    `observed expected values: ${[...outs].join(', ')}`)
  check('isNonDiscriminating agrees the derived spec has teeth',
    !!isOpenSpec && !isNonDiscriminating(isOpenSpec.cases))
  check('isNonDiscriminating REJECTS the live planner\'s all-true isBracket spec',
    isNonDiscriminating([
      { args: ['('], expected: true }, { args: ['{', '}'], expected: true }, { args: ['[', ']'], expected: true },
    ]))

  // ── 3. a correct helper must NOT be blamed when the ENTRY is the bug ───────────
  const buggy = await traceEntryCases(BUGGY_ENTRY, HELPERS, BAL_ACC)
  const failed = buggy.casePassed.filter(p => !p).length
  check('buggy entry: gold cases actually fail (the fixture is real)', failed >= 2,
    `${failed}/7 gold cases fail`)
  const suspects = localizeFault(buggy)
  const topReal = suspects.filter(s => s.failingCases + s.passingCases > 0)[0]
  check('no helper is blamed with high confidence when the ENTRY holds the bug',
    !topReal || topReal.suspicion < 0.9,
    `top suspect ${topReal?.helper} @ ${topReal?.suspicion.toFixed(2)}`)

  // ── 4. a DEAD rung is caught, which uniform budgeting is blind to ──────────────
  const dead = await traceEntryCases(DEAD_RUNG, [...HELPERS, 'isBracketPair'], BAL_ACC)
  check('dead rung: isBracketPair is reported as never called',
    dead.neverCalled.includes('isBracketPair'),
    `neverCalled = ${JSON.stringify(dead.neverCalled)}`)
  const deadLines = describeLocalization(dead)
  check('dead rung is described as a dead branch of the carve',
    deadLines.some(l => l.includes('isBracketPair') && l.includes('NEVER CALLED')),
    deadLines.join(' | '))

  // ── 4b. FALSE-DEAD and FALSE-WITNESS regressions (2026-07-27) ─────────────────
  // Four ways the tracer used to lie. Each made `neverCalled` mean something other than "the
  // composition does not need this", or put a value in a rung's acceptance set that no execution
  // ever produced. All four are pruning/spec decisions, so a lie here throws away a good carve or
  // grinds a rung against an impossible target.

  // (a) A helper that signals by THROWING was recorded only on the normal-return path, so
  //     "never called" actually meant "never returned" and the rung was pruned as unreachable.
  const THROWS = `
export function strictHead(a) { if (!a.length) throw new Error('empty'); return a[0] }
export function sum(a) { return a.reduce((x, y) => x + y, 0) }
export function headOrSum(a) { try { return strictHead(a) } catch { return sum(a) } }
`
  const thrownAcc: CodeAcceptance = { entry: 'headOrSum', cases: [
    { args: [[]], expected: 0 }, { args: [[5, 1]], expected: 5 },
  ] }
  const thrown = await traceEntryCases(THROWS, ['strictHead', 'sum'], thrownAcc)
  check('a THROWING helper is still recorded as called (not a dead rung)',
    !thrown.neverCalled.includes('strictHead'),
    `neverCalled = ${JSON.stringify(thrown.neverCalled)}`)
  const strictSpec = deriveHelperSpecs(thrown).find(s => s.helper === 'strictHead')
  check('a thrown call contributes NO return witness to the derived spec',
    !strictSpec || !strictSpec.cases.some(c => c.expected === null),
    `strictHead cases = ${JSON.stringify(strictSpec?.cases ?? [])}`)

  // (b) A helper invoked only while the MODULE EVALUATES (a precomputed table) was wiped by the
  //     per-case trace reset, so it looked never-called while being load-bearing.
  const BOOT = `
export function buildTable() { return { I: 1, V: 5, X: 10 } }
const TABLE = buildTable()
export function valueOf(ch) { return TABLE[ch] ?? 0 }
export function romanSum(s) { let t = 0; for (const ch of s) t += valueOf(ch); return t }
`
  const bootAcc: CodeAcceptance = { entry: 'romanSum', cases: [
    { args: ['II'], expected: 2 }, { args: ['XV'], expected: 15 },
  ] }
  const boot = await traceEntryCases(BOOT, ['buildTable', 'valueOf'], bootAcc)
  check('a module-evaluation-only helper is NOT reported never-called',
    !boot.neverCalled.includes('buildTable'),
    `casePassed=${JSON.stringify(boot.casePassed)} neverCalled=${JSON.stringify(boot.neverCalled)}`)
  const bootSpec = deriveHelperSpecs(boot).find(s => s.helper === 'buildTable')
  check('...but contributes no per-case witness either (caseIndex -1)',
    !bootSpec || bootSpec.cases.length === 0,
    `buildTable cases = ${JSON.stringify(bootSpec?.cases ?? [])}`)

  // (c) Args were stored BY REFERENCE and serialized at end-of-case, so a helper that mutates an
  //     argument had its spec rewritten to an (args -> expected) pair it never produced.
  const MUT = `
export function pushAndCount(acc, x) { acc.push(x); return acc.length }
export function countUp(s) { const acc = []; for (const ch of s) pushAndCount(acc, ch); return acc.length }
`
  const mutAcc: CodeAcceptance = { entry: 'countUp', cases: [
    { args: ['ab'], expected: 2 }, { args: ['xyz'], expected: 3 },
  ] }
  const mut = await traceEntryCases(MUT, ['pushAndCount'], mutAcc)
  const mutSpec = deriveHelperSpecs(mut).find(s => s.helper === 'pushAndCount')
  const firstCall = mutSpec?.cases.find(c => c.expected === 1)
  check('a MUTATING helper derives the args as they were AT CALL TIME',
    !!firstCall && Array.isArray((firstCall.args as unknown[])[0]) &&
      ((firstCall.args as unknown[])[0] as unknown[]).length === 0,
    `expected===1 case = ${JSON.stringify(firstCall ?? null)}`)

  // (d) `declPatterns` allowed leading indentation, so a NESTED declaration counted as declared;
  //     instrumenting it renamed the inner definition while hoisting the wrapper to module scope,
  //     leaving __crucible_orig_* out of scope and throwing ReferenceError on every call.
  const NESTED = `
export function classify(n) {
  function isBig(x) { return x > 100 }
  return n === 0 ? 'zero' : (isBig(n) ? 'big' : 'small')
}
`
  check('a NESTED declaration is not reported as declared-and-instrumentable',
    declaredHelpers(NESTED, ['isBig']).length === 0,
    `declaredHelpers = ${JSON.stringify(declaredHelpers(NESTED, ['isBig']))}`)
  const nestedAcc: CodeAcceptance = { entry: 'classify', cases: [
    { args: [0], expected: 'zero' }, { args: [5], expected: 'small' }, { args: [200], expected: 'big' },
  ] }
  const nested = await traceEntryCases(NESTED, ['isBig'], nestedAcc)
  check('instrumenting a nested helper does not corrupt the entry\'s own results',
    nested.casePassed.length === 3 && nested.casePassed.every(Boolean),
    `casePassed = ${JSON.stringify(nested.casePassed)} error=${nested.error ?? 'none'}`)

  // ── 5. cost ───────────────────────────────────────────────────────────────────
  const t0 = Date.now()
  await traceEntryCases(CORRECT, HELPERS, BAL_ACC)
  const ms = Date.now() - t0
  check('a full trace run costs well under one model draw (~4000ms)', ms < 2000, `${ms}ms`)

  console.log(`\n  ${pass}/${total} checks green`)
  if (pass !== total) { console.error('\ntrace-spec bench RED'); process.exit(1) }
}

main().catch(e => { console.error('tracespec bench failed:', e); process.exit(1) })
