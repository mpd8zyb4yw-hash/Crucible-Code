// Conversational counterpart to Tier 2.4 ambiguity.ts (which resolves code-goal
// references against the semantic index). This handles the non-code conversational
// path (server.ts offline-first conversational block), which has no equivalent
// pre-check today: solveNonCodeTurn() is handed the raw message and will always try
// to produce a confident answer, even when the request is missing something no
// amount of reasoning can supply (what "it" refers to, which location, which bug).
//
// Pure + deterministic + no model — mirrors the abstain/false-premise philosophy of
// declining rather than guessing, but for the "under-specified" failure mode instead
// of "unknowable" or "false premise".

export interface ClarifyDecision {
  needsClarification: boolean
  question: string
}

// Verbs that take a required, non-inferable argument (what to book, translate,
// send, etc.). When one of these fires on a bare pronoun object with no other
// concrete noun in a short command, the target is genuinely missing, not just
// implicit — asking beats guessing.
const ACTION_VERBS = 'book|schedule|reserve|translate|send|order|buy|forward|email|text|cancel|reschedule'
const ACTION_DANGLING_PRONOUN_RX = new RegExp(
  `\\b(${ACTION_VERBS})\\b(?:(?![.?!]).)*\\b(it|this|that|them)\\b`, 'i'
)

// Weather/local-condition questions implicitly need a place. Scoped to short,
// immediate-tense phrasing (not "in exactly 100 days" style, which is an abstain
// case regardless of location — see a006 in CONVOEDGE_50).
const WEATHER_NO_LOCATION_RX = /\b(is it going to|will it|going to)\s+(rain|snow|hail|be sunny|be cloudy)\b/i
const HAS_LOCATION_RX = /\b(here|my (?:location|city|area|house|town)|in [A-Z][a-z]+|at [A-Z][a-z]+)\b/

// "Fix/solve/debug the bug/issue/error" with nothing identifying which one —
// no file path, no error text, no code identifier.
const VAGUE_PROBLEM_RX = /\b(fix|solve|debug|resolve)\b.*\b(the\s+)?(bug|issue|error|problem)\b/i
const HAS_SPECIFICS_RX = /[\w./-]+\.\w{1,5}\b|error[:\s]|exception|line\s+\d+|`[^`]+`/i

function shortCommand(message: string, maxWords = 8): boolean {
  return message.trim().split(/\s+/).filter(Boolean).length <= maxWords
}

function hasDigits(message: string): boolean {
  return /\d/.test(message)
}

export function detectConversationalClarify(message: string): ClarifyDecision {
  const trimmed = message.trim()

  if (ACTION_DANGLING_PRONOUN_RX.test(trimmed) && shortCommand(trimmed)) {
    const verb = trimmed.match(ACTION_DANGLING_PRONOUN_RX)?.[1]?.toLowerCase() ?? 'do that'
    return {
      needsClarification: true,
      question: `Could you clarify what you'd like me to ${verb}? I don't have enough detail to know what "it" refers to.`,
    }
  }

  if (WEATHER_NO_LOCATION_RX.test(trimmed) && !HAS_LOCATION_RX.test(trimmed) && !hasDigits(trimmed)) {
    return {
      needsClarification: true,
      question: 'Which location are you asking about? I\'d need a city or area to give you a real answer.',
    }
  }

  if (VAGUE_PROBLEM_RX.test(trimmed) && !HAS_SPECIFICS_RX.test(trimmed) && shortCommand(trimmed, 10)) {
    return {
      needsClarification: true,
      question: 'Which bug or file are you referring to? Could you share the error message, the file, or steps to reproduce it?',
    }
  }

  return { needsClarification: false, question: '' }
}
