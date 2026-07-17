// ═══════════════════════════════════════════════════════════════════════════════
// API FAITHFULNESS VERIFIER — does the answer's code use the API the evidence documents?
// ═══════════════════════════════════════════════════════════════════════════════
//
// THE GAP THIS CLOSES (audit cont.82). Retrieval finds the right page, formatting now
// preserves it, and the model STILL fabricates: given a zod.dev passage containing a
// literal `z.ipv4();` it emitted `import { Schema } from 'zod'`, `require('zod').validate()`,
// and a hand-rolled regex — while citing the page it contradicted. A code-aware system
// prompt suppressed some of it but invented new APIs instead: necessary, not sufficient.
//
// So we stop asking the model to be faithful and CHECK it — the VGR thesis applied to the
// answer path (DOCTRINE.md): an unreliable generator + a sound deterministic verifier beats
// the generator. The model proposes library calls; this module checks each one against the
// retrieved evidence and rejects what the evidence never mentions.
//
// SOUNDNESS RULE — we only judge what we can PROVE is a library reference:
//   • named imports        `import { Schema } from 'zod'`   → Schema is bound to zod
//   • namespace members    `import * as z` / `require('zod')` then `z.ipv4()`
// and nothing else. A bare `foo()` or `schema.parse()` is NOT checked: resolving those needs
// type inference we don't have (`schema` is a local whose type comes from a zod call), and a
// wrong reject there would poison the repair loop. cont.79h is explicit that a FALSE REJECT is
// worse than a missed check — a missed fabrication ships one bad answer, a false reject teaches
// the loop to "fix" correct code. Every ambiguity in this file resolves toward ABSTAIN.
// ═══════════════════════════════════════════════════════════════════════════════

/** One library identifier the answer used that the evidence never documents. */
export interface ApiViolation {
  /** Package specifier as written in the answer (`zod`, `@vee-validate/zod`). */
  library: string
  /** The offending identifier (`Schema`, `validate`). */
  identifier: string
  /**
   * How it was bound — determines the repair hint.
   * `ignored-evidence` is the whole-answer case: code that touches the retrieved API surface
   * NOWHERE (see verifyEvidenceUsage), rather than one bad identifier.
   * `execution-failure` is the only kind produced by RUNNING the code (see executionVerify):
   * ground truth from the runtime, not a claim about names.
   */
  kind: 'named-import' | 'namespace-member' | 'ignored-evidence' | 'execution-failure'
  /** Verbatim source line, for the repair prompt. */
  line: string
}

export type FaithfulnessStatus = 'certified' | 'violations' | 'abstain'

export interface FaithfulnessVerdict {
  status: FaithfulnessStatus
  /** Human/model-readable justification. Always populated. */
  reason: string
  violations: ApiViolation[]
  /** Identifiers the evidence documents for the judged library (sorted). The judging vocabulary. */
  documented: string[]
  /** Call-shaped subset of `documented` — the API surface offered back in repair hints. */
  callSurface: string[]
  /** The library actually judged, when one was. */
  library?: string
}

/**
 * Minimum distinct identifiers the evidence must document for a library before we are
 * willing to call ANY identifier fabricated. Below this the evidence is a stub (a landing
 * page, a playground blurb) and absence proves nothing — so we abstain rather than reject
 * against a vocabulary too thin to be an authority.
 */
const MIN_VOCAB = 4

/** Members that exist on ~every JS value or module object — never a library-specific claim. */
const UNIVERSAL_MEMBERS = new Set([
  'default', 'length', 'name', 'call', 'apply', 'bind', 'toString', 'valueOf',
  'constructor', 'prototype', 'then', 'catch', 'finally', 'map', 'filter', 'forEach',
])

/**
 * Fence languages that are never an API claim. A `npm install zod` shell block is not the
 * model asserting an API exists, so judging it would manufacture false rejects. Note `json`
 * is deliberately NOT here: the measured failure IS a ```json JSON-Schema block substituted
 * for the library that was asked for.
 */
const NON_API_FENCES = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'text', 'txt', 'output', 'log', 'diff'])

