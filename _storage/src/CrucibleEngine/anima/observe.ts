// ANIMA processes signal to extract universal observations. No user data is stored at any layer.
//
// Candidate observation extractor. Runs AFTER a response is generated. Takes the
// conversation context + current emotional valence and asks: what does this
// interaction suggest about human experience that might be universally true?
//
// PRIVACY INVARIANT: observations are GENERALISED before they leave this function.
// The source conversation is never referenced in a candidate. Any candidate that
// still refers to "you"/"the user"/specific personal detail is rewritten to a
// universal claim or discarded — enforced by sanitiseCandidate() below.

import type { AnimaDeps, CandidateObservation, EmotionalValence, ConversationTurn, TruthDomain } from './types.js'

const VALID_DOMAINS: TruthDomain[] = ['emotional', 'cognitive', 'behavioral', 'relational', 'existential']

const OBSERVE_SYSTEM = `You are an anthropological observer studying the universal human condition. You are given an anonymised summary of an interaction and an emotional reading. Your task: propose at most 2 candidate observations about human experience that this interaction hints at.

STRICT RULES:
- FALSIFIABLE, not vacuous: "humans under stress seek sensory regulation" — NOT "people are emotional".
- GENERALISABLE: about humans in general, never about this individual. Never use "you", "the user", "this person", or any specific personal detail.
- NOVEL: a non-obvious regularity, not a truism everyone already knows.
- GROUNDED: it must plausibly follow from what happened, not free speculation.
- For each, state what would make it WRONG (its fragility). If you cannot state a fragility, do not propose it.

Return ONLY a JSON object:
{
  "observations": [
    {
      "observation": "a falsifiable universal claim about humans",
      "domain": "emotional | cognitive | behavioral | relational | existential",
      "noveltyScore": 0.0 to 1.0,
      "fragilityAssessment": "what evidence would falsify this",
      "confidence": 0.0 to 1.0
    }
  ]
}
If nothing universal and non-obvious is suggested, return { "observations": [] }.`

// Strip anything that could identify a person or leak conversation content.
// Returns null if the observation cannot be made universal.
function sanitiseCandidate(obs: string): string | null {
  let s = obs.trim()
  if (!s) return null
  // Reject candidates that personalise rather than generalise.
  if (/\b(you|your|this user|the user|this person|they (?:said|told|asked)|i was told)\b/i.test(s)) {
    // Attempt a light generalisation for "you/your" → "people/their"; if it still
    // reads as second-person after, discard.
    s = s.replace(/\byou are\b/gi, 'people are')
         .replace(/\byou\b/gi, 'people')
         .replace(/\byour\b/gi, 'their')
    if (/\b(the user|this person|this user)\b/i.test(s)) return null
  }
  // Must read as a general claim about humans, not a single event.
  if (s.length < 12) return null
  return s
}

export async function extractObservations(
  history: ConversationTurn[],
  currentPrompt: string,
  finalSynthesis: string,
  valence: EmotionalValence,
  deps: AnimaDeps,
): Promise<CandidateObservation[]> {
  // Build an ANONYMISED summary — never the raw transcript, and never a raw slice
  // of it. We pass ONLY the valence reading, abstracted signal labels, and a coarse
  // topic CLASS (no quoted user words ever reach the model). This is the privacy
  // boundary: raw conversation text does not leave this function in any form.
  const topicClass = inferTopicClass(currentPrompt || '')
  const anonSummary = [
    `Emotional reading: dominant=${valence.dominant}, score=${valence.score.toFixed(2)}, confidence=${valence.confidence.toFixed(2)}`,
    `Derived signals: ${valence.signals.join(', ') || 'none'}`,
    `Interaction topic class: ${topicClass}`,
    `Assistant responded with ~${Math.round(finalSynthesis.length / 5)} words.`,
  ].join('\n')

  // Use a small, fast model — this is a cheap background extraction.
  const { models } = deps.selectModels('analysis', undefined, 'simple')
  const model = models[0]
  if (!model) return []

  let parsed: { observations?: any[] } | null = null
  try {
    const raw = await deps.withTimeout(
      deps.callModel(model, [
        { role: 'system', content: OBSERVE_SYSTEM },
        { role: 'user', content: anonSummary },
      ], { requestId: deps.requestId }),
      12000,
      '',
    )
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    parsed = JSON.parse(cleaned)
  } catch {
    return []
  }

  if (!parsed || !Array.isArray(parsed.observations)) return []

  const out: CandidateObservation[] = []
  for (const o of parsed.observations.slice(0, 2)) {
    if (!o || typeof o.observation !== 'string') continue
    const clean = sanitiseCandidate(o.observation)
    if (!clean) continue
    const domain: TruthDomain = VALID_DOMAINS.includes(o.domain) ? o.domain : 'cognitive'
    const fragility = typeof o.fragilityAssessment === 'string' ? o.fragilityAssessment.trim() : ''
    out.push({
      observation: clean,
      domain,
      noveltyScore: clampUnit(o.noveltyScore, 0.5),
      supportingSignals: valence.signals.slice(),  // abstracted labels only — never raw text
      fragilityAssessment: fragility,
      confidence: clampUnit(o.confidence, 0.4),
    })
  }
  return out
}

function clampUnit(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : fallback
  return Math.min(1, Math.max(0, n))
}

// Abstract a prompt to a coarse topic CLASS — never returns any of the prompt's
// own words. This is what crosses the privacy boundary in place of raw text.
function inferTopicClass(prompt: string): string {
  const p = prompt.toLowerCase()
  const classes: string[] = []
  if (/\b(i feel|i'm|my (?:wife|husband|partner|mom|dad|friend|family|life|head|heart))\b/.test(p)) classes.push('personal/relational')
  if (/\b(sad|grief|lonely|anxious|angry|stressed|overwhelm|burned out|exhaust|afraid|hopeless)\b/.test(p)) classes.push('emotional')
  if (/\b(code|api|function|server|deploy|bug|algorithm|database|build|system)\b/.test(p)) classes.push('technical')
  if (/\b(meaning|purpose|why are we|death|mortality|existence|regret|forgive)\b/.test(p)) classes.push('existential')
  if (/\b(should i|what do i do|how do i|advice|decide|choice)\b/.test(p)) classes.push('decision/advice-seeking')
  if (/\?/.test(prompt)) classes.push('question')
  return classes.length ? classes.join(', ') : 'general'
}
