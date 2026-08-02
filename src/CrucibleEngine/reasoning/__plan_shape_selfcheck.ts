// ═══════════════════════════════════════════════════════════════════════════════
// SELFCHECK for planShape — validated against carves whose LIVE certification rate is known.
// Run:  npx tsx src/CrucibleEngine/reasoning/__plan_shape_selfcheck.ts
// ═══════════════════════════════════════════════════════════════════════════════
//
// A static score that claims to predict fillability is worthless unless it reproduces the one
// experiment that measured fillability. These are not invented fixtures: they are the three hand
// carves run live on 2026-08-02b — same rung, same head, same cases, same 6-draw budget — whose
// hard-rung certification rates were `index` 6/6, `raw` 1/9, `mask` 0/6. The score must ORDER them
// the same way. If a later edit breaks that ordering, the score has stopped encoding the finding it
// exists to encode, and this file fails rather than letting it drift into decoration.
//
// The ordering is the assertion. Absolute values are not claimed to mean anything.

import { planShapeScore } from './planShape'
import type { SubFunctionSpec } from './solve'

let passed = 0, failed = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const SENTINEL = String.fromCharCode(1)

// ── The three carves, copied from __handcarve_probe_live.ts CARVES ──────────────
const RAW: SubFunctionSpec[] = [
  { name: 'splitCsvRaw', goal: 'split on commas outside quotes, keeping the quotes', cases: [
    { args: ['a,b'], expected: ['a', 'b'] },
    { args: ['a'], expected: ['a'] },
    { args: ['a,,b'], expected: ['a', '', 'b'] },
    { args: ['"x,y",z'], expected: ['"x,y"', 'z'] },
    { args: ['"he said ""hi""",z'], expected: ['"he said ""hi"""', 'z'] },
  ] },
  { name: 'unquoteCsvField', goal: 'unescape one field', cases: [
    { args: ['a'], expected: 'a' },
    { args: [''], expected: '' },
    { args: ['"x,y"'], expected: 'x,y' },
    { args: ['"he said ""hi"""'], expected: 'he said "hi"' },
    { args: ['""'], expected: '' },
  ] },
]

const MASK: SubFunctionSpec[] = [
  { name: 'protectQuotedCommas', goal: 'replace commas inside quotes with a sentinel', cases: [
    { args: ['a,b'], expected: 'a,b' },
    { args: ['a,,b'], expected: 'a,,b' },
    { args: ['"x,y",z'], expected: `"x${SENTINEL}y",z` },
    { args: ['"he said ""hi""",z'], expected: '"he said ""hi""",z' },
    { args: ['"p,q","r,s"'], expected: `"p${SENTINEL}q","r${SENTINEL}s"` },
  ] },
  RAW[1],
]

const INDEX: SubFunctionSpec[] = [
  { name: 'nextUnquotedComma', goal: 'index of the next comma outside quotes', cases: [
    { args: ['a,b', 0], expected: 1 },
    { args: ['a', 0], expected: -1 },
    { args: ['a,,b', 2], expected: 2 },
    { args: ['"x,y",z', 0], expected: 5 },
    { args: ['"he said ""hi""",z', 0], expected: 16 },
    { args: ['a,b', 2], expected: -1 },
  ] },
  RAW[1],
]

console.log('# plan shape — selfcheck (validated against live certification rates)\n')

const raw = planShapeScore(RAW)
const mask = planShapeScore(MASK)
const index = planShapeScore(INDEX)
const f = (n: number): string => n.toFixed(3)
console.log(`  index (live 6/6): ${f(index.score)}    raw (live 1/9): ${f(raw.score)}    mask (live 0/6): ${f(mask.score)}\n`)

// THE ASSERTION: the static score reproduces the live ordering.
check('index scores above raw (live 6/6 vs 1/9)', index.score > raw.score, `${f(index.score)} vs ${f(raw.score)}`)
check('index scores above mask (live 6/6 vs 0/6)', index.score > mask.score, `${f(index.score)} vs ${f(mask.score)}`)
check('raw scores above mask (live 1/9 vs 0/6)', raw.score > mask.score, `${f(raw.score)} vs ${f(mask.score)}`)

// ATTRIBUTION: a score is only actionable if it says WHICH helper is the bad bet, and the shared
// helper must not be blamed — `unquoteCsvField` certified in one call in all three carves.
const worst = (r: ReturnType<typeof planShapeScore>): string =>
  [...r.helpers].sort((a, b) => a.score - b.score)[0].name
check('blames splitCsvRaw in the raw carve', worst(raw) === 'splitCsvRaw', worst(raw))
check('blames protectQuotedCommas in the mask carve', worst(mask) === 'protectQuotedCommas', worst(mask))
// `unquoteCsvField` certified in ONE call in all three carves, so it must never be the helper a
// down-ranked plan is blamed on. Checked only where another helper exists to blame: within the
// `index` carve both helpers are good and one of them is necessarily the lower of the two, which
// says nothing.
check('never blames the helper that certifies in 1 call everywhere',
  worst(raw) !== 'unquoteCsvField' && worst(mask) !== 'unquoteCsvField')
check('the always-certifying helper is not penalised for legitimate pass-through',
  (raw.helpers.find(h => h.name === 'unquoteCsvField')?.score ?? 0) === 1,
  String(raw.helpers.find(h => h.name === 'unquoteCsvField')?.score))

// The reasons are what a human reads when a plan is down-ranked; they must name the real defect.
const maskReasons = mask.helpers.find(h => h.name === 'protectQuotedCommas')?.reasons ?? []
check('names the control-character sentinel as the mask defect', maskReasons.some(r => /control-character/.test(r)), maskReasons.join(' | '))
const rawReasons = raw.helpers.find(h => h.name === 'splitCsvRaw')?.reasons ?? []
check('names carried-forward markup as the raw defect', rawReasons.some(r => /markup/.test(r)), rawReasons.join(' | '))

// A number-returning helper must be the top of the scale, since that is the shape that certified.
check('a number-returning helper scores 1.0',
  (index.helpers.find(h => h.name === 'nextUnquotedComma')?.score ?? 0) === 1)

// DEGENERATE INPUTS — this runs on every plan attempt, including malformed ones.
check('an empty plan scores 0 without throwing', planShapeScore([]).score === 0)
check('a helper with no cases does not crash or score extreme',
  (() => { const r = planShapeScore([{ name: 'x', goal: 'g', cases: [] }]); return r.score > 0 && r.score < 1 })())

console.log(`\n${failed === 0 ? '✅' : '❌'} plan shape: ${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
