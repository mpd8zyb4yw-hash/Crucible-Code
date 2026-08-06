// ANIMA processes signal to extract universal observations. No user data is stored at any layer.
//
// Response-time ANIMA query. Called during response shaping, BEFORE the final
// synthesis prompt is built. Takes the current emotional valence, queries the
// Universal Truth Store for relevant active observations, and returns response
// shaping DIRECTIVES — framing guidance, not explicit instructions. These are
// injected invisibly into the synthesis system prompt. The user never sees
// "ANIMA says be warmer" — they just experience a warmer response.

import * as store from './store.js'
import type { EmotionalValence, ShapingDirectives, TruthDomain } from './types.js'

// Confidence floor — below this we do not act on the emotional reading at all.
const ACT_THRESHOLD = 0.4

const NEUTRAL: ShapingDirectives = {
  toneShift: 'none',
  leadWith: 'none',
  omit: [],
  add: [],
}

export interface ShapingResult {
  directives: ShapingDirectives
  appliedTruths: string[]   // observations that informed the shaping (for transparency/logs)
}

export function queryShaping(valence: EmotionalValence): ShapingResult {
  // Low-confidence reading ⇒ do not shape. (Privacy + safety: never act on noise.)
  if (valence.confidence < ACT_THRESHOLD) {
    return { directives: { ...NEUTRAL }, appliedTruths: [] }
  }

  // Pull active truths relevant to this emotional context.
  const truths = store.query(null, valence).slice(0, 5)
  const appliedTruths = truths.map(t => t.observation)

  const d: ShapingDirectives = { toneShift: 'none', leadWith: 'none', omit: [], add: [] }

  const distress = valence.score <= -0.3
  const deepDistress = valence.score <= -0.6
  const positive = valence.score >= 0.4

  switch (valence.dominant) {
    case 'grief':
    case 'longing':
    case 'lonely':
    case 'sad':
      d.toneShift = 'softer'
      d.leadWith = 'acknowledgment'
      d.omit = ['caveats', 'alternatives', 'enthusiasm']
      d.add = ['one sentence acknowledgment', 'closing warmth']
      break
    case 'stressed':
    case 'overwhelmed':
    case 'frustrated':
    case 'anxious':
      d.toneShift = distress ? 'warmer' : 'briefer'
      d.leadWith = 'answer'
      d.omit = ['preamble', 'caveats', 'alternatives']
      d.add = distress ? ['one sentence acknowledgment'] : []
      break
    case 'anger':
    case 'betrayal':
      d.toneShift = 'more direct'
      d.leadWith = 'answer'
      d.omit = ['preamble', 'enthusiasm']
      d.add = []
      break
    case 'curious':
      d.toneShift = 'warmer'
      d.leadWith = 'answer'
      d.omit = []
      d.add = []
      break
    case 'calm':
    default:
      if (positive) { d.toneShift = 'warmer' }
      break
  }

  if (deepDistress && d.toneShift === 'briefer') d.toneShift = 'softer'

  // Behavioural gap (small ask, large emotional context) ⇒ acknowledge, don't lecture.
  if (valence.signals.includes('gap:small-ask-large-context')) {
    if (!d.add.includes('one sentence acknowledgment')) d.add.push('one sentence acknowledgment')
    if (!d.omit.includes('caveats')) d.omit.push('caveats')
  }

  // Truth-driven nudges: if an active truth in the behavioral domain is relevant
  // under distress, bias toward brevity (don't over-explain to someone regulating).
  if (distress && truths.some(t => t.domain === 'behavioral') && d.toneShift === 'none') {
    d.toneShift = 'softer'
  }

  return { directives: d, appliedTruths }
}

// Render directives as an invisible shaping block for the synthesis system prompt.
// Returns '' when there is nothing to shape (so the prompt stays clean).
export function renderShapingBlock(directives: ShapingDirectives): string {
  const isNeutral =
    directives.toneShift === 'none' && directives.leadWith === 'none' &&
    directives.omit.length === 0 && directives.add.length === 0
  if (isNeutral) return ''

  const lines: string[] = ['RESPONSE SHAPING (invisible to user — do not mention or reference this):']
  if (directives.leadWith !== 'none') {
    const lead = directives.leadWith === 'answer' ? 'Lead with the answer directly, skip any preamble'
      : directives.leadWith === 'acknowledgment' ? 'Open with a brief, genuine acknowledgment before the substance'
      : 'Open by reflecting the question back, then answer'
    lines.push(`- ${lead}`)
  }
  if (directives.toneShift !== 'none') lines.push(`- Tone: ${directives.toneShift} than default`)
  if (directives.omit.length) lines.push(`- Omit: ${directives.omit.join(', ')}`)
  if (directives.add.length && !directives.add.includes('none')) lines.push(`- If appropriate: ${directives.add.join('; ')} — nothing more`)
  return lines.join('\n')
}

// Domain affinity helper re-exported for callers that want to pre-warm a query.
export type { TruthDomain }
