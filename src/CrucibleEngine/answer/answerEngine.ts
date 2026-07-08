// The answer engine — one Q&A brain where the SYSTEM does the thinking and the FM is the
// messenger. Deterministic control flow (no model decides routing): classify facets → gather
// grounding (retrieval / compute) → draft with a depth-appropriate prompt → CHECK with
// deterministic critics → repair-or-abstain → return. Replaces the bare-FM "answer in 1-3
// sentences" bypass that shipped raw, unverified, throttled FM text.
//
// Strict-offline throughout: the only model is the local Apple FM (via fmComplete); retrieval
// is Crucible's own direct-https tooling. There is NO escalation to an external/paid model —
// when the checks can't be satisfied, the engine ABSTAINS honestly (mission: abstain≡abstain).
//
// Stage 1 (this file): single-call path — classify, optional retrieval grounding, depth-scaled
// draft, arithmetic + sanity critics, one bounded repair round, else abstain. Stages 2-4 add
// multi-step decomposition, grounding entailment, and the capabilityRouter facet classifier.

import { checkFmAvailable, fmComplete, type ConvTurn } from '../agent/fmReact'
import { solveNonCodeTurn } from '../agent/synthDriver'
import { debugBus } from '../debug/bus'
import { critiqueAnswer, type Issue } from './verify'

export type AnswerIntent = 'lookup' | 'explain' | 'reason' | 'converse'

export interface AnswerFacets {
  needsExternalFact: boolean
  needsComputation: boolean
  needsMultiStep: boolean
  isCode: boolean
  intent: AnswerIntent
}

export interface AnswerResult {
  text: string
  /** True when the answer passed all critics (possibly after in-place fix / one repair). */
  verified: boolean
  /** True when the engine could not produce a checkable answer and refused honestly. */
  abstained: boolean
  facets: AnswerFacets
  usedRetrieval: boolean
  sources: string[]
  corrections: number
  repaired: boolean
}

export interface AnswerOpts {
  history?: ConvTurn[]
  /** Progress sink — the engine emits {type:'thought'|'verify'} lines for the SSE stream. */
  emit?: (event: Record<string, unknown>) => void
  signal?: AbortSignal
}

// ── Facet classification (Stage 1 heuristic; Stage 4 swaps in capabilityRouter.classify) ──
// Deliberately conservative on needsExternalFact — retrieval adds latency, so it fires only on
// clear external-fact cues (named entities / recency / lookups), never on conceptual asks the
// FM answers from parametric knowledge.

