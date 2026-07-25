// ═══════════════════════════════════════════════════════════════════════════════
// VGR — code proposer (the ONLY place the model lives)
// ═══════════════════════════════════════════════════════════════════════════════
//
// The proposer wraps the on-device FM as a fallible candidate generator. It is
// explicitly NOT trusted: its output is always handed to the execution verifier.
// Its job is to turn the spec PLUS the structured feedback from every prior failed
// attempt into a better next guess. The feedback loop is what makes a weak 3B
// converge — each rejected candidate's ACTUAL-vs-expected signals are fed straight
// back into the next prompt, so the model debugs its own code against ground truth
// instead of guessing blind.
// ═══════════════════════════════════════════════════════════════════════════════

import { fmComplete, fmCompleteBatch } from '../agent/fmReact'
import { fencedCodeGrammar } from '../agent/grammars'
import type { Candidate, ProposeContext } from './types'

// W2: every proposal must be exactly one fenced TypeScript block. Constraining the sampler to
// this grammar makes a malformed-shape proposal (prose around the code, missing/doubled fence)
// unreachable, so `extractCode` never fails and the model spends its ~90s call on being correct,
// not on being well-formed. A backend without grammar support ignores it — extractCode still runs.
const CODE_GRAMMAR = fencedCodeGrammar('typescript')

/** Monotone draw counter feeding the anti-anchor seed. A counter, not a clock, so a run's seed
 *  sequence is reproducible from its call order — the diversity comes from the seeds DIFFERING
 *  across retries, which is all the anchor break requires. */
let drawCounter = 0
function nextDrawSeed(): number { return ++drawCounter }

/** Deterministic fingerprint for anti-thrash dedup (normalizes whitespace). */
export function fingerprintCode(code: string): string {
  const norm = code.replace(/\s+/g, ' ').trim()
  let h = 5381
  for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) | 0
  return `c${(h >>> 0).toString(36)}`
}

/** Reserved words that carry the SHAPE of a program — kept verbatim by structuralFingerprint while
 *  every other identifier is anonymized. Anything here is control flow or a built-in whose identity
 *  changes what the code DOES; anything not here is a name the model was free to choose. */
const STRUCTURAL_WORDS = new Set([
  'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break',
  'continue', 'const', 'let', 'var', 'of', 'in', 'new', 'typeof', 'instanceof', 'delete', 'void',
  'throw', 'try', 'catch', 'finally', 'export', 'import', 'class', 'extends', 'this', 'null',
  'undefined', 'true', 'false', 'NaN', 'Infinity',
  // Built-ins whose identity IS the algorithm — swapping map for reduce is a different structure.
  'map', 'reduce', 'filter', 'forEach', 'slice', 'splice', 'split', 'join', 'push', 'pop', 'shift',
  'unshift', 'concat', 'reverse', 'sort', 'indexOf', 'includes', 'charAt', 'charCodeAt', 'replace',
  'match', 'test', 'trim', 'length', 'Math', 'Number', 'String', 'Array', 'Object', 'JSON', 'Map',
  'Set', 'parseInt', 'parseFloat', 'floor', 'ceil', 'round', 'abs', 'min', 'max', 'pow',
])

/**
 * STRUCTURAL fingerprint — the same code modulo the names the model chose.
 *
 * WHY (2026-07-25c). `fingerprintCode` is exact text, so an ANCHORED head slips past the
 * anti-thrash signal for free: rename `i` to `idx`, reflow a line, drop a comment, and the search
 * sees a brand-new proposal even though the wrong control structure is byte-for-byte the same
 * algorithm. The escalation in `buildProposalPrompt` keys on repetition, so it never deepened and
 * the rung ground out its budget re-emitting one dead end.
 *
 * The normalization strips comments and whitespace, collapses every string literal to `"s"` and
 * every number to `0`, and rewrites each non-structural identifier to `v1`, `v2`, … in order of
 * first appearance. Operators, keywords, and shape-bearing built-ins survive untouched, so `>` vs
 * `>=` and `map` vs `for` still produce DIFFERENT fingerprints — this collapses cosmetics, not
 * semantics. It is a lexical normalization, not a parse: no AST, no dependency, no failure mode
 * on code that doesn't compile (which is most of what a weak head emits).
 *
 * Used only as stagnation EVIDENCE by search (see SearchOpts.structuralKey) — a structural repeat
 * is still verified, so a collision can never discard a correct candidate.
 */
