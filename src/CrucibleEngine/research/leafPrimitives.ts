// ── Research Leaf Primitives ──────────────────────────────────────────────────
//
// Every bounded FM call the research DAG makes lives here.
// Pattern: FM *proposes*, caller *verifies*. None of these return certified facts.
//
// The FM constraint (3B Apple FM at :11435, no tool-calling, small context) shapes
// every prompt: fixed shape, narrow output, at most 256 tokens of generated text.
//
// FmCall is injectable so callers can use the local daemon or a test stub.

const LOCAL_FM_URL = process.env.LOCAL_INFERENCE_URL ?? 'http://127.0.0.1:11435'
const DEFAULT_TIMEOUT_MS = Number(process.env.CRUCIBLE_RESEARCH_FM_TIMEOUT ?? 18000)

// ── FM call helper ────────────────────────────────────────────────────────────

export type FmCall = (system: string, user: string, maxMs?: number) => Promise<string>

/** Build the default local-FM caller — same pattern as synthDriver._callLocalFm. */
export function makeLocalFmCall(url = LOCAL_FM_URL): FmCall {
  return async function localFmCall(system, user, maxMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    try {
      const res = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'apple-fm',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          max_tokens: 256,
          temperature: 0.1,
        }),
        signal: AbortSignal.timeout(maxMs),
      })
      if (!res.ok) return ''
      const data = await res.json() as any
      return (data.choices?.[0]?.message?.content ?? '')
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .trim()
    } catch {
      return ''
    }
  }
}

/** Singleton default caller — shared across one research session. */
export const defaultFmCall: FmCall = makeLocalFmCall()

// ── Primitive 0: ping (availability check) ───────────────────────────────────

export async function pingLocalFm(fmCall = defaultFmCall): Promise<boolean> {
  // The small Apple FM may not follow "reply with exactly: ok" instructions,
  // so we just check that we get ANY non-empty response — proving the daemon is alive.
  const reply = await fmCall('You are a helpful assistant.', 'Say the word: ready', 4000)
  return reply.length > 0
}

// ── Primitive 1: snippetAnswers ───────────────────────────────────────────────
// Does this retrieved snippet answer this question?

export type SnippetVerdict = 'yes' | 'partial' | 'no'

export interface SnippetAnswer {
  verdict: SnippetVerdict
  extractedAnswer: string   // proposed answer text (FM output — not yet verified)
  confidence: number        // 0-1, FM-estimated (used for read-reliability pass only)
}

const SNIPPET_SYSTEM =
  'You are a precise fact-extractor. Given a question and a text snippet, ' +
  'determine if the snippet answers the question. ' +
  'Reply in this EXACT format (3 lines, nothing else):\n' +
  'VERDICT: yes|partial|no\n' +
  'ANSWER: <the exact answer from the snippet, or "none" if not found>\n' +
  'CONFIDENCE: <0.1-1.0>'

export async function snippetAnswers(
  question: string,
  snippet: string,
  fmCall: FmCall = defaultFmCall,
): Promise<SnippetAnswer> {
  const user =
    `QUESTION: ${question.slice(0, 200)}\n\n` +
    `SNIPPET:\n${snippet.slice(0, 1200)}`
  const raw = await fmCall(SNIPPET_SYSTEM, user)
  return parseSnippetAnswer(raw)
}

function parseSnippetAnswer(raw: string): SnippetAnswer {
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
  let verdict: SnippetVerdict = 'no'
  let extractedAnswer = 'none'
  let confidence = 0.3

  for (const line of lines) {
    if (/^VERDICT:/i.test(line)) {
      const v = line.replace(/^VERDICT:\s*/i, '').toLowerCase().trim()
      if (v === 'yes') verdict = 'yes'
      else if (v === 'partial') verdict = 'partial'
    } else if (/^ANSWER:/i.test(line)) {
      extractedAnswer = line.replace(/^ANSWER:\s*/i, '').trim()
    } else if (/^CONFIDENCE:/i.test(line)) {
      const n = parseFloat(line.replace(/^CONFIDENCE:\s*/i, ''))
      if (!isNaN(n)) confidence = Math.max(0.1, Math.min(1.0, n))
    }
  }

  return { verdict, extractedAnswer: extractedAnswer.slice(0, 400), confidence }
}

// ── Primitive 2: extractVerbatimSpan ─────────────────────────────────────────
// FM proposes a verbatim quote from pageText that proves claim.
// The CALLER must verify the proposed span actually exists in pageText (string check).

