// ═══════════════════════════════════════════════════════════════════════════════
// VGR — property-based verifier (certify tasks that have NO worked example)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Many requests state no concrete f(x)===y example ("write a function to sort an array
// ascending"). The doctrine forbids guessing an answer AND forbids memorizing one — so we
// certify against a GENERAL PROPERTY instead: a sort's output is a sorted permutation of
// its input; a codec roundtrips; a validator returns a boolean. These hold for ALL inputs,
// so a candidate that satisfies them is correct for the right reason, not pattern-matched.
//
// The family detection + property assertions are REUSED from the synth path
// (`synth/derive.ts derivePropertyTests`) — the exact high-confidence families the L0/L1
// oracle already trusts — so VGR and synth agree on what "correct by property" means. We
// only add execution: the assertions run in the same sandboxed harness as codeVerifier.
// Zero model in this file.
// ═══════════════════════════════════════════════════════════════════════════════

import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { transform } from 'esbuild'
import { extractFeatures } from '../synth/index'
import { derivePropertyTests, entryFromExamples } from '../synth/derive'
import type { Candidate, TaskSpec, Verdict } from './types'

export interface PropertyAcceptance {
  entry: string
  family: string
  /** Verbatim `prop('label', <boolean expr>)` call lines lifted from derivePropertyTests. */
  assertions: string[]
  timeoutMs?: number
  [k: string]: unknown
}

/**
 * Derive a property spec from an NL request, or null when no high-confidence family matches
 * (→ VGR abstains rather than certify against a weak/absent property). Reuses the synth
 * path's family detection so the two engines never disagree on what a property means.
 */
