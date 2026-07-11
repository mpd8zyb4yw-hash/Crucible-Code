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
import { solveByConsensus } from './selfConsistency'
import { applyRecomputation, recomputeMultiStep, recomputeWordProblem } from './wordProblem'
import { applyDateRecomputation, isDateQuestion, recomputeDate } from './dateTime'
import { checkConstraints } from './constraints'
import { corroborateFact, UNVERIFIED_NOTE, type FactConsensus } from './factConsensus'

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
// A quantitative ASK that REASON misses — discount/percent/money math and "what is the <quantity>"
// questions. Gated by NUMERIC below, so it never fires without numbers to compute over. This is
// what routes an arithmetic question into deterministic recomputation instead of a raw FM guess.
const COMPUTE_ASK = /(\d\s*%|\bpercent\b|\bdiscount(ed)?\b|\bsales? tax\b|\btip\b|\bsale price\b|\btotal (cost|price|amount|of)\b|\bhow much (is|are|does|do|will|would|much|in total)\b|\bwhat(?:'| i)?s?\s+the\s+(total|sum|product|difference|area|perimeter|average|mean|cost|price|result|remainder)\b)/i
const EXPLAIN = /\b(explain|how (does|do|to)|describe|what (is|are) (a |an |the )?[a-z]|why (does|do|is|are)|walk me through|tell me about|difference between|compare|pros and cons|trade-?offs?)\b/i
const NUMERIC = /\d/

export function classifyFacets(message: string): AnswerFacets {
  const m = message ?? ''
  const isCode = CODE_GEN.test(m) || CODE_FENCE.test(m) || (LANG.test(m) && CODE_CONSTRUCT.test(m))
  // A computation-bearing question that STATES two or more quantities is inherently multi-step
  // (relate → compute → conclude); it is also the signal that disambiguates a self-contained math
  // problem from a volatile lookup that merely shares a word like "price".
  const multiQuantity = (m.match(/\d+(?:\.\d+)?/g) || []).length >= 2
  const extFactRaw = !isCode && EXTERNAL_FACT.test(m)
  // Computation wins over external-fact ONLY when the question supplies its own operands (≥2
  // numbers): "shirt costs $40, discounted 25%, sale price?" is arithmetic, while "price of a
  // Tesla Model 3?" (one incidental digit) is a volatile lookup. A single-number arithmetic ask
  // still counts when it isn't an external-fact lookup at all.
  const needsComputation = !isCode && NUMERIC.test(m) && (REASON.test(m) || COMPUTE_ASK.test(m)) && (multiQuantity || !extFactRaw)
  // A self-contained math problem is not a retrieval, even if it shares a volatile-fact keyword.
  const needsExternalFact = extFactRaw && !needsComputation
  const needsMultiStep = !isCode && (MULTISTEP.test(m) || (needsComputation && (/\band\b/i.test(m) || multiQuantity)))

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
  // Multi-step reasoning that the FM must derive (not retrieve) is where a single pass ships a
  // confident wrong answer. Route it through verified self-consistency: the SYSTEM samples many
  // derivations, oracle-corrects each, and takes the majority vote. Pure lookups/explanations/
  // single-step asks stay a single depth-controlled call.
  const useConsensus = !usedRetrieval && !facets.isCode && facets.needsMultiStep && facets.needsComputation
  let draft = ''
  let consensusAgreement: number | null = null
  try {
    if (usedRetrieval) {
      emit?.({ type: 'thought', text: 'Researching with retrieval + tools…' })
      draft = (await solveNonCodeTurn(message, undefined, Array.isArray(history) ? history.slice(-6) : undefined)).trim()
    } else if (useConsensus) {
      const c = await solveByConsensus(message, sys, historyToMessages(history), emit)
      draft = c.text.trim()
      consensusAgreement = c.agreement
      if (draft) {
        emit?.({ type: 'verify', passed: c.agreement >= 0.5, report: `Self-consistency: ${Math.round(c.agreement * 100)}% of ${c.samples} independent derivations agreed on the answer.` })
      }
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

  // ── Word-problem recomputation (VGR for answers) ───────────────────────────
  // For a computation question, separate the SETUP (model) from the ARITHMETIC (machine): the
  // model translates the problem into an expression, the machine evaluates it, and a quorum of
  // independent extractions must agree. This catches a WRONG bare answer that no in-text
  // arithmetic critic can see (nothing was written as an equation). Only fires on non-retrieval
  // computation questions; abstains silently (keeps the draft) when no quorum forms.
  let recomputed = false

  // ── Calendar recomputation — date/weekday/days-between questions don't reduce to a numeric
  // expression, so they get their own deterministic calendar evaluator (dateTime.ts): the model
  // proposes the setup, UTC date math computes the result, a quorum certifies it.
  if (isDateQuestion(message) && !usedRetrieval && !signal?.aborted) {
    try {
      const recomp = await recomputeDate(message)
      if (recomp) {
        const rec = applyDateRecomputation(text, recomp)
        recomputed = true
        if (rec.corrected) {
          text = rec.text
          corrections += 1
          emit?.({ type: 'verify', passed: true, report: `Machine calendar computation: ${recomp.setup} → ${recomp.result} (${recomp.samples} independent setups, ${Math.round(recomp.agreement * 100)}% agreed). Appended the verified answer.` })
        } else {
          emit?.({ type: 'verify', passed: true, report: `Verified the date answer by independent calendar recomputation: ${recomp.result} (${recomp.samples} setups agreed).` })
        }
        issues = issues.filter(i => i.kind !== 'truncated')
      }
    } catch { /* non-blocking */ }
  } else if (facets.needsComputation && !usedRetrieval && !signal?.aborted) {
    try {
      // Try the single-expression extractor FIRST — it is fast (~3s) and, because the model can
      // nest ("120 - (3/4 * 120) - 15"), it already covers most compound problems. Only when it
      // can't form a quorum AND the question is multi-step do we pay for the richer (slower) step-
      // DAG setup, which handles the genuinely irreducible cases (relative speed, head start).
      let recomp = await recomputeWordProblem(message)
        ?? (facets.needsMultiStep ? await recomputeMultiStep(message) : null)
      // Constraint gate: a quorum value that violates a constraint the QUESTION itself imposes
      // (asked unit, percent/probability range, count integrality, part-of-whole) means the
      // SETUP was wrong across samples — the documented honest limit of recomputation. Reject
      // it: never stamp "machine-verified" on a value the question's own constraints refute.
      if (recomp) {
        const violations = checkConstraints(message, recomp.value, recomp.unit)
        if (violations.length) {
          emit?.({ type: 'verify', passed: false, report: `Rejected the recomputed value ${recomp.value}: ${violations.map(v => v.detail).join(' ')}` })
          debugBus.emit('pipeline', 'recomputation_rejected', { message: message.slice(0, 80), value: recomp.value, violations: violations.map(v => v.kind) }, { severity: 'warn' })
          recomp = null
        }
      }
      const rec = recomp ? applyRecomputation(text, recomp) : null
      if (recomp && rec && !rec.guarded) {
        if (rec.corrected) {
          text = rec.text
          corrections += 1
          recomputed = true
          emit?.({ type: 'verify', passed: true, report: `Recomputed the answer deterministically: ${recomp.expression} = ${formatRecomp(recomp)} (${recomp.samples} independent setups, ${Math.round(recomp.agreement * 100)}% agreed). Corrected a mismatched stated value.` })
        } else if (rec.confirmed) {
          recomputed = true
          emit?.({ type: 'verify', passed: true, report: `Verified the answer by independent recomputation: ${recomp.expression} = ${formatRecomp(recomp)} (${recomp.samples} setups agreed).` })
        } else {
          text = rec.text // draft stated no number; appended an explicit machine-computed Answer.
          recomputed = true
        }
        // The MACHINE (not the shown work) certifies the value, so a verbose/truncated derivation no
        // longer matters: guarantee the verified answer is stated cleanly at the very end, and drop any
        // 'truncated' flag — the answer is now complete and correct regardless of where the prose stopped.
        if (recomputed) {
          text = ensureTrailingAnswer(text, recomp)
          issues = issues.filter(i => i.kind !== 'truncated')
        }
      }
    } catch { /* non-blocking: keep the critic-checked draft */ }
  }

  // ── Short-factual self-consistency — the last unverified lane. A lookup answered from
  // parametric memory gets K independent resamples (+ any installed non-FM ensemble voters);
  // a quorum on the key claim stamps it verified, no quorum ships it with an explicit
  // unverified note. Gated off with CRUCIBLE_FACT_SC=0 (adds ~2 FM calls per lookup).
  let factChecked: FactConsensus | null = null
  if (facets.intent === 'lookup' && !usedRetrieval && !facets.needsComputation && !facets.isCode
      && !recomputed && process.env.CRUCIBLE_FACT_SC !== '0' && !signal?.aborted) {
    try {
      factChecked = await corroborateFact(message, text)
      if (factChecked) {
        const ens = factChecked.ensembleModels.length ? ` (incl. ${factChecked.ensembleModels.length} independent local model(s))` : ''
        if (factChecked.confirmed) {
          emit?.({ type: 'verify', passed: true, report: `Fact corroborated: ${Math.round(factChecked.agreement * 100)}% of ${factChecked.votes} independent answers${ens} agreed on "${factChecked.key}".` })
        } else {
          text += UNVERIFIED_NOTE
          emit?.({ type: 'verify', passed: false, report: `Independent answers disagreed (${Math.round(factChecked.agreement * 100)}% of ${factChecked.votes} agreed on "${factChecked.key}") — shipped with an explicit unverified note.` })
        }
      }
    } catch { /* corroboration is best-effort; the draft still ships */ }
  }

  debugBus.emit('pipeline', 'answered', {
    message: message.slice(0, 80), intent: facets.intent, usedRetrieval, corrections, repaired, recomputed, len: text.length,
    ...(consensusAgreement !== null ? { consensusAgreement: Number(consensusAgreement.toFixed(2)) } : {}),
  }, { severity: 'info' })

  return {
    text, verified: !(factChecked && !factChecked.confirmed), abstained: false, ...base,
    usedRetrieval, corrections, repaired,
  }
}

function formatRecomp(recomp: { value: number; unit?: string }): string {
  const shown = Number.isInteger(recomp.value) ? String(recomp.value) : String(Math.round(recomp.value * 1e6) / 1e6)
  return recomp.unit ? `${shown} ${recomp.unit}` : shown
}

// Guarantee the machine-verified value is stated cleanly at the very end. If the last non-empty
// line already IS an answer line stating this value, leave it; otherwise append a bold Answer line
// so a verbose or token-truncated derivation still ends with the correct, verified result.
export function ensureTrailingAnswer(text: string, recomp: { value: number; unit?: string }): string {
  const shown = formatRecomp(recomp)
  const valueToken = formatRecomp({ value: recomp.value }) // number without unit
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const last = lines[lines.length - 1] ?? ''
  if (/\banswer\s*[:=*]/i.test(last) && last.includes(valueToken)) return text
  return `${text.trimEnd()}\n\n**Answer: ${shown}**`
}

function buildRepairDirective(issues: Issue[]): string {
  const parts = issues.map(i => {
    switch (i.kind) {
      case 'empty': return 'Your reply was empty. Provide a complete answer to the question.'
      case 'truncated': return 'Your reply was cut off. Provide the complete answer, finishing every sentence.'
      case 'nonanswer': return 'You acknowledged the request but did not answer it. Give the actual answer now.'
      case 'contradiction': return `Your reply contradicts itself (${i.detail}). Resolve the contradiction and give one consistent answer.`
      default: return i.detail
    }
  })
  return `Revise your previous answer. ${parts.join(' ')} Return only the corrected answer.`
}