/** Strip markdown fences and return the code inside. Non-code prose is never judged. */
export function answerCodeBlocks(answer: string): string[] {
  const out: string[] = []
  const re = /```([a-zA-Z0-9+#._-]*)\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = re.exec(answer))) {
    if (NON_API_FENCES.has(m[1].toLowerCase())) continue
    out.push(m[2])
  }
  return out
}

/** Normalize a module specifier to the token we look for in evidence (`zod` from `zod/v4`). */
function packageToken(spec: string): string {
  const s = spec.replace(/^node:/, '')
  if (s.startsWith('@')) return s.split('/').slice(0, 2).join('/')
  return s.split('/')[0]
}

interface LibBinding {
  library: string
  named: Array<{ identifier: string; line: string }>
  namespaces: string[]
  /** `require('pkg').foo` — member read directly off the require call. */
  directMembers: Array<{ identifier: string; line: string }>
}

/**
 * Find every identifier the answer's code provably binds to an external package.
 * Handles ESM named/default/namespace imports and CJS require, including destructured
 * require and member-off-require.
 */
export function extractLibraryUsage(code: string): LibBinding[] {
  const byLib = new Map<string, LibBinding>()
  const get = (lib: string): LibBinding => {
    let b = byLib.get(lib)
    if (!b) { b = { library: lib, named: [], namespaces: [], directMembers: [] }; byLib.set(lib, b) }
    return b
  }
  const lineOf = (idx: number): string => {
    const start = code.lastIndexOf('\n', idx) + 1
    const end = code.indexOf('\n', idx)
    return code.slice(start, end === -1 ? code.length : end).trim()
  }

  // ── ESM: import { a, b as c } from 'pkg'
  const namedRe = /import\s*\{([^}]*)\}\s*from\s*['"`]([^'"`]+)['"`]/g
  let m: RegExpExecArray | null
  while ((m = namedRe.exec(code))) {
    const b = get(packageToken(m[2]))
    for (const raw of m[1].split(',')) {
      // `a as c` — the ORIGINAL name is the API claim; the alias is the author's own.
      const id = raw.trim().split(/\s+as\s+/)[0].trim().replace(/^type\s+/, '')
      if (id) b.named.push({ identifier: id, line: lineOf(m.index) })
    }
  }

  // ── ESM: import * as z from 'pkg'  |  import z from 'pkg'
  const nsRe = /import\s+(?:\*\s*as\s+)?([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\}\s*)?from\s*['"`]([^'"`]+)['"`]/g
  while ((m = nsRe.exec(code))) get(packageToken(m[2])).namespaces.push(m[1])

  // ── CJS: const z = require('pkg')  |  const { a } = require('pkg')  |  require('pkg').foo
  const reqRe = /(?:(?:const|let|var)\s+([\w${}\s,:]+?)\s*=\s*)?require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)\s*(?:\.\s*([A-Za-z_$][\w$]*))?/g
  while ((m = reqRe.exec(code))) {
    const b = get(packageToken(m[2]))
    const line = lineOf(m.index)
    if (m[3]) b.directMembers.push({ identifier: m[3], line })
    const lhs = (m[1] ?? '').trim()
    if (!lhs) continue
    if (lhs.startsWith('{')) {
      for (const raw of lhs.replace(/[{}]/g, '').split(',')) {
        const id = raw.trim().split(/\s*:\s*/)[0].trim()
        if (id) b.named.push({ identifier: id, line })
      }
    } else if (/^[A-Za-z_$][\w$]*$/.test(lhs)) {
      b.namespaces.push(lhs)
    }
  }

  return [...byLib.values()]
}

/**
 * Harvest every identifier the evidence documents. Deliberately OVER-inclusive: any name the
 * evidence calls, accesses, imports or backticks counts as documented. Over-inclusion costs a
 * missed fabrication; under-inclusion costs a false reject, which is strictly worse.
 *
 * Normalizes namespace-qualified prose to bare names, so a docs table listing `ipv4()` and a
 * code sample writing `z.ipv4()` both certify the same call (the cont.82 Q10 hazard).
 *
 * TWO DEFECTS FIXED (cont.85) — the same vocabulary bug fired in BOTH directions:
 *
 *   • FALSE CERTIFY. The member rule was `\.\s*(\w+)`, and `\s*` spans a SENTENCE BOUNDARY:
 *     `...email addresses.\nZod v4` parses as a member access and enters `Zod` into the
 *     vocabulary, so the fabricated `import { Zod } from 'zod'` certified green (t12). Same
 *     path admitted `Perfect` from `instantly. Perfect for learning`. A period followed by
 *     whitespace is prose; real member access — including chained `\n  .min()` — never puts
 *     whitespace between the dot and the name. So the dot now binds tight.
 *
 *   • FALSE REJECT (worse — cont.79h). The old `length > 1` floor could never admit `z`, so
 *     `import { z } from 'zod'` — the canonical zod import, with `const ipv4 = z.ipv4();`
 *     sitting in the evidence — was reported as a fabricated identifier. Single-character
 *     identifiers are the NORM for namespace imports (`z`, `_`, `$`), so the floor is gone and
 *     the dotted rule below harvests the namespace ROOT (`z` in `z.ipv4()`), not just members.
 *
 * Both fixes stay on the safe side of the asymmetry: dropping the floor and harvesting roots
 * only ADD to the vocabulary (fewer rejects), and the dot tightening removes only matches that
 * are provably prose. Prose noise that survives (`foo (v4)` still reads as a call) is left
 * alone deliberately — over-inclusion costs a missed check, under-inclusion costs a false
 * reject, and this file resolves every ambiguity toward abstain.
 */
export function documentedIdentifiers(evidence: string): Set<string> {
  const vocab = new Set<string>()
  const add = (s: string | undefined) => { if (s) vocab.add(s) }

  // called: `foo(` and `z.foo(`  → records `foo`
  for (const m of evidence.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) add(m[1])
  // dotted access `z.ipv4` → records BOTH the namespace root `z` and the member `ipv4`.
  // Whitespace-free on both sides of the dot, so a prose sentence boundary cannot match.
  for (const m of evidence.matchAll(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)) { add(m[1]); add(m[2]) }
  // chained member on its own line: `\n  .min(` → records `min` (no LHS to root).
  for (const m of evidence.matchAll(/\.([A-Za-z_$][\w$]*)/g)) add(m[1])
  // named imports/exports in evidence code samples
  for (const m of evidence.matchAll(/(?:import|export)\s*\{([^}]*)\}/g))
    for (const raw of m[1].split(',')) add(raw.trim().split(/\s+as\s+/).pop()?.trim())
  // inline-code / backticked identifiers
  for (const m of evidence.matchAll(/`([A-Za-z_$][\w$]*)`/g)) add(m[1])
  // `new Foo` / type positions `: Foo` — documented surface even when never called
  for (const m of evidence.matchAll(/\bnew\s+([A-Za-z_$][\w$]*)/g)) add(m[1])

  return vocab
}

/**
 * The subset of the vocabulary that reads like a real API surface — used ONLY to build repair
 * hints, never to judge.
 *
 * `documentedIdentifiers` is intentionally permissive, so it also absorbs prose noise: the
 * member regex turns `zod.dev` into `dev`, and `Perfect for learning Zod` into `Perfect`. That
 * noise is harmless when deciding what NOT to reject, but as a repair hint it is actively bad —
 * it spends the retry's information budget on words that are not APIs. So the hint is built
 * from call-shaped occurrences only: `z.ipv4()` (namespace member call) and `ipv4()` (bare
 * zero-arg call, the form the deepwiki docs table uses).
 */
/**
 * Control-flow keywords are followed by `(` too. They are a closed grammatical class (the
 * FUNCTION_WORDS precedent), never a library's API, and letting them into the surface would
 * both inflate the vocab count and let `if (…)` in an answer "overlap" the docs.
 */
const NOT_AN_API = new Set(
  ('if else for while switch catch return function await typeof instanceof new delete void ' +
   'do try throw case in of yield import export declare const let var class extends implements').split(/\s+/),
)

export function documentedCallSurface(evidence: string): string[] {
  const out = new Set<string>()
  for (const m of evidence.matchAll(/\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) out.add(m[1])
  for (const m of evidence.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)/g)) out.add(m[1])
  // TypeScript DECLARATION signatures — `ipv4(params?: core.$ZodCheckIPv4Params): this;`,
  // `declare function email(...): ZodEmail`. Neither pattern above can see these: there is no
  // leading dot and the parens are not empty.
  //
  // This matters because the grounding path now leads with a package's published .d.ts (the
  // authoritative API surface — cont.89 blocker #1). Measured on that evidence, this function
  // extracted FOUR call-shaped APIs against a MIN_VOCAB of 4 — one fewer and the whole-answer
  // check would abstain and every fabrication would ship. The richest, most precise source of
  // API truth in the system was reading as almost no surface at all.
  for (const m of evidence.matchAll(/\b([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*:/g)) out.add(m[1])
  for (const k of NOT_AN_API) out.delete(k)
  return [...out].sort()
}

/** Does the evidence actually talk about this package at all? */
export function evidenceCovers(evidence: string, library: string): boolean {
  const esc = library.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\w@/-])${esc}([^\\w-]|$)`, 'i').test(evidence)
}

/**
 * Identifiers the answer's code DEFINES for itself — declarations, not uses.
 *
 * MEASURED LIVE (cont.89), the gaming vector this closes: asked for a Zod schema and given zod's
 * real .d.ts, the FM emitted
 *   export function ipv4(address: string): boolean { return /^(25[0-5]|…)$/.test(address) }
 * — a hand-rolled regex that never imports or touches zod. But `ipv4(` in its OWN declaration
 * matched the "calls a documented API" test, so the whole-answer check concluded "it used the
 * evidence" and ABSTAINED. The answer shipped in 11.9s with no repair.
 *
 * Naming your own function after the API you were told to use is not using it. Subtracting
 * definitions is what makes "called a documented API" mean what it says.
 */
function definedIdentifiers(code: string): Set<string> {
  const out = new Set<string>()
  for (const m of code.matchAll(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1])
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) out.add(m[1])
  // `foo(a) { … }` / `foo: (a) => …` — object-literal and class methods.
  for (const m of code.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/gm)) out.add(m[1])
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function\b|\([^()]*\)\s*=>)/g)) out.add(m[1])
  return out
}

