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
import { registry } from './tools/registry'

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
// Closed-class function words (prepositions, pronouns, conjunctions, determiners,
// modals). Unlike the noun stoplist above — which its own history proves is an
// unbounded losing game — these are FINITE grammatical classes, so listing them is
// sound. Added 2026-07-07: "Build this for me: a snake game …" → DEF_REF matched
// "this for" and the agent stopped at 0 iterations asking the user which file "for"
// refers to. A preposition can never be a code reference; drop them all, permanently.
const FUNCTION_WORDS = new Set([
  'for', 'with', 'from', 'into', 'onto', 'over', 'under', 'about', 'above', 'below',
  'between', 'through', 'during', 'without', 'within', 'along', 'across', 'behind',
  'beyond', 'toward', 'towards', 'upon', 'off', 'out', 'and', 'or', 'but', 'nor',
  'because', 'since', 'unless', 'until', 'although', 'though', 'whether', 'while',
  'when', 'where', 'why', 'how', 'what', 'who', 'whom', 'whose', 'which',
  'me', 'you', 'him', 'her', 'them', 'us', 'it', 'its', 'my', 'your', 'our', 'their',
  'his', 'hers', 'theirs', 'mine', 'yours', 'ours', 'one', 'ones', 'once', 'now',
  'not', 'all', 'any', 'each', 'every', 'some', 'few', 'more', 'most', 'other',
  'another', 'such', 'only', 'own', 'too', 'very', 'just', 'also', 'then', 'than',
  'will', 'would', 'can', 'could', 'should', 'shall', 'may', 'might', 'must',
])
// Creation-shaped request: a build-from-scratch verb aimed at a NEW artifact
// ("build me a snake game", "create a landing page", "write a fully playable …").
// The header comment on the code-shape gate below already states the principle: a
// build-from-scratch request "can never be clarified by naming a file" — but until
// 2026-07-07 nothing actually implemented it, so creation asks were interrogated for
// unresolved references / missing targets they definitionally cannot have.
const CREATION_GOAL = /\b(build|create|make|write|code|program|generate|implement|scaffold|produce|design)\b[\s\S]{0,30}\b(me|us|a|an|new|from scratch)\b/i
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

// Every signal this gate can raise is about WHICH CODE to change ("which file or
// symbol…"). A goal that isn't code-shaped at all — a desktop action ("open finder and
// go to downloads"), a search, a message to send, or a build-from-scratch request in an
// empty workspace — can never be clarified by naming a file, so interrogating it here
// only kills valid tasks at 0 iterations (the cont.25 failure mode, seen again 2026-07-07
// via slash-shortcut goals). Gate on code-edit shape, not on every fresh goal.
const CODE_NOUN = /\b(code|file|files|function|class|method|module|test|tests|bug|error|variable|component|script|import|endpoint|api|parser|schema|query|type|interface|repo|branch|lint|compile|build)\b/i
const DESKTOP_ACTION = /^(open|close|launch|quit|play|pause|stop|resume|set|turn|toggle|enable|disable|show|hide|search|send|email|text|message|call|schedule|book|download|go|navigate|empty|organi[sz]e)\b/i

/** Desktop-action-shaped goal ("open finder and go to downloads") with no code nouns or
 *  file tokens. Shared by the ambiguity gate (skip the which-file interrogation) and the
 *  server's driver routing (prefer the on-device FM — online pool models refuse these). */
export function isDesktopActionGoal(goal: string): boolean {
  return DESKTOP_ACTION.test(goal.trim()) && !CODE_NOUN.test(goal) && !FILE_TOKEN.test(goal)
}

// ── The presupposition (2026-07-28) ────────────────────────────────────────────
// The paragraph above states the rule correctly — "gate on code-edit shape, not on every
// fresh goal" — but `isDesktopActionGoal` implemented it as an ANCHORED VERB ENUMERATION,
// so the rule only held for goals that happened to START with one of ~30 listed verbs.
// Measured on 14 ordinary non-code requests: 9 were interrogated for a file to change.
//
//   "take a screenshot of my screen"                 → "Which file or symbol…?"  (conf 0.42)
//   "sign me in to youtube"                          → "Which file or symbol…?"  (conf 0.42)
//   "every weekday at 8am summarise my inbox"        → "Which file or symbol…?"  (conf 0.42)
//   "check my email" / "what meetings do I have…"    → same
//
// Each returned that question with ZERO tool calls, which is what made `screenshot`,
// `browser_sign_in` and scheduling unreachable from chat: a registered, working tool behind
// an unanswerable question (the [[unreachable gate = dead feature]] rule). The five that did
// pass passed by ACCIDENT, not comprehension — "save example.com as a pdf" only cleared it
// because FILE_TOKEN matched the domain name.
//
// Widening the verb list is the banned move: it is an open semantic class, and this file's
// own history (three rounds of noun stoplist patches, then FUNCTION_WORDS) is the record of
// that losing game. So invert it. The signals below all answer ONE question — "which code
// should change?" — and a gate may only ask a question that HAS an answer. Fire on POSITIVE
// evidence that the goal edits this codebase; stay silent otherwise. Non-code goals are an
// unbounded class and are never enumerated; code-edit evidence is small and closed.
//
// Evidence, any one of which is sufficient:
//   1. it names a SOURCE FILE — a path with a real code/config extension. Deliberately
//      stricter than FILE_TOKEN, which counts "example.com" and "youtube.com" as files.
//   2. it names a code noun (CODE_NOUN — function, class, parser, endpoint, bug, …).
//   3. it resolves against the semantic index — the goal names a real symbol in THIS repo.
//   4. an edit verb acting on a bare demonstrative ("clean THIS up", "make IT faster"):
//      no target, but the thing being edited is anaphoric, so asking which file is exactly
//      the right question. This is the case that keeps vague CODE goals clarifying.