export function structuralFingerprint(code: string): string {
  const noComments = code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  const names = new Map<string, string>()
  const norm = noComments
    // literals first, so their contents can never be mistaken for identifiers
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '"s"')
    .replace(/\b\d+(?:\.\d+)?\b/g, '0')
    .replace(/[A-Za-z_$][A-Za-z0-9_$]*/g, (id) => {
      if (STRUCTURAL_WORDS.has(id)) return id
      let v = names.get(id)
      if (!v) { v = `v${names.size + 1}`; names.set(id, v) }
      return v
    })
    // ASI makes statement semicolons optional, so their presence is pure surface style — the same
    // program written with and without them must not read as two different structures.
    .replace(/;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  let h = 5381
  for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) | 0
  return `s${(h >>> 0).toString(36)}`
}

/** Pull the first fenced code block, else the whole trimmed body. */
export function extractCode(raw: string): string {
  const fence = /```(?:[a-zA-Z]+)?\n([\s\S]*?)```/.exec(raw)
  return (fence ? fence[1] : raw).trim()
}

type Attempt = ProposeContext<string>['history'][number]

/** Render one argument as a compact JS literal for an example call. JSON round-trips the
 *  JSON-comparable case values the verifier uses; falls back to String() for anything exotic. */
function renderArg(a: unknown): string {
  try {
    const s = JSON.stringify(a)
    if (s === undefined) return String(a)
    return s.length > 60 ? s.slice(0, 57) + '…' : s
  } catch { return String(a) }
}

/** Pull the exact declared parameter list for `name` out of a goal that spells the signature
 *  inline, e.g. goal "…sumEvens(nums: number[]): number…" → "nums: number[]". Returns null when
 *  the goal doesn't contain `name(...)`. Balanced to the first close-paren (params here never
 *  nest parens). This lets the skeleton use the AUTHOR's parameter names verbatim. */
function paramsFromGoal(goal: string, name: string): string | null {
  const idx = goal.indexOf(name + '(')
  if (idx < 0) return null
  const open = idx + name.length
  const close = goal.indexOf(')', open)
  if (close < 0) return null
  return goal.slice(open + 1, close).trim()
}

/**
 * The call-signature pin (see buildProposalPrompt). Weak heads reliably get the ALGORITHM right
 * but rewrite the INTERFACE (a measured `sumEvens(...nums)` where the harness calls
 * `sumEvens([1,2,3,4])`), and they IGNORE negative instructions ("do not use rest params"). So
 * this gives a POSITIVE skeleton — the exact `export function NAME(params) {` header to begin
 * with — because a 1.5B copies a concrete header far more reliably than it obeys a prohibition.
 * Params are the author's own names when the goal spells the signature, else arity-derived
 * `a0,a1,…`. Derived ONLY from spec ⇒ stable across iterations (cacheable-prefix safe). Returns
 * '' when no cases are available (proposer then behaves exactly as before).
 */
export function callSignatureHint(acc: { entry: string; entries?: string[]; cases?: Array<{ args: unknown[]; entry?: string }> }, goal = ''): string {
  // A/B toggle: CRUCIBLE_NO_SIGHINT=1 disables the skeleton so before/after can be measured with
  // the identical binary (no doubt about which code a background run loaded). Default: enabled.
  if (process.env.CRUCIBLE_NO_SIGHINT === '1') return ''
  const cases = acc.cases
  if (!cases || !cases.length) return ''
  const entries = acc.entries && acc.entries.length ? acc.entries : [acc.entry]
  const headers: string[] = []
  const examples: string[] = []
  for (const name of entries) {
    // First case that targets this entry (untagged cases default to the primary entry).
    const c = cases.find(x => (x.entry ?? acc.entry) === name) ?? (name === acc.entry ? cases[0] : undefined)
    if (!c) continue
    // Prefer the author's declared params; else synthesize positional names from the arity.
    const declared = paramsFromGoal(goal, name)
    const params = declared && declared.length ? declared
      : Array.from({ length: c.args.length }, (_, i) => `a${i}`).join(', ')
    headers.push(`export function ${name}(${params}) {`)
    examples.push(`\`${name}(${c.args.map(renderArg).join(', ')})\` (${c.args.length} arg${c.args.length === 1 ? '' : 's'})`)
  }
  if (!headers.length) return ''
  return [
    '',
    '## Function signature — copy it EXACTLY',
    'Begin each function with this exact header (fill in the body):',
    ...headers.map(h => '    ' + h),
    `It is invoked positionally: ${examples.join('; ')}. Use exactly the parameters shown — no rest/variadic (\`...args\`), no extra params, no wrapping the args in an array or object.`,
  ].join('\n')
}