/**
 * Identifiers the answer's code actually CALLS — `foo(` and `x.foo(`, normalized to bare names.
 * Identifiers the code DEFINES are excluded: a declaration is not a use (see definedIdentifiers).
 */
function calledIdentifiers(code: string): Set<string> {
  const out = new Set<string>()
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) out.add(m[1])
  // A member call (`z.ipv4()`, `s.parse()`) is always a real use, even if a local shares the
  // name — so re-admit anything that appears in member position before subtracting definitions.
  const memberCalled = new Set<string>()
  for (const m of code.matchAll(/\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) memberCalled.add(m[1])
  for (const d of definedIdentifiers(code)) if (!memberCalled.has(d)) out.delete(d)
  return out
}

/**
 * Is an imported binding actually TOUCHED — called (`z(`) or member-accessed (`z.`) — anywhere in
 * the code? This is what separates a real (if wrong) use of a library from a DECORATIVE import.
 *
 * Deliberately NOT a bare `\bname\b` scan: the measured gaming artifact destructures `string` and
 * then writes `type: 'string'`, so a plain word match reads a STRING LITERAL as use and un-catches
 * the very thing this exists for. Call/member position is the narrow, checkable signal for "this
 * name is being used AS the API".
 *
 * Under-counting here is the safe direction and is intentional: a miss means the decorative-import
 * check abstains, which is exactly what this file does with every ambiguity (cont.79h — a false
 * reject is the worse error).
 */
