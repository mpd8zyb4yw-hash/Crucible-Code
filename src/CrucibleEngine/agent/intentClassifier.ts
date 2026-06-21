// Fast intent classifier for Remote Brain agentic mode.
// Runs before every message to decide dispatch path.
// No LLM call — pure regex + heuristic, sub-millisecond.
//
// Categories:
//   simple_command        — direct AppleScript/shell dispatch, no LLM loop
//   complex_task          — full agent loop (multi-step, ambiguous, stateful)
//   conversational_redirect — mid-task correction; must mutate task state, not start fresh
//   conversational_reply  — normal chat, not an action request

export type IntentClass =
  | 'simple_command'
  | 'complex_task'
  | 'conversational_redirect'
  | 'conversational_reply'

export interface ClassifyResult {
  intent: IntentClass
  confidence: 'high' | 'medium' | 'low'
  redirectTarget?: string  // for conversational_redirect: what the new target is
}

// Signals that the user is correcting or aborting a current in-flight task
const REDIRECT_PATTERNS = [
  /\b(actually|wait|no|stop|cancel|nevermind|never mind|forget it|instead|go back|undo)\b/i,
  /\bdon'?t\s+(do|open|play|search|show|go)\b/i,
  /\bi (don'?t want|changed my mind)\b/i,
  /\b(open|go to|show me|switch to|use)\s+\w+\s+instead\b/i,
]

// Simple single-step commands the Layer 0 router can dispatch directly
const SIMPLE_COMMAND_PATTERNS = [
  /^(open|launch|start|close|quit|hide|show)\s+\w+(\s+\w+)?$/i,
  /^(play|pause|stop|next|previous|mute|unmute|volume\s+(up|down|to))\b/i,
  /^(take\s+a\s+screenshot|screenshot)\b/i,
  /^(empty\s+trash|clear\s+clipboard)\b/i,
  /^click\s+.{1,40}$/i,
  /^type\s+.{1,80}$/i,
  /^press\s+(enter|return|escape|esc|tab|space|delete)\b/i,
  /^(increase|decrease|set)\s+volume\b/i,
  /^(go\s+to|navigate\s+to)\s+https?:\/\//i,
]

// Complex multi-step patterns that need the full agent loop
const COMPLEX_TASK_PATTERNS = [
  /\b(go to|navigate to|open).{3,50}(and|then|after)\b/i,
  /\b(search|find|look\s+for|play).{3,50}(on|in|using)\b/i,
  /\bremove\b.{2,40}\bold\b/i,
  /\bconnect.{2,40}\bto\b/i,
  /\b(set\s+up|configure|install|download|update)\b/i,
  /\b(first|then|after\s+that|finally|next)\b.*\b(open|click|type|go)\b/i,
  /\b\d+\s+(step|thing|action|task)s?\b/i,
]

// Phrases that suggest pure conversation, not action
const CONVERSATIONAL_PATTERNS = [
  /^(what|how|why|when|where|who|can you|could you|do you|is it|does|tell me|explain)/i,
  /\b(think|believe|opinion|suggest|recommend|idea|thought)\b/i,
  /^(yes|no|ok|okay|thanks|thank you|got it|understood|sure|great|cool|nice|sounds good)/i,
]

export function classifyIntent(
  message: string,
  opts?: { hasActiveTask?: boolean; history?: string[] }
): ClassifyResult {
  const msg = message.trim()
  const lower = msg.toLowerCase()

  // Empty message → treat as conversational
  if (!msg) return { intent: 'conversational_reply', confidence: 'high' }

  // Check redirect first — takes priority over other classifications
  // Only meaningful when there is an active in-flight task
  if (opts?.hasActiveTask) {
    for (const pat of REDIRECT_PATTERNS) {
      if (pat.test(msg)) {
        // Extract what the new target might be (words after "instead", "open X instead", etc.)
        const insteadMatch = msg.match(/\b(open|go to|use|switch to|play)\s+(.+?)(?:\s+instead)?$/i)
        return {
          intent: 'conversational_redirect',
          confidence: 'high',
          redirectTarget: insteadMatch?.[2]?.trim(),
        }
      }
    }
    // Short follow-up after a task likely means redirect or clarification
    if (msg.split(/\s+/).length <= 4 && /\b(actually|but|wait|hmm)\b/i.test(msg)) {
      return { intent: 'conversational_redirect', confidence: 'medium' }
    }
  }

  // Redirect patterns also apply without an active task (catches "actually go back" etc.)
  if (REDIRECT_PATTERNS[0].test(msg) || REDIRECT_PATTERNS[1].test(msg)) {
    const insteadMatch = msg.match(/\b(open|go to|use|switch to|play)\s+(.+?)(?:\s+instead)?$/i)
    if (insteadMatch) {
      return {
        intent: 'conversational_redirect',
        confidence: 'medium',
        redirectTarget: insteadMatch[2]?.trim(),
      }
    }
  }

  // Pure conversational?
  for (const pat of CONVERSATIONAL_PATTERNS) {
    if (pat.test(msg)) {
      // Could still be an action if it also contains action verbs
      const hasAction = /\b(open|play|search|find|go to|click|type|download|install)\b/i.test(msg)
      if (!hasAction) return { intent: 'conversational_reply', confidence: 'high' }
    }
  }

  // Simple single-step command?
  for (const pat of SIMPLE_COMMAND_PATTERNS) {
    if (pat.test(msg)) {
      return { intent: 'simple_command', confidence: 'high' }
    }
  }

  // Complex multi-step task?
  for (const pat of COMPLEX_TASK_PATTERNS) {
    if (pat.test(msg)) {
      return { intent: 'complex_task', confidence: 'high' }
    }
  }

  // Word count heuristic: short messages with action verbs = simple, long = complex
  const wordCount = msg.split(/\s+/).length
  const hasActionVerb = /\b(open|launch|play|search|find|go|click|type|close|quit|download|install|navigate|browse)\b/i.test(msg)

  if (hasActionVerb) {
    if (wordCount <= 6) return { intent: 'simple_command', confidence: 'medium' }
    if (wordCount >= 10) return { intent: 'complex_task', confidence: 'medium' }
    return { intent: 'complex_task', confidence: 'low' }
  }

  return { intent: 'conversational_reply', confidence: 'low' }
}
