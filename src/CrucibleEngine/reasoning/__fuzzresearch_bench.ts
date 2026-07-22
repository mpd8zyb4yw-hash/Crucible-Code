// ═══════════════════════════════════════════════════════════════════════════════
// SELF-VERIFYING BENCH — fuzz ResearchFn as a stage-5 differential gate (W12→ladder, W5)
//
// Proves the "certified but edge-case-wrong" hole is actually closed: a candidate that PASSES
// its seed cases but disagrees with the trusted canonical reference on an unseen input must
//   (a) yield a NEW acceptance case whose `expected` is the REFERENCE's value (sound tightening), and
//   (b) carry W5 feedback — the minimized witness AND a top suspect line — in proposer context.
// A candidate that MATCHES the reference must produce no research (no false progress).
// Also exercises makeCanonicalFuzzResearch end-to-end from natural language, and the
// string/tuple mutators against real canonical references.
//
//   run:  npx tsx src/CrucibleEngine/reasoning/__fuzzresearch_bench.ts
// ═══════════════════════════════════════════════════════════════════════════════

import { makeFuzzResearchFn, makeCanonicalFuzzResearch, makeFuzzStage, makeCanonicalFuzzStage } from './fuzzResearch'
import { runLadder } from './verifierLadder'
import { verifyCode } from './codeVerifier'
import type { Attempt, Candidate, TaskSpec } from './types'
import type { ResearchInput } from './iterate'

const src = (...lines: string[]) => lines.join('\n')

function attempt(code: string): Attempt<string> {
  return { candidate: { value: code, fingerprint: 'x' }, verdict: { pass: false, score: -1, signals: [] } }
}
function input(best: Attempt<string>): ResearchInput<string> {
  const spec: TaskSpec = { goal: 'g', domain: 'code', acceptance: {} as Record<string, unknown> }
  return { spec, best, epoch: 1, priorContext: [] }
}