/**
 * Choose which prior attempts to show the model as debugging feedback: the 3 most recent PLUS the
 * closest-to-passing (highest score) when beam exploration made the recent window worse than an
 * earlier near-solution. Anchoring the model on the candidate one fix away from correct converges
 * faster than iterating from whatever ran last. Returns { shown, best } — `best` is the closest
 * attempt (or null), marked in the prompt so the model knows which to fix. Pure + deterministic.
 */
export function pickFeedbackAttempts(history: Attempt[]): { shown: Attempt[]; best: Attempt | null } {
  const recent = history.slice(-3)
  if (!recent.length) return { shown: [], best: null }
  const best = history.reduce((a, b) => (b.verdict.score > a.verdict.score ? b : a))
  const worstRecent = Math.min(...recent.map(a => a.verdict.score))
  const addBest = !recent.some(a => a.candidate.fingerprint === best.candidate.fingerprint)
    && best.verdict.score > worstRecent
  return { shown: addBest ? [best, ...recent] : recent, best }
}

/**
 * The full proposal prompt for a given search state — extracted so ANY local engine
 * (Apple FM, MiniCPM, a future GGUF) can be benched as a proposer with IDENTICAL
 * prompting (see __fault_headtohead.ts). Pure + deterministic.
 */
export function buildProposalPrompt(ctx: ProposeContext<string>): { system: string; user: string; temperature: number } {
  const { spec, history, diversify } = ctx
  const acc = spec.acceptance as { entry: string; entries?: string[]; cases?: Array<{ args: unknown[]; entry?: string }> }
  const multi = acc.entries && acc.entries.length > 1 ? acc.entries : null

  const system = [
    'You are a code-generation function inside a verification loop. You are NOT trusted —',
    'your output will be EXECUTED against hidden test cases immediately. Your only job is to',
    'return a correct implementation. Output ONE ES module in a single ``` code block and',
    'nothing else — no prose, no explanation.',
    '',
    multi
      ? `Export ALL of these functions from the one module (use \`export function <name>(...)\` for each): ${multi.map(e => '`' + e + '`').join(', ')}. Every one must be defined and correct — they are tested together.`
      : `Export a function named \`${acc.entry}\` (use \`export function ${acc.entry}(...)\`).`,
    // CALL-SIGNATURE PIN (measured 2026-07-22): the weak head reliably gets the ALGORITHM right
    // but botches the interface — it wrote `sumEvens(...nums)` (rest param) where the harness
    // calls `sumEvens([1,2,3,4])`, so the array landed as nums[0] and every case failed at 0.
    // Signature/arity confusion, not reasoning, was the dominant pass@k loss on trivial tasks.
    // Show the model EXACTLY how each function is invoked (arity + a concrete example call
    // rendered from the first acceptance case) and forbid variadic params. Spec-derived ⇒ stable
    // across a search's iterations ⇒ still a byte-identical cacheable system prefix (vgr:bench pins this).
    callSignatureHint(acc, spec.goal),
    spec.context ? `\n## Grounding\n${spec.context}` : '',
  ].filter(Boolean).join('\n')

  // Thread the most recent failures back in as concrete, actionable debugging signal.
  // This is the sample-efficiency lever: the model sees exactly what went wrong.
  // Surface the closest-to-passing attempt alongside the recent window (see pickFeedbackAttempts).
  const { shown, best } = pickFeedbackAttempts(history)
  const feedback = shown.length
    ? '\n\n## Your previous attempts FAILED verification. Fix these specific problems:\n' +
      shown.map((a, i) => {
        const code = a.candidate.value.length > 800 ? a.candidate.value.slice(0, 800) + '\n…(truncated)' : a.candidate.value
        const closest = a === best ? ' — CLOSEST to correct, fix THIS one' : ''
        return `### Attempt ${i + 1} (score ${a.verdict.score}${closest})\n\`\`\`\n${code}\n\`\`\`\nFailures:\n` +
          a.verdict.signals.map(s => `- ${s}`).join('\n')
      }).join('\n\n')
    : ''

  // SEMANTIC-THRASH detection (sample-efficiency): the model may make the SAME logical
  // mistake with cosmetically-different code (e.g. `.join(/\s+/)` vs `.join(/\s+/)` again),
  // so fingerprint-dedup never sees it. If the identical FAILURE SIGNAL recurs, the model is
  // ANCHORED. Live probe (2026-07-22l, basicCalculator foldMulDiv rung): a flat "you are stuck"
  // note + a fixed 0.8 temperature does NOT break the anchor — the model re-emits the same wrong
  // control structure every draw ("duplicate proposal (stuck)") until budget death. So escalate
  // PROGRESSIVELY with the depth of the identical-failure run: raise temperature in steps, ROTATE
  // a structural anchor-breaker (reduce↔index-loop↔recursion, different data structure), and once
  // deeply anchored STOP echoing the anchored code back (that feedback reinforces the wrong shape)
  // in favour of a clean-slate "abandon that structure" reframe. Sound: still fully verifier-gated —
  // diversity can only help the search FIND a correct impl, never certify a wrong one.
  const sig = (a: typeof history[number]) => (a.verdict.signals[0] ?? '')
  const lastSig = history.length ? sig(history[history.length - 1]) : ''
  // Anchoring depth = how many of the most-recent attempts failed with the IDENTICAL signal.
  let sameSigRun = 0
  if (lastSig) for (let i = history.length - 1; i >= 0; i--) { if (sig(history[i]) === lastSig) sameSigRun++; else break }
  const repeats = sameSigRun >= 2

  // Structural anchor-breakers, rotated by anchoring depth — each names a DIFFERENT control shape
  // so the model cannot re-emit the one that keeps failing. Generic (no task specifics), so this
  // is a pure search-diversity lever, not a hint about any particular answer.
  const BREAKERS = [
    'Rewrite it with a DIFFERENT control structure than your last attempt: if you used array methods (map/reduce/filter), use an explicit indexed `for` loop instead — or vice versa.',
    'Change your DATA REPRESENTATION: build the result by pushing onto a fresh array / accumulator you mutate step by step, rather than chaining transforms.',
    'Solve it RECURSIVELY, or if you were recursing, solve it with a single explicit loop and an accumulator variable.',
    'Handle the pieces in a DIFFERENT ORDER, and write out each intermediate value to its own named variable before combining — do not inline.',
  ]
  const deep = sameSigRun >= 4
  const stuckNote = repeats
    ? `\n\n## YOU ARE ANCHORED — the SAME wrong result ${sameSigRun}× in a row:\n"${lastSig}"\nYour current approach is a dead end. ${BREAKERS[Math.min(sameSigRun - 2, BREAKERS.length - 1)]} Do NOT submit the same structure again.`
    : ''
  const diversifyNote = (diversify && !repeats)
    ? '\n\nYour recent attempts are stuck. Change the SPECIFIC operation that produces the wrong output — different call, argument, or operator — not a cosmetic rename.'
    : ''

  // Progressive temperature: calm while making real progress, hotter the deeper the anchor.
  const temperature = deep ? 1.15 : sameSigRun >= 3 ? 1.0 : (diversify || repeats) ? 0.8 : 0.3
  // ANTI-ANCHOR SAMPLING (2026-07-25c). Temperature alone did not break the live anchors: it
  // re-weights the distribution but the nucleus still contains only the one wrong program, so the
  // head kept re-emitting it ("duplicate proposal (stuck)") until budget death. Two knobs address
  // exactly that, and only once anchoring is detected — the calm path stays untouched so a healthy
  // run keeps its focused sampling:
  //   • topP — widen the admitted set so a DIFFERENT structure is reachable at all.
  //   • seed — force a distinct RNG stream per draw, so a repeat prompt with repeat settings can
  //     no longer come back byte-identical. Sourced from a monotone counter (not a clock, so runs
  //     stay reproducible in order) mixed with the anchoring depth.
  const topP = deep ? 0.99 : repeats ? 0.97 : undefined
  const seed = repeats ? ((nextDrawSeed() * 2654435761) ^ (sameSigRun * 40503)) >>> 0 : undefined
  // Deeply anchored: the echoed attempt-code is REINFORCING the wrong shape — drop it, keep only
  // the reframe. Otherwise thread the concrete failure feedback (the normal sample-efficiency win).
  const body = deep ? '' : feedback
  const user = `## Task\n${spec.goal}${body}${stuckNote}${diversifyNote}\n\nReturn the corrected full module now.`
  return { system, user, temperature, topP, seed }
}

