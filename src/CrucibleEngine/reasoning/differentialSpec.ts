// ═══════════════════════════════════════════════════════════════════════════════
// VGR — differential-consensus spec derivation (certify ARBITRARY functions)
// ═══════════════════════════════════════════════════════════════════════════════
//
// THE CEILING THIS REMOVES. The strong property path (propertyVerifier.ts) only fires
// when the entry name matches a hardcoded family whitelist (`sort`, `gcd`, `reverse`, …).
// Every function OUTSIDE that list — `titleCase`, `groupBy`, `twoSum`, `rotateMatrix`,
// arbitrary business logic — falls to the weak "model invents both the input AND the
// expected output" path, which is biased on both axes and abstains often. Widening the
// whitelist one family per commit never reaches open-ended requests.
//
// The doctrine-sound generalization (AlphaCode-style filtering / N-version differential
// testing): the SYSTEM chooses the inputs (fuzzing over shape hypotheses + edge cases,
// so there is no input-selection bias), and the EXPECTED OUTPUT is decided by AGREEMENT
// ACROSS INDEPENDENTLY-WRITTEN IMPLEMENTATIONS executed on those inputs (far harder to
// fool than a single model stating a value it likes). Where a quorum of ≥2 DISTINCT
// implementations produce the same output, that (input → output) becomes derived ground
// truth. The final candidate is then certified against it by execution (codeVerifier).
//
// Why this is not "vote-counting amplifies bias" (the trap DOCTRINE.md warns about):
//   • The inputs are ours, not the model's — it cannot steer toward inputs it gets right.
//   • Agreement is across independently-written CODE run on the SAME inputs, not across
//     restatements of one opinion; a shared answer requires shared behavior, which the
//     varied framings (iterative / recursive / functional / built-in) make unlikely for
//     a genuine bug.
//   • We require ≥2 DISTINCT source fingerprints in the quorum (an impl echoed twice is
//     not corroboration), and abstain unless enough cases survive.
//   • It is ranked BELOW user examples and named properties, ABOVE the weaker path.
//
// HONEST LIMIT: if every sampled implementation shares the SAME systematic error on an
// input (all off-by-one the same way), the quorum can adopt a wrong output. This is
// strictly rarer than the existing single-value consensus and the whole derivation
// abstains when no quorum forms — but it is not zero. Named properties (a true invariant)
// remain preferred precisely because they cannot be fooled this way.
//
// The model only PROPOSES implementations. Everything else here is deterministic.
// ═══════════════════════════════════════════════════════════════════════════════

import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { transform } from 'esbuild'
import { fmComplete } from '../agent/fmReact'
import { extractFeatures } from '../synth/index'
import { entryFromExamples } from '../synth/derive'
import type { CodeCase } from './codeVerifier'

/** An implementation candidate: its source and a fingerprint (distinctness gate). */
export interface ImplSample {
  source: string
  fingerprint: string
}

/** Injectable sampler so the derivation LOOP is provable without a live model (see bench). */
export type ImplSampler = (nl: string, entry: string, k: number) => Promise<ImplSample[]>

export interface DifferentialResult {
  ok: boolean
  spec?: { entry: string; cases: CodeCase[] }
  detail?: string
  reason?: string
}

// ── Deterministic PRNG (bench-stable; the engine may use Math.random, but a fixed seed
// makes the derived battery — and therefore the bench — reproducible run to run). ──────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Deterministic fingerprint (normalizes whitespace) — matches codeProposer's scheme. */
export function implFingerprint(code: string): string {
  const norm = code.replace(/\s+/g, ' ').trim()
  let h = 5381
  for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) | 0
  return `i${(h >>> 0).toString(36)}`
}

// ── Input generation: shape hypotheses ─────────────────────────────────────────────
// We do not try to infer the function's exact domain up front. Instead we generate inputs
// under SEVERAL shape hypotheses (array-of-int, string, int, [array,int], …) plus edge
// cases; the real domain reveals itself as the shape where implementations AGREE. Inputs of
// the wrong shape simply throw across impls and drop out (no quorum) — safe, self-filtering.

type Gen = (rnd: () => number) => unknown

const smallInt = (rnd: () => number) => Math.floor(rnd() * 21) - 10          // -10..10
const posInt = (rnd: () => number) => Math.floor(rnd() * 12) + 1             // 1..12
const floatv = (rnd: () => number) => Math.round((rnd() * 20 - 10) * 100) / 100
const word = (rnd: () => number) => {
  const pool = ['hello', 'World', 'aBc', 'racecar', 'Foo Bar', 'the quick brown', 'x', 'HELLO', 'noon', 'a1b2']
  return pool[Math.floor(rnd() * pool.length)]
}
const intArr = (rnd: () => number) => Array.from({ length: Math.floor(rnd() * 5) + 1 }, () => smallInt(rnd))
const strArr = (rnd: () => number) => Array.from({ length: Math.floor(rnd() * 4) + 1 }, () => word(rnd))

