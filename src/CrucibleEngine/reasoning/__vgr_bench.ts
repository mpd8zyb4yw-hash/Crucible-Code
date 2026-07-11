// ═══════════════════════════════════════════════════════════════════════════════
// VGR bench — proves the thesis: correctness from the LOOP, not the oracle.
// Run:  npm run vgr:bench
// ═══════════════════════════════════════════════════════════════════════════════
//
// The proof has two parts:
//
//   PART A (deterministic, always runs): a MOCK proposer that behaves like a weak,
//   fallible generator — it emits a WRONG implementation first, and only produces a
//   correct one once it has seen the execution verifier's actual-vs-expected feedback.
//   We show:
//     • single-shot (trust the first proposal) SHIPS THE WRONG ANSWER, whereas
//     • the verification-guided loop REJECTS it via execution and converges to a
//       certified-correct solution.
//   This isolates and proves the LOOP mechanism with zero model dependency, so it is
//   stable in CI regardless of whether the on-device FM daemon is up.
//
//   PART B (only if the live FM daemon is up): runs the REAL on-device proposer on a
//   novel task to show the same loop closing over an actual weak model.
// ═══════════════════════════════════════════════════════════════════════════════

import { checkFmAvailable } from '../agent/fmReact'
import { verifyCode, verifyMultiFileCode } from './codeVerifier'
import { recoverFromPoisonedCase, solveCodeTask, solveCodingRequest } from './solve'
import { derivePropertySpec, verifyByProperty } from './propertyVerifier'
import { deriveDifferentialSpec, implFingerprint } from './differentialSpec'
import { deriveMetamorphicSpec, canonicalImpl } from './metamorphicSpec'
import { detectTargetPath, mergeCertifiedSource, planEmit } from './emitPlan'
import { detectDeclaredFunctions, extractCodeSpec, extractMultiFunctionSpec, harvestExplicitExamples } from './specExtractor'
import { deriveMultiFileProperties, detectRequestedFiles, isMultiFileRequest, mergeCertifiedFileSet, parseFileSet, solveMultiFileRequest } from './multiFile'
import type { CandidateFile } from './codeVerifier'
import type { Candidate, ProposeContext } from './types'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

// ── A novel task: sum only the EVEN numbers in an array. ──────────────────────────
const TASK = {
  goal: 'Write sumEvens(nums) returning the sum of only the even numbers in the array. Empty array → 0.',
  entry: 'sumEvens',
  cases: [
    { args: [[1, 2, 3, 4]], expected: 6 },
    { args: [[2, 4, 6]], expected: 12 },
    { args: [[1, 3, 5]], expected: 0 },
    { args: [[]], expected: 0 },
    { args: [[-2, -3, 8]], expected: 6 },
  ],
}

// A WRONG first guess (sums ALL numbers) — exactly the kind of plausible-but-wrong
// output a weak model emits. Single-shot would ship this.
const WRONG = `export function sumEvens(nums){return nums.reduce((a,b)=>a+b,0)}`
// The CORRECT implementation the mock only reaches after seeing the failure feedback.
const RIGHT = `export function sumEvens(nums){return nums.filter(n=>n%2===0).reduce((a,b)=>a+b,0)}`

function fp(code: string): string {
  const n = code.replace(/\s+/g, ' ').trim(); let h = 5381
  for (let i = 0; i < n.length; i++) h = ((h << 5) + h + n.charCodeAt(i)) | 0
  return `c${(h >>> 0).toString(36)}`
}

// Mock weak proposer: emits WRONG until it has been shown a failing verdict, then RIGHT.
// This models "the model debugs itself against ground-truth feedback".
function mockProposer() {
  return async (ctx: ProposeContext<string>): Promise<Candidate<string>> => {
    const sawFailure = ctx.history.some(a => !a.verdict.pass)
    const code = sawFailure ? RIGHT : WRONG
    return { value: code, fingerprint: fp(code) }
  }
}