export async function proposeCode(ctx: ProposeContext<string>): Promise<Candidate<string> | null> {
  const { system, user, temperature, topP, seed } = buildProposalPrompt(ctx)
  const raw = await fmComplete(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    { temperature, gbnf: CODE_GRAMMAR, topP, seed },
  )
  return rawToCandidate(raw)
}

/** Turn one raw completion into a Candidate (or null on empty/no-code). Shared by the single and
 *  batch proposers so both apply IDENTICAL extraction + fingerprinting. */
function rawToCandidate(raw: string): Candidate<string> | null {
  if (!raw || !raw.trim()) return null
  const code = extractCode(raw)
  if (!code) return null
  return { value: code, fingerprint: fingerprintCode(code) }
}

/**
 * W3 MULTI-CONTEXT batch proposer — draw ONE candidate for EACH of `ctxs` CONCURRENTLY across
 * llama-server KV slots. Unlike proposeCodeBatch (n draws of ONE state), this draws one draw of N
 * DIFFERENT states — exactly what a search round needs when it expands several beam parents whose
 * feedback differs. Result is aligned to input (result[i] ↔ ctxs[i]); a null means that draw came
 * back empty/no-code, so the caller's per-slot accounting maps straight back. Order-preserving.
 */
export async function proposeCodeMany(ctxs: ProposeContext<string>[]): Promise<(Candidate<string> | null)[]> {
  if (ctxs.length === 0) return []
  const prompts = ctxs.map(buildProposalPrompt)
  const messages = prompts.map(p => [{ role: 'system', content: p.system }, { role: 'user', content: p.user }])
  // Each ctx carries its own temperature (diversify raises it); the batch client samples each
  // independently, so pass them through per-slot. fmCompleteBatch takes a single opts, so when
  // temperatures differ we fall back to per-slot fmComplete via the batch client's own fan-out —
  // here we use the max temperature as the batch temperature, which only ever ADDS diversity
  // (never removes it) and keeps the single-round-trip batch. GBNF is constant across slots.
  const temp = Math.max(...prompts.map(p => p.temperature))
  // Same rationale as the widest temperature: take the widest top-p any slot asked for. Per-slot
  // SEEDS are deliberately not sent — fmCompleteBatch takes one opts, and a shared seed across K
  // slots would make the draws MORE alike, the opposite of what the batch is for. The slots already
  // diverge through the backend's own per-slot RNG.
  const topPs = prompts.map(p => p.topP).filter((v): v is number => typeof v === 'number')
  const raws = await fmCompleteBatch(messages, { temperature: temp, gbnf: CODE_GRAMMAR, ...(topPs.length ? { topP: Math.max(...topPs) } : {}) })
  return raws.map(rawToCandidate)
}

