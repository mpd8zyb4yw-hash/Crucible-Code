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

import { checkFmAvailable, fmComplete, fmStream, stripAgentScaffold, type ConvTurn } from '../agent/fmReact'
import { solveNonCodeTurn, type NonCodeMeta } from '../agent/synthDriver'
import { debugBus } from '../debug/bus'
import { unentailedQuotes, repairQuotations } from './quoteEntailment'
import { subjectAbsentFromEvidence, figuresAbsentFromEvidence } from './evidenceRelevance'
import { critiqueAnswer, type Issue } from './verify'
import { solveByConsensus } from './selfConsistency'
import { applyRecomputation, recomputeMultiStep, recomputeWordProblem, directArithmetic } from './wordProblem'
import { applyDateRecomputation, isDateQuestion, recomputeDate } from './dateTime'
import { isConversionQuestion, recomputeConversion } from './unitConvert'
import { checkConstraints } from './constraints'
import { corroborateFact, UNVERIFIED_NOTE, type FactConsensus } from './factConsensus'
import { applyExplainCheck, checkExplanation } from './explainCheck'
import { matchMeta } from './conversational'
import { answerWithWebGrounding } from './groundedAnswer'
import { isCodingQuery, namesExternalLibrary } from '../retrieval/retrievalLayer'
import { buildRecallContextAsync } from './conversationMemory'
import { isAboutSelf } from './referent'
import { selfFactsBlock } from './selfModel'
import { detectTruncation, buildContinuationMessages, stitchContinuation } from './longOutput'

export type AnswerIntent = 'lookup' | 'definition' | 'explain' | 'reason' | 'converse' | 'code'

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
// A generation verb plus a language in INSTRUMENT position ("implement a stack in TypeScript",
// "write a limiter for a Node server") is a code ask no matter what the deliverable NOUN is —
// CODE_GEN's closed noun list missed live asks whose deliverable was "stack" / "middleware"
// (cont.95: both routed 'converse'). Instrument position ("in/using/with/for <lang>") is the
// load-bearing guard: "write an essay about Python" names the language as a TOPIC and stays out.
const CODE_VERB = /\b(write|create|build|implement|generate|refactor|debug|optimi[sz]e|fix|convert|rewrite|complete|port)\b/i
const LANG_INSTRUMENT = /\b(?:in|using|with|for)\s+(?:an?\s+)?(?:python|javascript|typescript|java|c\+\+|c#|rust|go(?:lang)?|ruby|php|swift|kotlin|bash|shell|sql|node(?:\.js)?)\b/i

// Retrieval fires only for VOLATILE / recency-sensitive facts the FM cannot reliably know from
// parametric memory (live prices, current events, "latest/newest", today's weather/score). It
// deliberately does NOT match timeless facts (capitals, populations, definitions) — the FM
// answers those cleanly and directly, and routing them through the research DAG both slows the
// turn and, empirically, garbles trivial answers. Stage 3 will harden DAG grounding quality.
const EXTERNAL_FACT = /\b(latest|current(ly)?|todays?|tonight|right now|this (week|month|year)|last (week|month|year)|yesterday|recent(ly)?|news|headline|prices?|stock|shares?|market|weather|forecast|temperature|scores?|who won|standings?|release date|released|newest|as of|up to date|nowadays|who (is|are) the (current |reigning )?(ceo|president|prime minister|chancellor|pope|coach|manager|owner|champion|record holder|richest|oldest living|leader|head))\b/i
const MULTISTEP = /\b(and then|first[, ]|then |after that|finally|step by step|as well as)\b|.*\?.*\?/i
// REASON is deliberately TWO classes, because they license different things.
//
// REASON_VERB — reasoning verbs and conditionals. These describe an OPERATION the answer
// requires (derive it, solve it, project it forward), so they may select 'reason' on their own,
// with or without numbers present: "how long would it take to boil an egg" has no digits and is
// still a derivation.
const REASON_VERB = /\b(if\b[^?]*\b(then|will|would|does)|how (long|far|fast|many|much) (until|before|would|will|does|do)|calculate|solve|prove|derive|catch up|how old|what time)\b/i
// REASON_UNIT — rate and quantity NOUNS. These describe the TYPE OF THE ANSWER, not whether any
// derivation is needed. "the speed of light in metres per second" is a single retrieved constant;
// naming its unit does not make it a calculation. MEASURED (2026-07-26): with these folded into
// the intent selector, "What is the speed of light in metres per second?", "What is the top speed
// of a cheetah in miles per hour?" and "How many beats per minute is a normal resting heart rate?"
// all routed to 'reason' — a step-by-step-derivation prompt with a 1536-token budget for a
// one-number fact, and with corroborateFact (lookup-only) switched off.
// So units may only reach 'reason' through needsComputation, which is NUMERIC-gated and already
// applies the right discipline. Every genuine reason-intent control in __answer_bench's routing
// block sets needsComputation=true independently, so this removes false positives only.
const REASON_UNIT = /\b(percentage|ratio|average|per (hour|day|week|minute|second)|mph|km\/h)\b/i
// Union, for the numeric-gated computation test below — unchanged behavior there.
const REASON = new RegExp(`(?:${REASON_VERB.source})|(?:${REASON_UNIT.source})`, 'i')
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

// ── Lookup nucleus ─────────────────────────────────────────────────────────────
// What makes a turn a factual lookup is that its interrogative nucleus is a fact-seeking
// wh-word — NOT that the wh-word sits at character 0. English routinely fronts a preposition
// ("In what year…", "On what date…", "At what temperature…") or wraps the question in a
// knowledge frame ("Do you know who…", "Can you tell me what…"). MEASURED (2026-07-26): the
// old `^`-anchored test dropped all six of those shapes into the `converse` catch-all,
// including three items in __abstention_bench's own live non-bait probe.
//
// The frame is a CLOSED class and is stripped at most once, so this widens the nucleus test
// without turning it into "contains a wh-word anywhere" — that would swallow conversational
// turns like "I was wondering what you meant" and regress the confabulation work. Anything not
// in the class still falls through to `converse` exactly as before.
const LOOKUP_NUCLEUS = /^\s*(what|who|when|where|which|name|list|define|how (many|much|old|tall|far))\b/i
const INTERROGATIVE_FRAME = new RegExp(
  '^\\s*(?:' +
    // Fronted preposition: "In what year…", "On what date…", "At what temperature…".
    '(?:in|on|at|by|from|during|under|over|within|near|into|through|around)\\s+' +
    // Knowledge/politeness frame: "Do you know who…", "Could you tell me what…".
    '|(?:do|does|did)\\s+you\\s+(?:know|recall|remember)\\s+' +
    '|(?:can|could|would)\\s+you\\s+(?:please\\s+)?(?:tell\\s+me|remind\\s+me)\\s+' +
    '|(?:please\\s+)?tell\\s+me\\s+' +
  ')',
  'i',
)
function stripInterrogativeFrame(m: string): string {
  return m.replace(INTERROGATIVE_FRAME, '')
}

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
    || (CODE_VERB.test(m) && LANG_INSTRUMENT.test(m))
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
  // A code-generation ask gets its OWN intent — never 'reason'. The reason prompt demands a
  // trailing "Answer:" line (right for a math word problem, nonsensical for code): the weak FM
  // occasionally obeys it literally and ships a bare "Answer: true" instead of a code block, which
  // the prose critics then fail to flag as a non-answer. A dedicated 'code' intent carries a
  // code-appropriate prompt (no "Answer:" line) and a code-shaped non-answer critic downstream.
  if (isCode) intent = 'code'
  // REASON_VERB, not REASON: a unit noun may only reach 'reason' via needsComputation (which is
  // NUMERIC-gated). See the REASON_VERB/REASON_UNIT split above.
  else if (needsComputation || REASON_VERB.test(m)) intent = 'reason'
  // Definition BEFORE explain: "what is a <term>" trips EXPLAIN, but a bare definition is lighter.
  else if (isDefinitionAsk(m)) intent = 'definition'
  else if (EXPLAIN.test(m)) intent = 'explain'
  else if (LOOKUP_NUCLEUS.test(stripInterrogativeFrame(m))) intent = 'lookup'
  else intent = 'converse'

  return { needsExternalFact, needsComputation, needsMultiStep, isCode, intent }
}