export function derivePropertySpec(nl: string): { entry: string; family: string; assertions: string[] } | null {
  const pt = derivePropertyTests(nl, 'src/module.ts')
  if (!pt) return supplementalPropertySpec(nl)  // synth families missed → try VGR-side families
  // Lift the assertion calls. derive wraps each as: `try { prop('label', EXPR) } catch(e) { … }`.
  // The `} catch(e) { prop(` delimiter is stable and never appears inside an assertion's own
  // EXPR, so a greedy capture up to it recovers the inner `prop(...)` verbatim. Also accept a
  // bare `prop(...)` line for robustness against future formatting.
  const assertions: string[] = []
  for (const raw of pt.testFile.content.split('\n')) {
    const l = raw.trim()
    const wrapped = /^try\s*\{\s*(prop\([\s\S]*)\s*\}\s*catch\s*\(/.exec(l)
    if (wrapped) { assertions.push(wrapped[1].trim()); continue }
    if (l.startsWith('prop(')) assertions.push(l)
  }
  if (!assertions.length) return null
  const entry = entryFromExamples(nl) || extractFeatures(nl).exports[0] || ''
  if (!entry) return null
  // The 'string-transform' / 'object-transform' families carry only TRIVIAL invariants
  // (returns-a-string, idempotent, shape-preserving) that a wrong impl also satisfies — they
  // "certified" a buggy slugify (leading/trailing + doubled hyphens) live 2026-07-11. Refuse
  // to certify on them: return null so the ladder falls through to the STRONG metamorphic
  // string classes (slug/trim/case invariants, tier 2.5) and then differential consensus.
  if (pt.family === 'string-transform' || pt.family === 'object-transform') return null
  return { entry, family: pt.family, assertions }
}

// ── Supplemental property families (VGR-side; not in the shared synth path) ─────────
// Many common tasks (factorial, fibonacci, gcd, isPrime, …) have CRISP general properties —
// recurrences, divisibility, or an independent reference derivation — that certify correctness
// without knowing any specific answer value. This is the doctrine's ideal: reason about the
// problem's structure, never memorize an output. These fire only when the entry name matches
// tightly (avoiding the name-collision false-positive class documented in synth/derive.ts) and
// only when the synth families above don't already cover the request.

interface SuppFamily { family: string; test: (entry: string) => boolean; assertions: (E: string) => string[] }

// `E` is the entry function name; assertions are self-contained booleans over it.
const SUPP_FAMILIES: SuppFamily[] = [
  {
    family: 'factorial', test: e => /^(factorial|fact)$/i.test(e),
    assertions: E => [
      `prop('${E}(0)=1', ${E}(0) === 1)`,
      `prop('${E}(1)=1', ${E}(1) === 1)`,
      `prop('${E} recurrence n*f(n-1)', [2,3,4,5,6].every(n => ${E}(n) === n * ${E}(n-1)))`,
      `prop('${E}(5)=120', ${E}(5) === 120)`,
    ],
  },
  {
    family: 'fibonacci', test: e => /^(fib|fibonacci)$/i.test(e),
    // Base-case indexing varies by convention; the RECURRENCE is the convention-independent truth.
    assertions: E => [
      `prop('${E} recurrence f(n)=f(n-1)+f(n-2)', [4,5,6,7,8].every(n => ${E}(n) === ${E}(n-1) + ${E}(n-2)))`,
      `prop('${E} non-negative', [0,1,2,5,8].every(n => ${E}(n) >= 0))`,
    ],
  },
  {
    family: 'gcd', test: e => /^(gcd|greatestcommondivisor)$/i.test(e),
    assertions: E => [
      `prop('${E} divides both', (() => { const g=${E}(48,36); return g>0 && 48%g===0 && 36%g===0 })())`,
      `prop('${E}(a,a)=a', ${E}(9,9) === 9)`,
      `prop('${E}(a,0)=a', ${E}(7,0) === 7)`,
      `prop('${E} is maximal', (() => { const g=${E}(12,18); for(let d=g+1; d<=18; d++) if(12%d===0 && 18%d===0) return false; return true })())`,
    ],
  },
  {
    family: 'isPrime', test: e => /^isprime$/i.test(e),
    // Independent reference derivation (trial division) as the oracle — the doctrine's cross-check.
    assertions: E => [
      `prop('${E} matches trial division', (() => { const ref = n => { if (n < 2) return false; for (let d=2; d*d<=n; d++) if (n%d===0) return false; return true }; return [0,1,2,3,4,5,6,7,8,9,10,11,12,13,15,17,19,20,23,25,29].every(n => Boolean(${E}(n)) === ref(n)) })())`,
    ],
  },
  {
    family: 'capitalize', test: e => /^capitali[sz]e$/i.test(e),
    assertions: E => [
      `prop('${E} first char upper', ${E}('hello') === 'Hello')`,
      `prop('${E} length preserved', ${E}('hello world').length === 11)`,
      `prop('${E} idempotent', ${E}(${E}('hello')) === ${E}('hello'))`,
      `prop('${E} empty→empty', ${E}('') === '')`,
    ],
  },
  {
    // Numeric reduction. Tight name gate — 'sum'/'summarize'/'summary' collision class is
    // exactly why this only matches the bare reduction names, never a substring.
    family: 'sum', test: e => /^(sum|sumArray|total|addAll|sumOf|arraySum)$/i.test(e),
    assertions: E => [
      `prop('${E}([])=0', ${E}([]) === 0)`,
      `prop('${E}([x])=x', ${E}([7]) === 7)`,
      `prop('${E} matches reduce', (() => { const xs=[3,-1,4,1,5,9,2]; return ${E}(xs) === xs.reduce((a,b)=>a+b,0) })())`,
      `prop('${E} additive over concat', ${E}([1,2,3,4,5]) === ${E}([1,2]) + ${E}([3,4,5]))`,
    ],
  },
  {
    // Involution: reversing twice is identity, length is preserved. Works for string OR array
    // (JSON.stringify compares both). Name-gated to the bare reverse forms.
    family: 'reverse', test: e => /^(reverse|reverseString|reverseArray|reverseArr|reverseStr|rev)$/i.test(e),
    assertions: E => [
      `prop('${E} involution (twice = identity)', (() => { const x='abcde'; return ${E}(${E}(x)) === x })() || (() => { const x=[1,2,3,4]; return JSON.stringify(${E}(${E}(x))) === JSON.stringify(x) })())`,
      `prop('${E} length preserved', (() => { const r=${E}('abcde'); return (r && r.length === 5) })() || (() => { const r=${E}([1,2,3]); return r.length === 3 })())`,
      `prop('${E} first↔last', (() => { const r=${E}('abc'); return r[0]==='c' && r[2]==='a' })() || (() => { const r=${E}([1,2,3]); return r[0]===3 && r[2]===1 })())`,
    ],
  },
  {
    // chunk(arr, size): flattening the chunks reconstructs the input; every chunk ≤ size.
    family: 'chunk', test: e => /^(chunk|chunkArray|partition|batch|splitEvery)$/i.test(e),
    assertions: E => [
      `prop('${E} flattens back to input', JSON.stringify(${E}([1,2,3,4,5], 2).flat()) === JSON.stringify([1,2,3,4,5]))`,
      `prop('${E} respects size', ${E}([1,2,3,4,5], 2).every(c => c.length <= 2 && c.length >= 1))`,
      `prop('${E} empty→empty', ${E}([], 3).length === 0)`,
      `prop('${E} exact-multiple count', ${E}([1,2,3,4], 2).length === 2)`,
    ],
  },
  {
    // max(xs): the result is a member of xs AND ≥ every element — cross-checked against Math.max.
    family: 'max', test: e => /^(max|arrayMax|maximum|maxOf|largest)$/i.test(e),
    assertions: E => [
      `prop('${E} matches Math.max', (() => { const xs=[3,-1,4,1,5,9,2,6]; return ${E}(xs) === Math.max(...xs) })())`,
      `prop('${E} is a member and maximal', (() => { const xs=[3,-1,4,1,5]; const m=${E}(xs); return xs.includes(m) && xs.every(x => x <= m) })())`,
      `prop('${E}([x])=x', ${E}([7]) === 7)`,
      `prop('${E} negatives', ${E}([-5,-2,-9]) === -2)`,
    ],
  },
  {
    // min(xs): mirror of max — member of xs AND ≤ every element, cross-checked against Math.min.
    family: 'min', test: e => /^(min|arrayMin|minimum|minOf|smallest)$/i.test(e),
    assertions: E => [
      `prop('${E} matches Math.min', (() => { const xs=[3,-1,4,1,5,9,2,6]; return ${E}(xs) === Math.min(...xs) })())`,
      `prop('${E} is a member and minimal', (() => { const xs=[3,-1,4,1,5]; const m=${E}(xs); return xs.includes(m) && xs.every(x => x >= m) })())`,
      `prop('${E}([x])=x', ${E}([7]) === 7)`,
      `prop('${E} negatives', ${E}([-5,-2,-9]) === -9)`,
    ],
  },
  {
    // clamp(x, lo, hi): result stays in [lo,hi], is identity inside the range, and saturates outside.
    family: 'clamp', test: e => /^(clamp|clip|bound|constrain)$/i.test(e),
    assertions: E => [
      `prop('${E} identity in range', ${E}(5, 1, 10) === 5)`,
      `prop('${E} saturates low', ${E}(-3, 0, 10) === 0)`,
      `prop('${E} saturates high', ${E}(50, 0, 10) === 10)`,
      `prop('${E} always within bounds', [-100,-1,0,3,7,10,11,999].every(x => { const r=${E}(x,0,10); return r>=0 && r<=10 }))`,
      `prop('${E} idempotent', ${E}(${E}(50,0,10),0,10) === ${E}(50,0,10))`,
    ],
  },
  {
    // average(xs): equals sum/length — an independent reference derivation, not a memorized value.
    family: 'average', test: e => /^(average|mean|avg)$/i.test(e),
    assertions: E => [
      `prop('${E} matches sum/length', (() => { const xs=[2,4,6,8]; return ${E}(xs) === xs.reduce((a,b)=>a+b,0)/xs.length })())`,
      `prop('${E}([x])=x', ${E}([7]) === 7)`,
      `prop('${E} between min and max', (() => { const xs=[3,-1,4,1,5]; const a=${E}(xs); return a>=Math.min(...xs) && a<=Math.max(...xs) })())`,
    ],
  },
  {
    // power(base, exp): recurrence b^n = b·b^(n-1) with b^0 = 1 — convention-free structural truth.
    family: 'power', test: e => /^(power|pow|exponent|ipow|intpow)$/i.test(e),
    assertions: E => [
      `prop('${E}(b,0)=1', ${E}(2,0) === 1 && ${E}(9,0) === 1)`,
      `prop('${E} recurrence b*p(b,n-1)', [1,2,3,4,5,6,7,8].every(n => ${E}(2,n) === 2 * ${E}(2,n-1)))`,
      `prop('${E}(2,10)=1024', ${E}(2,10) === 1024)`,
      `prop('${E}(5,2)=25', ${E}(5,2) === 25)`,
    ],
  },
  {
    // isPalindrome(s): matches an independent reference (equals its own reversal, case/space as given).
    family: 'isPalindrome', test: e => /^(isPalindrome|palindrome|checkPalindrome)$/i.test(e),
    assertions: E => [
      `prop('${E} matches reverse-equality reference', (() => { const ref = s => s === [...s].reverse().join(''); return ['racecar','level','abba','','a','abc','hello','noon'].every(s => Boolean(${E}(s)) === ref(s)) })())`,
    ],
  },
  {
    // digitSum(n): equals the sum of |n|'s decimal digits — independent reference derivation.
    family: 'digitSum', test: e => /^(digitSum|sumDigits|digitalSum|sumOfDigits)$/i.test(e),
    assertions: E => [
      `prop('${E} matches digit-sum reference', (() => { const ref = n => String(Math.abs(n)).split('').reduce((a,d)=>a+Number(d),0); return [0,5,10,99,123,4567,1000000].every(n => ${E}(n) === ref(n)) })())`,
      `prop('${E}(single digit)=itself', [0,3,7,9].every(d => ${E}(d) === d))`,
    ],
  },
  {
    // countVowels(s): equals the reference regex count — independent derivation, no memorized answer.
    family: 'countVowels', test: e => /^(countVowels|vowelCount|numVowels)$/i.test(e),
    assertions: E => [
      `prop('${E} matches regex reference', (() => { const ref = s => (s.match(/[aeiou]/gi) || []).length; return ['hello','sky','aeiou','AEIOU','','rhythm','education'].every(s => ${E}(s) === ref(s)) })())`,
      `prop('${E} empty=0', ${E}('') === 0)`,
    ],
  },
  {
    // lcm(a,b): a*b/gcd — multiple of both and minimal. Pairs with the gcd family for number-theory bundles.
    family: 'lcm', test: e => /^(lcm|leastCommonMultiple|lowestCommonMultiple)$/i.test(e),
    assertions: E => [
      `prop('${E} is common multiple', (() => { const m=${E}(4,6); return m>0 && m%4===0 && m%6===0 })())`,
      `prop('${E} matches a*b/gcd', (() => { const g=(a,b)=>{while(b){[a,b]=[b,a%b]}return a}; return [[4,6],[3,5],[12,18],[7,7],[8,12]].every(([a,b]) => ${E}(a,b) === a*b/g(a,b)) })())`,
      `prop('${E} is minimal', (() => { const m=${E}(4,6); for(let k=1;k<m;k++) if(k%4===0 && k%6===0) return false; return true })())`,
    ],
  },
  {
    // isEven(n): parity matches n%2===0 — independent modulo reference.
    family: 'isEven', test: e => /^(isEven|even|checkEven)$/i.test(e),
    assertions: E => [
      `prop('${E} matches n%2===0', [-4,-3,-1,0,1,2,3,7,8,100,101].every(n => Boolean(${E}(n)) === (n%2===0)))`,
    ],
  },
  {
    // isOdd(n): parity matches n%2!==0 — independent modulo reference.
    family: 'isOdd', test: e => /^(isOdd|odd|checkOdd)$/i.test(e),
    assertions: E => [
      `prop('${E} matches n%2!==0', [-4,-3,-1,0,1,2,3,7,8,100,101].every(n => Boolean(${E}(n)) === (Math.abs(n%2)===1)))`,
    ],
  },
  {
    // unique(xs): dedupes preserving membership — matches Set-based reference, idempotent.
    family: 'unique', test: e => /^(unique|dedupe|dedup|distinct|uniq|removeDuplicates)$/i.test(e),
    assertions: E => [
      `prop('${E} matches Set reference', (() => { const xs=[1,2,2,3,1,4,4,4,5]; return JSON.stringify(${E}(xs)) === JSON.stringify([...new Set(xs)]) })())`,
      `prop('${E} idempotent', (() => { const xs=[3,1,3,2,1]; const a=${E}(xs); return JSON.stringify(${E}(a)) === JSON.stringify(a) })())`,
      `prop('${E} no duplicates remain', (() => { const r=${E}([1,1,2,3,3]); return r.length === new Set(r).size })())`,
    ],
  },
  {
    // flatten(xs): one-level flatten matches Array.prototype.flat() reference.
    family: 'flatten', test: e => /^(flatten|flat|flattenArray|flattenOnce)$/i.test(e),
    assertions: E => [
      `prop('${E} matches Array.flat', (() => { const xs=[[1,2],[3],[4,5,6],[]]; return JSON.stringify(${E}(xs)) === JSON.stringify(xs.flat()) })())`,
      `prop('${E} length = sum of parts', (() => { const xs=[[1,2],[3,4,5],[6]]; return ${E}(xs).length === 6 })())`,
    ],
  },
  {
    // median(xs): matches sort-and-middle reference; lies within [min,max].
    family: 'median', test: e => /^(median|middleValue)$/i.test(e),
    assertions: E => [
      `prop('${E} matches sort-middle reference', (() => { const ref = xs => { const s=[...xs].sort((a,b)=>a-b); const m=s.length>>1; return s.length%2 ? s[m] : (s[m-1]+s[m])/2 }; return [[3,1,2],[5,2,8,1],[7],[4,4,4,4]].every(xs => ${E}(xs) === ref(xs)) })())`,
      `prop('${E} within [min,max]', (() => { const xs=[3,1,4,1,5,9]; const m=${E}(xs); return m>=Math.min(...xs) && m<=Math.max(...xs) })())`,
    ],
  },
  {
    // primeFactors(n): product of factors = n, every factor prime — self-checking, no memorized list.
    family: 'primeFactors', test: e => /^(primeFactors|factorize|primeFactorization|factors)$/i.test(e),
    assertions: E => [
      `prop('${E} product equals n', [12,60,17,100,97,360].every(n => ${E}(n).reduce((a,b)=>a*b,1) === n))`,
      `prop('${E} all factors prime', (() => { const isP=p=>{ if(p<2)return false; for(let d=2;d*d<=p;d++) if(p%d===0) return false; return true }; return [12,60,100,360].every(n => ${E}(n).every(isP)) })())`,
      `prop('${E} non-decreasing', [12,60,360].every(n => { const f=${E}(n); return f.every((x,i) => i===0 || x>=f[i-1]) }))`,
    ],
  },
  {
    // celsiusToFahrenheit(c): affine C*9/5+32, matches reference at sampled points.
    family: 'celsiusToFahrenheit', test: e => /^(celsiusToFahrenheit|cToF|celsiusToF|toFahrenheit)$/i.test(e),
    assertions: E => [
      `prop('${E} matches C*9/5+32', [-40,0,37,100,20,-273].every(c => Math.abs(${E}(c) - (c*9/5+32)) < 1e-9))`,
      `prop('${E} fixed point at -40', Math.abs(${E}(-40) - (-40)) < 1e-9)`,
    ],
  },
  {
    // countWords(s): matches whitespace-split reference count.
    family: 'countWords', test: e => /^(countWords|wordCount|numWords)$/i.test(e),
    assertions: E => [
      `prop('${E} matches split reference', (() => { const ref = s => (s.trim() === '' ? 0 : s.trim().split(/\\s+/).length); return ['hello world','  one   two three ','','single','a b c d e'].every(s => ${E}(s) === ref(s)) })())`,
      `prop('${E} empty/blank=0', ${E}('') === 0 && ${E}('   ') === 0)`,
    ],
  },
  {
    // range(n) or range(a,b): consecutive integers, matches an index-built reference.
    family: 'range', test: e => /^(range|iota|sequence|intRange)$/i.test(e),
    assertions: E => [
      `prop('${E}(n) is 0..n-1', (() => { const r=${E}(5); return JSON.stringify(r) === JSON.stringify([0,1,2,3,4]) })() || (() => { const r=${E}(0,5); return JSON.stringify(r) === JSON.stringify([0,1,2,3,4]) })())`,
      `prop('${E} consecutive by 1', (() => { const r=${E}(6); return r.every((x,i) => i===0 || x===r[i-1]+1) })() || (() => { const r=${E}(2,8); return r.every((x,i) => i===0 || x===r[i-1]+1) })())`,
    ],
  },
  {
    // zip(a,b): pairs positionally, length = min of inputs — matches an index-built reference.
    family: 'zip', test: e => /^(zip|pairwise|zipWith|zipArrays)$/i.test(e),
    assertions: E => [
      `prop('${E} matches index reference', (() => { const a=[1,2,3], b=['x','y','z']; const ref=a.map((v,i)=>[v,b[i]]); return JSON.stringify(${E}(a,b)) === JSON.stringify(ref) })())`,
      `prop('${E} length = min', (() => { const r=${E}([1,2,3,4],[9,8]); return r.length === 2 })())`,
    ],
  },
  {
    // roundTo(x, dp): matches the Math.round(x*10^dp)/10^dp reference at sampled points.
    family: 'roundTo', test: e => /^(roundTo|round2|roundToDecimal|roundDp|toFixedNum)$/i.test(e),
    assertions: E => [
      `prop('${E} matches scaled-round reference', (() => { const ref=(x,d)=>Math.round(x*10**d)/10**d; return [[3.14159,2],[2.5,0],[1.005,2],[9.87654,3],[100,1]].every(([x,d]) => Math.abs(${E}(x,d) - ref(x,d)) < 1e-9) })())`,
      `prop('${E} idempotent at same dp', (() => { const r=${E}(3.14159,2); return Math.abs(${E}(r,2) - r) < 1e-9 })())`,
    ],
  },
  {
    // mode(xs): most-frequent value — is a member and no other value is strictly more frequent.
    family: 'mode', test: e => /^(mode|mostFrequent|mostCommon)$/i.test(e),
    assertions: E => [
      `prop('${E} matches frequency reference', (() => { const xs=[1,2,2,3,3,3,4]; const ref=(a)=>{const c={};let best=a[0],bc=0;for(const v of a){c[v]=(c[v]||0)+1;if(c[v]>bc){bc=c[v];best=v}}return best}; return ${E}(xs) === ref(xs) })())`,
      `prop('${E} is a member and maximal-frequency', (() => { const xs=[5,5,1,2,2,2,9]; const m=${E}(xs); const f=v=>xs.filter(x=>x===v).length; return xs.includes(m) && xs.every(x => f(x) <= f(m)) })())`,
    ],
  },
  {
    // fahrenheitToCelsius(f): affine (f-32)*5/9 and inverse-consistent with the C→F direction.
    family: 'fahrenheitToCelsius', test: e => /^(fahrenheitToCelsius|fToC|toCelsius|fahrenheitToC)$/i.test(e),
    assertions: E => [
      `prop('${E} matches (f-32)*5/9', [-40,32,98.6,212,68].every(f => Math.abs(${E}(f) - (f-32)*5/9) < 1e-9))`,
      `prop('${E} fixed point at -40', Math.abs(${E}(-40) - (-40)) < 1e-9)`,
    ],
  },
]

/** Best-effort entry-name extraction for supplemental gating (extractFeatures, else first call). */
function guessEntry(nl: string): string {
  const ex = extractFeatures(nl).exports[0]
  if (ex) return ex
  const m = /\b([a-zA-Z_$][\w$]*)\s*\(/.exec(nl)
  return m ? m[1] : ''
}

/** Supplemental (VGR-only) property spec, tried when the synth families don't match. */
export function supplementalPropertySpec(nl: string): { entry: string; family: string; assertions: string[] } | null {
  const entry = guessEntry(nl)
  if (!entry) return null
  for (const fam of SUPP_FAMILIES) {
    if (fam.test(entry)) return { entry, family: fam.family, assertions: fam.assertions(entry) }
  }
  return null
}

/**
 * Property spec for a SPECIFIC function name (not auto-detected from the NL). Used by the
 * multi-file path to derive properties per declared export — e.g. `reverse` and `isPrime` in a
 * two-file request each resolve to their own family's assertions. Returns null when the name
 * matches no high-confidence family. Name-gated exactly as SUPP_FAMILIES (no substring collisions).
 */
export function propertyForFunction(fn: string): { entry: string; family: string; assertions: string[] } | null {
  if (!fn) return null
  for (const fam of SUPP_FAMILIES) {
    if (fam.test(fn)) return { entry: fn, family: fam.family, assertions: fam.assertions(fn) }
  }
  return null
}

/**
 * Verify a candidate against its property assertions by EXECUTION. Deterministic ground
 * truth: the candidate's own exported functions are checked against invariants that hold
 * for every correct implementation. Reports each violated property as high-info feedback.
 */
export async function verifyByProperty(candidate: Candidate<string>, spec: TaskSpec): Promise<Verdict> {
  const acc = spec.acceptance as unknown as PropertyAcceptance
  const timeoutMs = acc.timeoutMs ?? 5000
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgr-prop-'))
  const modPath = path.join(dir, 'candidate.mjs')

  try {
    // Combine candidate + an inline property harness in ONE module so the assertions'
    // references to the exported functions resolve directly (same top-level scope).
    const harness = `
;(async () => {
  const __fail = [];
  function prop(label, cond) { try { if (!cond) __fail.push(label); } catch (e) { __fail.push(label + ' [threw: ' + (e && e.message ? e.message : e) + ']'); } }
  // check(): like prop, but the test fn returns a COUNTEREXAMPLE string on failure (or null
  // on pass). A concrete "f(input) = actual, expected …" signal is what lets a weak proposer
  // fix the exact bug instead of guessing at a property NAME. Falls back to the label if the
  // fn returns a bare true/false.
  function check(label, fn) { try { const d = fn(); if (d) __fail.push(typeof d === 'string' ? d : label); } catch (e) { __fail.push(label + ' [threw: ' + (e && e.message ? e.message : e) + ']'); } }
${acc.assertions.map(a => '  ' + a + ';').join('\n')}
  process.stdout.write('\\n' + JSON.stringify({ fail: __fail }) + '\\n');
})();
`
    let js: string
    try {
      const out = await transform(candidate.value + '\n' + harness, { loader: 'ts', format: 'esm', target: 'node18' })
      js = out.code
    } catch (e: any) {
      const msg = (e?.errors?.[0]?.text ?? e?.message ?? 'syntax error') as string
      return { pass: false, score: -1000, signals: [`syntax error (does not compile): ${String(msg).slice(0, 200)}`] }
    }
    fs.writeFileSync(modPath, js, 'utf-8')

    const out = await new Promise<{ stdout: string; stderr: string }>(resolve => {
      execFile('node', [modPath], { cwd: dir, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (_err, stdout, stderr) => resolve({ stdout, stderr }))
    })

    const line = out.stdout.split('\n').reverse().find(l => l.trim().startsWith('{"fail"'))
    if (!line) {
      const reason = (out.stderr.trim().split('\n').find(l => /Error/.test(l)) ?? out.stderr.trim().split('\n')[0] ?? 'no result emitted').slice(0, 200)
      return { pass: false, score: -1000, signals: [`load/runtime error: ${reason}`] }
    }
    let fail: string[] = []
    try { fail = (JSON.parse(line).fail ?? []) as string[] } catch { /* treat as pass-less */ }

    if (fail.length === 0) {
      return { pass: true, score: 0, signals: [`all ${acc.assertions.length} ${acc.family} propert${acc.assertions.length === 1 ? 'y' : 'ies'} held`] }
    }
    return {
      pass: false,
      score: -fail.length,
      signals: fail.slice(0, 6).map(f => `property violated: ${f}`),
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
}