/**
 * W3 BATCH proposer — draw `n` candidates for the SAME search state CONCURRENTLY across
 * llama-server KV slots (continuous batching), returning every distinct non-null candidate.
 * This is what lets the search loop (or the pass@k harness) spend its wall-clock on K parallel
 * proposals instead of K serial ones. Temperature is bumped for n>1 so the draws diverge — n
 * identical greedy samples would waste K-1 slots. Order-preserving; nulls (empty/no-code) dropped.
 */
export async function proposeCodeBatch(ctx: ProposeContext<string>, n: number): Promise<Candidate<string>[]> {
  const k = Math.max(1, n)
  const { system, user, temperature, topP } = buildProposalPrompt(ctx)
  // A batch of size 1 is just the single path; for n>1 raise temperature so the K draws are
  // genuinely different lines of attack (the whole point of sampling K) rather than K copies.
  const temp = k === 1 ? temperature : Math.max(temperature, 0.8)
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }]
  const raws = await fmCompleteBatch(Array.from({ length: k }, () => messages), { temperature: temp, gbnf: CODE_GRAMMAR, ...(typeof topP === 'number' ? { topP } : {}) })
  const out: Candidate<string>[] = []
  for (const raw of raws) {
    const c = rawToCandidate(raw)
    if (c) out.push(c)
  }
  return out
}
