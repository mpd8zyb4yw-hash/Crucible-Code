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
}

const VAGUE_TERMS = /\b(improve|optimi[sz]e|clean\s*up|refactor stuff|make (?:it )?better|handle (?:the )?edge cases|various|etc\.?|and so on|some stuff|things|somehow|nicer|tidy)\b/i
// "the/that/this <noun>" definite references that imply a specific existing thing.
const DEF_REF = /\b(?:the|that|this)\s+([a-zA-Z][a-zA-Z0-9_]{2,})\b/g
// Words that are definite-article nouns but never code symbols — skip them.
const STOP_REFS = new Set([
  'code', 'file', 'files', 'function', 'method', 'class', 'project', 'repo', 'codebase',
  'system', 'app', 'application', 'user', 'users', 'data', 'issue', 'issues', 'bug', 'bugs',
  'problem', 'feature', 'test', 'tests', 'output', 'input', 'result', 'value', 'way', 'thing',
  'following', 'above', 'below', 'same', 'new', 'old', 'current', 'existing', 'right', 'whole',
])
const FILE_TOKEN = /[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,5}/

/** Does the goal pin down a concrete success criterion (a measurable/observable verb)? */
function hasCheckableCriterion(goal: string): boolean {
  return /\b(return|returns|equal|equals|throw|throws|match|matches|render|output|outputs|status|response|=|==|===|so that|such that|when .* then|add|create|remove|delete|rename|implement|parse|format|convert|sort|validate)\b/i.test(goal)
}

export function resolveAmbiguity(goal: string, opts: { index?: SemanticIndex } = {}): ResolutionResult {
  const signals: AmbiguitySignal[] = []
  const resolvedReferences: ResolvedReference[] = []
  let rewritten = goal
  let clarification: string | undefined

  // ── 1. Definite references → resolve against the semantic index ─────────────────
  const refs: string[] = []
  let m: RegExpExecArray | null
  DEF_REF.lastIndex = 0
  while ((m = DEF_REF.exec(goal)) !== null) {
    const noun = m[1]
    if (!STOP_REFS.has(noun.toLowerCase())) refs.push(noun)
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
  const namesAFile = FILE_TOKEN.test(goal)
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
  }

  return {
    ambiguous,
    confidence,
    signals,
    resolvedReferences,
    rewrittenGoal: resolvedReferences.length && rewritten !== goal ? rewritten : undefined,
    clarification,
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
