// ═══════════════════════════════════════════════════════════════════════════════
// VGR — RETRIEVAL PROPOSER: retrieved web code as an EXECUTABLE CANDIDATE
// ═══════════════════════════════════════════════════════════════════════════════
//
// The live parseClock runs (cont.72c) proved a precise, load-bearing conclusion:
//
//   Retrieval FINDS the code (2460 chars of real 12h→minutes impl for exactly the
//   kernel the FM can't invent) — but folding it into the FM's CONTEXT does not
//   solve it. The weak ~3B ignores the reference and repeats its own broken parse.
//
// So "use the internet to SOLVE, not plan" has to go one step further than a hint:
//
//   Retrieved code is a CANDIDATE, not a prompt. We extract each function definition
//   from the fetched source, mechanically ALIAS it to the target signature, and hand
//   the resulting module STRAIGHT to the execution verifier — the FM never touches
//   the kernel. If a retrieved function passes the spec's cases, it is certified with
//   ZERO model calls. If none pass, the loop falls through to the FM (which still has
//   the reference in context via codeResearch channel 3).
//
// This is doctrine-sound by construction: a RetrievalProposer is just another fallible
// Proposer. Nothing it emits is trusted — every candidate is EXECUTED against the same
// ground-truth verifier as an FM proposal. A wrong/irrelevant snippet can only waste a
// budget slot, never certify a false answer. The verifier remains the sole source of
// correctness (types.ts / DOCTRINE.md).
//
// The FM's role collapses to what it is actually good at: naming the kernel to search
// for (the decomposition planner). The internet + the verifier do the solving.
// ═══════════════════════════════════════════════════════════════════════════════

import type { Candidate, Proposer, ProposeContext } from './types'
import { fingerprintCode } from './codeProposer'

/** A single function definition lifted verbatim from retrieved source. */
export interface ExtractedFn {
  /** The declared identifier (`parseClock`, `toMinutes`, …). */
  name: string
  /** Full source text of the definition (declaration + body), ready to re-emit. */
  source: string
  /** Best-effort positional parameter count (for signature-fit ranking). */
  arity: number
  /** How the binding was declared — used only for re-export shaping. */
  kind: 'function' | 'binding'
}

// ── sanitation ──────────────────────────────────────────────────────────────────
// Retrieved web code is written for a module system we can't reproduce in the sandbox:
// it `import`s siblings, `require`s libs, and `export`s / `module.exports =`. Strip the
// module plumbing so what remains is a flat set of top-level declarations the verifier's
// esbuild transform can load. We DO NOT try to resolve external deps — a snippet that
// genuinely needs `lodash` will simply fail to load (a dead candidate, not a false pass).

/** Remove import/require/export plumbing while preserving the declarations themselves. */
export function sanitizeRetrievedSource(code: string): string {
  return code
    // whole-line ES/CommonJS import statements
    .replace(/^[ \t]*import\s+[^\n;]*;?[ \t]*$/gm, '')
    .replace(/^[ \t]*(?:const|let|var)\s+[^=\n]*=\s*require\([^)]*\)\s*;?[ \t]*$/gm, '')
    // `module.exports = X` / `exports.foo = X` lines (the binding is defined elsewhere)
    .replace(/^[ \t]*module\.exports\s*=\s*[^\n;]*;?[ \t]*$/gm, '')
    .replace(/^[ \t]*exports\.[A-Za-z_$][\w$]*\s*=\s*[^\n;]*;?[ \t]*$/gm, '')
    // leading `export ` keyword on declarations — keep the declaration, drop the modifier
    .replace(/^([ \t]*)export\s+(default\s+)?(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/gm, '$1')
    // standalone `export { … }` / `export default …` statements
    .replace(/^[ \t]*export\s+default\s+[^\n;]*;?[ \t]*$/gm, '')
    .replace(/^[ \t]*export\s*\{[^}]*\}\s*;?[ \t]*$/gm, '')
}

