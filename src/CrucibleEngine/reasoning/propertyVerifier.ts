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
import { derivePropertyTests } from '../synth/derive'
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
  const entry = extractFeatures(nl).exports[0] ?? ''
  if (!entry) return null
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