// ── Depth-scaled system prompt — replaces the blanket "answer in 1-3 sentences" throttle. ──
// The point of the mission: the SYSTEM decides how much thinking a question needs; the FM
// isn't gagged into a wrong one-liner on a reasoning problem, nor made verbose on a lookup.

// The anti-confabulation rule, extracted so the single-model answer engine (base prompt below)
// and the multi-model quorum synthesis layer (server.ts buildSynthesisMessages) share ONE source
// of truth. The weak on-device model's worst failure is fluently inventing a specific (a name,
// date, source, attribution) to fill a gap it half-knows; synthesizing several such drafts does
// not launder that risk away, so the synthesis prompt must carry the same doctrine.
export const CALIBRATED_HONESTY_DOCTRINE =
  'CALIBRATED HONESTY IS YOUR FIRST DUTY. For every factual specific — a name, date, number, ' +
  'quote, citation, author, or event — state it ONLY if you are actually confident it is correct. ' +
  'You have exactly three honest moves: (1) answer plainly when you know it; (2) answer but flag ' +
  'the part you are unsure about ("I think… but I am not certain"); or (3) say you do not know / ' +
  'cannot verify it. NEVER invent a plausible-sounding specific to fill a gap — a truthful ' +
  '"I am not sure" or "I do not know" is always better than a confident guess. Do not pad an ' +
  'answer with fabricated detail to sound authoritative.'

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
    // Calibrated honesty — the load-bearing anti-confabulation rule. Shared verbatim with the
    // multi-model quorum synthesis prompt (server.ts) so a complex/ensemble answer is held to the
    // SAME anti-confabulation bar as a single-model one — see CALIBRATED_HONESTY_DOCTRINE below.
    CALIBRATED_HONESTY_DOCTRINE
  const grounding = evidence
    ? `\n\n## Retrieved evidence (ground your answer in THIS; do not contradict it)\n${evidence}`
    : ''
  switch (facets.intent) {
    case 'reason':
      return `${base}\n\nThink through this step by step. Show each calculation or logical step explicitly. Re-check any arithmetic. State the final answer clearly on its own line at the end, prefixed with "Answer:".${grounding}`
    case 'code':
      // No "Answer:" line here — a code ask wants runnable code, not a one-word verdict. The weak
      // FM will echo whatever closing instruction it's given, so the closing instruction must be
      // "produce the code," not "state the answer on its own line."
      return `${base}\n\nWrite complete, correct, runnable code that fully implements what was asked. Put the implementation in a single fenced code block with the right language tag. After the code block, add one or two sentences on how to use it. Do not output a bare yes/no or a one-line "Answer:" — the deliverable is the code itself.${grounding}`
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
    case 'code': return 1536     // a whole class/module implementation, never truncated
    default: return 768
  }
}

// Intents whose answers can legitimately run long enough to hit the budget and need continuation.
// Lookups are meant to be short — a lookup that fills its budget is verbose, not truncated, so it
// is deliberately excluded (continuing it would fight the length cap).
const LONG_CONT_INTENTS = new Set<AnswerFacets['intent']>(['explain', 'reason', 'converse', 'code'])
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

// ── Self-knowledge grounding ────────────────────────────────────────────────
// "How smart are you / who made you / what are you" have a GROUND TRUTH — what Crucible
// actually is — but the parametric model has never seen it, so it confabulates a persona
// (a real run answered "how smart are you" with "I am a fictional character created by Larry
// Niven and Jerry Pournelle"). This is NOT a canned per-question answer: we inject the honest
// facts as grounding and let the model compose the reply over them, the same way retrieved
// evidence grounds a lookup. It reasons about itself instead of inventing a biography.
// Every alternative anchors on "you"/"your" so a third-party question ("how smart are dolphins",
// "who made the iPhone") never matches. matchMeta (conversational.ts) runs FIRST and fixed-answers
// the identity/creator/capability families, so the phrasings added here are deliberately the ones
// matchMeta does NOT cover — IQ/EQ, cross-model comparison, training provenance, feelings — i.e.
// exactly the confabulation bait that otherwise reaches the FM ungrounded. Grounded layer and
// fixed-fact layer therefore stay disjoint in practice: matchMeta hits return before this is read.
export const SELF_REF_RX =
  /\b(how\s+(smart|intelligent|clever|capable|good|powerful|advanced|fast)\s+(are|r)\s+you|what('?s| is| are)\s+you\b|what('?s| is)\s+your\s+(iq|eq|intelligence|training data|architecture|parameter|context window|knowledge cutoff)|who\s+(are|r|made|built|created|trained|designed)\s+you|what\s+(kind|type|sort)\s+of\s+(ai|model|assistant|thing)\s+are\s+you|what\s+model\s+are\s+you|are\s+you\s+(conscious|sentient|alive|human|real|self.?aware|an?\s+(ai|llm|robot|model|human))|are\s+you\s+(smarter|dumber|better|worse|faster|slower|stronger|weaker|more\s+\w+|less\s+\w+)\s+than|do\s+you\s+have\s+(feelings|emotions|a\s+soul|consciousness|opinions|a\s+memory|self.?awareness)|when\s+were\s+you\s+(trained|made|built|created|born)|what\s+(data|dataset|corpus)\s+(were|was|are)\s+you\s+trained\s+on|tell\s+me\s+about\s+yourself|introduce\s+yourself|what\s+can\s+you\s+do|what\s+are\s+your\s+(capabilit|limitation|strength|weakness))/i