/**
 * Walk from an opening `{` (or `(`/`[`) to its matching close, honoring string and
 * template literals, line/block comments, and regex-ish `/…/` so braces inside them
 * don't miscount. Returns the index JUST AFTER the matching close, or -1 if unbalanced.
 * A small hand-rolled scanner is deliberate: pulling in a full JS parser for untrusted
 * web snippets is heavier and more brittle than a bounded brace-matcher.
 */
export function matchDelimiter(src: string, openIdx: number): number {
  const open = src[openIdx]
  const close = open === '{' ? '}' : open === '(' ? ')' : ']'
  let depth = 0
  let i = openIdx
  let inStr: string | null = null       // the active quote char, or null
  let inLine = false                    // // line comment
  let inBlock = false                   // /* block comment */
  for (; i < src.length; i++) {
    const c = src[i]
    const n = src[i + 1]
    if (inLine) { if (c === '\n') inLine = false; continue }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++ } continue }
    if (inStr) {
      if (c === '\\') { i++; continue }               // escaped char
      if (c === inStr) inStr = null
      continue
    }
    if (c === '/' && n === '/') { inLine = true; i++; continue }
    if (c === '/' && n === '*') { inBlock = true; i++; continue }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
    if (c === '{' || c === '(' || c === '[') { if (c === open) depth++ }
    if (c === '}' || c === ')' || c === ']') {
      if (c === close) { depth--; if (depth === 0) return i + 1 }
    }
  }
  return -1
}

/** Count positional params in a `(a, b, …)` header (best-effort; ignores defaults/rest shape). */
function arityOf(paramSrc: string): number {
  const inner = paramSrc.replace(/^\(|\)$/g, '').trim()
  if (!inner) return 0
  // split at top-level commas only (defaults/objects can contain commas)
  let depth = 0, count = 1
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (c === '(' || c === '{' || c === '[') depth++
    else if (c === ')' || c === '}' || c === ']') depth--
    else if (c === ',' && depth === 0) count++
  }
  return count
}

/**
 * Extract every top-level function-like definition from a (sanitized) source blob:
 *   • `function name(params) { … }`  (and `async function`)
 *   • `const name = (params) => { … }` / `= function (params) { … }` / `= async …`
 * Arrow expression bodies (`const f = x => x*2`) are captured through the end of the
 * statement. Returns them in source order, deduped by name (first wins). Bounded work.
 */
