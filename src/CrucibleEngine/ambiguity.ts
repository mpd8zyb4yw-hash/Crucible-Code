// Tier 2.4 — Ambiguity resolution.
//
// The honest counterpart to abstention: before a node is synthesized, decide
// whether the request is actually pinned down. A request can fail to be actionable
// in distinct ways, and each is handled differently:
//
//   • unresolved-reference  — "fix THE parser": resolve against the semantic index.
//       exactly one match → auto-resolve (rewrite the goal to name it). Zero matches
//       → it refers to something absent. Many matches → genuinely ambiguous → ask.
//   • no-target             — nothing names a file or a resolvable symbol.
//   • vague-scope           — "improve", "clean up", "handle edge cases", "etc".
//   • underspecified-behavior — an imperative with no checkable success criterion.
//
// The output drives the router/DAG: a node that stays ambiguous after resolution
// routes to ABSTAIN with a clarifying question, instead of guessing. Auto-resolved
// references rewrite the goal so downstream stages get a concrete target.
//
// Pure + deterministic + no model. Resolution uses ONLY the Tier 1.2 semantic index.

import { type SemanticIndex, findSymbol } from './state/semanticIndex'

export type AmbiguityType = 'unresolved-reference' | 'no-target' | 'vague-scope' | 'underspecified-behavior'

export interface AmbiguitySignal {
  type: AmbiguityType
  detail: string
  /** 0-1 — how much this lowers actionability. */
  severity: number
  phrase?: string
  candidates?: string[]
}

export interface ResolvedReference { phrase: string; symbol: string; rel: string }

export interface ResolutionResult {
  ambiguous: boolean
  /** Overall clarity in [0,1]. < 0.6 ⇒ ambiguous (matches goalDecomposer's threshold). */
  confidence: number
  signals: AmbiguitySignal[]
  resolvedReferences: ResolvedReference[]
  /** Goal with auto-resolved references named, when resolution succeeded. */
  rewrittenGoal?: string
  /** A single question to surface when the request cannot be made actionable. */
  clarification?: string
  /** Plain-language MC options, when the clarification has a genuinely enumerable answer
   *  set (currently only unresolved-reference-with-candidates) — HITL_PLANNING_TRACK.md §3's
   *  "MC-first, one question at a time" interface, applied to data this module already
   *  computes. Absent (not empty) when the clarification is open-ended free text instead. */
  clarificationOptions?: string[]
  /** Which clarificationOptions entry to present as the visible recommended default, per
   *  §3 ("a recommended default always visible"). Always present when clarificationOptions is. */
  recommendedOption?: string
}

const VAGUE_TERMS = /\b(improve|optimi[sz]e|clean\s*up|refactor stuff|make (?:it )?better|handle (?:the )?edge cases|various|etc\.?|and so on|some stuff|things|somehow|nicer|tidy)\b/i
// "the/that/this <noun>" definite references that imply a specific existing thing.
const DEF_REF = /\b(?:the|that|this)\s+([a-zA-Z][a-zA-Z0-9_]{2,})\b/g
// Words that are definite-article nouns but never code symbols — skip them.
// 2026-07-06: found firing live on leaderboardModule's real spec text (5 false
// "unresolved-reference" signals, confidence 0.031, agent stopped after 0 iterations
// asking to clarify "the COMPLETE" — a pure prose-parsing false positive, not a genuine
// ambiguous request). Added 'exact'/'complete'/'ordering' (the specific words that fired)
// plus the bare articles/conjunctions themselves ('the'/'this'/'that'/'a'/'an'), which can
// get captured when one directly follows another in prose (e.g. "...confirms that the
// input..." — DEF_REF matches "that the", capturing "the" as if it were a noun).
const STOP_REFS = new Set([
  'code', 'file', 'files', 'function', 'method', 'class', 'project', 'repo', 'codebase',
  'system', 'app', 'application', 'user', 'users', 'data', 'issue', 'issues', 'bug', 'bugs',
  'problem', 'feature', 'test', 'tests', 'output', 'input', 'result', 'value', 'way', 'thing',
  'following', 'above', 'below', 'same', 'new', 'old', 'current', 'existing', 'right', 'whole',
  'exact', 'complete', 'ordering', 'the', 'this', 'that', 'a', 'an',
])
const FILE_TOKEN = /[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,5}/
// Common verbs/conjugations that show up right after "the/that/this" in ordinary prose
// (e.g. "...that returns true...", "...this is a pattern...") — never code symbols, so
// they'd otherwise be misread as unresolved-reference nouns.
const VERB_STOPLIST = new Set([
  'returns', 'return', 'returned', 'returning',
  'is', 'was', 'were', 'are', 'be', 'been', 'being',
  'has', 'have', 'had', 'having',
  'does', 'do', 'did', 'doing',
  'matches', 'match', 'matched', 'matching',
  'contains', 'contain', 'contained', 'containing',
  'equals', 'equal', 'equaled',
  'holds', 'hold', 'held', 'holding',
  'means', 'mean', 'meant',
  'implies', 'imply', 'implied',
  // 2026-07-06: found live on leaderboardModule's spec ("...that sorts a mixed list...") —
  // same recurring class as 'returns' above, just a different common verb this pattern
  // didn't happen to cover yet.
  'sorts', 'sort', 'sorted', 'sorting',
])