function bindingIsTouched(code: string, ids: string[]): boolean {
  return ids.some(id => {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`\\b${esc}\\s*[.(]`).test(code)
  })
}

/**
 * The WHOLE-ANSWER failure: code that ignores the retrieved API completely.
 *
 * Measured live (cont.82/83) and by far the most common fabrication: asked for a Zod schema,
 * given zod.dev evidence containing `z.ipv4();`, the FM cites [S1] and then emits a JSON-Schema
 * object with a hand-rolled regex. Per-identifier checks CANNOT see this — there is no bad
 * identifier, there is no import at all — so it slips through as `abstain`.
 *
 * The signal is the absence of any contact with the evidence: rich API docs were retrieved, the
 * answer contains real code, and that code imports nothing documented AND calls nothing
 * documented. It didn't misuse the API; it never touched it.
 *
 * Conservative by construction — every condition must hold, and ANY overlap (one documented
 * call) certifies. That asymmetry is deliberate: cont.79h says a false reject is the worse error.
 */
export function verifyEvidenceUsage(answer: string, evidence: string): FaithfulnessVerdict {
  const abstain = (reason: string): FaithfulnessVerdict =>
    ({ status: 'abstain', reason, violations: [], documented: [], callSurface: [] })

  const blocks = answerCodeBlocks(answer)
  if (!blocks.length) return abstain('no code blocks in the answer — nothing to check')
  const code = blocks.join('\n')
  // Trivial snippets (a one-line import, a bare value) are not an implementation to judge.
  if (code.trim().length < 60) return abstain('code too short to judge as an implementation')

  const surface = documentedCallSurface(evidence)
  // Without a rich API surface the evidence is prose or a stub, and "no overlap" means nothing.
  if (surface.length < MIN_VOCAB) return abstain(`evidence documents only ${surface.length} call-shaped APIs — not an authority`)

  // USE is a CALL, never an import. Any overlap certifies (the deliberate asymmetry: cont.79h says
  // a false reject is the worse error), so this runs first and settles the innocent cases.
  const called = calledIdentifiers(code)
  const overlap = surface.filter(s => called.has(s))
  if (overlap.length) return abstain(`answer calls documented APIs (${overlap.slice(0, 5).join(', ')}) — it used the evidence`)

  // Zero documented APIs are CALLED. An import only earns an abstain when it points AWAY from the
  // evidence — express code judged against zod docs is a retrieval mismatch, where "no overlap" is
  // the innocent, expected outcome and firing here would be a false reject (the bench caught that).
  //
  // An import of the library the evidence DOCUMENTS is not innocent (cont.86, MEASURED LIVE). This
  // check used to abstain on ANY import, reasoning that "JSON Schema substituted for the library
  // imports nothing at all". **The repair loop falsified that premise.** `escalatedRepairHint` hands
  // the model the documented surface, and the FM pastes the whole list into a decorative import —
  //   const { base64, cidrv4, cuid, email, ipv4, string, … } = require('zod')
  //   const ipv4Schema = { type: 'object', properties: { ip: { pattern: '^(25[0-5]|…' } } }
  // — satisfying "it imported the docs' library" while emitting the exact JSON-Schema-plus-regex
  // substitution this check exists to catch. Every identifier is documented, so the per-identifier
  // checks pass too, and the answer CERTIFIED: the hint taught the model to game the verifier, and
  // repair MANUFACTURED a false green badge out of an honest failure.
  //
  // Importing a name is not using it. Calling one is. Note the per-identifier checks already own the
  // adjacent case (imports the library, then calls an UNDOCUMENTED member → named-import /
  // namespace-member violation), so this fires only on the true gap: named the library, called
  // nothing on it.
  const imported = extractLibraryUsage(code)
  const foreign = imported.filter(l => !evidenceCovers(evidence, l.library))
  if (imported.length && foreign.length === imported.length)
    return abstain(`answer imports ${foreign.map(l => l.library).join(', ')}, which the evidence does not document — not judged as ignoring it`)

  // The documented library IS imported. Decorative means the binding is never touched — not merely
  // that no DOCUMENTED api was called. `import { z } from 'zod'; z.parseIPv4()` calls a fabricated
  // member: the code plainly used zod, it just used it WRONG, and the per-identifier checks own
  // that (they name the exact fabrication). Firing here would report "the import is decorative" for
  // code that demonstrably touched the library, and — because the repair hint is built from this
  // reason — would send repair to fix something the model did not do.
  const covered = imported.filter(l => evidenceCovers(evidence, l.library))
  const bindings = covered.flatMap(l => [...l.named.map(n => n.identifier), ...l.namespaces])
  if (bindings.length && bindingIsTouched(code, bindings))
    return abstain(`answer uses its ${covered.map(l => l.library).join(', ')} import — any misuse is the per-identifier check's to judge`)

  // Two distinct shapes reach here, and the repair hint is built from this reason — so it must say
  // which one, or the model is told to fix something it did not do.
  const decorative = imported.length > 0
  return {
    status: 'violations',
    reason: decorative
      ? `the answer's code imports ${imported.map(l => l.library).join(', ')} but CALLS none of the ${surface.length} APIs the retrieved docs document — the import is decorative; it ignored the evidence`
      : `the answer's code neither imports nor calls ANY of the ${surface.length} APIs the retrieved docs document — it ignored the evidence`,
    violations: [{
      library: 'the retrieved documentation',
      identifier: '(no documented API used)',
      kind: 'ignored-evidence',
      line: code.trim().split('\n')[0].slice(0, 100),
    }],
    documented: surface,
    callSurface: surface,
    library: 'the retrieved documentation',
  }
}

