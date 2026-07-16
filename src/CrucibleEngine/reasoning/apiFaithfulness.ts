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
   */
  kind: 'named-import' | 'namespace-member' | 'ignored-evidence'
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
 */
export function documentedIdentifiers(evidence: string): Set<string> {
  const vocab = new Set<string>()
  const add = (s: string | undefined) => { if (s && s.length > 1) vocab.add(s) }

  // called: `foo(` and `z.foo(`  → records `foo`
  for (const m of evidence.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) add(m[1])
  // member access: `.foo` → records `foo`
  for (const m of evidence.matchAll(/\.\s*([A-Za-z_$][\w$]*)/g)) add(m[1])
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
export function documentedCallSurface(evidence: string): string[] {
  const out = new Set<string>()
  for (const m of evidence.matchAll(/\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) out.add(m[1])
  for (const m of evidence.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)/g)) out.add(m[1])
  return [...out].sort()
}

/** Does the evidence actually talk about this package at all? */
function evidenceCovers(evidence: string, library: string): boolean {
  const esc = library.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\w@/-])${esc}([^\\w-]|$)`, 'i').test(evidence)
}

/** Identifiers the answer's code actually CALLS — `foo(` and `x.foo(`, normalized to bare names. */
function calledIdentifiers(code: string): Set<string> {
  const out = new Set<string>()
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) out.add(m[1])
  return out
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

  // ANY import at all disqualifies this check.
  //   • imports a DOCUMENTED library → the per-identifier checks own it, not this one.
  //   • imports an UNDOCUMENTED library → the evidence is about something else (a retrieval
  //     mismatch, e.g. express code judged against zod docs). "No overlap" is then the expected,
  //     innocent outcome, and firing here would be a false reject — the bench caught exactly this.
  // The measured failure this check exists for — JSON Schema substituted for the library —
  // imports nothing at all, so restricting to import-free code keeps the catch and drops the risk.
  const imported = extractLibraryUsage(code)
  if (imported.length)
    return abstain(`answer imports ${imported.map(l => l.library).join(', ')} — not judged as ignoring the evidence`)

  const called = calledIdentifiers(code)
  const overlap = surface.filter(s => called.has(s))
  if (overlap.length) return abstain(`answer calls documented APIs (${overlap.slice(0, 5).join(', ')}) — it used the evidence`)

  return {
    status: 'violations',
    reason: `the answer's code neither imports nor calls ANY of the ${surface.length} APIs the retrieved docs document — it ignored the evidence`,
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

  if (!unique.length)
    return { status: 'certified', reason: `all ${judged} identifiers appear in the evidence`, violations: [], documented, callSurface: surface, library: judged }

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
      if (x.kind !== 'ignored-evidence') out.add(x.identifier)
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
