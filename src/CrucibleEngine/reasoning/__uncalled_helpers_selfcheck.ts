// ═══════════════════════════════════════════════════════════════════════════════
// SELFCHECK for ignored-helper feedback (solve.ts uncalledHelpers). No model.
// Run:  npx tsx src/CrucibleEngine/reasoning/__uncalled_helpers_selfcheck.ts
// ═══════════════════════════════════════════════════════════════════════════════
//
// WHY. Measured on the `index` carve: hand rungs certify 6/6 and compose still fails 6/6, because
// the composition re-implements a helper instead of calling the certified one — on cases that
// helper passes in a single call. Nothing in the loop ever told it so. This function is the
// detector behind that feedback.
//
// The property that makes it safe is NEGATIVE and cannot be observed from the function alone: it is
// only ever consulted on an ALREADY-FAILING verdict, so a candidate that passes every case without
// calling any helper is still certified. A false positive here costs one line of prompt text on a
// failed attempt; it can never reject a correct answer. These checks pin the detector's accuracy so
// that text stays truthful — telling the model it ignored a helper it actually called would be
// worse than saying nothing.

import { uncalledHelpers } from './solve'

let passed = 0, failed = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const HELPERS = ['nextUnquotedComma', 'unquoteCsvField']

console.log('# ignored-helper feedback — selfcheck\n')

// 1) THE REAL FAILURE this was built from: the composition calls one helper and inlines the other.
const inlined = `
export function splitCsvLine(line) {
  const out = []
  let start = 0
  for (;;) {
    const i = nextUnquotedComma(line, start)
    const raw = i === -1 ? line.slice(start) : line.slice(start, i)
    out.push(raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw)
    if (i === -1) break
    start = i + 1
  }
  return out
}`
check('names the helper that was re-implemented', uncalledHelpers(inlined, HELPERS).join() === 'unquoteCsvField',
  uncalledHelpers(inlined, HELPERS).join())

// 2) A candidate that calls both must be reported clean, or the feedback becomes noise the model
// learns to ignore.
const good = `
export function splitCsvLine(line) {
  const out = []; let start = 0
  for (;;) {
    const i = nextUnquotedComma(line, start)
    out.push(unquoteCsvField(i === -1 ? line.slice(start) : line.slice(start, i)))
    if (i === -1) break
    start = i + 1
  }
  return out
}`
check('a candidate calling every helper is reported clean', uncalledHelpers(good, HELPERS).length === 0,
  uncalledHelpers(good, HELPERS).join())

// 3) REDEFINITION IS NOT USE. The weak head's signature move is to paste the helper's source into
// its answer and call THAT. The verifier strips those redefinitions so the certified source wins —
// which means the candidate's own copy is not a call, and reporting it as one would tell the model
// everything is fine while it keeps failing.
const redefined = `
function unquoteCsvField(f) { return f.replace(/"/g, '') }
export function splitCsvLine(line) {
  return line.split(',').map(unquoteCsvField)
}`
check('a helper that is only REDEFINED, then referenced, is reported CLEAN (the reference survives stripping)',
  uncalledHelpers(redefined, ['unquoteCsvField']).length === 0,
  uncalledHelpers(redefined, ['unquoteCsvField']).join())

// 3b) A callback reference IS a use. `.map(helper)` never writes `helper(`, and an earlier version
// of this detector required the paren — it would have told the model to fix code that was correct.
check('passing a helper as a callback counts as a use',
  uncalledHelpers('export function f(xs){ return xs.map(unquoteCsvField) }', ['unquoteCsvField']).length === 0)

// 3c) The failure actually being reported: the candidate has its OWN copy and uses nothing else.
check('a candidate that only redefines and calls its private copy is reported uncalled',
  uncalledHelpers('function unquoteCsvField(f){ return f }\nexport function g(s){ return s.split(",") }',
    ['unquoteCsvField']).join() === 'unquoteCsvField',
  uncalledHelpers('function unquoteCsvField(f){ return f }\nexport function g(s){ return s.split(",") }', ['unquoteCsvField']).join())

// 4) NO FALSE POSITIVES FROM SUBSTRINGS. `unquote` must not be considered called because
// `unquoteCsvField(` appears — and a helper named as a prefix of another must not be confused.
const prefix = `export function f(s) { return unquoteCsvFieldExtra(s) }`
check('a longer identifier does not count as a call to its prefix',
  uncalledHelpers(prefix, ['unquoteCsvField']).join() === 'unquoteCsvField',
  uncalledHelpers(prefix, ['unquoteCsvField']).join())

// 5) MENTION IS NOT USE. A helper named only in a comment or string is not called.
const mentioned = `export function f(s) { /* uses unquoteCsvField eventually */ return s } // unquoteCsvField`
check('a helper named only in a comment is reported uncalled',
  uncalledHelpers(mentioned, ['unquoteCsvField']).join() === 'unquoteCsvField')

// 6) Whitespace between the name and the paren is still a call.
check('whitespace before the paren still counts as a call',
  uncalledHelpers('export function f(s){ return unquoteCsvField (s) }', ['unquoteCsvField']).length === 0)

console.log(`\n${failed === 0 ? '✅' : '❌'} ignored-helper feedback: ${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
