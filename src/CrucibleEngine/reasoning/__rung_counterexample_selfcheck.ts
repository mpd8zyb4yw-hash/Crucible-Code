// ═══════════════════════════════════════════════════════════════════════════════
// SELFCHECK for derived rung counterexamples (rungCounterexample.ts). No model.
// Run:  npx tsx src/CrucibleEngine/reasoning/__rung_counterexample_selfcheck.ts
// ═══════════════════════════════════════════════════════════════════════════════
//
// The asymmetry here is what the tests are built around. A derived case that is MISSING costs
// nothing — the loop is exactly as blind as it is today. A derived case that is WRONG makes a
// CORRECT helper un-certifiable and turns a solvable rung into a permanently failing one. So the
// checks below spend most of their effort on the second kind: silence when the derivation is not
// forced, and a full stop when it contradicts a case the rung already certified against.
//
// The headline check is that it derives the counterexample which would actually have caught the
// real defect measured on 2026-08-02c: `nextUnquotedComma('a,,b', 0)` returning 2 instead of 1,
// present in 5 of 6 draws and invisible to both the rung's own cases and the first witness set.

import { deriveScanIndexCases, mergeDerivedCases } from './rungCounterexample'

let passed = 0, failed = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('# derived rung counterexamples — selfcheck\n')

// ── 1) THE REAL DEFECT. Gold: "a,,b" -> ["a","","b"]. The boundaries are forced: 1 and 2.
const real = deriveScanIndexCases('nextUnquotedComma', 'a,,b', ['a', '', 'b'])
check('derives a case from the gold split that exposes the real defect',
  real.some(d => JSON.stringify(d.testCase.args) === JSON.stringify(['a,,b', 0]) && d.testCase.expected === 1),
  JSON.stringify(real.map(d => [d.testCase.args, d.testCase.expected])))
check('the broken helper FAILS the derived case (this is the whole point)',
  (() => {
    // The actual defect shape: skips a comma immediately followed by another.
    const broken = (line: string, from: number): number => {
      for (let i = from; i < line.length; i++) if (line[i] === ',' && line[i + 1] !== ',') return i
      return -1
    }
    const d = real.find(x => JSON.stringify(x.testCase.args) === JSON.stringify(['a,,b', 0]))!
    return broken('a,,b', 0) !== d.testCase.expected
  })())
check('a CORRECT helper passes every derived case (no false accusation)',
  (() => {
    const good = (line: string, from: number): number => {
      let q = false
      for (let i = from; i < line.length; i++) {
        const c = line[i]
        if (c === '"') q = !q
        else if (c === ',' && !q) return i
      }
      return -1
    }
    return real.every(d => good(...(d.testCase.args as [string, number])) === d.testCase.expected)
  })())
check('the final field yields a -1 case', real.some(d => d.testCase.expected === -1))

// ── 2) SILENCE WHEN NOT FORCED. If the transform rewrote the field text, the boundary is not
// recoverable from the gold and NOTHING may be emitted.
check('emits nothing when the fields were rewritten (quotes stripped)',
  deriveScanIndexCases('nextUnquotedComma', '"x,y",z', ['x,y', 'z']).length === 0)
check('emits nothing when a field does not sit at the scan position',
  deriveScanIndexCases('loc', 'a;b', ['a', 'b']).length === 0)
check('emits nothing for a single-field gold case (no boundary is determined)',
  deriveScanIndexCases('loc', 'abc', ['abc']).length === 0)
check('emits nothing for non-string input or non-array expected',
  deriveScanIndexCases('loc', 42, ['a']).length === 0 && deriveScanIndexCases('loc', 'a,b', 'a').length === 0)

// ── 3) MERGE SAFETY. Contradicting an already-certified case means the derivation is unsound for
// this task; the whole batch must be dropped rather than partially applied.
const spec = [{ args: ['a,b', 0], expected: 1 }, { args: ['a', 0], expected: -1 }]
const ok = mergeDerivedCases(spec, real)
check('merges new derived cases onto the spec', ok.added.length > 0 && !ok.contradicted && ok.cases!.length > spec.length)
const bad = mergeDerivedCases(spec, [{ helper: 'x', testCase: { args: ['a,b', 0], expected: 99 }, why: 'bogus' }])
check('a contradiction drops the WHOLE batch and leaves the spec untouched',
  bad.contradicted && bad.added.length === 0 && bad.cases!.length === spec.length)
const dup = mergeDerivedCases(spec, [{ helper: 'x', testCase: { args: ['a,b', 0], expected: 1 }, why: 'agrees' }])
check('a derived case that merely agrees with the spec is not duplicated',
  !dup.contradicted && dup.added.length === 0 && dup.cases!.length === spec.length)

// ── 4) The reason string has to survive into a prompt, so it must actually say something.
check('every derived case explains why it is forced',
  real.every(d => d.why.length > 40 && d.why.includes('gold case')))

console.log(`\n${failed === 0 ? '✅' : '❌'} rung counterexamples: ${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