const CODE_GEN = /\b(write|create|build|implement|generate|refactor|debug|optimi[sz]e|fix|convert|rewrite|complete|port|translate)\b[^.?!]{0,60}\b(function|method|class|program|script|code|regex|query|algorithm|component|endpoint|api|module|snippet|loop|version|one-?liner)\b/i
const CODE_FENCE = /```|\bdef\s+\w+\s*\(|\bclass\s+\w+|=>|\bfunction\s+\w+\s*\(|\bimport\s+\w+|\bconst\s+\w+\s*=/
const LANG = /\b(python|javascript|typescript|java|c\+\+|c#|rust|go(?:lang)?|ruby|php|swift|kotlin|bash|shell|sql|html|css|react|node)\b/i
const CODE_CONSTRUCT = /\b(function|method|class|code|script|program|lambda|closure|list|dict|array|tuple|regex|query|loop|sort|filter|parse|complexity|recursion|iterate)\b/i

// Retrieval fires only for VOLATILE / recency-sensitive facts the FM cannot reliably know from
// parametric memory (live prices, current events, "latest/newest", today's weather/score). It
// deliberately does NOT match timeless facts (capitals, populations, definitions) — the FM
// answers those cleanly and directly, and routing them through the research DAG both slows the
// turn and, empirically, garbles trivial answers. Stage 3 will harden DAG grounding quality.
const EXTERNAL_FACT = /\b(latest|current(ly)?|todays?|tonight|right now|this (week|month|year)|recent(ly)?|news|headline|prices?|stock|shares?|market|weather|forecast|temperature|scores?|who won|standings?|release date|released|newest|as of|up to date|nowadays)\b/i
const MULTISTEP = /\b(and then|first[, ]|then |after that|finally|step by step|as well as)\b|.*\?.*\?/i
const REASON = /\b(if\b[^?]*\b(then|will|would|does)|how (long|far|fast|many|much) (until|before|would|will|does|do)|calculate|solve|prove|derive|catch up|how old|what time|percentage|ratio|average|per (hour|day|week|minute|second)|mph|km\/h)\b/i
const EXPLAIN = /\b(explain|how (does|do|to)|describe|what (is|are) (a |an |the )?[a-z]|why (does|do|is|are)|walk me through|tell me about|difference between|compare|pros and cons|trade-?offs?)\b/i
const NUMERIC = /\d/

export function classifyFacets(message: string): AnswerFacets {
  const m = message ?? ''
  const isCode = CODE_GEN.test(m) || CODE_FENCE.test(m) || (LANG.test(m) && CODE_CONSTRUCT.test(m))
  const needsComputation = !isCode && NUMERIC.test(m) && REASON.test(m)
  // A computation-bearing reasoning question with two or more quantities is inherently
  // multi-step (relate the quantities → compute → conclude), even without an explicit "and
  // then". This is the signal Stage 2 uses to decompose + oracle-check each step.
  const multiQuantity = (m.match(/\d+(?:\.\d+)?/g) || []).length >= 2
  const needsMultiStep = !isCode && (MULTISTEP.test(m) || (needsComputation && (/\band\b/i.test(m) || multiQuantity)))
  const needsExternalFact = !isCode && EXTERNAL_FACT.test(m)

  let intent: AnswerIntent
  if (isCode) intent = 'reason'
  else if (needsComputation || REASON.test(m)) intent = 'reason'
  else if (EXPLAIN.test(m)) intent = 'explain'
  else if (/^\s*(what|who|when|where|which|name|list|define|how (many|much|old|tall|far))\b/i.test(m)) intent = 'lookup'
  else intent = 'converse'

  return { needsExternalFact, needsComputation, needsMultiStep, isCode, intent }
}

// ── Depth-scaled system prompt — replaces the blanket "answer in 1-3 sentences" throttle. ──
// The point of the mission: the SYSTEM decides how much thinking a question needs; the FM
// isn't gagged into a wrong one-liner on a reasoning problem, nor made verbose on a lookup.

function systemPromptFor(facets: AnswerFacets, evidence: string): string {
  const base = 'You are Crucible, an expert assistant. Be accurate above all — if you are not sure, say so plainly rather than guessing.'
  const grounding = evidence
    ? `\n\n## Retrieved evidence (ground your answer in THIS; do not contradict it)\n${evidence}`
    : ''
  switch (facets.intent) {
    case 'reason':
      return `${base}\n\nThink through this step by step. Show each calculation or logical step explicitly. Re-check any arithmetic. State the final answer clearly on its own line at the end, prefixed with "Answer:".${grounding}`
    case 'explain':
      return `${base}\n\nGive a clear, thorough explanation. Build intuition first, then detail; include a concrete example. Use markdown structure where it helps. Do not pad — every sentence should add information.${grounding}`
    case 'lookup':
      return `${base}\n\nAnswer directly and concisely (1-3 sentences). Do not add unrequested detail.${grounding}`
    default:
      return `${base}\n\nAnswer helpfully and naturally at a length that fits the question.${grounding}`
  }
}

function historyToMessages(history?: ConvTurn[]): Array<{ role: string; content: string }> {
  if (!Array.isArray(history)) return []
  return history.flatMap(h => [
    { role: 'user', content: h.user },
    { role: 'assistant', content: h.assistant },
  ])
}

const ABSTAIN_TEXT =
  "I can't answer this reliably offline right now — the on-device model is unavailable, and strict mode never falls back to an external model. Try again in a moment."

/**
 * Answer one query through the verification-gated single-call path.
 * Never throws; on unrecoverable failure returns an honest abstention.
 */
