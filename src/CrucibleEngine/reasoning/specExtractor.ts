// ═══════════════════════════════════════════════════════════════════════════════
// VGR — spec extraction: natural language → a mechanically-checkable TaskSpec
// ═══════════════════════════════════════════════════════════════════════════════
//
// The loop is inert without a spec: it needs an entry function name and acceptance
// cases (input → expected) to verify against. This turns an NL coding request into
// that spec. It is the step DOCTRINE.md flags as decisive: "if we cannot state what
// correct means, we ABSTAIN — we do not guess."
//
// The danger: the model invents WRONG expected values, poisoning the ground truth.
// Mitigation, per doctrine (independent derivation over vote-counting): draw K
// independent samples and keep ONLY the acceptance cases whose (args → expected)
// mapping AGREES across a majority of samples. A case the model can't reproduce
// consistently is not trustworthy ground truth, so it is dropped. If too few cases
// survive, we abstain rather than verify against a spec we don't trust.
//
// The model here proposes the spec; the CONSENSUS FILTER is the deterministic check.
// ═══════════════════════════════════════════════════════════════════════════════

import { fmComplete } from '../agent/fmReact'
import { extractSpecExamples } from '../synth/derive'
import type { CodeCase } from './codeVerifier'

/** Injectable completer so the consensus/parse logic is testable without a live model. */
export type Completer = (
  messages: Array<{ role: string; content: string }>,
  opts?: { temperature?: number },
) => Promise<string>

export interface ExtractedSpec {
  entry: string
  cases: CodeCase[]
}

// Flat shape (not a discriminated union) so it narrows reliably even under the project's
// loose tsconfig: on success `spec`+`detail` are set; on abstain `reason` is set.
export interface ExtractResult {
  ok: boolean
  spec?: ExtractedSpec
  detail?: string
  reason?: string
}

interface RawSpec { entry?: unknown; cases?: unknown }

const SYSTEM = [
  'You convert a coding request into a MACHINE-CHECKABLE test specification. You are inside a',
  'verification system: the cases you emit become the ground truth an implementation is executed',
  'against, so they must be UNAMBIGUOUS and CORRECT. Only include cases whose expected output is',
  'fully determined by the request — never guess, never include an example you are unsure of.',
  '',
  'Output STRICT JSON and nothing else, shape:',
  '{ "entry": "<functionName>", "cases": [ { "args": [<json args>], "expected": <json value>, "name": "<short>" } ] }',
  '',
  '- `args` is the positional argument list applied to the function.',
  '- `expected` is the exact return value (JSON).',
  '- Include 3-6 cases covering normal, boundary, and edge inputs (empty, zero, negatives).',
  '- If the request is too vague to determine ANY concrete expected output, output {"entry":"","cases":[]}.',
].join('\n')

// ── Deterministic harvest of USER-PROVIDED examples (trusted ground truth) ─────────
// When the request itself contains "entry(args) === value" (or → / -> / returns), those
// are GOLD — the user stated them, not the model. We trust them without cross-sample
// consensus. This is strictly better ground truth than anything the model invents, and
// it's exactly what the deterministic synth path keys on too (f(x)===y worked examples).

// The connector may be preceded by a MODAL ("isAdult(18) should return true") — the most natural
// way a repair request states its examples, and the shape a bare `returns?` misses entirely. A
// missed example is not a neutral loss: the case falls through to model-invented consensus, which
// costs a call AND is weaker ground truth than the user's own stated fact. Widening is safe by
// construction — addExample discards any pair that isn't a clean literal, so a sentence that only
// looks example-shaped ("run(x) should be fast") evaluates to nothing and is skipped, never guessed.
// Multi-char operators MUST precede their prefixes (`=>` before `=`), or `=` matches first and
// leaves ">" in the value, which then fails to evaluate.
//
// The VALUE alternation is ordered longest-form-first, and that order is load-bearing. The final
// `[^\n,;.]+` fallback stops at `.` to avoid swallowing the sentence's terminating period — but on
// its own it also truncates "1.5" to "1" and "-0.25" to "-0", which EVALUATE CLEANLY and are
// therefore harvested as TRUSTED ground truth that is silently WRONG. A wrong gold case is the
// worst failure this module has: it is exempt from consensus by design, so it would certify a
// wrong implementation (or reject a correct one). Matching structured literals and numbers
// EXPLICITLY, ahead of the fallback, is what keeps the trusted path honest.
const EXAMPLE_RX =
  /([A-Za-z_$][\w$]*)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*(?:(?:should|must|shall|will|would|ought\s+to|has\s+to|needs?\s+to)\s+)?(?:===|==|=>|=|→|->|returns?|gives?|yields?|evaluates?\s+to|equals?|outputs?|produces?|be)\s*(\[[^\]\n]*\]|\{[^}\n]*\}|"[^"\n]*"|'[^'\n]*'|-?\d+(?:\.\d+)?|true|false|null|undefined|[^\n,;.]+)/gi

