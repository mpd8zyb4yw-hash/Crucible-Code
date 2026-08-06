// ANIMA processes signal to extract universal observations. No user data is stored at any layer.
//
// Track U — ANIMA: Autonomous Naturalistic Inference about the Machine-Agnostic
// Anthropology. The system's evolving understanding of the human condition.
// NOT user profiles. NOT session logs. Universal, falsifiable observations about
// human experience, discovered from behavioural signal, verified through epistemic
// integrity, stored anonymously, applied invisibly to make responses more human.

export type TruthDomain = 'emotional' | 'cognitive' | 'behavioral' | 'relational' | 'existential'
export type TruthStatus = 'candidate' | 'active' | 'archived'

export interface UniversalTruth {
  id: string                    // ut_XXXX
  observation: string           // falsifiable claim about human experience
  domain: TruthDomain
  confidence: number            // 0–1, rises with confirmation, falls with contradiction
  noveltyScore: number          // how non-obvious when first observed
  confirmingInstances: number
  contradictingInstances: number
  fragility: string             // what would make this wrong (unfalsifiable ⇒ rejected)
  firstObserved: string         // ISO date (day granularity — never session-identifying)
  lastUpdated: string           // ISO date
  status: TruthStatus
}

export interface EmotionalValence {
  score: number                 // -1 (distress) to +1 (positive)
  dominant: string              // 'stressed' | 'grief' | 'curious' | 'frustrated' | 'calm' | ...
  signals: string[]             // what in the conversation produced this reading
  confidence: number            // 0–1; low confidence ⇒ don't act on it
}

export interface CandidateObservation {
  observation: string
  domain: TruthDomain
  noveltyScore: number
  supportingSignals: string[]
  fragilityAssessment: string
  confidence: number
}

// Response-shaping directives returned by apply.ts. These are framing guidance,
// not explicit instructions — injected invisibly into the synthesis system prompt.
export interface ShapingDirectives {
  toneShift: 'warmer' | 'briefer' | 'more direct' | 'softer' | 'none'
  leadWith: 'answer' | 'acknowledgment' | 'question' | 'none'
  omit: string[]                // 'preamble' | 'caveats' | 'alternatives' | 'enthusiasm'
  add: string[]                 // 'one sentence acknowledgment' | 'closing warmth' | 'none'
}

// A turn of conversation. ANIMA reads these but NEVER writes them anywhere.
export interface ConversationTurn {
  user: string
  assistant: string
}

// Injected dependencies — same shape as MASTERPIECE's, kept local so ANIMA is a
// self-contained module with no cross-imports into the masterpiece layer.
export interface AnimaDeps {
  callModel: (
    model: { id: string; label: string; provider: string; isWildcard: boolean },
    messages: { role: string; content: string }[],
    opts?: { requestId?: string }
  ) => Promise<string>
  selectModels: (
    promptType: string,
    config?: unknown,
    complexity?: 'simple' | 'complex',
    mode?: string
  ) => { models: Array<{ id: string; label: string; provider: string; isWildcard: boolean }> }
  withTimeout: <T>(promise: Promise<T>, ms: number, fallback: T) => Promise<T>
  requestId?: string
}