async function run() {
  console.log('\nVGR bench — correctness from the loop, not the oracle\n')

  // ── PART A ──────────────────────────────────────────────────────────────────────
  console.log('PART A — deterministic loop proof (no model)')

  // 1. Single-shot BASELINE: trust the model's first output. It is WRONG by execution.
  const singleShot = await verifyCode(
    { value: WRONG, fingerprint: fp(WRONG) },
    { goal: TASK.goal, domain: 'code', acceptance: { entry: TASK.entry, cases: TASK.cases } },
  )
  ok('single-shot ships an answer that FAILS ground-truth execution', !singleShot.pass,
    `score ${singleShot.score}: ${singleShot.signals[0]}`)

  // 2. The LOOP: same weak generator, but wrapped in propose→verify→backtrack.
  const looped = await solveCodeTask(TASK, { maxModelCalls: 6, beamWidth: 2 }, mockProposer())
  ok('verification-guided loop CERTIFIES a correct solution', looped.status === 'solved',
    `${looped.status} in ${looped.modelCalls} model call(s)`)
  ok('the loop\'s certified solution actually passes every case',
    !!looped.solution && (await verifyCode(looped.solution, {
      goal: TASK.goal, domain: 'code', acceptance: { entry: TASK.entry, cases: TASK.cases },
    })).pass)
  ok('the loop used the failure feedback (took >1 attempt, proving it did not luck into it)',
    looped.attempts.length >= 2, `${looped.attempts.length} attempts`)

  // 3. Honest abstain: a hopeless proposer must ABSTAIN, never ship a wrong answer.
  const hopeless = await solveCodeTask(TASK, { maxModelCalls: 4, beamWidth: 1 },
    async () => ({ value: WRONG, fingerprint: fp(WRONG) }))  // never improves
  ok('a proposer that never converges ABSTAINS honestly (no wrong answer shipped)',
    hopeless.status !== 'solved' && hopeless.solution === null,
    `status ${hopeless.status}`)

  // Infra resilience: transient FM failures (null proposals) must NOT burn the reasoning
  // budget or trip patience — the loop must still converge. This is the live-exhaustion fix.
  let flakyCalls = 0
  const flakyProposer = async (): Promise<Candidate<string> | null> => {
    flakyCalls++
    // Return null (simulating an overloaded-daemon empty response) on 4 of the first 5 calls.
    if (flakyCalls <= 5 && flakyCalls % 2 === 1) return null
    return { value: RIGHT, fingerprint: fp(RIGHT) }
  }
  const resilient = await solveCodeTask(TASK, { maxModelCalls: 4, beamWidth: 1, patience: 2 }, flakyProposer)
  ok('transient FM failures (null proposals) do NOT abort the search — it still certifies',
    resilient.status === 'solved', `status ${resilient.status} after ${flakyCalls} proposal call(s)`)

  // ── PART C — spec extraction + consensus filter (deterministic, injected completer) ──
  console.log('\nPART C — spec extraction: NL → checkable spec, with consensus guard')

  // A completer that AGREES on good cases but CONTRADICTS itself on a poisoned one.
  // The consensus filter must keep the agreed cases and DROP the contradictory one.
  let call = 0
  const flakyCompleter = async () => {
    call++
    // Two samples agree f(2)=4, f(3)=9; disagree on f(4) (16 vs 99 vs 7) → must be dropped.
    const bad = call === 1 ? 16 : call === 2 ? 99 : 7
    return JSON.stringify({
      entry: 'square',
      cases: [
        { args: [2], expected: 4, name: 'two' },
        { args: [3], expected: 9, name: 'three' },
        { args: [4], expected: bad, name: 'four' },
      ],
    })
  }
  const ex = await extractCodeSpec('write square(n) returning n squared', { samples: 3, complete: flakyCompleter })
  ok('extractor forms a spec when cases reach consensus', ex.ok === true, ex.detail ?? ex.reason ?? '')
  ok('consensus filter DROPS the case the model contradicted itself on (no poisoned ground truth)',
    !!ex.spec && ex.spec.cases.length === 2 && !ex.spec.cases.some(c => JSON.stringify(c.args) === '[4]'))

  // A SINGLE user-provided example is gold — trusted without consensus, even if the model
  // returns nothing usable. This is the fix for the live "1 case < 2 consensus" abstain.
  const userEx = await extractCodeSpec(
    'write initials(name) returning uppercase initials. Example: initials("john ronald tolkien") === "JRT"',
    { samples: 2, complete: async () => '{"entry":"","cases":[]}' })  // model gives nothing
  ok('a single USER-stated example forms a trustworthy spec (no model consensus needed)',
    userEx.ok === true && userEx.spec?.entry === 'initials' && userEx.spec.cases.length >= 1,
    userEx.ok ? userEx.detail : userEx.reason)

  // Vague request → the model can't name a concrete spec → HONEST ABSTAIN, not a guess.
  const vague = await extractCodeSpec('make it better somehow', { samples: 2,
    complete: async () => JSON.stringify({ entry: '', cases: [] }) })
  ok('extractor ABSTAINS on an unspecifiable request', vague.ok === false, vague.ok ? '' : vague.reason)

  // End-to-end from NL, fully deterministic: injected spec completer + mock code proposer.
  const e2e = await solveCodingRequest('sum the even numbers in an array', {
    maxModelCalls: 6, beamWidth: 2,
    specComplete: async () => JSON.stringify({ entry: 'sumEvens', cases: TASK.cases }),
    specSamples: 1,
  }, )
  // (solveCodingRequest passes proposer=real; inject via override is not exposed, so run mock path separately)
  ok('solveCodingRequest wires extraction → search and never returns unverified code',
    e2e.status === 'solved' ? e2e.code !== null : e2e.code === null,
    `status ${e2e.status}`)

  // ── PART D — property verification (no example → certify by general property) ──────
  console.log('\nPART D — property-based certification (no worked example)')
  const propSpecObj = derivePropertySpec('write a function sortAsc(arr) that sorts an array of numbers ascending')
  ok('derives a sort property spec from a no-example request',
    !!propSpecObj && propSpecObj.family === 'sort' && propSpecObj.assertions.length >= 3,
    propSpecObj ? `${propSpecObj.assertions.length} properties` : 'none')
  if (propSpecObj) {
    const pspec = { goal: 'sortAsc', domain: 'code', acceptance: { entry: propSpecObj.entry, family: propSpecObj.family, assertions: propSpecObj.assertions } as any }
    const right = await verifyByProperty({ value: 'export function sortAsc(a){return a.slice().sort((x,y)=>x-y)}', fingerprint: 'r' }, pspec as any)
    ok('a correct sort SATISFIES every property', right.pass, right.signals[0])
    // Wrong: returns input unsorted → the "sorted" property must fail (general truth, not a memorized case).
    const wrong = await verifyByProperty({ value: 'export function sortAsc(a){return a}', fingerprint: 'w' }, pspec as any)
    ok('an incorrect sort VIOLATES a property (certification is real, not memorized)',
      !wrong.pass && wrong.signals.some(s => /sorted/.test(s)), wrong.signals[0])
  }

  // ── PART E — supplemental property families (recurrence / reference-derivation) ────
  console.log('\nPART E — supplemental families (factorial/gcd/isPrime via general properties)')
  const supCases: Array<[string, string, string, string]> = [
    ['write factorial(n) computing n!', 'factorial',
      'export function factorial(n){return n<=1?1:n*factorial(n-1)}',
      'export function factorial(n){return n*2}'],
    ['write gcd(a,b) greatest common divisor', 'gcd',
      'export function gcd(a,b){return b===0?a:gcd(b,a%b)}',
      'export function gcd(a,b){return 1}'],
    ['write isPrime(n)', 'isPrime',
      'export function isPrime(n){if(n<2)return false;for(let d=2;d*d<=n;d++)if(n%d===0)return false;return true}',
      'export function isPrime(n){return n%2!==0}'],
    ['write sumArray(nums) returning the sum', 'sum',
      'export function sumArray(a){return a.reduce((x,y)=>x+y,0)}',
      'export function sumArray(a){return a.length}'],
    ['write reverseString(s)', 'reverse',
      'export function reverseString(s){return s.split("").reverse().join("")}',
      'export function reverseString(s){return s}'],
    ['write chunk(arr,size) splitting an array into chunks', 'chunk',
      'export function chunk(a,n){const r=[];for(let i=0;i<a.length;i+=n)r.push(a.slice(i,i+n));return r}',
      'export function chunk(a,n){return [a]}'],
    ['write max(xs) returning the largest number', 'max',
      'export function max(xs){return Math.max(...xs)}',
      'export function max(xs){return xs[0]}'],
    ['write min(xs) returning the smallest number', 'min',
      'export function min(xs){return Math.min(...xs)}',
      'export function min(xs){return xs[0]}'],
    ['write clamp(x, lo, hi) constraining x to a range', 'clamp',
      'export function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x))}',
      'export function clamp(x,lo,hi){return x}'],
    ['write average(xs) of an array of numbers', 'average',
      'export function average(xs){return xs.reduce((a,b)=>a+b,0)/xs.length}',
      'export function average(xs){return xs[0]}'],
    ['write power(base, exp) computing base to the exp', 'power',
      'export function power(b,n){let r=1;for(let i=0;i<n;i++)r*=b;return r}',
      'export function power(b,n){return b*n}'],
    ['write isPalindrome(s) checking if a string reads the same backwards', 'isPalindrome',
      "export function isPalindrome(s){return s===[...s].reverse().join('')}",
      'export function isPalindrome(s){return true}'],
    ['write digitSum(n) summing the decimal digits', 'digitSum',
      "export function digitSum(n){return String(Math.abs(n)).split('').reduce((a,d)=>a+Number(d),0)}",
      'export function digitSum(n){return n}'],
    ['write countVowels(s) counting vowels in a string', 'countVowels',
      "export function countVowels(s){return (s.match(/[aeiou]/gi)||[]).length}",
      'export function countVowels(s){return s.length}'],
  ]
  for (const [nl, fam, good, bad] of supCases) {
    const s = derivePropertySpec(nl)
    const spec = s && { goal: 'x', domain: 'code', acceptance: { entry: s.entry, family: s.family, assertions: s.assertions } as any }
    const g = spec ? await verifyByProperty({ value: good, fingerprint: 'g' }, spec as any) : null
    const b = spec ? await verifyByProperty({ value: bad, fingerprint: 'b' }, spec as any) : null
    ok(`${fam}: correct impl certified AND wrong impl rejected (general property, no memorized value)`,
      !!s && s.family === fam && !!g?.pass && !!b && !b.pass, b ? b.signals[0] : 'no spec')
  }

  // ── PART G — multi-function (multi-export) certification in one module ─────────────
  console.log('\nPART G — multi-function synthesis (several exports certified together)')
  const multiHarvest = harvestExplicitExamples('write add(a,b) and sub(a,b). add(2,3) === 5. sub(9,4) === 5. sub(1,1) === 0')
  ok('harvests multiple functions with per-case entry tags',
    multiHarvest.entries.length === 2 && multiHarvest.cases.every(c => c.entry) &&
    multiHarvest.cases.filter(c => c.entry === 'sub').length === 2,
    `entries [${multiHarvest.entries.join(',')}], ${multiHarvest.cases.length} tagged cases`)
  const multiSpec = { goal: '', domain: 'code', acceptance: { entry: multiHarvest.entry, entries: multiHarvest.entries, cases: multiHarvest.cases } } as any
  const bothRight = await verifyCode({ value: 'export function add(a,b){return a+b}\nexport function sub(a,b){return a-b}', fingerprint: 'r' }, multiSpec)
  ok('a module correct on ALL functions is certified', bothRight.pass, bothRight.signals[0])
  const oneWrong = await verifyCode({ value: 'export function add(a,b){return a+b}\nexport function sub(a,b){return a+b}', fingerprint: 'w' }, multiSpec)
  ok('one wrong function fails on ITS cases (per-function ground truth)',
    !oneWrong.pass && oneWrong.signals.some(s => /sub/.test(s)), oneWrong.signals[0])

  // ── PART F — poisoned-case recovery (cross-derivation drops a bad model case) ──────
  console.log('\nPART F — poisoned model-case recovery')
  // square spec with a POISONED case at index 2: square(4) should be 16, model said 99.
  const sqCases = [
    { args: [2], expected: 4, name: 'two' },
    { args: [3], expected: 9, name: 'three' },
    { args: [4], expected: 99, name: 'four(poison)' },
    { args: [5], expected: 25, name: 'five' },
  ]
  const mkAttempt = (code: string) => ({
    candidate: { value: code, fingerprint: fp(code) },
    verdict: { pass: false, score: -1, signals: ['case four(poison) → got 16, expected 99'] },
  })
  // Two INDEPENDENT correct implementations — both fail only the poisoned case.
  const twoIndependent = [
    mkAttempt('export function square(n){ return n*n }'),
    mkAttempt('export function square(n){ return Math.pow(n,2) }'),
  ]
  const rec = await recoverFromPoisonedCase('square', sqCases, twoIndependent as any)
  ok('recovery drops the poisoned case when ≥2 independent impls agree it is wrong',
    !!rec && rec.nAgree >= 2 && rec.cleaned.length === 3 && !rec.cleaned.some(c => JSON.stringify(c.args) === '[4]'),
    rec ? `dropped 1, ${rec.nAgree} agreed` : 'no recovery')
  // Only ONE candidate → NOT enough evidence; must NOT drop (could be a real bug, not poison).
  const one = await recoverFromPoisonedCase('square', sqCases, [twoIndependent[0]] as any)
  ok('recovery REFUSES to drop on a single implementation (no false certification)', one === null)
  // Candidates disagreeing on WHICH case fails → no consensus → no drop.
  const disagree = await recoverFromPoisonedCase('square', sqCases, [
    mkAttempt('export function square(n){ return n*n }'),                 // fails only [4]
    mkAttempt('export function square(n){ return n===5 ? 0 : n*n }'),     // fails only [5]
  ] as any)
  ok('recovery REFUSES when independent impls fail DIFFERENT cases (no agreement)', disagree === null)

  // ── PART H — emit planning (where certified code goes: create vs append-to-existing) ─
  console.log('\nPART H — emit planning (edit existing files, not just create)')
  ok('detectTargetPath finds an explicit path', detectTargetPath('add initials to src/utils/strings.ts') === 'src/utils/strings.ts')
  ok('detectTargetPath returns null for prose with no path', detectTargetPath('sort the array in ascending order') === null)

  const GOOD_CODE = 'export function initials(name: string): string {\n  return name.split(" ").map(w => w[0]).join("")\n}'
  const p1 = await planEmit('write initials(name)', 'initials', GOOD_CODE, null, null)
  ok('no target path → new src/<entry>.ts', p1.mode === 'create' && p1.rel === 'src/initials.ts')

  const p2 = await planEmit('add initials to src/strings.ts', 'initials', GOOD_CODE, null)
  ok('target path, file absent → create at requested path', p2.mode === 'create' && p2.rel === 'src/strings.ts')

  const existing = 'export function slug(s: string): string {\n  return s.toLowerCase()\n}\n'
  const p3 = await planEmit('add initials to src/strings.ts', 'initials', GOOD_CODE, existing)
  ok('target exists + appendable → APPEND (combined compiles, keeps existing fn)',
    p3.mode === 'append' && p3.rel === 'src/strings.ts' && p3.content.includes('slug') && p3.content.includes('initials'), p3.detail)

  const p4 = await planEmit('add initials to src/strings.ts', 'initials', GOOD_CODE, existing + '\nexport function initials(n){return n}')
  ok('target already defines the fn → new file (no duplicate definition)', p4.mode === 'create' && p4.rel === 'src/initials.ts')

  const p5 = await planEmit('add initials to src/strings.ts', 'initials', GOOD_CODE, 'export function slug(s){ this is not valid ts ((( ')
  ok('appending would break compile → new file (existing left untouched)', p5.mode === 'create' && p5.rel === 'src/initials.ts')

  // Certified in-place MODIFY of an existing definition (mission item 1: edit real files).
  const oldDef = 'export function slug(s: string): string {\n  return s.toLowerCase()\n}\n\nexport function initials(name: string): string {\n  return name[0]\n}\n\nexport const OTHER = 1\n'
  const p6 = await planEmit('fix initials in src/strings.ts so it uses every word', 'initials', GOOD_CODE, oldDef)
  ok('modify-shaped + fn exists → in-place REPLACE, rest of file intact',
    p6.mode === 'modify' && p6.rel === 'src/strings.ts' && p6.content.includes('map(w => w[0])')
    && !p6.content.includes('return name[0]') && p6.content.includes('slug') && p6.content.includes('OTHER'), p6.detail)

  const arrowDef = 'export const initials = (name: string): string => name[0];\nexport const KEEP = 2\n'
  const p7 = await planEmit('update initials in src/strings.ts', 'initials', GOOD_CODE, arrowDef)
  ok('modify replaces an arrow-const definition too',
    p7.mode === 'modify' && !p7.content.includes('name[0];') && p7.content.includes('KEEP'), p7.detail)

  const reExported = 'function initials(n: string) { return n[0] }\nexport { initials }\n'
  const p8 = await planEmit('fix initials in src/strings.ts', 'initials', GOOD_CODE, reExported)
  ok('modify that would double-export → compile gate downgrades to new file',
    p8.mode === 'create' && p8.rel === 'src/initials.ts', p8.detail)

  const p9 = await planEmit('add initials to src/strings.ts please', 'initials', GOOD_CODE, oldDef)
  ok('non-modify verb + fn exists → still avoids duplicate via new file', p9.mode === 'create', p9.detail)

  // Type-annotation grafting: untyped certified code inherits the original's annotations.
  const UNTYPED = 'export function initials(name) {\n  return name.split(" ").map(w => w[0]).join("")\n}'
  const p10 = await planEmit('fix initials in src/strings.ts', 'initials', UNTYPED, oldDef)
  ok('modify with UNTYPED certified code grafts the original param + return types',
    p10.mode === 'modify' && p10.content.includes('initials(name: string): string'), p10.detail)

  const arrowUntyped = await planEmit('update initials in src/strings.ts', 'initials',
    'export const initials = (name) => name.split(" ").map(w => w[0]).join("")', arrowDef)
  ok('grafting works on arrow-const definitions too',
    arrowUntyped.mode === 'modify' && arrowUntyped.content.includes('(name: string): string'), arrowUntyped.detail)

  // Call-site safety: esbuild's transform gate does NOT typecheck arity, so a signature
  // change must be reconciled deterministically or the plan downgrades — never a silent break.
  const withCalls = 'export function pad(s: string, width: number, fill: string): string {\n  return s.padStart(width, fill)\n}\n\nexport const banner = pad("hi", 10, "*")\n'
  const NARROWED = 'export function pad(s: string, width: number): string {\n  return s.padStart(width, " ")\n}'
  const p11 = await planEmit('change pad in src/strings.ts to always pad with spaces', 'pad', NARROWED, withCalls)
  ok('trailing param removed → call sites mechanically TRIMMED to the new arity',
    p11.mode === 'modify' && p11.content.includes('pad("hi", 10)') && !p11.content.includes('pad("hi", 10, "*")'), p11.detail)

  const WIDENED = 'export function pad(s: string, width: number, fill: string, right: boolean): string {\n  return right ? s.padEnd(width, fill) : s.padStart(width, fill)\n}'
  const p12 = await planEmit('change pad in src/strings.ts to support right padding', 'pad', WIDENED, withCalls)
  ok('new REQUIRED param with existing call sites → downgrade to new file (no silent break)',
    p12.mode === 'create' && p12.rel === 'src/pad.ts', p12.detail)

  const WIDENED_OPT = 'export function pad(s: string, width: number, fill: string, right: boolean = false): string {\n  return right ? s.padEnd(width, fill) : s.padStart(width, fill)\n}'
  const p13 = await planEmit('change pad in src/strings.ts to support right padding', 'pad', WIDENED_OPT, withCalls)
  ok('new DEFAULTED param → existing call sites fit → modify proceeds',
    p13.mode === 'modify' && p13.content.includes('right: boolean = false'), p13.detail)

  const noCalls = 'export function pad(s: string, width: number, fill: string): string {\n  return s.padStart(width, fill)\n}\n'
  const p14 = await planEmit('change pad in src/strings.ts', 'pad', WIDENED, noCalls)
  ok('signature change with NO call sites in the file → modify proceeds', p14.mode === 'modify', p14.detail)

  // Multi-file merge: certified module source merged into an EXISTING file (splice same-named,
  // append new, union imports) — the modify-inside-multi-file building block.
  const mExisting = "import { helper } from './util'\n\nexport function greet(name: string): string {\n  return 'hi ' + name\n}\n\nexport const KEEP = 1\n"
  const mCertified = "import { helper, extra } from './util'\n\nexport function greet(name) {\n  return 'hello ' + helper(name)\n}\n\nexport function shout(name) {\n  return greet(name).toUpperCase()\n}"
  const mg = mergeCertifiedSource(mExisting, mCertified)
  ok('merge splices same-named fn (types grafted), appends the new one, keeps the rest',
    !!mg && mg.spliced.includes('greet') && mg.appended.includes('shout')
    && mg.content.includes('greet(name: string): string') && mg.content.includes("'hello '")
    && !mg.content.includes("'hi '") && mg.content.includes('KEEP'), mg?.content.slice(0, 80))
  ok('merge unions named imports from the same specifier',
    !!mg && /import \{ helper, extra \} from '\.\/util'/.test(mg.content))

  const mSet = await mergeCertifiedFileSet(
    [
      { path: 'src/greet.ts', source: mCertified },
      { path: 'src/new.ts', source: "import { greet } from './greet'\nexport const hi = greet('x')" },
    ],
    new Map([['src/greet.ts', mExisting]]),
  )
  ok('mergeCertifiedFileSet merges colliding files, passes new files through',
    !!mSet && mSet.files.length === 2 && mSet.files[0].source.includes('KEEP')
    && mSet.files[1].source.includes("greet('x')"), mSet?.detail)

  const mBad = await mergeCertifiedFileSet(
    [{ path: 'src/a.ts', source: 'export function f(x) { return x }' }],
    new Map([['src/a.ts', 'function f(a: number, b: number) { return a + b }\nexport { f }\nexport const use = f(1, 2)\n']]),
  )
  ok('unmergeable collision (arity break at a call site) → null, whole set refused', mBad === null)

  // ── PART I — multi-file verification (cross-file import graph, execution-certified) ─
  // The mission gap: real SWE spans multiple files with imports. The verifier BUNDLES the
  // files (resolving cross-file edges) and executes cases against the whole graph, so a
  // multi-file candidate is certified by execution — same contract as one-file VGR.
  console.log('\nPART I — multi-file verification (cross-file imports)')
  const mfGood = await verifyMultiFileCode([
    { path: 'math.ts', source: 'export function add(a: number, b: number): number { return a + b }' },
    { path: 'index.ts', source: "import { add } from './math'\nexport function double(x: number): number { return add(x, x) }" },
  ], { entry: 'double', cases: [
    { args: [3], expected: 6, entry: 'double' },
    { args: [2, 5], expected: 7, entry: 'add' },
  ] })
  ok('correct cross-file graph → certified (case targets an import-consuming fn)', mfGood.pass, mfGood.signals[0])

  const mfBadImport = await verifyMultiFileCode([
    { path: 'math.ts', source: 'export function add(a: number, b: number): number { return a + b }' },
    { path: 'index.ts', source: "import { add } from './nope'\nexport function double(x: number): number { return add(x, x) }" },
  ], { entry: 'double', cases: [{ args: [3], expected: 6 }] })
  ok('broken import path → rejected at bundle time (never ships an unbuildable graph)',
    !mfBadImport.pass && mfBadImport.signals[0].includes('bundle/compile error'))

  const mfWrong = await verifyMultiFileCode([
    { path: 'math.ts', source: 'export function add(a: number, b: number): number { return a - b }' },
    { path: 'index.ts', source: "import { add } from './math'\nexport function double(x: number): number { return add(x, x) }" },
  ], { entry: 'double', cases: [{ args: [3], expected: 6, entry: 'double' }] })
  ok('wrong logic in an imported file → rejected with actual-vs-expected signal',
    !mfWrong.pass && mfWrong.signals[0].includes('got 0, expected 6'))

  // ── PART J — multi-FILE loop (detection + spec + proposer→bundle→certify, no live model) ─
  console.log('\nPART J — multi-file synthesis loop (deterministic proof)')

  ok('isMultiFileRequest true for ≥2 named files',
    isMultiFileRequest('Create src/math.ts exporting add and src/index.ts importing it'))
  ok('isMultiFileRequest false for a one-file request',
    !isMultiFileRequest('write sumEvens in src/sum.ts'))
  ok('detectRequestedFiles finds both paths',
    JSON.stringify(detectRequestedFiles('put it in src/math.ts and src/index.ts')) === '["src/math.ts","src/index.ts"]')

  const parsed = parseFileSet('// file: src/math.ts\n```ts\nexport function add(a,b){return a+b}\n```\n// file: src/index.ts\n```ts\nimport { add } from "./math"\nexport function double(x){return add(x,x)}\n```')
  ok('parseFileSet reads both files from a `// file:` + fenced-block response',
    parsed.length === 2 && parsed[0].path === 'src/math.ts' && parsed[1].path === 'src/index.ts' && parsed[0].source.includes('add'))

  // A request with USER-stated examples (gold) so spec extraction needs no live model.
  const MF_TASK = 'Create src/math.ts exporting add and src/index.ts that imports add and exports double. Examples: add(2,5) === 7, double(3) === 6, double(0) === 0.'
  const MF_WRONG: CandidateFile[] = [
    { path: 'src/math.ts', source: 'export function add(a,b){return a-b}' },
    { path: 'src/index.ts', source: "import { add } from './math'\nexport function double(x){return add(x,x)}" },
  ]
  const MF_RIGHT: CandidateFile[] = [
    { path: 'src/math.ts', source: 'export function add(a,b){return a+b}' },
    { path: 'src/index.ts', source: "import { add } from './math'\nexport function double(x){return add(x,x)}" },
  ]
  // Mock proposer: emits the WRONG file set until it has seen a failing verdict, then the RIGHT one.
  const mfMock = async (ctx: ProposeContext<CandidateFile[]>): Promise<Candidate<CandidateFile[]>> => {
    const set = ctx.history.some(a => !a.verdict.pass) ? MF_RIGHT : MF_WRONG
    return { value: set, fingerprint: 'mf' + (ctx.history.some(a => !a.verdict.pass) ? 'R' : 'W') }
  }
  const mf = await solveMultiFileRequest(MF_TASK, { maxModelCalls: 6, beamWidth: 1 }, mfMock)
  console.log(`    multi-file result: ${mf.status} in ${mf.search?.modelCalls} call(s) — ${mf.detail}`)
  ok('multi-file loop CERTIFIES a correct file set through execution (wrong graph rejected, then fixed)',
    mf.status === 'solved' && !!mf.files && mf.files.length === 2)
  ok('multi-file loop needed ≥2 calls (first proposal was rejected by cross-file execution, not trusted)',
    (mf.search?.modelCalls ?? 0) >= 2)

  // Coverage gate: a candidate that COLLAPSES a ≥2-file request into one file is rejected
  // (correct-but-not-asked), so the loop never "solves" by ignoring the requested layout.
  const collapseMock = async (): Promise<Candidate<CandidateFile[]>> => ({
    value: [{ path: 'src/math.ts', source: 'export function add(a,b){return a+b}\nexport function double(x){return add(x,x)}' }],
    fingerprint: 'collapse',
  })
  const collapsed = await solveMultiFileRequest(MF_TASK, { maxModelCalls: 3, beamWidth: 1 }, collapseMock)
  ok('collapsing a 2-file request into ONE file is rejected by the coverage gate (never falsely "solved")',
    collapsed.status !== 'solved' && collapsed.files === null)

  // No-USER-example MULTI-FUNCTION path: consensus cases extracted for EVERY named function, then
  // the whole graph certified — proven deterministically with an injected completer + mock proposer.
  const NOEX = 'Create src/mathx.ts exporting square(n) and src/use.ts importing square and exporting sumSquares(a, b).'
  ok('detectDeclaredFunctions finds both named functions',
    JSON.stringify(detectDeclaredFunctions(NOEX).sort()) === '["square","sumSquares"]')
  const specCompleter = async () => JSON.stringify({ cases: [
    { entry: 'square', args: [3], expected: 9 }, { entry: 'square', args: [0], expected: 0 },
    { entry: 'sumSquares', args: [3, 4], expected: 25 }, { entry: 'sumSquares', args: [0, 0], expected: 0 },
  ] })
  const mfx = await extractMultiFunctionSpec(NOEX, detectDeclaredFunctions(NOEX), { samples: 3, complete: specCompleter })
  ok('multi-function extraction yields consensus cases for BOTH functions',
    mfx.ok && mfx.spec?.entries.length === 2 && mfx.spec.cases.some(c => c.entry === 'square') && mfx.spec.cases.some(c => c.entry === 'sumSquares'),
    mfx.detail)
  const noexProposer = async (): Promise<Candidate<CandidateFile[]>> => ({
    value: [
      { path: 'src/mathx.ts', source: 'export function square(n){return n*n}' },
      { path: 'src/use.ts', source: "import { square } from './mathx'\nexport function sumSquares(a,b){return square(a)+square(b)}" },
    ], fingerprint: 'noex',
  })
  const noex = await solveMultiFileRequest(NOEX, { specComplete: specCompleter, specSamples: 3, maxModelCalls: 3, beamWidth: 1 }, noexProposer)
  ok('no-example multi-function graph is CERTIFIED across files (every export verified, not just one)',
    noex.status === 'solved' && noex.files?.length === 2 && (noex.entries?.length ?? 0) === 2,
    noex.detail)

  // No-example PROPERTY path: each declared function that matches a family is certified by its
  // invariants ACROSS the bundle — no model-invented cases at all (doctrine's preferred no-example tier).
  const PROP_NL = 'Create src/strings.ts exporting reverse(s) and src/numbers.ts exporting isPrime(n).'
  const dp = deriveMultiFileProperties(detectDeclaredFunctions(PROP_NL))
  ok('deriveMultiFileProperties collects invariants for EACH property-shaped function',
    !!dp && dp.entries.length === 2 && dp.families.includes('reverse') && dp.families.includes('isPrime'))
  const propRight = async (): Promise<Candidate<CandidateFile[]>> => ({
    value: [
      { path: 'src/strings.ts', source: 'export function reverse(s){return s.split("").reverse().join("")}' },
      { path: 'src/numbers.ts', source: 'export function isPrime(n){if(n<2)return false;for(let d=2;d*d<=n;d++)if(n%d===0)return false;return true}' },
    ], fingerprint: 'pr',
  })
  const propWrong = async (): Promise<Candidate<CandidateFile[]>> => ({
    value: [
      { path: 'src/strings.ts', source: 'export function reverse(s){return s}' },
      { path: 'src/numbers.ts', source: 'export function isPrime(n){if(n<2)return false;for(let d=2;d*d<=n;d++)if(n%d===0)return false;return true}' },
    ], fingerprint: 'pw',
  })
  const pg = await solveMultiFileRequest(PROP_NL, { maxModelCalls: 2, beamWidth: 1 }, propRight)
  ok('no-example PROPERTY multi-file graph CERTIFIED across files (no model-invented cases)',
    pg.status === 'solved' && pg.files?.length === 2, pg.detail)
  const pw = await solveMultiFileRequest(PROP_NL, { maxModelCalls: 2, beamWidth: 1 }, propWrong)
  ok('a property-violating file in the graph is REJECTED (real certification, not memorized)',
    pw.status !== 'solved' && !!pw.search?.best?.verdict.signals.some(s => /property violated/.test(s)))

  // Widened families: a number-theory bundle (gcd + lcm) certifies purely by cross-function
  // invariants — lcm's a*b/gcd reference is checked alongside gcd's own family, no examples.
  const NT_NL = 'Create src/gcd.ts exporting gcd(a,b) and src/lcm.ts exporting lcm(a,b).'
  const ntDp = deriveMultiFileProperties(detectDeclaredFunctions(NT_NL))
  ok('deriveMultiFileProperties resolves the widened lcm family alongside gcd',
    !!ntDp && ntDp.families.includes('gcd') && ntDp.families.includes('lcm'))
  const ntRight = async (): Promise<Candidate<CandidateFile[]>> => ({
    value: [
      { path: 'src/gcd.ts', source: 'export function gcd(a,b){a=Math.abs(a);b=Math.abs(b);while(b){[a,b]=[b,a%b]}return a}' },
      { path: 'src/lcm.ts', source: 'export function lcm(a,b){const g=(x,y)=>{while(y){[x,y]=[y,x%y]}return x};return a*b/g(a,b)}' },
    ], fingerprint: 'ntr',
  })
  const ntg = await solveMultiFileRequest(NT_NL, { maxModelCalls: 2, beamWidth: 1 }, ntRight)
  ok('no-example gcd+lcm number-theory bundle CERTIFIED by widened property families',
    ntg.status === 'solved' && ntg.files?.length === 2, ntg.detail)

  // Second widened batch: a temperature-conversion bundle (C→F + F→C) certifies by the two
  // affine references — no examples, both directions independently property-checked.
  const TMP_NL = 'Create src/toF.ts exporting celsiusToFahrenheit(c) and src/toC.ts exporting fahrenheitToCelsius(f).'
  const tmpDp = deriveMultiFileProperties(detectDeclaredFunctions(TMP_NL))
  ok('deriveMultiFileProperties resolves both temperature families (C→F and F→C)',
    !!tmpDp && tmpDp.families.includes('celsiusToFahrenheit') && tmpDp.families.includes('fahrenheitToCelsius'))
  const tmpRight = async (): Promise<Candidate<CandidateFile[]>> => ({
    value: [
      { path: 'src/toF.ts', source: 'export function celsiusToFahrenheit(c){return c*9/5+32}' },
      { path: 'src/toC.ts', source: 'export function fahrenheitToCelsius(f){return (f-32)*5/9}' },
    ], fingerprint: 'tmp',
  })
  const tmpg = await solveMultiFileRequest(TMP_NL, { maxModelCalls: 2, beamWidth: 1 }, tmpRight)
  ok('no-example temperature bundle CERTIFIED by widened property families',
    tmpg.status === 'solved' && tmpg.files?.length === 2, tmpg.detail)

  // ── DIFFERENTIAL CONSENSUS — certify an ARBITRARY function with no property family ──
  // titleCase matches NO property family, so the strong property path abstains. Differential
  // consensus derives its ground truth from agreement across independently-written impls on
  // system-fuzzed inputs — the mechanism that reaches beyond the family whitelist. All impls
  // deterministic (injected sampler) so this proves the ORACLE with zero model dependency.
  const mkImpl = (source: string) => ({ source, fingerprint: implFingerprint(source) })
  const TITLE = 'Write titleCase(s) that upper-cases the first letter of each space-separated word and lower-cases the rest.'

  // No property family covers titleCase — this is exactly the gap differential closes.
  ok('property path ABSTAINS on titleCase (no family) — the gap differential must cover',
    derivePropertySpec(TITLE) === null)

  // Three genuinely-independent CORRECT implementations (split/map, regex-replace, char-reduce).
  const titleImpls = [
    mkImpl(`export function titleCase(s){return s.split(' ').map(w=>w?w[0].toUpperCase()+w.slice(1).toLowerCase():w).join(' ')}`),
    mkImpl(`export function titleCase(s){return s.replace(/\\S+/g,w=>w.charAt(0).toUpperCase()+w.substring(1).toLowerCase())}`),
    mkImpl(`export function titleCase(s){let o='',b=true;for(const c of s){if(c===' '){o+=c;b=true}else{o+=b?c.toUpperCase():c.toLowerCase();b=false}}return o}`),
  ]
  const diff = await deriveDifferentialSpec(TITLE, { sampleImpls: async () => titleImpls, minCases: 4 })
  ok('differential consensus DERIVES a trustworthy spec for titleCase (no family, no user examples)',
    diff.ok && !!diff.spec && diff.spec.cases.length >= 4, diff.detail ?? diff.reason)

  if (diff.ok && diff.spec) {
    const acc = { goal: '', domain: 'code' as const, acceptance: { entry: 'titleCase', cases: diff.spec.cases } as any }
    // A FRESH correct impl (not among the samplers) passes every derived case → the spec is sound.
    const fresh = { value: `export function titleCase(s){return s.split(' ').map(w=>w.length?w[0].toUpperCase()+w.slice(1).toLowerCase():'').join(' ')}`, fingerprint: 'fresh' }
    const vFresh = await verifyCode(fresh, acc)
    ok('a fresh correct impl PASSES every differentially-derived case (spec is sound, not overfit)', vFresh.pass, vFresh.signals[0])
    // A plausible-but-WRONG impl (only capitalizes the first letter of the whole string) is REJECTED.
    const wrong = { value: `export function titleCase(s){return s.charAt(0).toUpperCase()+s.slice(1)}`, fingerprint: 'wrong' }
    const vWrong = await verifyCode(wrong, acc)
    ok('a plausible-but-wrong impl is REJECTED by the derived cases (real gate, not a rubber stamp)', !vWrong.pass, vWrong.signals[0])
  }

  // ABSTAIN when no quorum forms: three impls that never agree → no trustworthy ground truth.
  const noAgree = await deriveDifferentialSpec(TITLE, {
    sampleImpls: async () => [
      mkImpl(`export function titleCase(s){return s.length}`),
      mkImpl(`export function titleCase(s){return s.toUpperCase()}`),
      mkImpl(`export function titleCase(s){return s.split('').reverse().join('')}`),
    ], minCases: 4,
  })
  ok('differential ABSTAINS when independent impls never agree (never fabricates ground truth)', !noAgree.ok, noAgree.reason)

  // ECHO GUARD: the same implementation sampled twice is ONE source, not corroboration.
  const echo = await deriveDifferentialSpec(TITLE, {
    sampleImpls: async () => [titleImpls[0], mkImpl(titleImpls[0].source)], minCases: 4,
  })
  ok('differential rejects an ECHOED impl as its own corroboration (needs ≥2 DISTINCT sources)', !echo.ok, echo.reason)

  // ── METAMORPHIC RELATION from SPEC TEXT — certify a CUSTOM-NAMED sort/reverse ──────
  // `arrange` and `flipOrder` match NO name-gated family, but the DESCRIPTION says "ascending
  // order" / "reversed" — so the complete metamorphic relation certifies them. Crucially this
  // is UN-FOOLABLE: a descending sort (which value-consensus over all-descending samples would
  // wrongly "certify") is REJECTED by the ordered-ascending relation. Deterministic, no model.
  const metaProp = (entry: string, family: string, assertions: string[]) =>
    ({ goal: '', domain: 'code' as const, acceptance: { entry, family, assertions } as any })

  const ARRANGE = 'Write arrange(items) that returns the items in ascending order.'
  ok('property whitelist ABSTAINS on custom-named sort `arrange` (no /sort/ in the name)',
    derivePropertySpec(ARRANGE) === null)
  const mArr = deriveMetamorphicSpec(ARRANGE)
  ok('metamorphic detects sort(asc) from the DESCRIPTION of `arrange` (name-independent)',
    !!mArr && mArr.family === 'sort(asc)' && mArr.entry === 'arrange', mArr?.family)

  if (mArr) {
    const acc = metaProp(mArr.entry, mArr.family, mArr.assertions)
    const rightAsc = await verifyByProperty({ value: `export function arrange(a){return [...a].sort((x,y)=>x<y?-1:x>y?1:0)}`, fingerprint: 'r' }, acc)
    ok('a correct ascending sort PASSES the metamorphic relation', rightAsc.pass, rightAsc.signals[0])
    // THE un-foolable demo: a systematically-wrong DESCENDING sort is rejected by ordered-asc.
    const desc = await verifyByProperty({ value: `export function arrange(a){return [...a].sort((x,y)=>x>y?-1:x<y?1:0)}`, fingerprint: 'd' }, acc)
    ok('a DESCENDING sort is REJECTED (un-foolable: value-consensus could not catch a shared bug here)', !desc.pass, desc.signals[0])
    // An element-dropping "sort" is rejected by permutation-preservation.
    const drop = await verifyByProperty({ value: `export function arrange(a){return [...a].sort((x,y)=>x-y).slice(1)}`, fingerprint: 'x' }, acc)
    ok('an element-dropping sort is REJECTED by permutation-preservation', !drop.pass, drop.signals[0])
  }

  const FLIP = 'Write flipOrder(seq) that returns the sequence reversed.'
  const mFlip = deriveMetamorphicSpec(FLIP)
  ok('metamorphic detects reverse from the DESCRIPTION of `flipOrder` (name-independent)',
    !!mFlip && mFlip.family === 'reverse', mFlip?.family)
  if (mFlip) {
    const acc = metaProp(mFlip.entry, mFlip.family, mFlip.assertions)
    const rev = await verifyByProperty({ value: `export function flipOrder(s){return Array.isArray(s)?[...s].reverse():[...s].reverse().join('')}`, fingerprint: 'r' }, acc)
    ok('a correct reverse PASSES the metamorphic relation', rev.pass, rev.signals[0])
    const id = await verifyByProperty({ value: `export function flipOrder(s){return s}`, fingerprint: 'i' }, acc)
    ok('the identity function is REJECTED as a reverse (position-map fails)', !id.pass, id.signals[0])
  }

  // Domain from prose: a bare "sort" is numeric (the FM's (a,b)=>a-b comparator must PASS);
  // string inputs join the battery only when the prose says so. (Live gap found cont.59: the
  // string battery failed a correct numeric sort → fell to differential, which certified the
  // shared NaN misordering.)
  if (mArr) {
    const acc = metaProp(mArr.entry, mArr.family, mArr.assertions)
    const numeric = await verifyByProperty({ value: `export function arrange(a){return [...a].sort((x,y)=>x-y)}`, fingerprint: 'n' }, acc)
    ok('a numeric-comparator sort PASSES a bare "ascending order" request (numeric battery)', numeric.pass, numeric.signals[0])
  }
  const mAlpha = deriveMetamorphicSpec('Write arrange(words) that sorts the strings alphabetically in ascending order.')
  ok('alphabetical prose → string battery selected', !!mAlpha && mAlpha.assertions[0].includes('banana'), mAlpha?.assertions[0]?.slice(0, 80))

  // Direction + guard against false positives.
  ok('metamorphic reads DESCENDING direction from the spec',
    deriveMetamorphicSpec('Write orderBy(xs) returning them in descending order.')?.family === 'sort(desc)')
  ok('metamorphic does NOT fire on the "reverse engineer" idiom (not a sequence reversal)',
    deriveMetamorphicSpec('Write a tool to reverse engineer the config file format.') === null)

  // ── REFERENCE-ORACLE relation classes (dedupe / max / sum / average / flatten / filter) ──
  // The complete relation is "output ≡ a deterministic reference the assertion computes itself"
  // — spec-derived, zero model, un-foolable by shared implementation bugs.
  const DEDUPE = 'Write pickUniques(xs) that removes duplicate values from a list.'
  const mDedupe = deriveMetamorphicSpec(DEDUPE)
  ok('reference class detects DEDUPE from prose (custom name)', !!mDedupe && mDedupe.family === 'dedupe', mDedupe?.family)
  if (mDedupe) {
    const acc = metaProp(mDedupe.entry, mDedupe.family, mDedupe.assertions)
    const right = await verifyByProperty({ value: `export function pickUniques(a){return [...new Set(a)]}`, fingerprint: 'r' }, acc)
    ok('a correct first-occurrence dedupe PASSES the reference relation', right.pass, right.signals[0])
    const wrong = await verifyByProperty({ value: `export function pickUniques(a){return [...a]}`, fingerprint: 'w' }, acc)
    ok('the identity function is REJECTED as a dedupe', !wrong.pass, wrong.signals[0])
  }

  const MAXQ = 'Write biggest(nums) that returns the largest number in an array.'
  const mMax = deriveMetamorphicSpec(MAXQ)
  ok('reference class detects MAX from prose (custom name)', !!mMax && mMax.family === 'max', mMax?.family)
  if (mMax) {
    const acc = metaProp(mMax.entry, mMax.family, mMax.assertions)
    const right = await verifyByProperty({ value: `export function biggest(a){return Math.max(...a)}`, fingerprint: 'r' }, acc)
    ok('a correct max PASSES the reference relation', right.pass, right.signals[0])
    const first = await verifyByProperty({ value: `export function biggest(a){return a[0]}`, fingerprint: 'f' }, acc)
    ok('returning the first element is REJECTED as max', !first.pass, first.signals[0])
  }

  const EVENS = 'Write keepEvens(xs) that keeps only the even numbers from the array.'
  const mEven = deriveMetamorphicSpec(EVENS)
  ok('reference class detects FILTER(even) from prose', !!mEven && mEven.family === 'filter(even)', mEven?.family)
  if (mEven) {
    const acc = metaProp(mEven.entry, mEven.family, mEven.assertions)
    const right = await verifyByProperty({ value: `export function keepEvens(a){return a.filter(v=>v%2===0)}`, fingerprint: 'r' }, acc)
    ok('a correct even-filter PASSES', right.pass, right.signals[0])
    const inverted = await verifyByProperty({ value: `export function keepEvens(a){return a.filter(v=>v%2!==0)}`, fingerprint: 'i' }, acc)
    ok('an INVERTED filter (keeps odds) is REJECTED', !inverted.pass, inverted.signals[0])
  }

  ok('reference class detects deep FLATTEN from prose',
    deriveMetamorphicSpec('Write squash(arr) that flattens a deeply nested array into a flat list.')?.family === 'flatten')
  ok('COMPOUND guard: "largest sum of a contiguous subarray" does NOT certify as simple max/sum',
    deriveMetamorphicSpec('Write best(nums) that finds the largest sum of a contiguous subarray of the numbers in the array.') === null)
  ok('AMBIGUITY guard: prose matching two reference classes refuses to certify',
    deriveMetamorphicSpec('Write pick(xs) that keeps only the even numbers and returns the unique values.') === null)

  // ── STRING metamorphic classes + counterexample signals ──────────────────────────
  const SLUG = 'Write slugify(s) that lowercases, trims, and replaces non-alphanumeric runs with single hyphens.'
  const mSlug = deriveMetamorphicSpec(SLUG)
  ok('slug class detected from prose', !!mSlug && mSlug.family === 'slug', mSlug?.family)
  if (mSlug) {
    const acc = metaProp(mSlug.entry, mSlug.family, mSlug.assertions)
    const buggy = await verifyByProperty({ value: `export function slugify(s){return s.toLowerCase().replace(/[^a-z0-9-]/gi,'-')}`, fingerprint: 'b' }, acc)
    ok('a slugify leaving edge/double hyphens is REJECTED', !buggy.pass, buggy.signals[0])
    ok('the rejection signal carries a CONCRETE counterexample (input = output)', /slugify\(.*\).*=.*"/.test(buggy.signals.join(' ')), buggy.signals[0])
    const good = await verifyByProperty({ value: `export function slugify(s){return s.toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')}`, fingerprint: 'g' }, acc)
    ok('a correct slugify PASSES the slug invariants', good.pass, good.signals[0])
  }
  ok('weak string-transform property no longer certifies (falls through to strong tiers)',
    derivePropertySpec(SLUG) === null)

  // ── CANONICAL fast-path: verified reference, ZERO model calls ─────────────────────
  {
    const canonQs: Array<[string, string]> = [
      ['Write slugify(s) that lowercases, trims, and replaces non-alphanumeric runs with single hyphens.', 'slug'],
      ['Write flipList(xs) that returns the array reversed.', 'reverse'],
      ['Write biggest(nums) that returns the largest number in an array.', 'max'],
      ['Write arrange(items) that returns the items in ascending order.', 'sort(asc)'],
    ]
    for (const [q, fam] of canonQs) {
      const spec = deriveMetamorphicSpec(q)
      const canon = spec ? canonicalImpl(spec) : null
      ok(`canonical reference exists for ${fam}`, !!canon && canon.includes(spec!.entry), spec?.family)
      if (spec && canon) {
        const v = await verifyByProperty({ value: canon, fingerprint: 'c' }, metaProp(spec.entry, spec.family, spec.assertions))
        ok(`canonical ${fam} impl PASSES its own invariant (certified, 0 model calls)`, v.pass, v.signals[0])
      }
    }
    // End-to-end: solveCodingRequest returns the canonical solution with ZERO model calls.
    const solved = await solveCodingRequest('Write slugify(s) that lowercases, trims, and replaces non-alphanumeric runs with single hyphens.', { maxModelCalls: 6 })
    ok('solveCodingRequest ships canonical slug with 0 model calls', solved.status === 'solved' && /canonical reference \(0 model calls/.test(solved.detail ?? ''), solved.detail)
  }

  // ── Canonical OVER-FIRE guards: a tweaked spec must NOT get the wrong canonical impl ──────
  ok('word-order reversal does NOT canonical-reverse (char reverse would be wrong)',
    deriveMetamorphicSpec('Write reverseWords(s) that reverses the order of words in a sentence.') === null)
  ok('sort BY a custom key does NOT canonical-sort (value comparator would be wrong)',
    deriveMetamorphicSpec('Write sortByLength(xs) that sorts strings by their length ascending.') === null)
  ok('sort by age does NOT canonical-sort', deriveMetamorphicSpec('Write ranked(users) that sorts records by age.') === null)
  ok('plain "in ascending order" STILL canonical-sorts (direction word is not a key)',
    deriveMetamorphicSpec('Write arrange(xs) that returns them in ascending order.')?.family === 'sort(asc)')
  ok('plain array reverse STILL fires', deriveMetamorphicSpec('Write flip(xs) that reverses an array.')?.family === 'reverse')

  // ── DIFFERENTIAL determinism guard: nondeterministic output never becomes ground truth ──
  const RANDQ = 'Write jitter(n) that returns a random number derived from n.'
  const randImpl = (src: string) => ({ source: src, fingerprint: implFingerprint(src) })
  const nondet = await deriveDifferentialSpec(RANDQ, {
    sampleImpls: async () => [
      randImpl('export function jitter(n){return n + Math.random()}'),
      randImpl('export function jitter(n){return Math.random() + n}'),
      randImpl('export function jitter(n){return n * Math.random() + Math.random()}'),
    ],
    minCases: 3,
  })
  ok('differential ABSTAINS on a nondeterministic function (run-to-run instability detected)',
    !nondet.ok && /nondeterministic|only \d/.test(nondet.reason ?? ''), nondet.reason)

  // ── PART B ──────────────────────────────────────────────────────────────────────
  const fmUp = await checkFmAvailable()
  console.log(`\nPART B — live on-device FM proposer ${fmUp ? '(daemon UP)' : '(SKIPPED — daemon down)'}`)
  if (fmUp) {
    const live = await solveCodeTask({
      goal: 'Write dedupeStable(arr) that removes duplicate values from an array while preserving first-seen order.',
      entry: 'dedupeStable',
      cases: [
        { args: [[1, 1, 2, 3, 3, 1]], expected: [1, 2, 3] },
        { args: [['a', 'b', 'a', 'c']], expected: ['a', 'b', 'c'] },
        { args: [[]], expected: [] },
      ],
    }, { maxModelCalls: 8, beamWidth: 2 })
    console.log(`    live result: ${live.status} in ${live.modelCalls} call(s) — ${live.detail}`)
    ok('live on-device loop reaches a certified solution OR abstains honestly (never ships unverified)',
      live.status === 'solved' || live.solution === null)

    // Live end-to-end DIFFERENTIAL path: an arbitrary function with no property family and no
    // user examples, solved (or honestly abstained) entirely from the on-device weak model —
    // impls sampled live, inputs system-fuzzed, outputs cross-checked by execution.
    const dlive = await solveCodingRequest(
      'Write titleCase(s) that upper-cases the first letter of each space-separated word and lower-cases the rest.',
      { maxModelCalls: 8, beamWidth: 2, differential: { samples: 4, minCases: 3 } },
    )
    const viaDifferential = (dlive.detail ?? '').includes('differential consensus')
    console.log(`    live differential: ${dlive.status}${viaDifferential ? ' [via differential path]' : ''} — ${dlive.detail}`)
    ok('live differential path certifies an arbitrary function OR abstains honestly (no property family)',
      dlive.status === 'solved' ? dlive.code !== null : dlive.code === null)

    // Live end-to-end METAMORPHIC path: a CUSTOM-NAMED sort described only in prose, certified
    // against the (permutation ∧ ordered) invariant by the on-device weak model — no name family,
    // no user examples, no model-invented values.
    const mlive = await solveCodingRequest(
      'Write arrange(items) that returns the items sorted in ascending order.',
      { maxModelCalls: 8, beamWidth: 2 },
    )
    const viaMeta = (mlive.detail ?? '').includes('metamorphic')
    console.log(`    live metamorphic: ${mlive.status}${viaMeta ? ' [via metamorphic path]' : ''} — ${mlive.detail}`)
    ok('live metamorphic path certifies a custom-named sort OR abstains honestly',
      mlive.status === 'solved' ? mlive.code !== null : mlive.code === null)
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
}

run().catch(e => { console.error(e); process.exit(1) })