// BARE input→output examples: `"3+2*2" -> 7`, `[1,2] => 3`, `"racecar" returns true` — a stated
// example with NO `entry(` call wrapping the input. These are common in authored/user prompts
// ("Examples: \"()[]{}\" -> true") and, unharvested, drop the request to `vgr:no-acceptance-cases`
// (the gold tier never fires → the decompose lever is never reached). We can only attribute them to
// a function when the request declares EXACTLY ONE export and states no call-form case for it, and
// we treat the LHS as the SOLE argument (bare form can't express multi-arg unambiguously). The LHS
// must be a clean literal, and — critically — must NOT be preceded by `(` or an identifier char, so
// a call-form `f("x") -> y` is NOT re-matched here (its `"x"` sits right after `(`). Same honesty
// guard as the call-form path: addExample discards any pair that isn't a clean literal.
const BARE_EXAMPLE_RX =
  /(?:^|[\s,;:])((?:"[^"\n]*"|'[^'\n]*'|\[[^\]\n]*\]|-?\d+(?:\.\d+)?))\s*(?:(?:should|must|shall|will|would|maps?\s+to)\s+)?(?:===|==|=>|→|->|returns?|gives?|yields?|evaluates?\s+to|equals?|outputs?|produces?)\s*(\[[^\]\n]*\]|\{[^}\n]*\}|"[^"\n]*"|'[^'\n]*'|-?\d+(?:\.\d+)?|true|false|null|undefined)/gi

/** Evaluate a JS/JSON literal (from the user's own prompt) to a value, or throw. */
function evalLiteral(src: string): unknown {
  const s = src.trim().replace(/[.\s]+$/, '')
  try { return JSON.parse(s) } catch { /* fall through to JS-literal eval */ }
  // eslint-disable-next-line no-new-func — literal from the user's own request, strict mode, no scope access
  return Function('"use strict"; return (' + s + ')')()
}

export interface Harvested {
  /** Primary entry (the function with the most stated examples). */
  entry: string
  /** All exported functions the request states examples for (multi-function specs). */
  entries: string[]
  /** All cases across all entries, each tagged with its target `entry`. */
  cases: CodeCase[]
}

/** Parse a call expression "entry(argSrc)" → [entry, argSrc]; null if not a call. */
function parseCall(lhs: string): [string, string] | null {
  const m = /^([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)\s*$/.exec(lhs.trim())
  return m ? [m[1], m[2]] : null
}

/** Add one (name, argsSrc, rhs) example to the per-entry map, evaluating literals. */
function addExample(byEntry: Map<string, CodeCase[]>, name: string, argsSrc: string, rhs: unknown | string): void {
  let args: unknown[], expected: unknown
  try {
    args = evalLiteral('[' + argsSrc + ']') as unknown[]
    expected = typeof rhs === 'string' ? evalLiteral(rhs) : rhs
  } catch { return }  // not a clean literal pair → skip (never guess)
  if (!Array.isArray(args)) return
  const list = byEntry.get(name) ?? []
  const key = JSON.stringify(args)
  if (list.some(c => JSON.stringify(c.args) === key)) return  // dedup within an entry
  list.push({ args, expected, name: `${name}(${argsSrc.trim()})` })
  byEntry.set(name, list)
}

// Harvest USER-PROVIDED examples (trusted ground truth — the user stated them, not the model)
// from TWO deterministic sources unioned: (1) this module's own permissive regex, and (2) the
// synth path's `extractSpecExamples`, which uses extractFeatures to resolve the real exported
// name (so it catches examples my regex would miss, and stays consistent with what the L0/L1
// synth oracle keys on). Trusted → no model consensus required.
export function harvestExplicitExamples(nl: string): Harvested {
  const byEntry = new Map<string, CodeCase[]>()

  // Source 1 — permissive regex over the raw request text.
  for (const m of nl.matchAll(EXAMPLE_RX)) addExample(byEntry, m[1], m[2], m[3])

  // Source 2 — the synth path's example extractor (feature-aware entry resolution). Seed it with
  // the explicitly-declared function names too: a multi-file request ("Create src/x.ts exporting
  // add(a,b) … For example add(2,3) returns 5") has no signature extractFeatures recognizes, so
  // without this the embedded examples go unharvested and the request falls to weak-FM consensus.
  try {
    for (const { lhs, rhs } of extractSpecExamples(nl, detectDeclaredFunctions(nl))) {
      const call = parseCall(lhs)
      if (call) addExample(byEntry, call[0], call[1], rhs)
    }
  } catch { /* best-effort; regex source still applies */ }

  // Source 3 — BARE `"x" -> y` examples (no call wrapping the input). Only safe to attribute when
  // the request declares EXACTLY ONE export and Sources 1-2 harvested NO call-form case for it (so
  // we can't be mixing arg arities), treating the LHS literal as the SOLE argument. This fills the
  // `vgr:no-acceptance-cases` gap for authored/user prompts that state examples as input→output.
  const declared = declaredExportedNames(nl)
  const soleEntry = declared.length === 1 ? declared[0]
    : (() => { const d = detectDeclaredFunctions(nl); return d.length === 1 ? d[0] : null })()
  if (soleEntry && !(byEntry.get(soleEntry)?.length)) {
    for (const m of nl.matchAll(BARE_EXAMPLE_RX)) addExample(byEntry, soleEntry, m[1], m[2])
  }

  const entries = [...byEntry.keys()]
  if (!entries.length) return { entry: '', entries: [], cases: [] }
  // Primary = the entry with the most stated examples (the function the request centers on).
  const primary = entries.reduce((a, b) => ((byEntry.get(b)!.length > byEntry.get(a)!.length) ? b : a))
  // Flatten ALL entries' cases, tagging each with its target function so the verifier can
  // route it. This is what lets a single request certify several functions at once.
  const cases: CodeCase[] = []
  for (const [entry, cs] of byEntry) for (const c of cs) cases.push({ ...c, entry })
  return { entry: primary, entries, cases }
}

// ── Multi-FUNCTION spec extraction (for multi-file no-example requests) ─────────────
// A multi-file request with no user examples ("src/a.ts exporting square(n) and src/b.ts
// exporting sumSquares(a,b)…") names SEVERAL functions but states no f(x)===y. extractCodeSpec
// only models ONE function, so the other exports go unverified. This extracts consensus cases
// for EACH named function at once: the consensus filter keys on (entry, args) so each function's
// ground truth is cross-checked independently. Same doctrine — model proposes, consensus certifies.

const IDENT_RX = /^[A-Za-z_$][\w$]*$/
const NON_FN_WORDS = new Set(['if', 'for', 'while', 'return', 'function', 'const', 'let', 'var', 'switch', 'catch'])

/**
 * The exact function names the request DECLARES as exports via a real signature —
 * `export function rotate90<T>(matrix: T[][]): T[][]` or an "Export exactly:" block. This is the
 * audit's import identity (`import { rotate90 } from '../src/matrixRotate'`), and it is
 * AUTHORITATIVE over any name the model's proposed examples happen to call. Narrower on purpose
 * than detectDeclaredFunctions (which also grabs any call-shaped token): only a genuine
 * `export function NAME` / `export const NAME =` declaration counts, so this can safely override
 * a mis-voted entry without swallowing prose. First-seen order preserved.
 */
export function declaredExportedNames(nl: string): string[] {
  const names = new Set<string>()
  for (const m of nl.matchAll(/\bexport\s+(?:async\s+)?(?:function\s+|const\s+|class\s+)([A-Za-z_$][\w$]*)/g)) {
    if (IDENT_RX.test(m[1]) && !NON_FN_WORDS.has(m[1].toLowerCase())) names.add(m[1])
  }
  return [...names]
}

/** Function names the request explicitly asks to export/define (identifier before `(`). */
export function detectDeclaredFunctions(nl: string): string[] {
  const names = new Set<string>()
  // "exporting/exports/defines/expose the NAME(" — a declared export.
  for (const m of nl.matchAll(/\b(?:export(?:ing|s)?|expose[sd]?|defines?|declares?)\s+(?:a\s+|the\s+|an\s+)?([A-Za-z_$][\w$]*)\s*\(/gi)) names.add(m[1])
  // Any bare call-shaped signature "NAME(args)" (in a no-example request these ARE the fns).
  for (const m of nl.matchAll(/\b([A-Za-z_$][\w$]*)\s*\([^)]*\)/g)) names.add(m[1])
  return [...names].filter(n => IDENT_RX.test(n) && !NON_FN_WORDS.has(n.toLowerCase()))
}

const MULTI_SYSTEM = (fns: string[]) => [
  'You convert a coding request into a MACHINE-CHECKABLE test specification for MULTIPLE functions.',
  'You are inside a verification system: the cases you emit become the ground truth implementations are',
  'executed against, so they must be UNAMBIGUOUS and CORRECT. Only include a case whose expected output',
  'is fully determined by the request — never guess.',
  '',
  `The request defines these functions: ${fns.map(f => '`' + f + '`').join(', ')}.`,
  'Output STRICT JSON and nothing else, shape:',
  '{ "cases": [ { "entry": "<functionName>", "args": [<json args>], "expected": <json value>, "name": "<short>" } ] }',
  '',
  '- Every case MUST set "entry" to the function it targets (exactly one of the names above).',
  '- Give 2-4 cases PER function covering normal, boundary, and edge inputs.',
  '- "args" is ALWAYS a JSON array (a single argument 5 is written [5], never 5).',
  '- If you cannot determine ANY concrete expected output, output {"cases":[]}.',
  '',
  '### Example (for a DIFFERENT request defining `inc` and `add` — do not copy its values):',
  '{ "cases": [',
  '  { "entry": "inc", "args": [4], "expected": 5, "name": "inc" },',
  '  { "entry": "inc", "args": [0], "expected": 1, "name": "inc zero" },',
  '  { "entry": "add", "args": [2, 3], "expected": 5, "name": "add" },',
  '  { "entry": "add", "args": [0, 0], "expected": 0, "name": "add zero" } ] }',
  'Note EVERY named function has its OWN cases, and every "args" is an array.',
].join('\n')

export interface MultiFunctionSpec { entry: string; entries: string[]; cases: CodeCase[] }

/**
 * Extract consensus cases for several named functions from a no-example request. Draws `samples`
 * independent proposals; keeps a case only when its (entry,args)→expected agrees across a majority.
 * Requires ≥2 functions to survive with ≥1 case each (else the single-function path is enough and
 * this abstains). No user examples are consulted here — that path is handled upstream.
 */
export async function extractMultiFunctionSpec(
  nl: string,
  fns: string[],
  opts: { samples?: number; complete?: Completer } = {},
): Promise<{ ok: boolean; spec?: MultiFunctionSpec; detail?: string; reason?: string }> {
  const targets = fns.filter(f => IDENT_RX.test(f))
  if (targets.length < 2) return { ok: false, reason: 'fewer than 2 named functions — use the single-function path' }
  const samples = Math.max(1, opts.samples ?? 3)
  const complete = opts.complete ?? fmComplete
  const allow = new Set(targets)

  const proposals: CodeCase[][] = []
  for (let i = 0; i < samples; i++) {
    let raw: string
    try {
      raw = await complete(
        [{ role: 'system', content: MULTI_SYSTEM(targets) }, { role: 'user', content: `Request:\n${nl}` }],
        { temperature: i === 0 ? 0.1 : 0.5 },
      )
    } catch { continue }
    const parsed = parseRaw(raw)
    const cs: CodeCase[] = []
    if (parsed && Array.isArray((parsed as any).cases)) {
      for (const c of (parsed as any).cases) {
        // Coerce a scalar `args` to a single-element list — weak models often write `"args": 5`
        // meaning `[5]`. Dropping those (Array.isArray only) lost most of a function's cases.
        if (c && typeof c === 'object' && 'args' in c && 'expected' in c && typeof c.entry === 'string' && allow.has(c.entry)) {
          const args = Array.isArray(c.args) ? c.args : [c.args]
          cs.push({ entry: c.entry, args, expected: c.expected, name: c.name })
        }
      }
    }
    if (cs.length) proposals.push(cs)
  }
  if (!proposals.length) return { ok: false, reason: 'no parseable multi-function spec proposal from the model' }

  // Consensus keyed on (entry, args): each function's ground truth is cross-checked independently.
  const byKey = new Map<string, { entry: string; args: unknown[]; name?: string; expected: Map<string, { v: unknown; n: number }> }>()
  for (const p of proposals) {
    const seen = new Set<string>()
    for (const c of p) {
      const key = `${c.entry}|${argsKey(c.args)}`
      if (seen.has(key)) continue
      seen.add(key)
      const slot = byKey.get(key) ?? { entry: c.entry!, args: c.args, name: c.name, expected: new Map() }
      const vk = valKey(c.expected)
      const ev = slot.expected.get(vk) ?? { v: c.expected, n: 0 }
      ev.n++; slot.expected.set(vk, ev)
      byKey.set(key, slot)
    }
  }
  const majority = samples === 1 ? 1 : Math.floor(samples / 2) + 1
  const cases: CodeCase[] = []
  for (const slot of byKey.values()) {
    const top = [...slot.expected.values()].sort((a, b) => b.n - a.n)[0]
    if (top && (samples === 1 || top.n >= majority)) {
      cases.push({ entry: slot.entry, args: slot.args as unknown[], expected: top.v, name: slot.name })
    }
  }

  // Require ≥2 distinct functions to survive consensus (each with ≥1 case) — else this isn't a
  // trustworthy multi-function spec and we abstain rather than certify a half-specified graph.
  const covered = [...new Set(cases.map(c => c.entry!))]
  if (covered.length < 2) return { ok: false, reason: `only ${covered.length} function(s) reached consensus — multi-function spec not trustworthy` }
  const primary = covered.reduce((a, b) => (cases.filter(c => c.entry === b).length > cases.filter(c => c.entry === a).length ? b : a))
  return {
    ok: true,
    spec: { entry: primary, entries: covered, cases },
    detail: `${cases.length} model-consensus case(s) across ${covered.length} functions [${covered.join(', ')}]`,
  }
}

/** Parse the model's JSON (tolerating a ```json fence and surrounding prose). */
function parseRaw(text: string): RawSpec | null {
  if (!text) return null
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = (fence ? fence[1] : text).trim()
  // Grab the outermost object if the model added prose around it.
  const start = body.indexOf('{'); const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(body.slice(start, end + 1)) as RawSpec } catch { return null }
}

/** A stable key for a case's (args) so we can compare expected values across samples. */
function argsKey(args: unknown): string {
  try { return JSON.stringify(args ?? []) } catch { return String(args) }
}
function valKey(v: unknown): string {
  try { return JSON.stringify(v) } catch { return String(v) }
}

function normalizeCases(raw: RawSpec): { entry: string; cases: CodeCase[] } {
  const entry = typeof raw.entry === 'string' ? raw.entry.trim() : ''
  const cases: CodeCase[] = []
  if (Array.isArray(raw.cases)) {
    for (const c of raw.cases) {
      // Coerce a scalar `args` to `[args]` — weak models write `"args": 5` for a single argument.
      if (c && typeof c === 'object' && 'args' in c && 'expected' in c) {
        const a = (c as any).args
        cases.push({ args: Array.isArray(a) ? a : [a], expected: (c as any).expected, name: (c as any).name })
      }
    }
  }
  return { entry, cases }
}

/**
 * Extract a checkable spec from an NL request. Draws `samples` independent proposals and
 * keeps only cases whose (args → expected) agree across a majority — the consensus filter
 * is the deterministic guard against the model inventing wrong ground truth. Abstains
 * (ok:false) when the entry name or the surviving-case count is too weak to trust.
 */
export async function extractCodeSpec(
  nl: string,
  opts: { samples?: number; minCases?: number; complete?: Completer } = {},
): Promise<ExtractResult> {
  const samples = Math.max(1, opts.samples ?? 3)
  const minCases = opts.minCases ?? 2
  const complete = opts.complete ?? fmComplete

  // (0) TRUSTED: examples the user stated verbatim in the request. Gold — no consensus
  // needed. A single user-provided example is worth more than any number of model votes.
  const harvested = harvestExplicitExamples(nl)
  const trustedByArgs = new Set(harvested.cases.map(c => argsKey(c.args)))

  const proposals: Array<{ entry: string; cases: CodeCase[] }> = []
  for (let i = 0; i < samples; i++) {
    let raw: string
    try {
      raw = await complete(
        [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Request:\n${nl}` }],
        { temperature: i === 0 ? 0.1 : 0.5 },  // one low-temp anchor + diverse samples
      )
    } catch { continue }
    const parsed = parseRaw(raw)
    if (parsed) proposals.push(normalizeCases(parsed))
  }

  // With trusted user examples we can proceed even if the model returned nothing usable.
  if (!proposals.length && !harvested.cases.length) {
    return { ok: false, reason: 'no parseable spec proposal from the model and no user-provided examples' }
  }

  // Entry name: prefer the one the USER named in an explicit example; else majority vote.
  // The entry MUST be a plain JS identifier — never a file path. On a multi-file request the
  // model sometimes names the entry "src/mathx.ts", which yields a spec whose cases can never
  // resolve to a function and burns the whole model-call budget on a guaranteed exhaust. Reject
  // non-identifier entries up front so a poisoned spec abstains cheaply instead.
  const IDENT = /^[A-Za-z_$][\w$]*$/
  const entryVotes = new Map<string, number>()
  for (const p of proposals) if (p.entry && IDENT.test(p.entry)) entryVotes.set(p.entry, (entryVotes.get(p.entry) ?? 0) + 1)
  const harvestedEntry = IDENT.test(harvested.entry) ? harvested.entry : ''
  let entry = harvestedEntry || ([...entryVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '')
  // CERTIFICATION-SCOPE SOUNDNESS (2026-07-22): when the request DECLARES an exact exported API
  // (`Export exactly: export function rotate90<T>(…)`), that name is the audit's import identity
  // and OVERRIDES a mis-voted entry. Without this, a prose-only request ("matrix rotation") whose
  // model-proposed examples call the wrong name (`matrixRotate`) certifies + emits that symbol,
  // and the external audit's `import { rotate90 }` then hits "rotate90 is not a function". Only
  // override on an UNAMBIGUOUS single declared export the current entry doesn't already match —
  // multi-export specs route through extractMultiFunctionSpec and are left untouched.
  const declaredExports = declaredExportedNames(nl)
  if (declaredExports.length === 1 && entry !== declaredExports[0]) entry = declaredExports[0]
  if (!entry) return { ok: false, reason: 'could not name a concrete entry function (no valid identifier — request too vague or path-shaped; abstaining)' }

  // Consensus over cases: group every proposed case by argsKey; for each arg-set, the
  // expected value must AGREE across a majority of the proposals that included it.
  const byArgs = new Map<string, { args: unknown[]; name?: string; expected: Map<string, { v: unknown; n: number }> }>()
  for (const p of proposals) {
    // dedupe within a single proposal so one sample can't outvote itself
    const seenInThis = new Set<string>()
    for (const c of p.cases) {
      const ak = argsKey(c.args)
      if (seenInThis.has(ak)) continue
      seenInThis.add(ak)
      const slot = byArgs.get(ak) ?? { args: c.args, name: c.name, expected: new Map() }
      const vk = valKey(c.expected)
      const ev = slot.expected.get(vk) ?? { v: c.expected, n: 0 }
      ev.n++; slot.expected.set(vk, ev)
      byArgs.set(ak, slot)
    }
  }

  const majority = samples === 1 ? 1 : Math.floor(samples / 2) + 1
  const agreed: CodeCase[] = []
  const dropped: string[] = []
  for (const [ak, slot] of byArgs) {
    if (trustedByArgs.has(ak)) continue  // user already pinned this input — trusted set wins
    const top = [...slot.expected.values()].sort((a, b) => b.n - a.n)[0]
    // With a single sample there's nothing to cross-check, so trust it (minCases still gates).
    if (top && (samples === 1 || top.n >= majority)) {
      agreed.push({ args: slot.args as unknown[], expected: top.v, name: slot.name })
    } else {
      dropped.push(argsKey(slot.args))
    }
  }

  // Final acceptance set. CRITICAL (DOCTRINE.md — vote-counting amplifies systematic bias):
  // a model-invented case can be confidently WRONG, which makes the spec UNSATISFIABLE and
  // forces the loop to exhaust on a task it could actually solve. So:
  //   • If the USER stated examples, they are the gold gate — certify against THOSE ONLY.
  //     Model-invented cases don't get to block a correct implementation.
  //   • Only when there are NO user examples do we fall back to model-consensus cases
  //     (accepting the bias risk, because some checkable spec beats none).
  const cases = harvested.cases.length >= 1 ? harvested.cases : agreed
  const enough = harvested.cases.length >= 1 || agreed.length >= minCases
  if (!cases.length || !enough) {
    return { ok: false, reason: `spec not trustworthy — ${harvested.cases.length} user example(s), ${agreed.length}/${minCases} consensus case(s); abstaining` }
  }
  const provenance = harvested.cases.length >= 1
    ? `${harvested.cases.length} user example(s) (gold gate; ${agreed.length} model case(s) held as advisory only)`
    : `${agreed.length} model-consensus case(s)${dropped.length ? `, ${dropped.length} dropped` : ''}`
  return { ok: true, spec: { entry, cases }, detail: `entry '${entry}', ${provenance}` }
}