const VERBATIM_SYSTEM =
  'You are a quote extractor. Find the EXACT sentence or phrase in the provided ' +
  'text that most directly proves the given claim. ' +
  'Copy it VERBATIM — no paraphrasing, no additions. ' +
  'If no such phrase exists, reply with: NONE\n' +
  'Reply with ONLY the quoted phrase or NONE — nothing else.'

export async function extractVerbatimSpan(
  claim: string,
  pageText: string,
  fmCall: FmCall = defaultFmCall,
): Promise<string | null> {
  // Pre-filter: chunk pageText to fit FM context
  const textChunk = pageText.slice(0, 3000)
  const user =
    `CLAIM: ${claim.slice(0, 200)}\n\n` +
    `TEXT:\n${textChunk}`
  const raw = (await fmCall(VERBATIM_SYSTEM, user)).trim()
  if (!raw || /^none$/i.test(raw)) return null
  // Strip any surrounding quotes the FM may have added
  const cleaned = raw.replace(/^["']|["']$/g, '').trim()
  if (cleaned.length < 5 || cleaned.length > 500) return null
  return cleaned
}

// ── Primitive 3: claimsContradict ────────────────────────────────────────────
// Do two verified claims say opposite things about the same topic?

export interface ContradictionCheck {
  contradicts: boolean
  explanation: string
  confidence: number  // how confident the FM is in its contradiction verdict
}

const CONTRADICTION_SYSTEM =
  'You are a logical consistency checker. Determine if two claims directly contradict each other. ' +
  'Two claims contradict if they cannot both be true at the same time about the same subject. ' +
  'Reply in this EXACT format (3 lines, nothing else):\n' +
  'CONTRADICTS: yes|no\n' +
  'EXPLANATION: <one sentence reason>\n' +
  'CONFIDENCE: <0.1-1.0>'

export async function claimsContradict(
  claimA: string,
  claimB: string,
  fmCall: FmCall = defaultFmCall,
): Promise<ContradictionCheck> {
  const user =
    `CLAIM A: ${claimA.slice(0, 300)}\n` +
    `CLAIM B: ${claimB.slice(0, 300)}`
  const raw = await fmCall(CONTRADICTION_SYSTEM, user)
  return parseContradictionCheck(raw)
}

function parseContradictionCheck(raw: string): ContradictionCheck {
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
  let contradicts = false
  let explanation = ''
  let confidence = 0.5

  for (const line of lines) {
    if (/^CONTRADICTS:/i.test(line)) {
      contradicts = /yes/i.test(line.replace(/^CONTRADICTS:\s*/i, ''))
    } else if (/^EXPLANATION:/i.test(line)) {
      explanation = line.replace(/^EXPLANATION:\s*/i, '').slice(0, 200)
    } else if (/^CONFIDENCE:/i.test(line)) {
      const n = parseFloat(line.replace(/^CONFIDENCE:\s*/i, ''))
      if (!isNaN(n)) confidence = Math.max(0.1, Math.min(1.0, n))
    }
  }

  return { contradicts, explanation, confidence }
}

// ── Primitive 3a: isPremiseBearing (FM-guided classification gate) ──────────
// premiseGrounding (3b below) asks the FM to identify AND correct a false premise
// in one shot — a compound task that misfires on ordinary "explain how X works"
// questions with no embedded claim to check, producing a hallucinated "correction"
// that overwrites an otherwise-correct grounded answer (observed on explain-category
// questions like "explain the water cycle" and "how does a refrigerator keep food
// cold" — the FM invented a contradiction where none existed). This gate runs FIRST
// and asks a narrower, easier question: does this question presuppose a specific,
// checkable factual claim about a named subject/event (myth/trivia-shaped, like "why
// did Einstein fail math" or "why is X the only Y"), or does it ask to explain the
// general mechanism of a real, well-established phenomenon (like "how does a
// refrigerator work" or "why is the sky blue")? Only the former should ever reach
// premiseGrounding's correction-generation step.

export interface PremiseRiskCheck {
  bearsClaim: boolean
  confidence: number
}

const PREMISE_RISK_SYSTEM =
  'Classify the QUESTION into exactly one of two types.\n' +
  'CLAIM: the question presupposes a specific, checkable factual claim about a named ' +
  'subject or event (a trivia/myth-shaped question like "why did X fail Y" or "why is ' +
  'X the only Y") — the claim itself could turn out to be true or false.\n' +
  'MECHANISM: the question asks to explain the general mechanism, process, or cause of ' +
  'a real, well-established phenomenon (e.g. "how does X work", "why does X happen", ' +
  '"explain X") — there is no specific disputable claim embedded, just a request to ' +
  'explain something already known to be true.\n' +
  'Reply in this EXACT format (2 lines, nothing else):\n' +
  'TYPE: CLAIM|MECHANISM\n' +
  'CONFIDENCE: <0.1-1.0>'

// Deterministic guard that runs BEFORE the FM classifier: an open selection question
// ("who won X?", "what is X?", "which team scored Y?") presupposes only that SOMEONE/
// SOMETHING satisfies the predicate — an existential presupposition, not a contestable
// embedded claim between named entities. The FM classifier misfires on these (observed
// live 2026-07-11: "who won the 2018 World Cup?" → bearsClaim, then checkPremiseGrounding
// invented a contradiction at confidence 1.0 and replaced the grounded answer "France"
// with its NEGATION). Premise-bearing questions this must NOT match keep their embedded
// relational claim outside the wh-slot: "when did the US buy Alaska from Canada?",
// "why did Einstein fail math?" — those start with when/why/how, not an open selection.
const OPEN_SELECTION_QUESTION =
  /^\s*(who|what|which(\s+\w+){0,2})\s+(won|wins|is|are|was|were|wrote|invented|discovered|created|directed|founded|scored|holds?|leads?|owns?|made|built|composed|painted|designed)\b/i

export async function isPremiseBearing(
  question: string,
  fmCall: FmCall = defaultFmCall,
): Promise<PremiseRiskCheck> {
  if (OPEN_SELECTION_QUESTION.test(question)) return { bearsClaim: false, confidence: 1 }
  const raw = await fmCall(PREMISE_RISK_SYSTEM, `QUESTION: ${question.slice(0, 200)}`, 12000)
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
  let bearsClaim = false
  let confidence = 0.5
  for (const line of lines) {
    if (/^TYPE:/i.test(line)) {
      bearsClaim = /claim/i.test(line.replace(/^TYPE:\s*/i, ''))
    } else if (/^CONFIDENCE:/i.test(line)) {
      const n = parseFloat(line.replace(/^CONFIDENCE:\s*/i, ''))
      if (!isNaN(n)) confidence = Math.max(0.1, Math.min(1.0, n))
    }
  }
  return { bearsClaim, confidence }
}

// ── Primitive 3b: premiseGrounding ───────────────────────────────────────────
// A question can PRESUPPOSE a claim ("When did the US buy Alaska from Canada?"
// presupposes "the US bought Alaska from Canada"; "Why is the Moon made of cheese?"
// presupposes "the Moon is made of cheese"). Plain grounded synthesis answers the
// question and parrots that presupposition straight into the answer — even when the
// verified evidence says otherwise ("from Russia", "rock") — because token-overlap
// grounding can't tell "Canada" from "Russia". This is a VERIFICATION gate, not an
// exhortation: it asks the FM to classify whether the verified facts contradict the
// question's embedded premise, and (when they do) to state the correction USING ONLY
// those facts. The label drives control flow in the DAG; the correction text is built
// from evidence, never from "be more skeptical" instructions.

export interface PremiseCheck {
  contradicted: boolean   // verified facts contradict a premise embedded in the question
  correction: string      // evidence-grounded correction (empty unless contradicted)
  confidence: number
}

const PREMISE_SYSTEM =
  'A question can PRESUPPOSE a factual claim. Your job is to check that presupposition ' +
  'against verified facts — NOT to answer the question. ' +
  'Identify any factual claim the question assumes is true, then decide whether the ' +
  'VERIFIED FACTS contradict it (state the opposite of what the question assumes about ' +
  'the same subject). Use ONLY the facts provided; never use outside knowledge. ' +
  'Reply in this EXACT format (3 lines, nothing else):\n' +
  'CONTRADICTED: yes|no\n' +
  'CORRECTION: <if yes, one sentence stating the correct fact and naming the false assumption, using only the verified facts; if no, write NONE>\n' +
  'CONFIDENCE: <0.1-1.0>'

export async function checkPremiseGrounding(
  question: string,
  verifiedFacts: string[],
  fmCall: FmCall = defaultFmCall,
  samples = Math.max(1, Number(process.env.CRUCIBLE_PREMISE_VOTES ?? 3)),
): Promise<PremiseCheck> {
  if (verifiedFacts.length === 0) return { contradicted: false, correction: '', confidence: 0 }
  const factsBlock = verifiedFacts.map((f, i) => `FACT ${i + 1}: ${f}`).join('\n')
  const notContradicted = { contradicted: false, correction: '', confidence: 0 }

  // CONSENSUS over K independent votes — a premise correction FLIPS the answer to the opposite
  // of what the question assumed, so a single hallucinated "contradicted" (the 2018-World-Cup
  // bug: one FM call said France did NOT win, at confidence 1.0) must never carry it alone.
  // A correction ships only when a strict majority independently (a) flags a contradiction and
  // (b) AGREES on what the correction is. Each vote is diversified by a benign nonce line so
  // identical cached completions don't masquerade as independent corroboration.
  const votes = await Promise.all(
    Array.from({ length: samples }, async (_, i) => {
      const user =
        `QUESTION: ${question.slice(0, 200)}\n\n` +
        `VERIFIED FACTS:\n${factsBlock.slice(0, 2000)}` +
        (samples > 1 ? `\n\n(independent review #${i + 1})` : '')
      try { return parsePremiseCheck(await fmCall(PREMISE_SYSTEM, user, 20000)) }
      catch { return { contradicted: false, correction: '', confidence: 0 } as PremiseCheck }
    }),
  )

  // A vote only counts as a real contradiction if it names a usable correction that isn't the
  // bare negation of a verified fact (the deterministic un-foolable guard, applied per vote).
  const contra = votes.filter(v =>
    v.contradicted && v.correction.trim() && !correctionNegatesEvidence(v.correction, verifiedFacts))
  if (contra.length * 2 <= samples) return notContradicted // no strict majority → outvoted

  // The majority flagged a contradiction — but do they agree on WHICH one? Cluster the
  // corrections by shared entity content; a real presupposition failure names the same
  // displaced entity ("from Russia"), whereas independent hallucinations diverge. Agreement
  // must be on the NEW asserted fact, so tokens already present in the QUESTION (the shared
  // subject) are ignored — else "X is red not blue" and "X is purple not blue" would falsely
  // corroborate on the subject "X". Require the largest agreeing cluster to be a strict majority.
  const qTokens = new Set([
    ...entityTokens(question),
    ...(question.toLowerCase().match(/[a-z]{4,}/g) ?? []),
  ])
  let best: PremiseCheck[] = []
  for (const anchor of contra) {
    const cluster = contra.filter(v => correctionsAgree(v.correction, anchor.correction, qTokens))
    if (cluster.length > best.length) best = cluster
  }
  if (best.length * 2 <= samples) return notContradicted // majority flagged but disagree on the fix

  // Ship the highest-confidence member of the agreeing majority.
  const chosen = best.reduce((a, b) => (b.confidence > a.confidence ? b : a))
  return { contradicted: true, correction: chosen.correction, confidence: best.length / samples }
}

/** Two corrections corroborate when they share an entity token or content word that is NOT
 *  already in the question — the same DISPLACED fact ("from Russia") stated two ways, rather
 *  than the shared subject the question already names. `ignore` holds the question's own tokens.
 *  Used to require the voting majority to agree on the fix, not merely on the topic. */
export function correctionsAgree(a: string, b: string, ignore: Set<string> = new Set()): boolean {
  const ea = new Set(entityTokens(a)), eb = new Set(entityTokens(b))
  for (const e of ea) if (eb.has(e) && !ignore.has(e)) return true
  const wa = new Set(a.toLowerCase().match(/[a-z]{4,}/g) ?? [])
  const wb = new Set(b.toLowerCase().match(/[a-z]{4,}/g) ?? [])
  for (const w of wa) if (!ENTITY_STOPWORDS.test(w) && wb.has(w) && !ignore.has(w)) return true
  return false
}

const NEGATORS = /\b(not|never|no|didn't|did not|doesn't|does not|isn't|is not|wasn't|was not|weren't|were not|won't|will not|cannot|can't|no longer)\b/gi

const ENTITY_STOPWORDS = /^(the|a|an|it|its|this|that|these|those|there|however|but|and|or|none|yes|no|correction)$/i

// The information carriers of a factual sentence are its named entities and numbers —
// verb-form differences ("won" vs "did not win") make word-overlap unreliable, but a
// correction that introduces NO entity absent from the fact, while adding a negator,
// is contentless negation. Entities = capitalized tokens (minus stopwords) + numbers.
function entityTokens(s: string): string[] {
  return (s.match(/\b(?:[A-Z][a-zA-Z'-]*|\d[\d,.]*)\b/g) ?? [])
    .filter(t => !ENTITY_STOPWORDS.test(t))
    .map(t => t.toLowerCase())
}

export function correctionNegatesEvidence(correction: string, verifiedFacts: string[]): boolean {
  NEGATORS.lastIndex = 0
  if (!NEGATORS.test(correction)) return false
  const corrEntities = [...new Set(entityTokens(correction))]
  if (corrEntities.length === 0) return false
  // Common-noun information carriers too: "…is not made of cheese; it is rock" displaces
  // the common noun "cheese", not a capitalized entity. Any content word (len ≥ 4, negators
  // stripped) absent from the fact means the correction carries new information.
  const corrWords = [...new Set(
    correction.toLowerCase().replace(NEGATORS, ' ').match(/[a-z]{4,}/g) ?? [],
  )]
  for (const fact of verifiedFacts) {
    NEGATORS.lastIndex = 0
    if (NEGATORS.test(fact)) continue // fact itself negated → correction may legitimately agree
    const factLower = fact.toLowerCase()
    // Every entity AND every content word of the correction already appears in this
    // non-negated fact → the correction adds nothing but the negation of that fact.
    // A genuine correction names what it displaces ("…from Russia, not Canada" against
    // a fact that never mentions Canada), so something is absent and it survives.
    if (corrEntities.every(e => factLower.includes(e)) && corrWords.every(w => factLower.includes(w))) return true
  }
  return false
}

function parsePremiseCheck(raw: string): PremiseCheck {
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
  let contradicted = false
  let correction = ''
  let confidence = 0.5
  for (const line of lines) {
    if (/^CONTRADICTED:/i.test(line)) {
      contradicted = /yes/i.test(line.replace(/^CONTRADICTED:\s*/i, ''))
    } else if (/^CORRECTION:/i.test(line)) {
      correction = line.replace(/^CORRECTION:\s*/i, '').slice(0, 300)
    } else if (/^CONFIDENCE:/i.test(line)) {
      const n = parseFloat(line.replace(/^CONFIDENCE:\s*/i, ''))
      if (!isNaN(n)) confidence = Math.max(0.1, Math.min(1.0, n))
    }
  }
  if (/^none$/i.test(correction.trim())) correction = ''
  // A "contradicted" verdict with no usable correction text is not actionable — treat
  // as not-contradicted so we never emit an empty/garbled correction.
  if (contradicted && !correction.trim()) contradicted = false
  return { contradicted, correction, confidence }
}

// ── Primitive 4: isAtomicQuestion (deterministic, no FM) ─────────────────────
// Is this question answerable from a single retrieved snippet?
// A question is atomic if it asks for exactly one fact.

const MULTI_PART = /\b(and|also|as well|in addition|furthermore|compare|versus|vs\.?|difference between|both)\b/i
const COMPOUND_SIGNALS = /[;:]|(?:\(1\)|\(2\)|\(a\)|\(b\)|first[,;]|second[,;]|finally[,;])/

export function isAtomicQuestion(question: string): boolean {
  if (question.length > 300) return false
  if (MULTI_PART.test(question) && question.split('?').length > 2) return false
  if (COMPOUND_SIGNALS.test(question)) return false
  // Count question marks — more than one suggests compound
  const qmarks = (question.match(/\?/g) ?? []).length
  if (qmarks > 1) return false
  return true
}

// ── Primitive 5: decompositionRecipe (FM-guided, template-anchored) ──────────
// Narrow a complex question into atomic sub-questions. The FM fills slot in a
// template — it never generates the structure, only the content of each slot.

const DECOMPOSE_SYSTEM =
  'You are a question decomposer. Break the given question into 2-5 simple, ' +
  'self-contained sub-questions that each ask for exactly ONE fact. ' +
  'Each sub-question should be answerable from a single paragraph. ' +
  'Reply with ONLY a numbered list of sub-questions, one per line. ' +
  'Prefix each with its number and a period. Example:\n' +
  '1. What is X?\n2. What is Y?\n3. How does X affect Y?\n' +
  'Do NOT include explanations, preamble, or commentary.'

export interface DecompositionResult {
  subQuestions: string[]
  /** true when the FM produced parseable output */
  parsed: boolean
}

export async function decomposeQuestion(
  question: string,
  fmCall: FmCall = defaultFmCall,
): Promise<DecompositionResult> {
  if (isAtomicQuestion(question)) {
    return { subQuestions: [question], parsed: true }
  }
  const raw = await fmCall(DECOMPOSE_SYSTEM, question.slice(0, 400))
  return parseDecompositionResult(raw, question)
}

function parseDecompositionResult(raw: string, fallback: string): DecompositionResult {
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
  const subQuestions: string[] = []
  for (const line of lines) {
    const m = line.match(/^\d+\.\s*(.+)/)
    if (m) {
      const q = m[1].trim()
      if (q.length >= 10 && q.length <= 300) subQuestions.push(q)
    }
    if (subQuestions.length >= 5) break
  }
  if (subQuestions.length >= 2) return { subQuestions, parsed: true }
  // Fallback: return the original question as a single item
  return { subQuestions: [fallback.slice(0, 300)], parsed: false }
}

// ── Primitive 6: read-reliability vote ───────────────────────────────────────
// Ask the FM to extract the answer from the same snippet N times.
// Measures how consistently the FM reads this particular snippet — NOT truth.
// High consistency = the extraction is stable; low = the snippet is ambiguous.

export interface ReadReliabilityResult {
  /** Number of consistent answers (agreeing on the first 40 chars) */
  agreementCount: number
  /** Representative answer from the majority */
  consensusAnswer: string
  /** 0-1: fraction of trials that agreed */
  reliability: number
}

export async function readReliabilityVote(
  question: string,
  snippet: string,
  trials = 3,
  fmCall: FmCall = defaultFmCall,
): Promise<ReadReliabilityResult> {
  const answers: string[] = []
  for (let i = 0; i < trials; i++) {
    const r = await snippetAnswers(question, snippet, fmCall)
    if (r.verdict !== 'no' && r.extractedAnswer !== 'none') {
      answers.push(r.extractedAnswer.slice(0, 40).toLowerCase().trim())
    }
  }
  if (answers.length === 0) {
    return { agreementCount: 0, consensusAnswer: '', reliability: 0 }
  }
  // Find the modal answer
  const freq = new Map<string, number>()
  for (const a of answers) freq.set(a, (freq.get(a) ?? 0) + 1)
  const [consensusKey, count] = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]
  return {
    agreementCount: count,
    consensusAnswer: consensusKey,
    reliability: count / trials,
  }
}

// ── Primitive 7: buildSearchQuery (deterministic) ────────────────────────────
// Turn a research question into an effective web search query.
// No FM needed — deterministic keyword extraction is sufficient and faster.

export function buildSearchQuery(question: string): string {
  const STOP_WORDS = /\b(what|is|are|how|does|do|why|who|when|where|explain|describe|tell|me|about|the|of|for|a|an|in|on|at|to|with|was|were|be|been|difference|between|stand|stands|exactly|right|now)\b/gi
  const q = question
    .replace(/\b(what is|what are|how does|how do|why does|why do|who is|when did|where is|explain|describe|tell me about)\b/gi, '')
    .replace(STOP_WORDS, ' ')
    .replace(/[?.,!;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return q.slice(0, 100)
}

// ── Primitive 8: groundedSynthesis ───────────────────────────────────────────
// Synthesize a final answer from verified claims.
// The FM's role is formatting only — it cannot introduce new facts.
// Caller must verify every output sentence maps to at least one verified claim.

const SYNTHESIS_SYSTEM =
  'You are a precise answer synthesizer. Write a clear, direct answer to the question ' +
  'using ONLY the verified facts provided below. ' +
  'Do NOT add any information not found in the facts. ' +
  'Do NOT hedge with "according to sources" or "based on context". ' +
  'Just state the facts directly. Be concise. ' +
  'If facts are contradictory, say so explicitly.'

export async function groundedSynthesis(
  question: string,
  verifiedFacts: string[],
  fmCall: FmCall = defaultFmCall,
): Promise<string> {
  if (verifiedFacts.length === 0) return ''
  const factsBlock = verifiedFacts.map((f, i) => `FACT ${i + 1}: ${f}`).join('\n')
  const user = `QUESTION: ${question.slice(0, 200)}\n\nVERIFIED FACTS:\n${factsBlock.slice(0, 2000)}\n\nAnswer:`
  const raw = await fmCall(SYNTHESIS_SYSTEM, user, 20000)
  return raw.trim()
}