/** Does the goal pin down a concrete success criterion (a measurable/observable verb)? */
function hasCheckableCriterion(goal: string): boolean {
  return /\b(return|returns|equal|equals|throw|throws|match|matches|render|output|outputs|status|response|=|==|===|so that|such that|when .* then|add|create|remove|delete|rename|implement|parse|format|convert|sort|validate)\b/i.test(goal)
}

export function resolveAmbiguity(goal: string, opts: { index?: SemanticIndex } = {}): ResolutionResult {
  const signals: AmbiguitySignal[] = []
  const resolvedReferences: ResolvedReference[] = []
  let rewritten = goal
  let clarification: string | undefined
  let clarificationOptions: string[] | undefined
  let recommendedOption: string | undefined

  // ── 1. Definite references → resolve against the semantic index ─────────────────
  // Gated on whether the goal ALREADY names a concrete target file (2026-07-06, found via
  // a live task failure — see below). DEF_REF's whole purpose is catching the "fix THE
  // parser" shape: a request that refers to something via a definite article WITHOUT
  // giving any concrete target. Ordinary prose is saturated with other "the X" phrases
  // (rules, behavior descriptions, self-test instructions) that are never code references
  // — a hand-maintained stoplist can never keep up (this file already had 3 rounds of
  // stoplist patches for individual words — 'returns', then 'sorts'/'ordering'/'exact'/
  // 'complete' — and a live audit against ALL 9 of this repo's own benchmark specs still
  // found 6/9 falsely flagged ambiguous afterward: "the least", "the WAL", "the injected",
  // "the rolling", "the preceding", "the primary", "the calls", "the account", "the
  // credits", etc. — an unbounded surface, not a fixable finite list). The dominant
  // real-world case where more "the X" phrases exist in prose is EXACTLY the case where a
  // file/path has already been named — the "what to change" question is already answered,
  // so hunting for other supposedly-unresolved definite references in the surrounding
  // rules text is not adding real signal, only false positives. `namesAFile` is computed
  // early (was section 2) so this gate can use it; auto-resolution (single index match)
  // still runs unconditionally since it's purely additive/harmless goal enrichment, never
  // a source of a false "ambiguous" verdict.
  const namesAFile = FILE_TOKEN.test(goal)
  const refs: string[] = []
  let m: RegExpExecArray | null
  DEF_REF.lastIndex = 0
  while ((m = DEF_REF.exec(goal)) !== null) {
    const noun = m[1]
    const low = noun.toLowerCase()
    if (!STOP_REFS.has(low) && !VERB_STOPLIST.has(low)) refs.push(noun)
  }

  for (const ref of [...new Set(refs)]) {
    if (!opts.index) continue
    // Candidate symbols whose name contains the reference token (case-insensitive).
    const low = ref.toLowerCase()
    const candidates = new Map<string, string>()  // symbol → rel
    for (const f of opts.index.files) {
      for (const s of f.symbols) {
        if (s.name.toLowerCase().includes(low)) candidates.set(s.name, f.rel)
      }
    }
    const entries = [...candidates.entries()]
    if (entries.length === 1) {
      const [symbol, rel] = entries[0]
      resolvedReferences.push({ phrase: ref, symbol, rel })
      // Name it inline so downstream stages get a concrete target.
      rewritten = rewritten.replace(new RegExp(`\\b(the|that|this)\\s+${ref}\\b`, 'i'), `$1 ${ref} (\`${symbol}\` in ${rel})`)
    } else if (namesAFile) {
      continue // a concrete target is already named — don't flag ambiguity on prose nouns
    } else if (entries.length === 0) {
      signals.push({ type: 'unresolved-reference', phrase: ref, severity: 0.5,
        detail: `"the ${ref}" does not match any symbol in the codebase` })
    } else {
      signals.push({ type: 'unresolved-reference', phrase: ref, severity: 0.7,
        candidates: entries.slice(0, 6).map(([s, r]) => `${s} (${r})`),
        detail: `"the ${ref}" is ambiguous — ${entries.length} matching symbols` })
    }
  }

  // ── 2. No target at all ─────────────────────────────────────────────────────────
  if (!namesAFile && resolvedReferences.length === 0 && refs.length === 0) {
    signals.push({ type: 'no-target', severity: 0.4,
      detail: 'no target file or resolvable symbol named in the request' })
  }

  // ── 3. Vague scope ──────────────────────────────────────────────────────────────
  const vague = goal.match(VAGUE_TERMS)
  if (vague) {
    signals.push({ type: 'vague-scope', phrase: vague[0], severity: 0.35,
      detail: `vague scope term "${vague[0]}" — no concrete change described` })
  }

  // ── 4. Underspecified behavior ──────────────────────────────────────────────────
  if (!hasCheckableCriterion(goal)) {
    signals.push({ type: 'underspecified-behavior', severity: 0.3,
      detail: 'no checkable success criterion (expected output / behavior) stated' })
  }

  // ── Score + verdict ─────────────────────────────────────────────────────────────
  // Severities compound multiplicatively so several small issues still erode clarity.
  let confidence = 1
  for (const s of signals) confidence *= (1 - s.severity)
  confidence = +confidence.toFixed(3)
  const ambiguous = confidence < 0.6

  if (ambiguous) {
    const worst = [...signals].sort((a, b) => b.severity - a.severity)[0]
    clarification = phraseClarification(worst)
    if (worst.type === 'unresolved-reference' && worst.candidates?.length) {
      // The only signal with a genuinely enumerable answer set today — every other type
      // (no-target, vague-scope, underspecified-behavior) needs open-ended free text, so
      // deliberately don't force a fake MC list there (a wrong-shaped options list is worse
      // than none — same "don't guess" discipline as the rest of this module).
      clarificationOptions = [...worst.candidates, 'Something else / not sure']
      recommendedOption = worst.candidates[0]
    }
  }

  return {
    ambiguous,
    confidence,
    signals,
    resolvedReferences,
    rewrittenGoal: resolvedReferences.length && rewritten !== goal ? rewritten : undefined,
    clarification,
    clarificationOptions,
    recommendedOption,
  }
}

function phraseClarification(s: AmbiguitySignal): string {
  switch (s.type) {
    case 'unresolved-reference':
      return s.candidates?.length
        ? `Which "${s.phrase}" do you mean — ${s.candidates.join(', ')}?`
        : `I can't find "${s.phrase}" in the codebase — which file or symbol does it refer to?`
    case 'no-target':
      return 'Which file or symbol should this change target?'
    case 'vague-scope':
      return `What specifically should change? "${s.phrase}" is too broad to act on safely.`
    case 'underspecified-behavior':
      return 'What is the expected behavior or output after this change (so it can be verified)?'
  }
}