/**
 * Is this question about Crucible itself?
 *
 * cont.118 — this is now REFERENT RESOLUTION with the old regex kept only as a safety net.
 *
 * `SELF_REF_RX` above is an ENUMERATION of self-question phrasings, and an enumeration of an open
 * class always has a tail. The observed failure was `"are you made in china"`: the regex has
 * `are you made BY <x>` and not `are you made IN <x>`, so the message fell past this gate, past
 * the `!isSelfReferential` web-grounding veto below, and was searched on the open web — returning
 * pages about goods manufactured in China. One preposition separated shipping from broken. Adding
 * `made in` would have been whack-a-mole (`crucible-no-templates-universal-fix`).
 *
 * `resolveReferent` asks the CLOSED grammatical question instead — what is the referent of the
 * subject? — which covers "made in", "assembled in", "owned by", "trained on", "spying on", and
 * every phrasing nobody has thought of yet. The union with SELF_REF_RX is belt-and-braces: it
 * makes the new behaviour a provable strict superset of the old, which `__referent_bench.ts`
 * asserts directly rather than trusting.
 */
export function isSelfReferential(message: string): boolean {
  return isAboutSelf(message) || SELF_REF_RX.test(message ?? '')
}
export const CRUCIBLE_SELF_FACTS =
  `- Crucible is a private AI assistant that runs entirely on the user's own device (offline-first); in strict mode it makes no external calls at all.\n` +
  `- Its cognitive core is a deliberately SMALL on-device language model (about 1.5 billion parameters today). It is not a large frontier model and does not claim to be one.\n` +
  `- Its reliability does NOT come from raw model size. It comes from a verification-and-search loop around that small model: the model only proposes, and deterministic checkers (arithmetic, code execution, calendar math, self-consistency voting) certify or reject each answer, and it backtracks when a check fails.\n` +
  `- Because of that loop it is strongest on things that can be checked — arithmetic and word problems, code it can run, definitions and explanations, recall of what you told it earlier. It is weaker on obscure or very recent facts it was never trained on, and it can be wrong on those.\n` +
  `- It has no feelings, no consciousness, and no fixed IQ score. "How smart am I" is best answered by what it can and cannot reliably do, not by a number.\n` +
  `- When it is not sure or cannot verify something, it says so or abstains rather than guessing. It was built by its developer as an experiment in making a small model trustworthy through verification, not scale.`

const ABSTAIN_TEXT =
  "I can't answer this reliably offline right now — the on-device model is unavailable, and strict mode never falls back to an external model. Try again in a moment."

// An EXTERNAL/volatile fact the retrieval layer could not ground (no web in strict offline, or
// retrieval fell through to a bare parametric FM answer). There is no verified answer to ship and
// the weak head would fluently invent one, so we abstain honestly rather than confabulate.
const UNVERIFIABLE_FACT_TEXT =
  "I can't verify this offline — it needs a live external lookup that strict mode doesn't make, and I won't guess at a specific (a name, date, number, or quote) I can't confirm."