/** One shape hypothesis for a given arity: a per-position generator list. */
interface Shape { label: string; gens: Gen[] }

function shapesForArity(arity: number): Shape[] {
  if (arity <= 1) {
    return [
      { label: 'array<int>', gens: [intArr] },
      { label: 'array<str>', gens: [strArr] },
      { label: 'string', gens: [word] },
      { label: 'int', gens: [smallInt] },
      { label: 'posInt', gens: [posInt] },
      { label: 'float', gens: [floatv] },
    ]
  }
  if (arity === 2) {
    return [
      { label: 'array<int>,int', gens: [intArr, posInt] },
      { label: 'int,int', gens: [smallInt, smallInt] },
      { label: 'string,string', gens: [word, word] },
      { label: 'array<int>,array<int>', gens: [intArr, intArr] },
      { label: 'string,int', gens: [word, posInt] },
      { label: 'array<str>,string', gens: [strArr, word] },
    ]
  }
  // arity >= 3
  return [
    { label: 'int,int,int', gens: [smallInt, smallInt, smallInt] },
    { label: 'array<int>,int,int', gens: [intArr, smallInt, smallInt] },
    { label: 'string,int,int', gens: [word, smallInt, smallInt] },
  ]
}

/** Hand-picked edge tuples per arity — the inputs bugs hide behind (empty, zero, negatives). */
function edgeTuples(arity: number): unknown[][] {
  if (arity <= 1) return [[[]], [['']], [[0]], [[1]], [''], ['a'], [0], [1], [-1], [[1, 1, 2]]]
  if (arity === 2) return [[[], 1], [[1], 1], [[1, 2, 3], 2], ['', 0], ['a', 1], [0, 0], [1, 0], [-3, 5], [[1, 2], [3, 4]]]
  return [[0, 0, 10], [5, 0, 10], [-3, 0, 10], [50, 0, 10], [[1, 2, 3], 0, 2]]
}

/** Build the full deterministic input battery for an arity (edges first, then fuzz). */
function buildInputs(arity: number, perShape: number, seed: number): unknown[][] {
  const rnd = mulberry32(seed)
  const seen = new Set<string>()
  const inputs: unknown[][] = []
  const push = (t: unknown[]) => {
    let k: string; try { k = JSON.stringify(t) } catch { return }
    if (seen.has(k)) return
    seen.add(k); inputs.push(t)
  }
  for (const t of edgeTuples(arity)) push(t)
  for (const shape of shapesForArity(arity)) {
    for (let i = 0; i < perShape; i++) push(shape.gens.map(g => g(rnd)))
  }
  return inputs
}