export async function answerQuery(message: string, opts: AnswerOpts = {}): Promise<AnswerResult> {
  const { history, emit, signal } = opts
  const facets = classifyFacets(message)
  const base: Omit<AnswerResult, 'text' | 'verified' | 'abstained'> = {
    facets, usedRetrieval: false, sources: [], corrections: 0, repaired: false,
  }
  debugBus.emit('pipeline', 'facets', { message: message.slice(0, 80), ...facets }, { severity: 'info' })

  if (!(await checkFmAvailable())) {
    return { text: ABSTAIN_TEXT, verified: false, abstained: true, ...base }
  }

  if (signal?.aborted) return { text: ABSTAIN_TEXT, verified: false, abstained: true, ...base }

  // ── Draft: the FM is the messenger; the SYSTEM chose how to think ──────────
  // A genuine external-fact question is handed to the retrieval/tool brain (research DAG →
  // FM ReAct → FM direct). Everything else (reasoning, explanation, lookup, chat) gets a
  // single depth-controlled FM call — NOT web-retrieved, because there is no external fact to
  // fetch (a math word problem or a concept explanation is answered from reasoning, not search).
  const sys = systemPromptFor(facets, '')
  const usedRetrieval = facets.needsExternalFact
  let draft = ''
  try {
    if (usedRetrieval) {
      emit?.({ type: 'thought', text: 'Researching with retrieval + tools…' })
      draft = (await solveNonCodeTurn(message, undefined, Array.isArray(history) ? history.slice(-6) : undefined)).trim()
    } else {
      const msgs = [{ role: 'system', content: sys }, ...historyToMessages(history), { role: 'user', content: message }]
      draft = (await fmComplete(msgs)).trim()
    }
  } catch {
    draft = ''
  }

  if (!draft) {
    return { text: ABSTAIN_TEXT, verified: false, abstained: true, ...base, usedRetrieval }
  }

  // ── Check with deterministic critics ───────────────────────────────────────
  let { text, issues } = critiqueAnswer(draft, message)
  let corrections = issues.filter(i => i.kind === 'arithmetic').length
  let repaired = false

  // Issues that were fixed in place (arithmetic splice) need no re-prompt. Issues that need
  // the model to redo work (empty/truncated/nonanswer) get ONE bounded repair round.
  const needsReprompt = issues.filter(i => !i.fixedText)
  if (needsReprompt.length) {
    emit?.({ type: 'verify', passed: false, report: needsReprompt.map(i => i.detail).join(' ') })
    const directive = buildRepairDirective(needsReprompt)
    const repairMsgs = [
      { role: 'system', content: sys },
      ...historyToMessages(history),
      { role: 'user', content: message },
      { role: 'assistant', content: draft },
      { role: 'user', content: directive },
    ]
    const retry = (await fmComplete(repairMsgs)).trim()
    if (retry) {
      const second = critiqueAnswer(retry, message)
      // Accept the repair only if it removed the re-promptable issues; else keep the better draft.
      const stillBroken = second.issues.filter(i => !i.fixedText)
      if (stillBroken.length < needsReprompt.length) {
        text = second.text
        issues = second.issues
        corrections += second.issues.filter(i => i.kind === 'arithmetic').length
        repaired = true
      }
    }
    // Still fundamentally broken (empty / non-answer) after the repair → abstain honestly.
    const fatal = issues.filter(i => i.kind === 'empty' || i.kind === 'nonanswer')
    if (fatal.length) {
      debugBus.emit('pipeline', 'abstain_after_repair', { message: message.slice(0, 80), issues: fatal.map(i => i.kind) }, { severity: 'warn' })
      return { text: ABSTAIN_TEXT, verified: false, abstained: true, ...base, usedRetrieval, corrections, repaired }
    }
  }

  if (corrections) emit?.({ type: 'verify', passed: true, report: `Corrected ${corrections} arithmetic error(s) with the deterministic oracle.` })

  debugBus.emit('pipeline', 'answered', {
    message: message.slice(0, 80), intent: facets.intent, usedRetrieval, corrections, repaired, len: text.length,
  }, { severity: 'info' })

  return {
    text, verified: true, abstained: false, ...base,
    usedRetrieval, corrections, repaired,
  }
}

function buildRepairDirective(issues: Issue[]): string {
  const parts = issues.map(i => {
    switch (i.kind) {
      case 'empty': return 'Your reply was empty. Provide a complete answer to the question.'
      case 'truncated': return 'Your reply was cut off. Provide the complete answer, finishing every sentence.'
      case 'nonanswer': return 'You acknowledged the request but did not answer it. Give the actual answer now.'
      default: return i.detail
    }
  })
  return `Revise your previous answer. ${parts.join(' ')} Return only the corrected answer.`
}
