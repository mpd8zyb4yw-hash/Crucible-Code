// Track M — Conversational Intelligence
// M1: detect low-content / casual prompts and route to lightweight conversational mode.
// M2: unified voice wrapper — same tone whether casual or pipeline response.

export interface ConversationalDecision {
  isConversational: boolean
  reason: string
}

const CASUAL_PATTERNS = [
  /^(hi|hey|hello|yo|sup|hiya|howdy|good\s+(morning|afternoon|evening|day))[!.?]?$/i,
  /^(ok|okay|k|got it|sure|sounds good|alright|cool|nice|great|perfect|awesome|thanks|thank you|ty|thx)[!.?]?$/i,
  /^(test|testing|ping|check|hello world)[!.?]?$/i,
  /^(yes|no|nope|yep|yeah|nah|maybe|idk)[!.?]?$/i,
  /^(lol|lmao|haha|hehe|😂|😄)[!.?]?$/i,
  /^what's?\s+up\??$/i,
  /^how\s+(are\s+you|is\s+it\s+going|goes\s+it|you\s+doing)\??$/i,
  /^(bye|goodbye|see\s+you|later|cya|take\s+care)[!.?]?$/i,
  /^(who\s+are\s+you|what\s+are\s+you|are\s+you\s+(ai|a\s+bot|an?\s+ai))\??$/i,
  /^(ready|go|start|begin|let's\s+go|let\s+us\s+go)[!.?]?$/i,
]

const DOMAIN_SIGNAL_WORDS = [
  'how', 'why', 'what', 'when', 'where', 'which', 'who',
  'name', 'tell', 'count', 'translate', 'summarize', 'summarise', 'convert', 'estimate', 'predict',
  'explain', 'describe', 'compare', 'difference', 'help me', 'write', 'create', 'build', 'fix', 'debug',
  'analyze', 'analyse', 'calculate', 'find', 'show', 'give me', 'list', 'define',
  'implement', 'solve', 'code', 'function', 'class', 'algorithm',
]

export function detectConversational(message: string): ConversationalDecision {
  const trimmed = message.trim()
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length

  // Explicit casual patterns
  for (const pat of CASUAL_PATTERNS) {
    if (pat.test(trimmed)) {
      return { isConversational: true, reason: 'casual_pattern' }
    }
  }

  // Very short + no domain signal → conversational
  if (wordCount <= 4) {
    const lower = trimmed.toLowerCase()
    const hasDomainSignal = DOMAIN_SIGNAL_WORDS.some(w => lower.includes(w))
    if (!hasDomainSignal) {
      return { isConversational: true, reason: 'short_no_domain' }
    }
  }

  return { isConversational: false, reason: 'has_domain_content' }
}

// M2 — Voice normalization layer applied to pipeline output
// Strips robotic openers and formality markers so pipeline answers feel like
// the same voice as conversational replies. Does NOT alter factual content.
const ROBOTIC_OPENERS = [
  // Affirmation openers
  /^(Certainly|Absolutely|Of course|Sure thing|Sure!|Of course!|Definitely|Indeed)[!,.]?\s*/i,
  /^(Great question|Excellent question|That'?s? (a )?(great|excellent|wonderful|fantastic|good|interesting) question)[!,.]?\s*/i,
  /^(What (a )?(great|excellent|wonderful|interesting|fascinating) (question|topic|problem))[!,.]?\s*/i,
  // Offering-help openers (consume full sentence ending in punctuation)
  /^(I('m| am) (happy|glad|pleased|delighted) to (help|assist|explain|answer)[^.!]*[.!]\s*)/i,
  /^(I('d| would) (be happy|be glad|love) to (help|assist|explain|answer)[^.!]*[.!]\s*)/i,
  /^(I('ll| will) (help you|assist you|explain|walk you through)[^.!]*[.!]\s*)/i,
  /^(Allow me to (explain|help|assist|walk you through)[^.!]*[.!]\s*)/i,
  /^(Let me (help you|walk you through|break (this|it) down|explain)[^.!]*[.!]\s*)/i,
  // AI identity disclaimers
  /^(As an AI( language model)?,?\s+)/i,
  /^(As a (large |)language model,?\s+)/i,
  /^(As your AI assistant,?\s+)/i,
  // Announcement openers
  /^(In this (response|answer|explanation|analysis|overview),?\s+I\s+will\s+[^.]{0,60}\.?\s*)/i,
  /^(I('ll| will) (now |)(explain|describe|walk you through|cover|address|discuss|outline|break down)[^.]{0,60}\.?\s*)/i,
  /^(Here('s| is) (a |an |)(comprehensive|detailed|thorough|complete|brief|quick) (overview|explanation|breakdown|summary|guide|answer)[^:\n]{0,80}[:\n]\s*)/i,
  /^(Below (is|are|you('ll| will) find)[^:\n]{0,60}[:\n]\s*)/i,
  // Based-on openers (consume full sentence)
  /^(Based on [^.!]{5,120}[.!]\s*)/i,
  // Meta-commentary
  /^(To answer your question[,:]?\s+)/i,
  /^(To address (your|this) (question|concern|point|request)[,:]?\s+)/i,
  /^(Great[!,.]?\s+)(To |I |Here)/i,
]

const ROBOTIC_CLOSERS = [
  // Robotic sign-off block — strip one or more trailing closer sentences.
  // Applied repeatedly so "I hope this helps! Let me know if you have questions." → stripped in two passes.
  /\n{1,2}(I hope (this|that) [^.!\n]{0,120}[!.]?)\s*$/i,
  /\n{1,2}(Let me know if you [^.!]{0,120}[.!]?)\s*$/i,
  /\n{1,2}(Feel free to (ask|reach out)[^.!]{0,120}[.!]?)\s*$/i,
  /\n{1,2}(Please (don'?t hesitate to|feel free to) (ask|reach out|let me know)[^.!]{0,120}[.!]?)\s*$/i,
  /\n{1,2}(If you (have|need) [^.!]{0,120}(feel free to ask|let me know|don'?t hesitate)[^.!]{0,60}[.!]?)\s*$/i,
  /\n{1,2}(Don'?t hesitate to (ask|reach out)[^.!]{0,120}[.!]?)\s*$/i,
  /\n{1,2}(I('m| am) (here|happy|glad) (to help|if you need)[^.!]{0,80}[.!]?)\s*$/i,
  // Summary-conclusion closers
  /\n\n(In (conclusion|summary)[,:]?\s+[^.]{0,120}\.)\s*$/i,
  /\n\n(To summarize[,:]?\s+[^.]{0,120}\.)\s*$/i,
  /\n\n(Overall[,:]?\s+[^.]{0,120}\.)\s*$/i,
]

export function applyVoiceLayer(text: string): string {
  if (!text || text.length < 20) return text
  let out = text.trim()

  // Strip robotic openers from the very start — loop until no pattern matches
  // (handles chained openers: "Certainly! I'd be happy to help. Here is a...")
  let changed = true
  while (changed) {
    changed = false
    for (const pat of ROBOTIC_OPENERS) {
      const stripped = out.replace(pat, '')
      if (stripped !== out && stripped.length > 10) {
        out = stripped.charAt(0).toUpperCase() + stripped.slice(1)
        changed = true
      }
    }
  }

  // Strip robotic sign-off closers — loop until stable
  changed = true
  while (changed) {
    changed = false
    for (const pat of ROBOTIC_CLOSERS) {
      const stripped = out.replace(pat, '')
      if (stripped !== out && stripped.length > 10) {
        out = stripped
        changed = true
      }
    }
  }

  return out.trim()
}

// M2 — Build a natural conversational response (no ensemble, no calibration)
// The response should feel like presence, not a tool output.
export function buildConversationalFallback(message: string): string {
  const trimmed = message.trim().toLowerCase()

  // Identity questions
  if (/who\s+are\s+you|what\s+are\s+you|are\s+you\s+(ai|a\s+bot|an?\s+ai)/.test(trimmed)) {
    return "I'm Crucible — a multi-model AI system. What can I help you with?"
  }

  // Greetings
  if (/^(hi|hey|hello|yo|sup|hiya|howdy)[!.?]?$/.test(trimmed) || /^(good\s+(morning|afternoon|evening|day))[!.?]?$/.test(trimmed)) {
    return "Hey — what's on your mind?"
  }

  // Farewells
  if (/^(bye|goodbye|see\s+you|later|cya|take\s+care)[!.?]?$/.test(trimmed)) {
    return "See you. Feel free to come back anytime."
  }

  // Test / ping
  if (/^(test|testing|ping|check|hello world)[!.?]?$/.test(trimmed)) {
    return "Ready when you are — what's up?"
  }

  // Affirmations
  if (/^(ok|okay|k|got it|sure|sounds good|alright|cool|nice|great|perfect|awesome)[!.?]?$/.test(trimmed)) {
    return "Got it. What do you need?"
  }

  // Thanks
  if (/^(thanks|thank you|ty|thx)[!.?]?$/.test(trimmed)) {
    return "Of course. Anything else?"
  }

  // How are you
  if (/how\s+(are\s+you|is\s+it\s+going|you\s+doing)/.test(trimmed)) {
    return "Doing well — focused and ready. You?"
  }

  // Yes/no one-liners
  if (/^(yes|yep|yeah)[!.?]?$/.test(trimmed)) return "Let's go — what do you need?"
  if (/^(no|nope|nah)[!.?]?$/.test(trimmed)) return "No problem. Anything else I can do?"

  // Default: acknowledge and invite
  return "Got it. What would you like help with?"
}