let pass = 0
const fails: string[] = []
const check = (name: string, ok: boolean, note = '') => {
  if (ok) pass++; else fails.push(name)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${note ? `\n         ${note}` : ''}`)
}

console.log('── Fuzz ResearchFn — stage-5 differential gate self-verification ──\n')

// ── 1) Edge-case-wrong candidate vs a canonical `filter(even)` reference ────────────────
// The candidate forgets that 0 is even (`v % 2 === 0 && v !== 0`) — passes any seed without a 0,
// disagrees with the reference the moment a 0 appears. The gate must surface that.
{
  const referenceSource = 'export function keepEven(xs) { return xs.filter(v => v % 2 === 0) }'
  const buggy = src(
    'export function keepEven(xs) {',
    '  const out = []',
    '  for (const v of xs) {',
    '    if (v % 2 === 0 && v !== 0) {',   // bug: drops 0
    '      out.push(v)',
    '    }',
    '  }',
    '  return out',
    '}',
  )
  const fn = makeFuzzResearchFn({ entry: 'keepEven', referenceSource, family: 'filter(even)' })
  const r = await fn(input(attempt(buggy)))
  const cases = (r?.acceptance as { cases?: any[] } | undefined)?.cases ?? []
  const hasZeroWitness = cases.some(c => Array.isArray(c.args?.[0]) && c.args[0].includes(0))
  const expectedMatches = cases.every(c => {
    const ref = (c.args[0] as number[]).filter(v => v % 2 === 0)
    return JSON.stringify(c.expected) === JSON.stringify(ref)
  })
  check('edge-case-wrong filter(even): injects a witness case', !!r && cases.length >= 1 && hasZeroWitness,
    r ? `case=${JSON.stringify(cases[0]?.args)} expected=${JSON.stringify(cases[0]?.expected)}` : 'no research')
  check('injected case expected == reference value (sound tightening)', cases.length >= 1 && expectedMatches)
  check('W5 feedback carries a suspect line', !!r?.context && /suspect line/i.test(r.context),
    r?.context?.split('\n').find(l => /suspect/i.test(l))?.trim())
}

// ── 2) A CORRECT candidate must produce no research (no false progress) ──────────────────
{
  const referenceSource = 'export function keepEven(xs) { return xs.filter(v => v % 2 === 0) }'
  const correct = 'export function keepEven(xs) { return xs.filter(v => v % 2 === 0) }'
  const fn = makeFuzzResearchFn({ entry: 'keepEven', referenceSource, family: 'filter(even)' })
  const r = await fn(input(attempt(correct)))
  check('correct candidate → null research (no false counterexample)', r === null)
}

// ── 3) String family via the string mutator: buggy uppercase misses non-ASCII ───────────
{
  const referenceSource = 'export function up(s) { return String(s).toUpperCase() }'
  const buggy = src(
    'export function up(s) {',
    '  let out = ""',
    '  for (const c of s) {',
    '    if (c >= "a" && c <= "z") { out += String.fromCharCode(c.charCodeAt(0) - 32) }',
    '    else { out += c }',
    '  }',
    '  return out',
    '}',
  )
  const fn = makeFuzzResearchFn({ entry: 'up', referenceSource, family: 'uppercase' })
  const r = await fn(input(attempt(buggy)))
  const cases = (r?.acceptance as { cases?: any[] } | undefined)?.cases ?? []
  const sound = cases.every(c => c.expected === String(c.args[0]).toUpperCase())
  check('string family (uppercase): injects a sound witness case', !!r && cases.length >= 1 && sound,
    cases.length ? `witness=${JSON.stringify(cases[0].args)} → ${JSON.stringify(cases[0].expected)}` : 'no research')
}

// ── 4) End-to-end from natural language via makeCanonicalFuzzResearch ────────────────────
{
  const fn = makeCanonicalFuzzResearch('remove duplicates from the array', 'dedupe')
  check('makeCanonicalFuzzResearch resolves a canonical family from NL', fn !== null)
  if (fn) {
    // A dedupe that only removes ADJACENT duplicates disagrees with first-occurrence dedupe.
    const buggy = src(
      'export function dedupe(xs) {',
      '  const out = []',
      '  for (let i = 0; i < xs.length; i++) {',
      '    if (i === 0 || xs[i] !== xs[i - 1]) { out.push(xs[i]) }',   // adjacent-only bug
      '  }',
      '  return out',
      '}',
    )
    const r = await fn(input(attempt(buggy)))
    const cases = (r?.acceptance as { cases?: any[] } | undefined)?.cases ?? []
    const sound = cases.every(c => {
      const ref = (c.args[0] as number[]).filter((v, i, a) => a.indexOf(v) === i)
      return JSON.stringify(c.expected) === JSON.stringify(ref)
    })
    check('NL→canonical dedupe: catches adjacent-only bug with a sound case', !!r && cases.length >= 1 && sound,
      cases.length ? `witness=${JSON.stringify(cases[0].args)} → ${JSON.stringify(cases[0].expected)}` : 'no research')
  } else {
    check('NL→canonical dedupe: catches adjacent-only bug with a sound case', false, 'no fuzz fn')
  }
}

// ── 5) LADDER-STAGE form (the single-shot production gate, W7): acceptance → fuzz ────────
// This is what solveCodeTask({ fuzzGate:true }) composes. Proves the gate enforces ordering AND
// short-circuit in a real runLadder: (a) a candidate that passes fixed cases but is edge-case-wrong
// is REJECTED by the fuzz rung; (b) a correct candidate passes the whole ladder; (c) a candidate
// that fails ACCEPTANCE short-circuits and never pays for the fuzz rung.
{
  const cand = (code: string): Candidate<string> => ({ value: code, fingerprint: 'x' })
  const acceptanceStage = { name: 'acceptance', cost: 2, verify: verifyCode }
  const fuzzStage = makeCanonicalFuzzStage('remove duplicates from the array', 'dedupe')!
  check('makeCanonicalFuzzStage resolves a canonical family from NL', !!fuzzStage)

  // Fixed cases the edge-case-wrong candidate happens to satisfy (no adjacent-nonadjacent dup).
  const spec: TaskSpec = {
    goal: 'remove duplicates', domain: 'code',
    acceptance: { entry: 'dedupe', cases: [
      { args: [[1, 2, 3]], expected: [1, 2, 3] },
      { args: [[1, 1, 2]], expected: [1, 2] },
    ] } as Record<string, unknown>,
  }
  const adjacentOnly = src(
    'export function dedupe(xs) {',
    '  const out = []',
    '  for (let i = 0; i < xs.length; i++) {',
    '    if (i === 0 || xs[i] !== xs[i - 1]) { out.push(xs[i]) }',   // passes the fixed cases, wrong on [1,2,1]
    '  }',
    '  return out',
    '}',
  )
  const vWrong = await runLadder([acceptanceStage, fuzzStage], cand(adjacentOnly), spec)
  check('ladder rejects certified-but-edge-case-wrong candidate at the fuzz rung',
    !vWrong.pass && vWrong.decidedBy === 'fuzz',
    `decidedBy=${vWrong.decidedBy} signals=${vWrong.signals.join(' | ')}`)

  const correct = 'export function dedupe(xs) { return xs.filter((v, i, a) => a.indexOf(v) === i) }'
  const vOk = await runLadder([acceptanceStage, fuzzStage], cand(correct), spec)
  check('ladder passes a correct candidate through every rung', vOk.pass && vOk.decidedBy === 'fuzz')

  // Acceptance-failing candidate must short-circuit: the costly fuzz rung never runs.
  const brokenParse = 'export function dedupe(xs) { return xs.filter((v =>' // syntax error
  const vShort = await runLadder([acceptanceStage, fuzzStage], cand(brokenParse), spec)
  const fuzzRan = vShort.trace.find(t => t.name === 'fuzz')?.ran
  check('acceptance failure short-circuits — fuzz rung never runs', !vShort.pass && fuzzRan === false,
    `decidedBy=${vShort.decidedBy} fuzzRan=${fuzzRan}`)

  // Direct makeFuzzStage over an int-array reference, no NL routing: inert PASS when candidate agrees.
  const stage = makeFuzzStage({ entry: 'keepEven', referenceSource: 'export function keepEven(xs){return xs.filter(v=>v%2===0)}', family: 'filter(even)' })
  const agree = await Promise.resolve(stage.verify(cand('export function keepEven(xs){return xs.filter(v=>v%2===0)}'), spec))
  check('makeFuzzStage passes (inert) when the candidate agrees with the reference', agree.pass)
}

const ok = fails.length === 0
console.log(`\n  ${ok ? 'PASS' : 'FAIL'} — ${pass}/${pass + fails.length} checks passed`)
if (fails.length) console.log(`  failing: ${fails.join('; ')}`)
process.exit(ok ? 0 : 1)