// ── Shared decline / hedge recognizer ───────────────────────────────────────────
// The weak head, handed an unknowable specific, often produces an honest DECLINE in prose ("I
// can't verify that", "not provided in the evidence", "I don't have access to that") instead of a
// fabricated specific. That is the CORRECT behavior — but until now ONLY the abstention bench's
// regex could recognize it; the production pipeline shipped the hedge as if it were a confident,
// verified answer, with no way to upgrade it to a clean, stamped `abstained:true`. This is the ONE
// source of truth for "this text is the model declining", shared by the engine (to convert a hedge
// into an honest abstention — see answerQuery's retrieval-abstain block) AND by __abstention_bench.ts
// (to score a reply as calibrated). Keeping both on the same regex means a phrasing the engine now
// abstains on can never be one the bench silently rewards while production ships it raw.
export const DECLINE_RX =
  /\b(i (do not|don'?t) know|i(?:'| a)m not (sure|certain)|not sure|cannot (verify|confirm|answer|find|provide|determine|know)|can'?t (verify|confirm|answer|find|provide|determine|know)|no (reliable )?way to (verify|know)|unable to (verify|find|answer|provide|determine)|i (do not|don'?t) have (access|the|any|enough|that|this)|(do not|don'?t) have access to|no access to|not aware of|no record|couldn'?t find|i (do not|don'?t) have (real-?time|specific|exact)|(does|do) not (exist|address)|(there (is|are) no|no such)\b[^.]*\b(record|answer|way|information|data|sequel|publication|isbn|number)|cannot be (determined|known|verified)|not possible to (know|determine|verify)|(not able to|un(?:able|willing) to|cannot|can'?t) predict(?: the future)?|(do not|don'?t) predict the future|no way to predict|(do not|don'?t) have (information|data|any information)|no (publicly )?available (information|record|data)|isn'?t (published|available|public)|not (provided|found|mentioned|listed|included|present|available|specified) in the (?:provided\s+|retrieved\s+|available\s+|given\s+)?(evidence|sources?|text|context|excerpts?|passages?))\b/i

/** True when a reply IS the model honestly declining/hedging rather than answering. Used to
 *  convert a decline-phrased retrieval answer into a clean, stamped abstention. */
export function isDecline(text: string): boolean {
  return DECLINE_RX.test(text ?? '')
}

// True when a reply is DOMINATED by declining — i.e. the model is honestly abstaining and NOT also
// delivering a real, cited answer alongside the hedge. This is the discriminator the production
// abstention gate needs: `isDecline()` fires on any decline CLAUSE, which false-positives on a
// legitimate grounded lookup that answers the main question and merely flags a missing sub-detail
// ("Canberra is the capital of Australia [S1], but the exact founding date isn't in the sources").
// Nuking that whole reply to `[abstained]` throws away a correct, cited answer. Dominance keeps the
// gate honest: a decline-phrased reply that ALSO contains a genuinely cited answer sentence
// (a non-decline sentence carrying an [S#] marker) is a partial hedge, not an abstention — ship it.
// Only when EVERY factual sentence is itself a decline (the ISBN bait: "the ISBN is not provided in
// the evidence [S1]" — cites, but the cited sentence IS the decline) do we convert to a clean abstain.
export function isDeclineDominant(text: string): boolean {
  const t = text ?? ''
  if (!DECLINE_RX.test(t)) return false
  // A "real answer" sentence: not itself a decline, and carrying a citation marker ([S1], [S2]…) —
  // the grounded path staples those onto the claims it actually verified, so their presence on a
  // NON-decline sentence means a genuine answer rode along with the hedge.
  for (const sentence of t.split(/(?<=[.!?])\s+|\s*[;\n]+\s*/)) {
    if (/\[S\d/.test(sentence) && !DECLINE_RX.test(sentence)) return false
  }
  return true
}

// A query whose premise fixes a settled outcome at a date still in the FUTURE ("who won the 2043
// Nobel Prize"). The event has not happened, so there is nothing to look up or reason to — abstain
// on the false premise instead of naming a fabricated winner.
const FUTURE_PREMISE_TEXT =
  "That refers to an event dated in the future, which hasn't happened yet — there's no result to report, and I won't invent one."

// ── Temporally-impossible premise (deterministic) ───────────────────────────────
// A "settled-outcome" question ("who WON / winner of / results of / champion / recipient of") that
// pins a specific year STRICTLY GREATER than the current year describes an event that has not
// occurred. The weak head confabulates a confident laureate/winner for it (a live probe named a
// real physicist for the "2043 Nobel Prize"). Detect the future year + settled-outcome frame and
// abstain. Kept narrow — a plain future-year mention ("plans for 2043") has no settled-outcome cue.
const SETTLED_OUTCOME_RX =
  /\b(who\s+won|winner\s+of|winners?\b|won\s+the|results?\s+of|champions?\b|recipient\s+of|awarded\s+to|elected|voted\s+in|gold\s+medal(?:list)?)\b/i
// True when a draft is DOMINATED by fenced code — i.e. a fenced ```…``` block makes up the majority
// of its non-whitespace content, or the draft opens straight into one. Used to reject a code answer
// to a non-code factual ask (the confabulation-as-code failure mode). Deliberately conservative: a
// short inline snippet inside an otherwise-prose answer does NOT trip it.
export function isCodeDominated(draft: string): boolean {
  const d = draft ?? ''
  const fences = d.match(/```[\s\S]*?```/g)
  if (!fences || !fences.length) return false
  const codeChars = fences.reduce((n, f) => n + f.replace(/\s/g, '').length, 0)
  const totalChars = d.replace(/\s/g, '').length
  if (totalChars === 0) return false
  // Dominated: ≥60% of the content is inside code fences, or the draft leads with a fence and the
  // prose around it is negligible (< 40 non-space chars outside the fences).
  return codeChars / totalChars >= 0.6 || (/^\s*```/.test(d) && totalChars - codeChars < 40)
}

export function hasFutureSettledPremise(message: string, now = new Date()): boolean {
  const m = message ?? ''
  if (!SETTLED_OUTCOME_RX.test(m)) return false
  const currentYear = now.getFullYear()
  for (const y of m.matchAll(/\b(20\d{2}|21\d{2})\b/g)) {
    if (Number(y[1]) > currentYear) return true
  }
  return false
}

// ── First-person-possessive unknowable premise (deterministic) ──────────────────
// A question that asks for a UNIQUE CONCRETE SPECIFIC (a name, date, number, serial, exact value)
// about the USER'S own private world — "my unpublished novel", "my parked car", "the banknote in
// my wallet", "what I had for breakfast on April 12 2013" — is unknowable to an on-device model by
// construction: the fact was never provided, and no retrieval can reach the user's private past.
// The weak head otherwise GROUNDS-then-FABRICATES ("based on the evidence provided, I had…" → an
// invented meal; "…the dog is Captain Roy Archer"). Catch it BEFORE retrieval, the same shape as
// hasFutureSettledPremise, and abstain. Kept deliberately conservative — it fires only on a
// first-person-possessive/private-action reference PAIRED WITH a concrete-datum demand, and NOT on
// advice / how-to / computational / help asks ("how do I…", "what should I…", "if I weigh 70kg…"),
// which are answerable and must fall through untouched. Under-triggering is safe (the retrieval /
// isDecline nets still catch the rest); over-triggering would kill real user questions.
const POSSESSIVE_REF_RX =
  /\b(my|mine)\b|\b(?:did\s+I|I)\s+(had|have|ate|drank|bought|saw|met|wrote|said|did|wore|parked|paid|took|visited|received|sent|submitted|read)\b/i
const CONCRETE_DEMAND_RX =
  /\b(what\s+(?:is|was|were|did)|which\b|how\s+many|how\s+much|on\s+what\s+(?:\w+\s+){0,2}(?:date|day)|the\s+(?:exact\s+)?(?:\w+\s+){0,2}(?:name|serial(?:\s+number)?|number|date|time|price|amount|colou?r|address|phone(?:\s+number)?|latitude|longitude|gps|move|score|objective|title))\b/i
// Answerable frames that must NEVER be swallowed even when they contain "my"/"I": advice, how-to,
// help, opinion, and computation-with-given-data (the "if I …" conditional supplies its own inputs).
const ANSWERABLE_FRAME_RX =
  /\b(how\s+(?:do|can|could|should|would|might)\s+(?:i|we|you)|(?:should|can|could|would|shall)\s+i\b|help\s+me|if\s+i\b|explain|recommend|suggest|advice|meaning|means?\b|difference|better|vs\.?|versus|center|css|html|code|function|variable|BMI)\b/i

export function hasUnknowablePossessivePremise(message: string): boolean {
  const m = message ?? ''
  if (ANSWERABLE_FRAME_RX.test(m)) return false
  return POSSESSIVE_REF_RX.test(m) && CONCRETE_DEMAND_RX.test(m)
}

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
  // NORTH-STAR (cont.69): grounding is the DEFAULT spine, not an opt-in subset. The weak FM is
  // the PLANNER/synthesizer, never the source of truth — so a "general/basic" question is NOT a
  // license to answer from parametric memory. There is no physical-world question the internet
  // can't answer; if retrieval comes back empty, that is a research-QUALITY failure to fix (or a
  // genuinely ambiguous ask to clarify), never a reason to let the dumb model bluff. Ground it.
  // (Only the dedicated VERIFIED non-web paths opt out upstream: arithmetic/consensus and code
  // GENERATION — those are checked, not memorized. Everything else researches.)
  return true
}

// ── Grounding acceptance — is this grounded draft actually entailed by what we read? ──────────
// One decision point for the three entailment checks (quote / figure / subject), applied where a
// rejection is CHEAP and honest: at acceptance, so unusable grounding falls back to the same
// on-device path a failed lookup takes. Quotation REPAIR runs first (cont.112b) — a misquote whose
// verbatim wording IS in the evidence is fixed, not rejected — and only a span that cannot be
// anchored counts against the draft.
function acceptGrounding(
  g: { text: string; evidence?: string } | null,
  message: string,
): { ok: boolean; text: string; reason: string } {
  if (!g || !g.text) return { ok: false, text: '', reason: 'no grounding' }
  const evidence = g.evidence ?? ''
  if (!evidence) return { ok: true, text: g.text, reason: '' }
  const fixed = repairQuotations(g.text, evidence, message)
  const text = fixed.repaired.length ? fixed.text : g.text
  if (fixed.remaining.length) return { ok: false, text, reason: 'quoted text appears in no source' }
  if (figuresAbsentFromEvidence(text, evidence, message)) return { ok: false, text, reason: 'no figure in the answer occurs in the sources' }
  if (subjectAbsentFromEvidence(message, evidence)) return { ok: false, text, reason: 'the sources never mention the subject' }
  return { ok: true, text, reason: '' }
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
  const recall = await buildRecallContextAsync(rawHistory, message)
  const history = recall.recentTurns
  if (recall.recalledCount > 0 || recall.omitted > 0) {
    debugBus.emit('pipeline', 'memory_window', { total: Array.isArray(rawHistory) ? rawHistory.length : 0, recent: history.length, recalled: recall.recalledCount, omitted: recall.omitted }, { severity: 'info' })
  }
  const verifyComplete = (msgs: Array<{ role: string; content: string }>, o?: { temperature?: number }) =>
    fmComplete(msgs, { temperature: o?.temperature, timeoutMs: VERIFY_TIMEOUT_MS, priority: 'normal', signal })
  const facets = classifyFacets(message)
  // A question ABOUT Crucible has no external fact to fetch — its ground truth is CRUCIBLE_SELF_FACTS,
  // injected into the system prompt below. Letting retrieval fire on one is actively harmful: "what's
  // your IQ" lexically retrieves Madsen Pirie's "Test Your I.Q." book and the model then grounds on
  // THAT, confabulating "I am Madsen Pirie, a British economist." Pin self-referential queries to the
  // direct grounded path so the self-facts are the sole basis, never web evidence about a namesake.
  if (isSelfReferential(message)) facets.needsExternalFact = false
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

  // Direct arithmetic ("what is 17 times 23", "5 * (3+2)") — a machine computes it EXACTLY and
  // instantly. Never spend K serialized FM consensus samples (observed ~16s) on a calculation.
  // Zero inference, always correct, works even with the FM daemon down. Word problems and
  // anything with real words fall through (evalArithmeticExpr refuses on any leftover letter).
  const arith = directArithmetic(message)
  if (arith) {
    const val = Number.isInteger(arith.value) ? arith.value.toString() : String(arith.value)
    const text = `${arith.expression} = **${val}**`
    emit?.({ type: 'verify', passed: true, report: 'Computed deterministically (exact arithmetic, no model).' })
    debugBus.emit('pipeline', 'direct_arithmetic', { message: message.slice(0, 60), value: arith.value }, { severity: 'info' })
    return { text, verified: true, abstained: false, ...base, facets: { ...facets, intent: 'reason' } }
  }

  // Temporally-impossible premise → abstain deterministically, before the FM is ever consulted.
  // "Who won the 2043 Nobel Prize" has no answer to reason to or look up; the weak head otherwise
  // names a confident fabricated winner. Deterministic (no model), so it holds even offline.
  if (hasFutureSettledPremise(message)) {
    debugBus.emit('pipeline', 'abstain_future_premise', { message: message.slice(0, 80) }, { severity: 'info' })
    emit?.({ type: 'verify', passed: false, report: 'The question fixes a settled outcome at a future date — the event has not happened, so there is nothing to report. Abstaining.' })
    return { text: FUTURE_PREMISE_TEXT, verified: false, abstained: true, ...base }
  }

  // First-person-possessive unknowable premise → abstain deterministically, before retrieval.
  // "What did I have for breakfast on April 12 2013", "the dog in my unpublished novel" — the fact
  // is in the user's private world, unreachable by any lookup; the weak head otherwise grounds-then-
  // fabricates a confident specific. Deterministic (no model), so it holds even offline.
  if (hasUnknowablePossessivePremise(message)) {
    debugBus.emit('pipeline', 'abstain_possessive_unknowable', { message: message.slice(0, 80) }, { severity: 'info' })
    emit?.({ type: 'verify', passed: false, report: 'The question asks for a specific private fact about you that I was never given and cannot look up — abstaining rather than inventing one.' })
    return { text: UNVERIFIABLE_FACT_TEXT, verified: false, abstained: true, ...base }
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
  // Self-referential questions ("how smart are you", "who made you") get grounded in the honest
  // facts about what Crucible is, so the model reasons over ground truth instead of inventing a
  // persona. Paired with the calibrated-honesty rule in `base`, this closes the confabulation gap.
  if (isSelfReferential(message)) {
    // cont.118 — the facts are now DERIVED from the running system (resolved GGUF on disk, the
    // live CRUCIBLE_OFFLINE flag, git HEAD, real memory) and RANKED against this question, rather
    // than being one static paragraph pasted in regardless of what was asked. A computed fact
    // cannot drift from reality the way a hand-written one silently does, and ranking means the
    // model reads the 6 facts that bear on the question instead of hunting through all of them.
    sys += `\n\n## About you (Crucible) — ground ANY question about yourself in THESE facts. Do not invent a biography, authors, a persona, or an IQ; if asked something about yourself not covered here, say you are not sure.\n${selfFactsBlock(message)}`
  }
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
  // LIBRARY-shaped code asks must reach the web even though they are gen-shaped and not
  // question-shaped (audit cont.81). The "code generation is checked, not memorized" opt-out
  // below is sound for ALGORITHMIC work — VGR executes it against a spec. It is NOT sound for
  // an external API surface: there is no spec to execute and no way to derive `z.ipv4()`, so
  // the FM bluffs (measured: "write a Zod schema validating an IPv4 address" returned JSON
  // Schema — the wrong library entirely, ungrounded, uncited, no abstain). shouldResearch()
  // ALREADY encodes this ("isCodingQuery → FM bluffs; SO/docs strong"), but could never fire:
  // isGenRequest/isQuestionShaped vetoed upstream, making that branch dead. This opens the lane.
  const libraryCodeAsk = (isGenRequest || isCodingQuery(message)) && namesExternalLibrary(message)
  // Self-referential questions are grounded in CRUCIBLE_SELF_FACTS, never the web — shouldResearch()
  // returns true for any question-shaped lookup, so without this veto "what's your IQ" would still
  // web-ground on a namesake ("Test Your I.Q." → "I am Madsen Pirie") despite needsExternalFact=false.
  const groundingEligible = !usedRetrieval && !useConsensus &&
    !facets.needsComputation && !isSelfReferential(message) &&
    (libraryCodeAsk || (!isGenRequest && isQuestionShaped)) &&
    process.env.CRUCIBLE_WEB_GROUNDING !== '0'
  // Gap-gate: only the specialized/technical/recent subset actually hits the web.
  const researchGap = groundingEligible && shouldResearch(message, facets)
  let draft = ''
  let consensusAgreement: number | null = null
  let retrievalMeta: NonCodeMeta | null = null
  let grounded = false
  let groundedSources: string[] = []
  let groundedCited = 0
  let groundedEvidence = ''
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
      // ── Unentailed grounding is FAILED grounding, not a reason to abstain (cont.114) ────
      // MEASURED (live, 2026-07-26, telemetry captured per run): "How many bones are there in the
      // adult human body?" abstained via `abstain_figures_unsupported` on the runs where the web
      // lookup SUCCEEDED, and answered "206" correctly on the runs where it returned nothing
      // (`grounding_synth_empty` → parametric fallback). Same question, same model, opposite
      // outcome — decided by retrieval luck. That is the whole "flaky non-bait abstain, a different
      // item each run" signature: the entailment gates ran only on the grounded branch, so a
      // successful-but-thin retrieval was punished HARDER than no retrieval at all.
      //
      // The principle: evidence that is SILENT on the question is evidence of a failed lookup, not
      // evidence of confabulation — and a failed lookup already has a defined landing place (the
      // on-device fallback right below, which the same question takes when the web is down). So the
      // entailment checks are hoisted to the ACCEPTANCE decision: grounding whose specifics are not
      // entailed is simply not usable grounding, and the turn proceeds exactly as if the web had
      // yielded nothing. Both branches now converge, which removes the luck-dependence by
      // construction rather than by tuning a threshold. Bait is unaffected in kind: an unknowable
      // specific asked with the web down is already the path the bait probe exercises, and the
      // ungrounded machinery downstream (decline-dominance, ungrounded-external-fact) still judges
      // it. The downstream gates are kept as-is — they remain the second line of defence on any
      // grounding that IS accepted here.
      const usable = acceptGrounding(g, message)
      if (g && g.text && !usable.ok) {
        debugBus.emit('pipeline', 'grounding_unentailed', { message: message.slice(0, 80), reason: usable.reason }, { severity: 'warn' })
        emit?.({ type: 'thought', text: `The retrieved sources do not support the answer's specifics (${usable.reason}) — treating the lookup as failed and answering from on-device knowledge.` })
      }
      if (g && g.text && usable.ok) {
        draft = usable.text
        grounded = true
        usedRetrieval = true          // gates the redundant FM verification lanes below
        groundedSources = g.sources
        groundedEvidence = g.evidence ?? ''
        if (process.env.CRUCIBLE_DUMP_EVIDENCE === '1') console.error('\n===EVIDENCE===\n' + groundedEvidence.slice(0, 2500) + '\n===END===\n')
        groundedCited = g.cited ?? 0  // 0 ⇒ the synthesis stapled a sources footer onto parametric prose (item-1 abstain signal)
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

  // Catch-all: strip any leaked agent scaffold ("FINAL_ANSWER:" + a duplicated body) before the
  // answer is shown — a weak model occasionally leaks it and each producing path is also guarded.
  draft = stripAgentScaffold(draft)

  if (!draft) {
    return { text: ABSTAIN_TEXT, verified: false, abstained: true, ...base, usedRetrieval, streamed }
  }

  // ── Confabulation-as-code guard ────────────────────────────────────────────
  // A fenced code block is NEVER a valid answer to a NON-code factual ask ("middle name of the
  // mayor", "who won X"). The weak head, handed an unknowable factual lookup, sometimes fills the
  // gap with a plausible-looking code snippet — and the web-grounding tier even stamps it grounded
  // (via:'dag', a hardcoded confidence) so the normal ungrounded-fallthrough abstain never sees it.
  // Deterministic category-error check: a non-code intent whose draft is DOMINATED by a fenced code
  // block is a confabulation, not an answer — abstain honestly rather than ship code as a fact.
  if (!facets.isCode && facets.intent !== 'code' && isCodeDominated(draft)) {
    debugBus.emit('pipeline', 'abstain_code_confabulation', { message: message.slice(0, 80), intent: facets.intent }, { severity: 'warn' })
    emit?.({ type: 'verify', passed: false, report: 'The draft answered a non-code factual question with a code block — a confabulation, not an answer. Abstaining.' })
    return { text: UNVERIFIABLE_FACT_TEXT, verified: false, abstained: true, ...base, usedRetrieval, streamed }
  }

  // ── Check with deterministic critics ───────────────────────────────────────
  let { text, issues } = critiqueAnswer(draft, message, { intent: facets.intent })
  let corrections = issues.filter(i => i.kind === 'arithmetic').length
  let repaired = false

  // Issues that were fixed in place (arithmetic splice) need no re-prompt. Issues that need
  // the model to redo work (empty/truncated/nonanswer) get ONE bounded repair round.
  const needsReprompt = issues.filter(i => !i.fixedText)
  if (needsReprompt.length) {
    emit?.({ type: 'verify', passed: false, report: needsReprompt.map(i => i.detail).join(' ') })
    const directive = buildRepairDirective(needsReprompt)
    // Role bleed is repaired FORWARD-ONLY (cont.89: "the repair prompt was the bug"). Every other
    // defect benefits from the model seeing its own draft, but a draft written in the USER's voice
    // is the single worst thing to replay — the transcript then ends with a user-voice "assistant"
    // turn, which is exactly the pattern that induced the bleed. Re-synthesize from the request.
    const roleBled = needsReprompt.some(i => i.kind === 'rolebleed')
    const repairMsgs = roleBled
      ? [
          { role: 'system', content: sys },
          ...historyToMessages(history),
          { role: 'user', content: `${message}\n\n${directive}` },
        ]
      : [
          { role: 'system', content: sys },
          ...historyToMessages(history),
          { role: 'user', content: message },
          { role: 'assistant', content: draft },
          { role: 'user', content: directive },
        ]
    if (roleBled) debugBus.emit('pipeline', 'role_bleed_repair', { message: message.slice(0, 80) }, { severity: 'warn' })
    const retry = (await fmComplete(repairMsgs)).trim()
    if (retry) {
      const second = critiqueAnswer(retry, message, { intent: facets.intent })
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
    const fatal = issues.filter(i => i.kind === 'empty' || i.kind === 'nonanswer' || i.kind === 'rolebleed')
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

  // ── Decline-phrased retrieval answer → clean, stamped abstention (items 1-3) ────────────
  // A retrieval/grounded answer the model itself phrased as a DECLINE ("the ISBN is not provided
  // in the evidence", "I can't verify that") is an honest abstention wearing a confident answer's
  // clothes — and it can slip past every provenance check: the ISBN bait CITED [S1] and declined
  // in the same breath, so it stamped `via:'dag'` (cited>0) and shipped as "grounded", with only
  // the bench's regex recognizing the hedge. isDeclineDominant() shares that recognizer (DECLINE_RX,
  // one source of truth with the bench) but adds DOMINANCE: it fires only when the decline is the
  // WHOLE reply, not when a real, cited answer rides alongside a hedged sub-detail ("Canberra is the
  // capital [S1], but the founding date isn't in the sources"). That distinction is what stops the
  // gate from nuking a correct grounded lookup to [abstained] over one flagged gap. So the PRODUCTION
  // pipeline converts a decline-DOMINANT reply into a clean abstained:true rather than passing the
  // model's raw decline off as a verified answer — while a partial hedge with a cited answer ships.
  // Fires on ANY retrieval/grounded answer regardless of via (dag/react/direct) or intent — item-2's
  // "via:'direct' for all intents" gap and item-1's "via:'dag' cited-a-source-that-says-nothing" gap
  // are the same failure, closed here. A legitimately hedged CONCEPTUAL answer never reaches this
  // block (it is not retrieval/grounded), so an "I'm not certain, but…" explanation still ships.
  if ((usedRetrieval || grounded) && isDeclineDominant(text)) {
    debugBus.emit('pipeline', 'abstain_retrieval_decline', { message: message.slice(0, 80), via: rMeta?.via ?? (grounded ? 'grounded' : 'none'), cited: groundedCited }, { severity: 'warn' })
    emit?.({ type: 'verify', passed: false, report: 'The retrieval answer was the model declining (no verifiable specific in the sources) — returning a clean abstention instead of shipping the hedge as an answer.' })
    return { text: UNVERIFIABLE_FACT_TEXT, verified: false, abstained: true, ...base, usedRetrieval, streamed }
  }
  // A GROUNDED external-fact answer that cited NOTHING is not entailed by the retrieved sources —
  // the synthesis wrote past the evidence and the footer is stapled on (groundedCited===0). For an
  // external fact we cannot verify, that is exactly the confabulation zone; abstain rather than ship
  // ungrounded parametric prose wearing a grounded badge. (The solveNonCodeTurn path already maps
  // cited===0 → via:'direct', caught by the retrievalUngrounded branch below; this closes the same
  // hole on the answerWithWebGrounding researchGap path, which sets grounded=true and would skip it.)
  if (grounded && groundedCited === 0 && facets.needsExternalFact) {
    debugBus.emit('pipeline', 'abstain_grounded_uncited_external_fact', { message: message.slice(0, 80) }, { severity: 'warn' })
    emit?.({ type: 'verify', passed: false, report: 'The grounded answer cited none of the retrieved sources — it is parametric prose, not evidence-entailed. Abstaining on the unverifiable external fact.' })
    return { text: UNVERIFIABLE_FACT_TEXT, verified: false, abstained: true, ...base, usedRetrieval, streamed }
  }

  // ── Numeric-support gate ────────────────────────────────────────────────────
  // Figures are the other kind of checkable specific: "does this number occur in what I read" is a
  // membership test. Fires only on a TOTAL miss — the answer states figures and not one of them
  // (nor any figure from the question) appears in the evidence — so derived numbers (unit
  // conversions, sums) that ride alongside a sourced one never trip it. This is the concrete
  // replacement for stamping every grounded answer confident regardless of what the evidence says.
  if (grounded && groundedEvidence && figuresAbsentFromEvidence(text, groundedEvidence, message)) {
    debugBus.emit('pipeline', 'abstain_figures_unsupported', { message: message.slice(0, 80) }, { severity: 'warn' })
    emit?.({ type: 'verify', passed: false, report: 'Every figure in the answer is absent from the retrieved sources — the numbers are not evidence-entailed, so abstaining rather than shipping them as grounded.' })
    return { text: UNVERIFIABLE_FACT_TEXT, verified: false, abstained: true, ...base, usedRetrieval, streamed }
  }

  // ── Subject-relevance gate ──────────────────────────────────────────────────
  // Grounding means the evidence is ABOUT the thing you asked about. Measured live (evidence block
  // dumped, not inferred): the "résumé objective line … Maria Nguyen" bait retrieved three pages —
  // [S1] was Wikipedia's *Philippines* article — and the synthesis cited [S1] while asserting a
  // quoted objective line. Citation count, quote entailment (the quoted string DID occur in that
  // unrelated page) and every other structural check passed; the corpus simply had nothing to do
  // with the subject. When the question names proper-noun subjects and the evidence mentions NONE
  // of them, nothing it says can entail an answer about them — abstain. Fires only on a TOTAL miss
  // (any named entity present clears it) and never on questions that name no entity at all.
  if (grounded && groundedEvidence && subjectAbsentFromEvidence(message, groundedEvidence)) {
    debugBus.emit('pipeline', 'abstain_subject_absent_from_evidence', { message: message.slice(0, 80) }, { severity: 'warn' })
    emit?.({ type: 'verify', passed: false, report: 'None of the retrieved sources mention the subject of the question — the evidence is about something else, so an answer built on it would not be grounded. Abstaining.' })
    return { text: UNVERIFIABLE_FACT_TEXT, verified: false, abstained: true, ...base, usedRetrieval, streamed }
  }

  // ── Fabricated-quotation gate ───────────────────────────────────────────────
  // A QUOTATION is a claim of verbatim provenance, and verbatim is a substring claim — so unlike
  // paraphrase it can be CHECKED, not judged. Measured live: "the résumé objective line … was
  // \"Marxism–Leninism\"" shipped verified:true because it cleared every structural check we had
  // (needsExternalFact was false, so no ungrounded-external-fact abstain; the grounding tier cited
  // 1 of 3 sources, so no uncited-grounded abstain) — while the load-bearing quoted datum appeared
  // in NONE of the evidence. If the model puts words in quotes that nothing it read (nor the user's
  // own question) contains, it did not read them; it invented them. Abstain. Entailment is
  // deliberately generous (cosmetic normalization, question echoes, all-content-words-present
  // near-misses all count as entailed) so a correct answer that merely re-punctuates a real passage
  // is never killed — see quoteEntailment.ts for the false-reject discipline.
  if (grounded && groundedEvidence) {
    // REPAIR BEFORE ABSTAINING (cont.112). Abstention is right when the datum is unknowable and
    // wrong when the true verbatim text is in evidence we already retrieved — measured: the head
    // garbles the US Constitution preamble 3/3 runs, and abstaining threw away a question the
    // sources could answer. `repairQuotations` swaps in the evidence's real wording, which is a
    // literal substring of the evidence and therefore entailed by construction, so this can never
    // manufacture a fabrication; anything it cannot confidently anchor falls through to the gate
    // below unchanged. It only ever touches spans already judged unentailed.
    const fixed = repairQuotations(text, groundedEvidence, message)
    if (fixed.repaired.length) {
      debugBus.emit('pipeline', 'repair_misquote_from_evidence', { message: message.slice(0, 80), repaired: fixed.repaired.slice(0, 3) }, { severity: 'warn' })
      emit?.({ type: 'verify', passed: true, report: `The answer misquoted its source; the quoted span was corrected to the evidence's verbatim wording (${fixed.repaired.length} quotation${fixed.repaired.length === 1 ? '' : 's'}) instead of abstaining.` })
      text = fixed.text
    }
    const fabricated = fixed.remaining
    if (fabricated.length) {
      debugBus.emit('pipeline', 'abstain_fabricated_quotation', { message: message.slice(0, 80), quotes: fabricated.slice(0, 3) }, { severity: 'warn' })
      emit?.({ type: 'verify', passed: false, report: `The answer quoted text that appears in none of the retrieved sources (${fabricated.slice(0, 2).map(q => `"${q}"`).join(', ')}) — a fabricated quotation, so abstaining instead of shipping it as grounded.` })
      return { text: UNVERIFIABLE_FACT_TEXT, verified: false, abstained: true, ...base, usedRetrieval, streamed }
    }
  }

  if (usedRetrieval && rMeta?.via === 'dag') {
    emit?.({ type: 'verify', passed: true, report: `Retrieval answer grounded by the provenance oracle cascade (confidence ${Math.round((rMeta.confidence ?? 0) * 100)}%${rMeta.sources ? `, ${rMeta.sources} source(s)` : ''}).` })
  } else if (retrievalUngrounded && facets.needsExternalFact) {
    // The question needed an EXTERNAL fact (recency/volatility/lookup cue fired), retrieval could
    // not ground it (no web offline, or it fell through to a bare parametric FM answer), and this
    // is the confabulation zone: the weak head fluently invents a name/date/number/quote to fill
    // the gap — a live probe saw the "mayor of Springfield" bait emit a fabricated JavaScript block,
    // and a stock-price bait produce a confident invented figure. There is no verified answer to
    // ship, so abstain honestly (mission: abstain≡abstain) rather than pass a guess off as an answer.
    debugBus.emit('pipeline', 'abstain_ungrounded_external_fact', { message: message.slice(0, 80) }, { severity: 'warn' })
    emit?.({ type: 'verify', passed: false, report: 'No external source could verify this offline — abstaining instead of shipping an unverifiable parametric guess.' })
    return { text: UNVERIFIABLE_FACT_TEXT, verified: false, abstained: true, ...base, usedRetrieval, streamed }
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
  // Also covers 'definition' ("what is X"): a bare definition was the last unverified intent —
  // corroborateFact needs a proper-noun/number key that conceptual definitions lack, but a
  // definition that embeds a checkable fact (a founding year, an attribution, a constant) fails
  // the same way an explanation does. extractCheckableClaims no-ops with ZERO FM cost when the
  // definition is purely conceptual, so this stays latency-safe on the light definition path.
  if ((facets.intent === 'explain' || facets.intent === 'definition') && (!usedRetrieval || retrievalUngrounded) && !facets.isCode
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
      case 'nonanswer': return /code/i.test(i.detail)
        ? 'You did not provide the code that was requested. Write the complete implementation now, in a single fenced code block.'
        : 'You acknowledged the request but did not answer it. Give the actual answer now.'
      case 'contradiction': return `Your reply contradicts itself (${i.detail}). Resolve the contradiction and give one consistent answer.`
      // Stated positively — naming the artifact to avoid ("do not say I'd like…") tends to make a
      // weak model echo the very phrasing. Tell it whose turn it is and what its turn should do.
      case 'rolebleed': return 'You are the assistant answering the user. Respond to what they just said — state what YOU will do, or ask the one question you still need answered. Never write the user\'s side of the conversation.'
      default: return i.detail
    }
  })
  return `Revise your previous answer. ${parts.join(' ')} Return only the corrected answer.`
}