/** Source-file path, as opposed to FILE_TOKEN's "anything with a dot" (which matches domains). */
const SOURCE_FILE = /[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|json|md|css|scss|less|html|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|yml|yaml|toml|ini|sql|vue|svelte|graphql|proto|lock)\b/i
/**
 * Verbs denoting maintenance of code that already exists — the positive definition of this
 * analyzer's domain, not a list of exceptions.
 *
 * Deliberately EXCLUDES the generic CRUD verbs (add/remove/delete/change/update/modify).
 * They are the ones ordinary life shares with programming — "delete the downloads folder",
 * "update the calendar", "change the wallpaper" — and a code use of them almost always also
 * carries a CODE_NOUN ("remove the unused import", "update the parser"), which is caught above.
 * Including them bought nothing for code and misclassified real device requests.
 */
const EDIT_VERB = /\b(fix|debug|refactor|rewrite|reimplement|optimi[sz]e|clean|tidy|simplify|rename|extract|inline|migrate|port|patch|revert|improve|speed|make)\b/i
/** A bare anaphor — the edit target named only by pointing at it. */
const ANAPHOR = /\b(it|this|that|these|those)\b/i

/** Definite references ("the parser") with the prose false-positive classes stripped. Shared
 *  by the jurisdiction test and the resolution loop so the two can never drift apart. */
function definiteReferences(goal: string): string[] {
  const refs: string[] = []
  let m: RegExpExecArray | null
  DEF_REF.lastIndex = 0
  while ((m = DEF_REF.exec(goal)) !== null) {
    const noun = m[1]
    const low = noun.toLowerCase()
    // Registered tool names ("prefer the control_mac tool") are always-resolvable
    // references — they name a live capability, not a codebase symbol to hunt for.
    if (!STOP_REFS.has(low) && !VERB_STOPLIST.has(low) && !FUNCTION_WORDS.has(low) && !registry.get(noun)) refs.push(noun)
  }
  return refs
}

/**
 * Does this goal actually propose editing THIS codebase?
 *
 * The precondition for every signal `resolveAmbiguity` raises. False for the whole open class
 * of non-code requests (device actions, personal data, web reads, scheduling, questions),
 * which is why it is defined by positive code evidence rather than by listing them.
 */
export function isCodeEditGoal(goal: string, index?: SemanticIndex): boolean {
  if (SOURCE_FILE.test(goal) || CODE_NOUN.test(goal)) return true
  // VAGUE_TERMS is already, by construction, the vocabulary of vague code maintenance
  // ("improve", "optimise", "clean up", "handle the edge cases"). A goal built out of it is a
  // code goal that has not said what to change — precisely what this gate exists to catch.
  if (VAGUE_TERMS.test(goal)) return true
  // A symbol that genuinely exists in this repo is unambiguous evidence of a code goal.
  if (index?.files.length) {
    const named = new Set((goal.match(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g) ?? []).map(w => w.toLowerCase()))
    for (const f of index.files) {
      for (const s of f.symbols) if (named.has(s.name.toLowerCase())) return true
    }
  }
  // An edit verb whose target is named only by pointing — "clean THIS up", "fix THE tokenizer".
  // No concrete target, but the thing being edited is anaphoric, so "which file or symbol?" is
  // exactly the right question. This is the branch that keeps vague CODE goals clarifying.
  return EDIT_VERB.test(goal) && (ANAPHOR.test(goal) || definiteReferences(goal).length > 0)
}

export function resolveAmbiguity(goal: string, opts: { index?: SemanticIndex } = {}): ResolutionResult {
  const signals: AmbiguitySignal[] = []
  const resolvedReferences: ResolvedReference[] = []
  // A goal this analyzer has no jurisdiction over leaves with a clean bill of health, so the
  // agent loop proceeds to its tools instead of stopping at 0 iterations to ask which file a
  // screenshot should target. `isDesktopActionGoal` is subsumed by this (a desktop action has
  // no code evidence) but stays exported — server.ts uses it for driver/GUI-tool routing.
  if (!isCodeEditGoal(goal, opts.index)) {
    return { ambiguous: false, confidence: 1, signals, resolvedReferences }
  }
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
  // Two more structural bypasses for the which-file interrogation (2026-07-07, both from
  // the live "Build this for me: a snake game" failure — agent finished in 0.0s asking
  // which file "for" refers to):
  //   • creationShaped — the goal asks to CREATE a new artifact; there is no existing
  //     code for a definite reference to be ambiguous against, and "which file or
  //     symbol?" is definitionally unanswerable.
  //   • emptyIndex — the semantic index has no files (fresh/empty workspace); every
  //     lookup would return 0 candidates and every prose noun would flag as an
  //     unresolved reference. Zero code means zero resolvable references, not an
  //     infinitely ambiguous request.
  // Auto-resolution below still runs when the index has content (purely additive);
  // only the false-"ambiguous" SIGNALS are skipped.
  const creationShaped = CREATION_GOAL.test(goal)
  const emptyIndex = !opts.index || opts.index.files.length === 0
  const refs = definiteReferences(goal)

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
    } else if (namesAFile || creationShaped || emptyIndex) {
      continue // concrete target named / creating something new / nothing indexed to
               // reference — don't flag ambiguity on prose nouns
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
  // Creation-shaped goals are exempt: "build me a snake game" has no target file BY
  // DESIGN — the deliverable is new. Flagging it here scored real build requests as
  // ambiguous (0.4 × 0.3 underspecified compounded to confidence 0.42 < 0.6 → the agent
  // stopped at 0 iterations asking "Which file or symbol should this change target?").
  if (!namesAFile && !creationShaped && resolvedReferences.length === 0 && refs.length === 0) {
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