// ── Arity inference from implementations ────────────────────────────────────────────
// The impls themselves are the most reliable arity signal. Parse the exported entry's
// parameter list; take the modal arity across impls (ignoring rest/defaults nuance —
// extra generated args are harmless, JS ignores them).
function arityOf(source: string, entry: string): number | null {
  // export function entry(a, b) | function entry(a,b) | const entry = (a,b) => | export const entry = (a) =>
  const patterns = [
    new RegExp(`function\\s+${escapeRe(entry)}\\s*\\(([^)]*)\\)`),
    new RegExp(`${escapeRe(entry)}\\s*=\\s*(?:async\\s*)?\\(([^)]*)\\)\\s*=>`),
    new RegExp(`${escapeRe(entry)}\\s*=\\s*(?:async\\s*)?function\\s*\\(([^)]*)\\)`),
  ]
  for (const re of patterns) {
    const m = re.exec(source)
    if (m) {
      const params = m[1].trim()
      if (!params) return 0
      // Count top-level commas (ignore commas inside destructuring/defaults — rare in these fns).
      return params.split(',').filter(s => s.trim().length).length
    }
  }
  return null
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

function modalArity(impls: ImplSample[], entry: string): number {
  const votes = new Map<number, number>()
  for (const im of impls) {
    const a = arityOf(im.source, entry)
    if (a != null) votes.set(a, (votes.get(a) ?? 0) + 1)
  }
  if (!votes.size) return 1
  return [...votes.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0][0]
}

// ── Differential execution ──────────────────────────────────────────────────────────
// Run ONE implementation over the WHOLE input battery in a single node process, returning
// a JSON-string result per input ('__throw__' / '__nonjson__' sentinels for the unusable).
async function runImplOverInputs(source: string, entry: string, inputs: unknown[][], timeoutMs: number): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgr-diff-'))
  const modPath = path.join(dir, 'candidate.mjs')
  const runPath = path.join(dir, 'run.mjs')
  try {
    let js: string
    try {
      const out = await transform(source, { loader: 'ts', format: 'esm', target: 'node18' })
      js = out.code
    } catch {
      return inputs.map(() => '__throw__')  // does not compile → contributes no votes
    }
    fs.writeFileSync(modPath, js, 'utf-8')
    fs.writeFileSync(runPath, DIFF_RUNNER(entry, inputs), 'utf-8')
    const out = await new Promise<{ stdout: string }>(resolve => {
      execFile('node', [runPath], { cwd: dir, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (_e, stdout) => resolve({ stdout }))
    })
    const line = out.stdout.split('\n').reverse().find(l => l.trim().startsWith('{"results"'))
    if (!line) return inputs.map(() => '__throw__')
    try { return (JSON.parse(line).results ?? []) as string[] } catch { return inputs.map(() => '__throw__') }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
}

function DIFF_RUNNER(entry: string, inputs: unknown[][]): string {
  return `import * as mod from './candidate.mjs'
const INPUTS = ${JSON.stringify(inputs)};
const fn = mod[${JSON.stringify(entry)}] ?? mod.default;
const results = [];
for (const args of INPUTS) {
  if (typeof fn !== 'function') { results.push('__throw__'); continue; }
  try {
    let v = fn(...args);
    if (v && typeof v.then === 'function') v = await v;
    let s;
    try { s = JSON.stringify(v); } catch { s = undefined; }
    // undefined return, or a value JSON can't represent (function/symbol/circular) → not usable ground truth.
    results.push(s === undefined ? '__nonjson__' : s);
  } catch (e) { results.push('__throw__'); }
}
process.stdout.write('\\n' + JSON.stringify({ results }) + '\\n');
`
}

// ── The public derivation ───────────────────────────────────────────────────────────

const APPROACHES = [
  'Use a straightforward iterative loop.',
  'Use a recursive formulation where natural.',
  'Use a functional style (map/filter/reduce) where natural.',
  'Use built-in language methods where they apply.',
  'Write the clearest correct version you can.',
]

/** Default sampler: draw K independently-FRAMED implementations from the on-device FM. */
async function sampleImplsFM(nl: string, entry: string, k: number): Promise<ImplSample[]> {
  const out: ImplSample[] = []
  for (let i = 0; i < k; i++) {
    const system = [
      'You are a code-generation function inside a verification loop. Output ONE ES module in a',
      'single ``` code block and NOTHING else — no prose.',
      `Export a function named \`${entry}\` (use \`export function ${entry}(...)\`).`,
      APPROACHES[i % APPROACHES.length],
    ].join('\n')
    let raw: string
    try {
      raw = await fmComplete(
        [{ role: 'system', content: system }, { role: 'user', content: `## Task\n${nl}\n\nReturn the module now.` }],
        { temperature: i === 0 ? 0.2 : 0.7 },
      )
    } catch { continue }
    const fence = /```(?:[a-zA-Z]+)?\n([\s\S]*?)```/.exec(raw || '')
    const code = (fence ? fence[1] : (raw || '')).trim()
    if (code) out.push({ source: code, fingerprint: implFingerprint(code) })
  }
  return out
}

export interface DifferentialOpts {
  /** How many independent implementations to sample (default 4). */
  samples?: number
  /** Fuzz inputs generated per shape hypothesis (default 6). */
  perShape?: number
  /** Minimum quorum-agreed cases required to trust the derived spec (default 4). */
  minCases?: number
  /** PRNG seed for a reproducible battery (default 0x00c0ffee). */
  seed?: number
  /** Per-implementation execution timeout, ms (default 5000). */
  timeoutMs?: number
  /** Injectable sampler (tests feed deterministic impls; production uses the FM). */
  sampleImpls?: ImplSampler
  /** Optional explicit entry name (else inferred from the request). */
  entry?: string
}

/**
 * Derive a trustworthy acceptance spec for an arbitrary function by differential consensus.
 * Returns { ok:true, spec } when a distinct-implementation quorum agrees on enough
 * system-generated inputs, else { ok:false, reason } (→ caller falls through / abstains).
 */
export async function deriveDifferentialSpec(nl: string, opts: DifferentialOpts = {}): Promise<DifferentialResult> {
  const samples = Math.max(3, opts.samples ?? 4)      // need ≥3 so a majority quorum means ≥2
  const perShape = Math.max(1, opts.perShape ?? 6)
  const minCases = Math.max(1, opts.minCases ?? 4)
  const seed = opts.seed ?? 0x00c0ffee
  const timeoutMs = opts.timeoutMs ?? 5000
  const sample = opts.sampleImpls ?? sampleImplsFM

  const entry = (opts.entry && opts.entry.trim()) || entryFromExamples(nl) || extractFeatures(nl).exports[0] || guessEntry(nl)
  if (!entry) return { ok: false, reason: 'no entry function name could be inferred' }

  const impls = await sample(nl, entry, samples)
  const distinct = dedupeByFingerprint(impls)
  if (distinct.length < 2) {
    return { ok: false, reason: `need ≥2 distinct implementations to corroborate; got ${distinct.length}` }
  }

  const arity = modalArity(distinct, entry)
  const inputs = buildInputs(arity, perShape, seed)

  // Execute every distinct impl over the whole battery.
  const perImpl: Array<{ fp: string; results: string[] }> = []
  for (const im of distinct) {
    const results = await runImplOverInputs(im.source, entry, inputs, timeoutMs)
    perImpl.push({ fp: im.fingerprint, results })
  }

  // Determinism guard: output that varies run-to-run (randomness, time, iteration-order
  // leaks) must never become derived ground truth — re-run one impl over the same battery
  // and drop any input whose result changed. If most of the battery is unstable, the
  // function itself is nondeterministic → abstain outright.
  const recheck = await runImplOverInputs(distinct[0].source, entry, inputs, timeoutMs)
  const unstable = new Set<number>()
  for (let i = 0; i < inputs.length; i++) {
    if (perImpl[0].results[i] !== recheck[i]) unstable.add(i)
  }
  if (unstable.size > inputs.length / 2) {
    return { ok: false, reason: `outputs are nondeterministic on ${unstable.size}/${inputs.length} inputs — differential ground truth impossible, abstaining` }
  }

  // Quorum per input: among impls that produced a usable (JSON, non-throw) value, does a
  // majority AND ≥2 DISTINCT fingerprints agree on the same value? If so, that value is the
  // derived expected output for this input.
  const quorum = Math.max(2, Math.floor(distinct.length / 2) + 1)
  const cases: CodeCase[] = []
  for (let i = 0; i < inputs.length; i++) {
    if (unstable.has(i)) continue
    const byVal = new Map<string, Set<string>>()  // value-json → set of fingerprints
    let usable = 0
    for (const im of perImpl) {
      const r = im.results[i]
      if (r === '__throw__' || r === '__nonjson__' || r === undefined) continue
      usable++
      const set = byVal.get(r) ?? new Set<string>()
      set.add(im.fp); byVal.set(r, set)
    }
    if (usable < quorum) continue
    // Winning value: most distinct fingerprints; must clear the quorum on DISTINCT sources.
    let bestVal: string | null = null, bestN = 0
    for (const [val, fps] of byVal) if (fps.size > bestN) { bestVal = val; bestN = fps.size }
    if (bestVal == null || bestN < quorum) continue
    let expected: unknown
    try { expected = JSON.parse(bestVal) } catch { continue }
    cases.push({ args: inputs[i], expected, name: `${entry}(${short(inputs[i])})` })
  }

  if (cases.length < minCases) {
    return {
      ok: false,
      reason: `differential quorum produced only ${cases.length}/${minCases} agreed case(s) across ${distinct.length} impls (arity ${arity}) — not trustworthy, abstaining`,
    }
  }

  // Cap the case set (keep edge cases — they come first — plus a spread of fuzz cases).
  const trimmed = cases.slice(0, 24)
  return {
    ok: true,
    spec: { entry, cases: trimmed },
    detail: `no example → differential consensus: ${trimmed.length} case(s) agreed by ≥${quorum} of ${distinct.length} distinct impls (arity ${arity}, ${inputs.length} inputs fuzzed)`,
  }
}

function dedupeByFingerprint(impls: ImplSample[]): ImplSample[] {
  const seen = new Set<string>()
  const out: ImplSample[] = []
  for (const im of impls) {
    if (!im.source || seen.has(im.fingerprint)) continue
    seen.add(im.fingerprint); out.push(im)
  }
  return out
}

function guessEntry(nl: string): string {
  const m = /\b([a-zA-Z_$][\w$]*)\s*\(/.exec(nl)
  return m ? m[1] : ''
}

function short(args: unknown[]): string {
  try { const s = JSON.stringify(args); return s.length > 40 ? s.slice(0, 37) + '…' : s.slice(1, -1) }
  catch { return '…' }
}
