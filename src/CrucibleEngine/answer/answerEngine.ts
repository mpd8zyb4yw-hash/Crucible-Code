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

import { checkFmAvailable, fmComplete, fmStream, type ConvTurn } from '../agent/fmReact'
import { solveNonCodeTurn, type NonCodeMeta } from '../agent/synthDriver'
import { debugBus } from '../debug/bus'
import { critiqueAnswer, type Issue } from './verify'
import { solveByConsensus } from './selfConsistency'
import { applyRecomputation, recomputeMultiStep, recomputeWordProblem } from './wordProblem'
import { applyDateRecomputation, isDateQuestion, recomputeDate } from './dateTime'
import { isConversionQuestion, recomputeConversion } from './unitConvert'
import { checkConstraints } from './constraints'
import { corroborateFact, UNVERIFIED_NOTE, type FactConsensus } from './factConsensus'
import { applyExplainCheck, checkExplanation } from './explainCheck'
import { matchMeta } from './conversational'
import { answerWithWebGrounding } from './groundedAnswer'
import { isCodingQuery } from '../retrieval/retrievalLayer'
import { buildRecallContext } from './conversationMemory'
import { detectTruncation, buildContinuationMessages, stitchContinuation } from './longOutput'

export type AnswerIntent = 'lookup' | 'definition' | 'explain' | 'reason' | 'converse'

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
  /** True when the answer text was already STREAMED to the client via emit({type:'synthesis'})
   *  deltas — the server must then finalize with replace:true instead of appending again. */
  streamed?: boolean
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
const EXTERNAL_FACT = /\b(latest|current(ly)?|todays?|tonight|right now|this (week|month|year)|recent(ly)?|news|headline|prices?|stock|shares?|market|weather|forecast|temperature|scores?|who won|standings?|release date|released|newest|as of|up to date|nowadays|who (is|are) the (current |reigning )?(ceo|president|prime minister|chancellor|pope|coach|manager|owner|champion|record holder|richest|oldest living|leader|head))\b/i
const MULTISTEP = /\b(and then|first[, ]|then |after that|finally|step by step|as well as)\b|.*\?.*\?/i
const REASON = /\b(if\b[^?]*\b(then|will|would|does)|how (long|far|fast|many|much) (until|before|would|will|does|do)|calculate|solve|prove|derive|catch up|how old|what time|percentage|ratio|average|per (hour|day|week|minute|second)|mph|km\/h)\b/i
// A quantitative ASK that REASON misses — discount/percent/money math and "what is the <quantity>"
// questions. Gated by NUMERIC below, so it never fires without numbers to compute over. This is
// what routes an arithmetic question into deterministic recomputation instead of a raw FM guess.
const COMPUTE_ASK = /(\d\s*%|\bpercent\b|\bdiscount(ed)?\b|\bsales? tax\b|\btip\b|\bsale price\b|\btotal (cost|price|amount|of)\b|\bhow much (is|are|does|do|will|would|much|in total)\b|\bwhat(?:'| i)?s?\s+the\s+(total|sum|product|difference|area|perimeter|average|mean|cost|price|result|remainder)\b)/i
const EXPLAIN = /\b(explain|how (does|do|to)|describe|what (is|are) (a |an |the )?[a-z]|why (does|do|is|are)|walk me through|tell me about|difference between|compare|pros and cons|trade-?offs?)\b/i
const NUMERIC = /\d/

// ── Definition sub-intent ──────────────────────────────────────────────────────
// A bare "what is a hash map" / "define recursion" / "what does X mean" wants a tight 2-4
// sentence answer, but the EXPLAIN regex above swallows "what is a <term>" and routes it to the
// full explain treatment (intuition→detail→example), which decodes ~1100 tokens ≈ 19s on the weak
// FM (measured cont.67). A definition is a lighter ask; it gets its own short budget + concise
// prompt. It fires ONLY on the term-definition shape with NO explanatory expander (how/why/works/
// example/difference/…) — those signal the user actually wants depth — and NOT on entity-fact
// lookups ("capital of Australia"), which stay on the web-grounded lookup path.
const DEFINE = /^\s*(?:can you |could you |please )?(?:what(?:'s| is| are)\s+(?:a |an |the )?[a-z][\w-]*(?:\s+[\w-]+){0,3}\s*\??$|define\s+\w|what\s+does\s+.{1,40}\s+mean\b|what\s+is\s+meant\s+by\b|meaning\s+of\s+\w|what(?:'s| is)\s+(?:the\s+)?definition\s+of\b)/i
const DEFINE_EXPANDER = /\b(how|why|works?|working|difference|differ|compare|comparison|versus|vs\.?|explain|walk me through|pros and cons|trade-?offs?|used for|use case|examples?|step by step|in detail|detailed|deep dive|elaborate|derive|derivation|internals?)\b/i
// Relational/entity nouns that make a "what is the X of Y" a specific FACT lookup, not a term def.
const FACTUAL_LOOKUP = /\b(capital|population|currency|language|president|prime minister|ceo|founder|author|inventor|distance|height|weight|born|died|located|time in|weather|price|gdp|area of)\b/i

function isDefinitionAsk(m: string): boolean {
  if (!DEFINE.test(m) || DEFINE_EXPANDER.test(m) || FACTUAL_LOOKUP.test(m)) return false
  // A capitalized entity mid-sentence signals a specific fact ("capital of Australia", "GDP of
  // France") that benefits from web grounding — leave those on the lookup path, not definition.
  if (/(?<=\S\s)[A-Z][a-zA-Z]{2,}/.test(m)) return false
  return true
}

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
  // Definition BEFORE explain: "what is a <term>" trips EXPLAIN, but a bare definition is lighter.
  else if (isDefinitionAsk(m)) intent = 'definition'
  else if (EXPLAIN.test(m)) intent = 'explain'
  else if (/^\s*(what|who|when|where|which|name|list|define|how (many|much|old|tall|far))\b/i.test(m)) intent = 'lookup'
  else intent = 'converse'

  return { needsExternalFact, needsComputation, needsMultiStep, isCode, intent }
}

// ── Depth-scaled system prompt — replaces the blanket "answer in 1-3 sentences" throttle. ──
// The point of the mission: the SYSTEM decides how much thinking a question needs; the FM
// isn't gagged into a wrong one-liner on a reasoning problem, nor made verbose on a lookup.

function systemPromptFor(facets: AnswerFacets, evidence: string): string {
  // Identity + turn-anchoring + anti-roleplay are the load-bearing lines. Without them the
  // weak FM (a) invents a persona from an ambiguous opener and carries it forward, and (b)
  // starts speaking AS the user ("I'm studying English literature…") when prior turns bleed
  // in. "Answer the MOST RECENT message" + "never speak as the user" kill both failure modes.
  const base =
    "You are Crucible, a private AI assistant that runs entirely on the user's own device. " +
    'Answer the user\'s MOST RECENT message directly. Any earlier messages are context only — ' +
    'do not repeat a previous answer, do not resume a task the user did not just ask for, and ' +
    'never write as if you were the user (you respond TO the user, you are not them). ' +
    // Recall grounding: when the user asks you to remember something THEY stated earlier (their
    // name, their project, a preference, a past decision), the answer is in the conversation above
    // — quote it from there. Never answer such a question with YOUR OWN name/identity ("Crucible")
    // and never invent a value. If it genuinely is not in the conversation, say you do not have it.
    'When the user asks you to recall a fact they told you earlier (e.g. their name, their project, ' +
    'a decision), find it in the conversation above and answer with THAT exact fact — do not give ' +
    'your own name and do not make one up; if it is not in the conversation, say so. ' +
    'Be accurate above all — if you are not sure, say so plainly rather than guessing.'
  const grounding = evidence
    ? `\n\n## Retrieved evidence (ground your answer in THIS; do not contradict it)\n${evidence}`
    : ''
  switch (facets.intent) {
    case 'reason':
      return `${base}\n\nThink through this step by step. Show each calculation or logical step explicitly. Re-check any arithmetic. State the final answer clearly on its own line at the end, prefixed with "Answer:".${grounding}`
    case 'explain':
      return `${base}\n\nGive a clear, thorough explanation. Build intuition first, then detail; include a concrete example. Use markdown structure where it helps. Do not pad — every sentence should add information.${grounding}`
    case 'definition':
      return `${base}\n\nDefine the term directly in 2-4 sentences: a one-sentence plain-language definition first, then just enough to make it concrete (a short example or where it is used). Do not write a full tutorial, do not add sections, and do not pad — stop once the term is clearly defined.${grounding}`
    case 'lookup':
      return `${base}\n\nAnswer directly and concisely (1-3 sentences). Do not add unrequested detail.${grounding}`
    default:
      return `${base}\n\nAnswer helpfully and naturally at a length that fits the question. Keep it tight — a short paragraph for a simple ask; don't pad with restatements, caveats, or a summary the answer already made.${grounding}`
  }
}

// ── Output-length cap, scaled to intent ────────────────────────────────────────
// The system prompt asks for the right length; this is the hard ceiling that keeps the weak FM
// from running on. Apple FM latency ∝ output tokens, so a lookup that decodes 500 tokens is both
// verbose AND slow. Lookups/chat get a tight budget; explanations and multi-step reasoning keep
// the room they actually need (a capped reasoning chain would truncate mid-derivation).
function maxTokensFor(facets: AnswerFacets): number {
  switch (facets.intent) {
    case 'lookup': return 320    // 1-3 sentences + slack for a list
    case 'definition': return 384 // 2-4 sentence definition + a short example (not a tutorial)
    case 'converse': return 448  // a tight paragraph or two
    case 'explain': return 1100  // intuition + detail + an example
    case 'reason': return 1536   // full step-by-step chain, never truncated
    default: return 768
  }
}

// Intents whose answers can legitimately run long enough to hit the budget and need continuation.
// Lookups are meant to be short — a lookup that fills its budget is verbose, not truncated, so it
// is deliberately excluded (continuing it would fight the length cap).
const LONG_CONT_INTENTS = new Set<AnswerFacets['intent']>(['explain', 'reason', 'converse'])
const MAX_CONT_ROUNDS = Number(process.env.CRUCIBLE_LONG_CONT_ROUNDS ?? 3)

function historyToMessages(history?: ConvTurn[]): Array<{ role: string; content: string }> {
  if (!Array.isArray(history)) return []
  return history
    .filter(h => h && (h.user || h.assistant))
    .flatMap(h => [
      { role: 'user', content: h.user },
      { role: 'assistant', content: h.assistant },
    ])
}

const ABSTAIN_TEXT =
  "I can't answer this reliably offline right now — the on-device model is unavailable, and strict mode never falls back to an external model. Try again in a moment."

// ── Metacognitive gap-gate (deterministic) ─────────────────────────────────────
// Decide when to close a knowledge gap with a web lookup vs. answer directly (fast).
//
// We tried true model self-assessment (a LOOKUP protocol; a 1-5 confidence rating) and the
// weak Apple FM CANNOT introspect its own gaps: it rated "capital of Australia" and "what is a
// variable" as needing a lookup (1/5) while rating "photosynthesis" 5/5 — noise. The protocol
// variant also confused it into refusals ("CANNOT COMPLETE THIS REQUEST"). So the gate is a
// deterministic heuristic tuned to the user's framing: research the SPECIALIZED/technical/
// recent/precise questions (where the FM bluffs and retrieval is strong), answer the general
// conceptual ones directly (where the FM is fine and the existing verification lanes still run).
function shouldResearch(message: string, facets: AnswerFacets): boolean {
  if (facets.needsExternalFact) return true                 // recency/volatility (also routed upstream)
  // Factual lookups ("what is the capital of X", "who wrote Y", "when did Z") — the weak FM is
  // demonstrably unreliable on these (it fumbled "capital of Australia" into a clarify-request),
  // while the web is authoritative and, streamed, fast. Look them up.
  if (facets.intent === 'lookup') return true
  if (isCodingQuery(message)) return true                   // API/library/language specifics — FM bluffs; SO/docs strong
  // Specialized / precise / niche cues — the "mechanics of orbital trajectory" class.
  if (/\b(mechanics|equations?|derivation|internals?|specification|spec|protocol|rfc|architecture|algorithm|theorem|formula|standard|version|release|changelog|benchmark|configuration|configure|install(?:ation)?|deprecat|migrat|troubleshoot|error|exception|best practices?|trade-?offs?|compared? (?:to|with)|difference between|vs\.?|versus)\b/i.test(message)) return true
  // Proper-noun-heavy: specific products/tools/people/places beyond a single common entity.
  const caps = (message.match(/(?<=\S\s)[A-Z][a-zA-Z0-9.+#-]{2,}/g) ?? []).length
  if (caps >= 2) return true
  return false                                              // general/basic → fast direct answer
}

/**
 * Answer one query through the verification-gated single-call path.
 * Never throws; on unrecoverable failure returns an honest abstention.
 */
// Optional verification lanes (fact consensus, explain checks, recomputation setups) must
// never hold the concurrency-1 FM gate for the full strict ceiling — a slow/wedged optional
// call would starve the NEXT live request (observed 2026-07-11: chat froze after one query
// because leftover HIGH-priority verification calls blocked the next draft). They run at
// 'normal' priority (so a fresh request's HIGH draft preempts them) with a short timeout
// (so a wedged one is abandoned, leaving the draft to ship), and honor the request signal.
const VERIFY_TIMEOUT_MS = Number(process.env.CRUCIBLE_VERIFY_TIMEOUT_MS ?? 30_000)

export async function answerQuery(message: string, opts: AnswerOpts = {}): Promise<AnswerResult> {
  const { history: rawHistory, emit, signal } = opts
  // Long-horizon recall inside the FM's finite window, split into two channels the weak FM handles
  // far better than one giant chat log: the RECENT thread stays verbatim conversation, while the
  // older turns THIS message needs (first-turn anchor + relevance-retrieved) are surfaced as a
  // labeled "earlier in this conversation" evidence block in the system prompt — the one place the
  // model reliably reads facts. This is what lets turn 500 recall turn 1. Deterministic, no summary.
  const recall = buildRecallContext(rawHistory, message)
  const history = recall.recentTurns
  if (recall.recalledCount > 0 || recall.omitted > 0) {
    debugBus.emit('pipeline', 'memory_window', { total: Array.isArray(rawHistory) ? rawHistory.length : 0, recent: history.length, recalled: recall.recalledCount, omitted: recall.omitted }, { severity: 'info' })
  }
  const verifyComplete = (msgs: Array<{ role: string; content: string }>, o?: { temperature?: number }) =>
    fmComplete(msgs, { temperature: o?.temperature, timeoutMs: VERIFY_TIMEOUT_MS, priority: 'normal', signal })
  const facets = classifyFacets(message)
  const base: Omit<AnswerResult, 'text' | 'verified' | 'abstained'> = {
    facets, usedRetrieval: false, sources: [], corrections: 0, repaired: false,
  }
  debugBus.emit('pipeline', 'facets', { message: message.slice(0, 80), ...facets }, { severity: 'info' })

  // Deterministic conversational layer — greetings, "who are you", "what can you do" are
  // FIXED FACTS about Crucible, not something to reason over. Answering them here (before the
  // FM is even consulted) is fast, un-poisonable, and correct even when the model is offline.
  // This is the root fix for the "test → invented studying task → poisoned persona" failure.
  const meta = matchMeta(message)
  if (meta) {
    debugBus.emit('pipeline', 'meta_response', { kind: meta.kind, message: message.slice(0, 60) }, { severity: 'info' })
    return { text: meta.text, verified: true, abstained: false, ...base, facets: { ...facets, intent: 'converse' } }
  }

  if (!(await checkFmAvailable())) {
    return { text: ABSTAIN_TEXT, verified: false, abstained: true, ...base }
  }

  if (signal?.aborted) return { text: ABSTAIN_TEXT, verified: false, abstained: true, ...base }

  // ── Draft: the FM is the messenger; the SYSTEM chose how to think ──────────
  // A genuine external-fact question is handed to the retrieval/tool brain (research DAG →
  // FM ReAct → FM direct). Everything else (reasoning, explanation, lookup, chat) gets a
  // single depth-controlled FM call — NOT web-retrieved, because there is no external fact to
  // fetch (a math word problem or a concept explanation is answered from reasoning, not search).
  let sys = systemPromptFor(facets, '')
  // Fold the older-turn recall into the system prompt as labeled context the FM reads reliably.
  if (recall.recallBlock) {
    sys += `\n\n## Earlier in this conversation (facts the user already told you — treat as authoritative)\n${recall.recallBlock}`
  }
  const draftMaxTokens = maxTokensFor(facets)
  let usedRetrieval = facets.needsExternalFact
  // Multi-step reasoning that the FM must derive (not retrieve) is where a single pass ships a
  // confident wrong answer. Route it through verified self-consistency: the SYSTEM samples many
  // derivations, oracle-corrects each, and takes the majority vote. Pure lookups/explanations/
  // single-step asks stay a single depth-controlled call.
  const useConsensus = !usedRetrieval && !facets.isCode && facets.needsMultiStep && facets.needsComputation
  // Knowledge questions are where the tiny parametric brain bluffs or dead-ends on things it
  // half-knows. Close the gap the way a person does: look it up. We research the web FIRST (now
  // that retrieval is fast + reliable — cont.67), synthesize a grounded, cited answer, and fall
  // back to a parametric draft only when the web yields nothing. This is the core of the agentic
  // gap-closing thesis: build the needed knowledge in real time, per query.
  //
  // Eligibility keys off the MESSAGE, not facets.isCode — because a coding *question* ("what is
  // the useEffect cleanup function?") trips isCode (LANG+CONSTRUCT) and was wrongly routed to the
  // reasoning path where the FM BLUFFED a wrong answer. We ground any question-shaped, non-
  // generation, non-arithmetic query — coding-concept questions route to StackOverflow via the
  // domain-aware retrieval layer. Code GENERATION (write/implement/fix …) and math stay on their
  // dedicated verified paths.
  const isGenRequest = CODE_GEN.test(message) || CODE_FENCE.test(message)
  const isQuestionShaped = /^\s*(what|how|why|when|which|who|where|does|do|is|are|can|could|should|would|explain|describe|tell me|define|compare|list)\b/i.test(message) || message.trim().endsWith('?')
  const groundingEligible = !usedRetrieval && !useConsensus && !isGenRequest &&
    !facets.needsComputation && isQuestionShaped &&
    process.env.CRUCIBLE_WEB_GROUNDING !== '0'
  // Gap-gate: only the specialized/technical/recent subset actually hits the web.
  const researchGap = groundingEligible && shouldResearch(message, facets)
  let draft = ''
  let consensusAgreement: number | null = null
  let retrievalMeta: NonCodeMeta | null = null
  let grounded = false
  let groundedSources: string[] = []
  let streamed = false
  try {
    if (usedRetrieval) {
      emit?.({ type: 'thought', text: 'Researching with retrieval + tools…' })
      // forceResearch: this call happens ONLY when EXTERNAL_FACT fired — synthDriver's own
      // research-shape regex must not re-veto the retrieval decision (split-brain bug: it
      // lacked "who won", skipped the DAG, and shipped a wrong parametric answer).
      draft = (await solveNonCodeTurn(message, undefined, Array.isArray(history) ? history.slice(-6) : undefined, m => { retrievalMeta = m }, { forceResearch: true })).trim()
    } else if (useConsensus) {
      const c = await solveByConsensus(message, sys, historyToMessages(history), emit)
      draft = c.text.trim()
      consensusAgreement = c.agreement
      if (draft) {
        emit?.({ type: 'verify', passed: c.agreement >= 0.5, report: `Self-consistency: ${Math.round(c.agreement * 100)}% of ${c.samples} independent derivations agreed on the answer.` })
      }
    } else if (researchGap) {
      // Detected knowledge gap → close it with a web lookup, grounded + cited. STREAM the
      // synthesis to the client (first fragment ~0.7s) when an emit sink is wired.
      const onToken = emit
        ? (d: string) => emit({ type: 'synthesis', modelId: 'local/apple-fm', model: 'Crucible', text: d, replace: false })
        : undefined
      const g = await answerWithWebGrounding(message, { history, recallBlock: recall.recallBlock, emit, signal, onToken })
      if (g && g.text) {
        draft = g.text
        grounded = true
        usedRetrieval = true          // gates the redundant FM verification lanes below
        groundedSources = g.sources
        streamed = !!onToken
      } else {
        // Web yielded nothing usable → answer from on-device knowledge (never worse than before).
        emit?.({ type: 'thought', text: 'No usable web sources — answering from on-device knowledge.' })
        const msgs = [{ role: 'system', content: sys }, ...historyToMessages(history), { role: 'user', content: message }]
        draft = (await fmComplete(msgs, { signal, maxTokens: draftMaxTokens })).trim()
      }
    } else {
      // Direct on-device answer (common knowledge, fast path). STREAM it when an emit sink is
      // wired so the first token lands in ~1s instead of after the whole answer decodes; the
      // verification lanes below then polish it in place (server finalizes with replace:true).
      const msgs = [{ role: 'system', content: sys }, ...historyToMessages(history), { role: 'user', content: message }]
      const onToken = emit
        ? (d: string) => emit({ type: 'synthesis', modelId: 'local/apple-fm', model: 'Crucible', text: d, replace: false })
        : undefined
      if (onToken) {
        draft = (await fmStream(msgs, onToken, { signal, maxTokens: draftMaxTokens })).trim()
        streamed = true
      } else {
        draft = (await fmComplete(msgs, { signal, maxTokens: draftMaxTokens })).trim()
      }
      // Long-output continuation: a genuinely long answer can fill the token budget and stop
      // mid-sentence / inside an open code block. When we detect that (high-precision signals only,
      // so a finished answer is never extended), resume from exactly where it stopped and stitch —
      // large builds ship whole instead of truncated. Bounded rounds; streams as it goes.
      if (LONG_CONT_INTENTS.has(facets.intent) && process.env.CRUCIBLE_LONG_CONT !== '0') {
        for (let round = 0; round < MAX_CONT_ROUNDS; round++) {
          if (signal?.aborted) break
          const trunc = detectTruncation(draft, draftMaxTokens)
          if (!trunc.truncated) break
          emit?.({ type: 'thought', text: `Answer hit the length budget (${trunc.reason}) — continuing where it left off…` })
          const contMsgs = buildContinuationMessages(msgs, draft)
          let piece = ''
          try {
            piece = onToken
              ? (await fmStream(contMsgs, onToken, { signal, maxTokens: draftMaxTokens }))
              : (await fmComplete(contMsgs, { signal, maxTokens: draftMaxTokens }))
          } catch { break }
          piece = piece.trim()
          if (!piece) break
          const before = draft.length
          draft = stitchContinuation(draft, piece).trim()
          if (draft.length <= before) break   // no net progress → stop (avoid loops)
        }
        // Safety net: if the rounds were exhausted with a code block still open (a very large build
        // that outran the budget), close the fence so the answer renders as valid markdown instead
        // of swallowing the rest of the page into an unterminated code block.
        if ((draft.match(/```/g)?.length ?? 0) % 2 === 1) draft = draft.replace(/\s*$/, '') + '\n```'
      }
    }
  } catch {
    draft = ''
  }

  if (!draft) {
    return { text: ABSTAIN_TEXT, verified: false, abstained: true, ...base, usedRetrieval, streamed }
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
      return { text: ABSTAIN_TEXT, verified: false, abstained: true, ...base, usedRetrieval, corrections, repaired, streamed }
    }
  }

  if (corrections) emit?.({ type: 'verify', passed: true, report: `Corrected ${corrections} arithmetic error(s) with the deterministic oracle.` })

  // ── Retrieval grounding provenance ─────────────────────────────────────────
  // A research-DAG answer is already grounded by the provenance oracle cascade — surface
  // that. An FM ReAct/direct FALLTHROUGH is NOT retrieval-grounded (parametric knowledge
  // wearing a retrieval label), so the normal verification lanes below must still apply.
  const rMeta = retrievalMeta as NonCodeMeta | null
  // A web-grounded answer (useGrounding path) is retrieval-grounded by construction and already
  // emitted its own sources/verify — it is NOT an ungrounded fallthrough.
  const retrievalUngrounded = usedRetrieval && !grounded && (rMeta === null || rMeta.via === 'react' || rMeta.via === 'direct')
  if (usedRetrieval && rMeta?.via === 'dag') {
    emit?.({ type: 'verify', passed: true, report: `Retrieval answer grounded by the provenance oracle cascade (confidence ${Math.round((rMeta.confidence ?? 0) * 100)}%${rMeta.sources ? `, ${rMeta.sources} source(s)` : ''}).` })
  } else if (retrievalUngrounded && text) {
    emit?.({ type: 'verify', passed: false, report: 'Retrieval fell through to the on-device model (no web grounding) — applying the standard verification lanes.' })
  }

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
      const recomp = await recomputeDate(message, { complete: verifyComplete })
      if (recomp) {
        const rec = applyDateRecomputation(text, recomp, message)
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
  } else if ((facets.needsComputation || isConversionQuestion(message)) && !usedRetrieval && !signal?.aborted) {
    try {
      // Try the single-expression extractor FIRST — it is fast (~3s) and, because the model can
      // nest ("120 - (3/4 * 120) - 15"), it already covers most compound problems. Only when it
      // can't form a quorum AND the question is multi-step do we pay for the richer (slower) step-
      // DAG setup, which handles the genuinely irreducible cases (relative speed, head start).
      // Unit conversions try FIRST: Tier 1 parses deterministically (zero model calls, the
      // factor table is ground truth); a non-conversion falls through to the arithmetic lanes.
      let recomp = isConversionQuestion(message) ? await recomputeConversion(message, { complete: verifyComplete }) : null
      if (!recomp && facets.needsComputation) {
        recomp = await recomputeWordProblem(message, { complete: verifyComplete })
          ?? (facets.needsMultiStep ? await recomputeMultiStep(message, { complete: verifyComplete }) : null)
      }
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
        // samples === 0 marks a Tier-1 conversion: parsed + converted purely from the unit
        // table, no model setup involved — the strongest provenance we can report.
        const how = recomp.samples === 0
          ? 'deterministic unit-conversion table, no model involved'
          : `${recomp.samples} independent setups, ${Math.round(recomp.agreement * 100)}% agreed`
        if (rec.corrected) {
          text = rec.text
          corrections += 1
          recomputed = true
          emit?.({ type: 'verify', passed: true, report: `Recomputed the answer deterministically: ${recomp.expression} = ${formatRecomp(recomp)} (${how}). Corrected a mismatched stated value.` })
        } else if (rec.confirmed) {
          recomputed = true
          emit?.({ type: 'verify', passed: true, report: `Verified the answer by independent recomputation: ${recomp.expression} = ${formatRecomp(recomp)} (${how}).` })
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
  if (facets.intent === 'lookup' && (!usedRetrieval || retrievalUngrounded) && !facets.needsComputation && !facets.isCode
      && !recomputed && process.env.CRUCIBLE_FACT_SC !== '0' && !signal?.aborted) {
    try {
      factChecked = await corroborateFact(message, text, { complete: verifyComplete })
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

  // ── Explain spot checks — the last unverified lane. Embedded factual claims (years,
  // measures, attributions) are extracted deterministically and judged in isolation by K
  // decorrelated verdicts; majority-refuted claims ship with an explicit caution. Weakest
  // verifier by design (model-judged), so it only ever FLAGS, never rewrites.
  let explainFlags = 0
  if (facets.intent === 'explain' && (!usedRetrieval || retrievalUngrounded) && !facets.isCode
      && process.env.CRUCIBLE_EXPLAIN_CHECK !== '0' && !signal?.aborted) {
    try {
      const chk = await checkExplanation(text, { complete: verifyComplete })
      if (chk) {
        explainFlags = chk.flagged.length
        text = applyExplainCheck(text, chk)
        emit?.({
          type: 'verify', passed: chk.flagged.length === 0,
          report: chk.flagged.length
            ? `Spot-checked ${chk.checked} embedded claim(s); ${chk.flagged.length} could not be confirmed — flagged in the answer.`
            : `Spot-checked ${chk.checked} embedded factual claim(s) with ${chk.verdicts} independent verdicts — none refuted.`,
        })
      }
    } catch { /* spot check is best-effort */ }
  }

  debugBus.emit('pipeline', 'answered', {
    message: message.slice(0, 80), intent: facets.intent, usedRetrieval, corrections, repaired, recomputed, len: text.length,
    ...(consensusAgreement !== null ? { consensusAgreement: Number(consensusAgreement.toFixed(2)) } : {}),
  }, { severity: 'info' })

  return {
    text, verified: !(factChecked && !factChecked.confirmed) && explainFlags === 0, abstained: false, ...base,
    usedRetrieval, corrections, repaired, streamed,
    sources: grounded ? groundedSources : base.sources,
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