/**
 * Certify that every library identifier in `answer`'s code appears in `evidence`.
 *
 * Returns `abstain` — never `certified` — whenever we cannot be an authority: no code, no
 * provable library binding, evidence that never mentions the package, or a vocabulary too
 * thin to justify a rejection. Abstain means the caller ships the answer unchanged; only
 * `violations` should trigger repair.
 */
export function verifyApiFaithfulness(answer: string, evidence: string): FaithfulnessVerdict {
  const none = (reason: string): FaithfulnessVerdict =>
    ({ status: 'abstain', reason, violations: [], documented: [], callSurface: [] })

  const blocks = answerCodeBlocks(answer)
  if (!blocks.length) return none('no code blocks in the answer — nothing to check')

  const code = blocks.join('\n')
  const usage = extractLibraryUsage(code)
  // No import at all is not automatically innocent: the measured failure substitutes JSON Schema
  // for the library entirely. Hand off to the whole-answer check, which abstains unless the code
  // provably never touches the documented surface.
  if (!usage.length) return verifyEvidenceUsage(answer, evidence)

  const vocab = documentedIdentifiers(evidence)
  const surface = documentedCallSurface(evidence)
  const violations: ApiViolation[] = []
  let judged: string | undefined
  let documented: string[] = []
  const skipped: string[] = []

  for (const lib of usage) {
    if (!evidenceCovers(evidence, lib.library)) { skipped.push(`${lib.library} (evidence never mentions it)`); continue }
    if (vocab.size < MIN_VOCAB) { skipped.push(`${lib.library} (evidence documents only ${vocab.size} identifiers)`); continue }
    judged = lib.library
    documented = [...vocab].sort()

    for (const n of lib.named)
      if (!vocab.has(n.identifier))
        violations.push({ library: lib.library, identifier: n.identifier, kind: 'named-import', line: n.line })

    for (const d of lib.directMembers)
      if (!UNIVERSAL_MEMBERS.has(d.identifier) && !vocab.has(d.identifier))
        violations.push({ library: lib.library, identifier: d.identifier, kind: 'namespace-member', line: d.line })

    // Members read off a namespace binding: `z.ipv4()`.
    for (const ns of lib.namespaces) {
      const esc = ns.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      for (const m of code.matchAll(new RegExp(`\\b${esc}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g'))) {
        const id = m[1]
        if (UNIVERSAL_MEMBERS.has(id) || vocab.has(id)) continue
        const start = code.lastIndexOf('\n', m.index) + 1
        const end = code.indexOf('\n', m.index)
        violations.push({
          library: lib.library, identifier: id, kind: 'namespace-member',
          line: code.slice(start, end === -1 ? code.length : end).trim(),
        })
      }
    }
  }

  // Every import was un-judgeable (evidence silent on those packages). The answer may still have
  // ignored the documented API wholesale — that check gates itself and abstains when unsure.
  if (!judged) {
    const whole = verifyEvidenceUsage(answer, evidence)
    if (whole.status === 'violations') return whole
    return none(`no library could be judged against this evidence: ${skipped.join('; ') || 'none applicable'}`)
  }

  // Dedup — the same fabricated identifier used twice is one defect.
  const seen = new Set<string>()
  const unique = violations.filter(v => {
    const k = `${v.library}:${v.kind}:${v.identifier}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  if (!unique.length) {
    // PROVENANCE IS NECESSARY, NOT SUFFICIENT (cont.86). "Every identifier is documented" was the
    // whole certify condition, and this branch returned green WITHOUT ever consulting the
    // whole-answer check — that check only ran when there were no imports at all, or when no
    // library was judgeable. So the one shape it could never see was the one the repair loop
    // actually produces: import the documented library, call NOTHING on it, emit JSON Schema.
    // Fixing verifyEvidenceUsage alone would have been inert here — the composite is the gate.
    // Every name being real does not make the answer use the API; only a call does.
    const whole = verifyEvidenceUsage(answer, evidence)
    if (whole.status === 'violations') return whole
    return { status: 'certified', reason: `all ${judged} identifiers appear in the evidence`, violations: [], documented, callSurface: surface, library: judged }
  }

  return {
    status: 'violations',
    reason: `${unique.length} ${judged} identifier${unique.length > 1 ? 's do' : ' does'} not appear in the evidence: ${unique.map(v => v.identifier).join(', ')}`,
    violations: unique,
    documented,
    callSurface: surface,
    library: judged,
  }
}

/**
 * A short, human-readable phrase naming what went wrong — for live thoughts and the verify
 * badge. The two violation classes read completely differently to a user ("it used an API that
 * doesn't exist" vs "it ignored the docs entirely"), and the internal placeholder identifier
 * used by `ignored-evidence` must never reach the UI.
 */
export function describeViolations(v: FaithfulnessVerdict): string {
  if (v.status !== 'violations') return ''
  // Execution beats every claim about names: we RAN it and it broke.
  const exec = v.violations.filter(x => x.kind === 'execution-failure')
  if (exec.length)
    return `the code fails when actually run (${exec.map(x => x.line).join('; ')})`
  if (v.violations.some(x => x.kind === 'ignored-evidence'))
    return "the code doesn't use the documented API from the sources at all"
  const names = v.violations.map(x => `\`${x.identifier}\``).join(', ')
  return `${v.library} ${v.violations.length > 1 ? 'APIs' : 'API'} ${names} ${v.violations.length > 1 ? 'do' : 'does'} not appear in the retrieved docs`
}

/**
 * Every identifier a set of verdicts has ALREADY proven absent from the evidence. The
 * placeholder used by `ignored-evidence` is not a real identifier and never leaks out.
 */
export function rejectedIdentifiers(verdicts: FaithfulnessVerdict[]): string[] {
  const out = new Set<string>()
  for (const v of verdicts)
    for (const x of v.violations)
      // `ignored-evidence` uses a placeholder; `execution-failure` names the answer's OWN symbol
      // (`validateIpv4`), not a fabricated library API — telling the model "never use validateIpv4
      // again" would be nonsense. Neither is a rejected identifier.
      if (x.kind !== 'ignored-evidence' && x.kind !== 'execution-failure') out.add(x.identifier)
  return [...out].sort()
}

/**
 * The repair hint for attempt N>1: `repairHint` plus everything earlier attempts already
 * disproved. One retry with a hint is not search — the measured FM re-proposes a *different*
 * fabrication rather than copying the evidence, so each attempt must carry the accumulated
 * negative information or the loop just samples the same wrong distribution K times.
 *
 * `prior` is the attempts that FAILED before this one; `latest` is the verdict being repaired.
 * Both are verdicts of the same shape, so this composes with any future faithfulness check.
 */
export function escalatedRepairHint(latest: FaithfulnessVerdict, prior: FaithfulnessVerdict[]): string {
  const base = repairHint(latest)
  if (!base) return ''
  // Only names this attempt is not already being told about — repeating them wastes the hint.
  const already = rejectedIdentifiers(prior).filter(id => !latest.violations.some(v => v.identifier === id))
  if (!already.length && !prior.length) return base
  const lines = [base, '', `This is attempt ${prior.length + 2}. Previous attempts were rejected for the same reason.`]
  if (already.length)
    lines.push(
      `You have ALREADY tried these names and the evidence does not contain any of them: ${already.map(i => `\`${i}\``).join(', ')}.`,
      'Do not use them again, and do not invent another new name.',
    )
  lines.push('Copy the identifiers VERBATIM from the EVIDENCE block above. Do not rely on memory.')
  return lines.join('\n')
}

/**
 * Turn a rejection into a corrective instruction for the next proposal. Per types.ts, every
 * rejected candidate must return feedback rich enough to converge in a handful of calls —
 * so we name the fabricated identifier AND show the documented surface to choose from.
 */
export function repairHint(v: FaithfulnessVerdict): string {
  if (v.status !== 'violations') return ''

  // EXECUTION FAILURE — the strongest hint we can give, because it is not a claim about names:
  // we ran the code and the runtime rejected it. The old name-list hint is exactly what taught
  // the FM to game the verifier (cont.86b) — it could satisfy "use documented names" by pasting
  // them into a decorative import. A runtime error cannot be satisfied that way: the next
  // candidate is re-executed, so the only way through the gate is code that actually works.
  const exec = v.violations.filter(x => x.kind === 'execution-failure')
  if (exec.length) {
    const lines = exec.map(x => `  - ${x.identifier}: ${x.line}`)
    // Execution and the name check find DIFFERENT defects; when both fired, the hint must carry
    // both or it is less informative than the one it replaced.
    const fabricated = v.violations.filter(x => x.kind === 'named-import' || x.kind === 'namespace-member')
    return [
      'Your code was EXECUTED against the real library and it failed:',
      ...lines,
      ...(fabricated.length
        ? ['', `These identifiers do not exist in ${v.library ?? 'the library'} and are not in the evidence: ${fabricated.map(x => `\`${x.identifier}\``).join(', ')}`]
        : []),
      '',
      'This is a real error from actually running your code, not a style note. It means you built a',
      'plain object or a hand-rolled substitute and then called a method that does not exist on it.',
      '',
      `Use the real ${v.library ?? 'library'} API from the evidence, which the runtime does provide: ${(v.callSurface.length ? v.callSurface : v.documented).slice(0, 60).join(', ')}`,
      'Importing those names is NOT enough — the code must actually CALL them and use what they return.',
      'Your code will be executed again, so it must genuinely work.',
    ].join('\n')
  }

  // Whole-answer miss: the fix is not "rename an identifier", it is "use the documented library".
  if (v.violations.some(x => x.kind === 'ignored-evidence')) {
    return [
      'Your code does not use the API documented in the retrieved sources at all — it substitutes',
      'a different format or a hand-rolled implementation.',
      '',
      `Rewrite it using the documented API. The evidence documents these calls: ${v.callSurface.slice(0, 60).join(', ')}`,
      'Use those names exactly as the evidence writes them. Do not emit a different schema format,',
      'and do not hand-roll what the documented API already provides.',
    ].join('\n')
  }

  const lines = v.violations.map(x => `  - \`${x.identifier}\` (in: ${x.line}) — not in the evidence for ${x.library}`)
  // Offer the call-shaped surface, falling back to the raw vocabulary if the evidence had no
  // call-shaped occurrences. Capped: the point is a focused, high-information retry, not a dump.
  const pool = v.callSurface.length ? v.callSurface : v.documented
  const surface = pool.slice(0, 60).join(', ')
  return [
    `Your code uses ${v.library} APIs that the retrieved documentation does not contain:`,
    ...lines,
    '',
    `Rewrite the code using ONLY ${v.library} identifiers that appear in the evidence. The evidence documents: ${surface}`,
    'Do not invent API names, and do not substitute a hand-rolled implementation for a documented API.',
  ].join('\n')
}