export function extractFunctions(rawCode: string): ExtractedFn[] {
  const code = sanitizeRetrievedSource(rawCode)
  const out: ExtractedFn[] = []
  const seen = new Set<string>()

  const push = (name: string, source: string, arity: number, kind: ExtractedFn['kind']) => {
    if (!name || seen.has(name)) return
    seen.add(name)
    out.push({ name, source: source.trim(), arity, kind })
  }

  // 1) `function name(...) { ... }`
  const fnDecl = /(?:^|\n)[ \t]*(?:async[ \t]+)?function[ \t]+([A-Za-z_$][\w$]*)[ \t]*\(/g
  for (let m; (m = fnDecl.exec(code)); ) {
    const name = m[1]
    const parenIdx = code.indexOf('(', m.index + m[0].length - 1)
    const afterParams = matchDelimiter(code, parenIdx)
    if (afterParams < 0) continue
    const paramSrc = code.slice(parenIdx, afterParams)
    const braceIdx = code.indexOf('{', afterParams)
    if (braceIdx < 0) continue
    const end = matchDelimiter(code, braceIdx)
    if (end < 0) continue
    const start = code.lastIndexOf('function', m.index + m[0].length)
    // include a leading `async` if present
    const asyncStart = /async\s+$/.test(code.slice(Math.max(0, start - 7), start)) ? start - 6 : start
    push(name, code.slice(Math.max(m.index, asyncStart), end).replace(/^\n/, ''), arityOf(paramSrc), 'function')
  }

  // 2) `const/let/var name = (params) => { … }` | `= function (…) { … }` | `= x => expr`
  const bindDecl = /(?:^|\n)[ \t]*(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(async[ \t]+)?(function\b[^\n(]*\(|\([^;]*?\)[ \t]*=>|[A-Za-z_$][\w$]*[ \t]*=>)/g
  for (let m; (m = bindDecl.exec(code)); ) {
    const name = m[1]
    const declStart = code.indexOf(m[1], m.index) - (m[0].indexOf(m[1]))
    const headStart = m.index + m[0].indexOf(m[1]) // approximate; we re-slice from `const`
    const kwIdx = code.lastIndexOf('const', headStart) >= m.index ? code.lastIndexOf('const', headStart)
      : Math.max(code.lastIndexOf('let', headStart), code.lastIndexOf('var', headStart), m.index)
    const from = Math.max(m.index, kwIdx < 0 ? m.index : kwIdx)
    void declStart
    // Locate the params paren for arity, then the body.
    const arrowFn = /=>\s*$/.test(m[0]) || /=>/.test(m[3])
    const parenIdx = code.indexOf('(', m.index + m[0].indexOf('='))
    let arity = 0
    // Bare-identifier arrow (`= str =>` / `= async x =>`, no parens) is a single param —
    // the paren-based count below would miss it and mis-report arity 0, the most common
    // shape for single-arg helpers on SO/blogs. Detect it off the captured head (m[3]).
    if (/^(?:async[ \t]+)?[A-Za-z_$][\w$]*[ \t]*=>/.test(m[3])) {
      arity = 1
    } else if (parenIdx >= 0 && parenIdx < m.index + m[0].length + 2) {
      const afterParams = matchDelimiter(code, parenIdx)
      if (afterParams > 0) arity = arityOf(code.slice(parenIdx, afterParams))
    }
    // Body: block `{…}` after `=>` / function header, else expression to statement end.
    const braceIdx = code.indexOf('{', m.index + m[0].length - 1)
    const arrowIdx = code.indexOf('=>', m.index)
    let end = -1
    if (braceIdx >= 0 && (arrowIdx < 0 || braceIdx < arrowIdx + 3) ) {
      end = matchDelimiter(code, braceIdx)
    } else if (arrowIdx >= 0) {
      const afterArrow = arrowIdx + 2
      const nextBrace = code.indexOf('{', afterArrow)
      // block-body arrow only if the very next non-space char is `{`
      if (nextBrace >= 0 && /^\s*$/.test(code.slice(afterArrow, nextBrace))) {
        end = matchDelimiter(code, nextBrace)
      } else {
        // expression body — read to the terminating `;` or newline at paren depth 0
        end = statementEnd(code, afterArrow)
      }
    }
    if (end < 0) continue
    let src = code.slice(from, end)
    // ensure a trailing semicolon for arrow/function-expression bindings
    if (!/[;}]\s*$/.test(src)) src += ';'
    push(name, src, arity, 'binding')
  }

  return out
}

/** Read from `i` to the end of the current statement (top-level `;` or newline). */
function statementEnd(src: string, i: number): number {
  let depth = 0
  let inStr: string | null = null
  for (; i < src.length; i++) {
    const c = src[i]
    if (inStr) { if (c === '\\') { i++; continue } if (c === inStr) inStr = null; continue }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
    if (c === '(' || c === '{' || c === '[') depth++
    else if (c === ')' || c === '}' || c === ']') depth--
    else if ((c === ';' || c === '\n') && depth <= 0) return c === ';' ? i + 1 : i
  }
  return src.length
}

// ── candidate assembly ───────────────────────────────────────────────────────────

/**
 * Build an executable candidate MODULE that exports `entry`, backed by the retrieved
 * function `chosen`. ALL sibling definitions are included so inter-helper calls resolve
 * (the chosen fn may call others in the same snippet); the chosen one is re-exported
 * under the target name. If a sibling already IS named `entry`, we don't collide — we
 * alias via `export { chosen as entry }` (or a thin wrapper when names match).
 */
export function aliasToEntry(allSource: string, chosen: string, entry: string): string {
  const body = sanitizeRetrievedSource(allSource).trim()
  const declaresEntry = new RegExp(`(?:function|const|let|var|class)\\s+${entry}\\b`).test(body)
  if (chosen === entry || declaresEntry) {
    // The retrieved source already binds `entry` locally — just ensure it is exported.
    return `${body}\n\nexport { ${entry} };\n`
  }
  // Bind the chosen definition to the target name as a REAL local const (not just
  // `export { a as b }`, which exports the name but leaves the local binding as `a` —
  // so composed code that CALLS `entry` would throw ReferenceError). The local const
  // makes `entry` callable inside the module AND the export exposes it to the verifier.
  return `${body}\n\nconst ${entry} = ${chosen};\nexport { ${entry} };\n`
}

/** Score a candidate fn for how well it fits the target: name overlap + arity match. Exported for ranking tests. */
export function fitScore(fn: ExtractedFn, entry: string, goal: string, wantArity: number | null): number {
  const e = entry.toLowerCase()
  const n = fn.name.toLowerCase()
  let s = 0
  if (n === e) s += 100
  else if (n.includes(e) || e.includes(n)) s += 40
  // token overlap with the goal text (e.g. goal "convert to minutes" ↔ name toMinutes)
  const goalToks = new Set((goal.toLowerCase().match(/[a-z]{3,}/g) ?? []))
  for (const t of (n.match(/[a-z]{3,}/g) ?? [])) if (goalToks.has(t)) s += 8
  if (wantArity != null && fn.arity === wantArity) s += 15
  // prefer earlier (usually the primary export sits first) and non-trivial bodies
  if (fn.source.length > 40) s += 3
  // Minimality tie-breaker: when two candidates share a name/arity, a plain spec-matching
  // impl should rank ahead of an option-heavy library one (e.g. a slugify that transliterates
  // `&`→`and` behind a config object and breaks the spec). This is RANKING ONLY — every queued
  // candidate still executes; it just decides which lands first when the try-budget is tight.
  if (/\b(options|opts|config|settings)\b/.test(fn.source)) s -= 6
  if (fn.source.length > 600) s -= 4   // sprawling bodies are usually the kitchen-sink variant
  return s
}

export interface RetrievalProposerOpts {
  /** Target export name the candidate module must expose. */
  entry: string
  /** Natural-language goal — used for name/goal token ranking of extracted fns. */
  goal: string
  /**
   * The retriever: given a query, return raw source text (or null). Injected so the pure
   * loop never touches the network. Called AT MOST ONCE (result cached for the search).
   *
   * MAY return a `string[]` of per-file blobs instead of one joined string. Doing so is
   * strictly better for certify-rate: same-named alternate impls (e.g. a plain `slugify`
   * and an option-taking library `slugify`) are kept as DISTINCT candidates instead of
   * being collapsed by extractFunctions' first-wins name dedup — so the one that actually
   * matches the spec reaches the verifier. Prefer one entry per retrieved source file.
   */
  webGround: (query: string) => Promise<string | string[] | null>
  /** The search query to retrieve with. Defaults to `goal`. */
  query?: string
  /** Expected positional arity of the target, when known (from acceptance cases). */
  wantArity?: number | null
  /** Cap on how many extracted candidates to try (best-fit first). Default 6. */
  maxCandidates?: number
  /** Optional progress sink (shares the search emit shape). */
  emit?: (e: Record<string, unknown>) => void
}

/**
 * Build a RetrievalProposer: a Proposer that, on its first invocation, fetches reference
 * source and extracts + ranks its function definitions into a queue of executable
 * candidate modules. Each subsequent call shifts the next candidate. When the queue is
 * exhausted it returns null — so `composeProposers(retrieval, proposeCode)` naturally
 * tries every retrieved candidate first, then falls through to the FM (which by then has
 * the reference in its context). Stateful across calls within ONE search; construct a
 * fresh one per solve.
 */
export function makeRetrievalProposer(opts: RetrievalProposerOpts): Proposer<string> {
  const emit = opts.emit ?? (() => {})
  const max = opts.maxCandidates ?? 6
  let fetched = false
  let queue: string[] = []      // pre-built candidate module sources, best-fit first
  const usedFingerprints = new Set<string>()

  const ensureFetched = async (ctx: ProposeContext<string>) => {
    if (fetched) return
    fetched = true
    if (ctx.signal?.aborted) return
    let raw: string | string[] | null = null
    try { raw = await opts.webGround(opts.query ?? opts.goal) }
    catch (e: any) { emit({ type: 'thought', text: `retrieval: fetch error ${String(e?.message ?? e)}` }); return }
    // Normalize to per-file blobs. Keeping files SEPARATE (vs one joined string) preserves
    // same-named alternate impls as distinct candidates — the certify-rate lever (see opts).
    const blobs = (Array.isArray(raw) ? raw : [raw]).filter((b): b is string => !!b && !!b.trim())
    if (!blobs.length) { emit({ type: 'thought', text: 'retrieval: no source returned (dry)' }); return }
    // Each candidate carries the fn AND the blob it came from, so aliasToEntry only ever
    // sees ONE file's declarations — no duplicate-const collisions across files.
    const candidates: Array<{ fn: ExtractedFn; blob: string; score: number }> = []
    let totalFns = 0
    for (const blob of blobs) {
      const fns = extractFunctions(blob)
      totalFns += fns.length
      for (const fn of fns) {
        candidates.push({ fn, blob, score: fitScore(fn, opts.entry, opts.goal, opts.wantArity ?? null) })
      }
    }
    if (!candidates.length) { emit({ type: 'thought', text: 'retrieval: source found but no function definitions extracted' }); return }
    candidates.sort((a, b) => b.score - a.score)
    queue = candidates.slice(0, max).map(c => aliasToEntry(c.blob, c.fn.name, opts.entry))
    emit({ type: 'thought', text: `retrieval: ${totalFns} fn(s) across ${blobs.length} file(s), queued ${queue.length} candidate(s) aliased to \`${opts.entry}\`` })
  }

  return async (ctx: ProposeContext<string>): Promise<Candidate<string> | null> => {
    await ensureFetched(ctx)
    while (queue.length) {
      const value = queue.shift()!
      const fingerprint = `retrieval:${fingerprintCode(value)}`
      if (usedFingerprints.has(fingerprint)) continue
      usedFingerprints.add(fingerprint)
      emit({ type: 'thought', text: 'retrieval: proposing an executable candidate straight from web source' })
      // Lifted verbatim from retrieved source — no model wrote it, so it costs no model call.
      return { value, fingerprint, modelFree: true }
    }
    return null // exhausted → composite falls through to the next proposer (the FM)
  }
}

/**
 * Compose proposers into one: on each call, try each in order and return the FIRST that
 * yields a candidate. A proposer returning null means "I have nothing right now" — the
 * next takes over. This is how retrieval-candidates-first-then-FM is expressed with no
 * special-casing in search.ts: `composeProposers(retrieval, proposeCode)`.
 *
 * NOTE: a proposer that returns null is treated by search.ts as a transient/infra miss
 * (it retries the slot without charging the reasoning budget). A composite only returns
 * null when EVERY member is exhausted — which for [retrieval, fm] means the FM itself
 * returned null (a real transient), preserving that contract.
 */
export function composeProposers(...proposers: Proposer<string>[]): Proposer<string> {
  return async (ctx: ProposeContext<string>): Promise<Candidate<string> | null> => {
    for (const p of proposers) {
      const c = await p(ctx)
      if (c) return c
    }
    return null
  }
}
