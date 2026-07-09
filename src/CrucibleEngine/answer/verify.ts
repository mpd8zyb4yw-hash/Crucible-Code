// Deterministic, strict-offline critics for the answer engine.
//
// MISSION: the intelligence lives in the SYSTEM, not the model. The FM is the messenger —
// so before any answer ships, the system must CHECK it with code, not trust it. Under
// CRUCIBLE_OFFLINE=strict there is no online judge to escalate to, so every critic here is
// deterministic (arithmetic evaluation, string/number entailment) — never a model call.
//
// Stage 1 ships the arithmetic critic (reusing the proven correctArithmeticCascade) plus
// cheap answer-sanity signals. Stage 2 adds word-problem recomputation; Stage 3 adds
// retrieval-grounding entailment. Each critic returns a structured Issue the engine turns
// into a targeted repair directive.

import { correctArithmeticCascade, verifyConsistency } from '../domainVerifiers'

export interface Issue {
  kind: 'arithmetic' | 'clock' | 'contradiction' | 'empty' | 'truncated' | 'nonanswer'
  /** Human-readable defect, spliced into the repair prompt so the FM fixes THIS, not vibes. */
  detail: string
  /** When set, the critic already produced a corrected text (deterministic fix, no re-prompt). */
  fixedText?: string
}

// A reply that trails off mid-token/mid-clause — small FMs do this when they hit the token
// cap. We only flag the egregious case (ends with a dangling connective / open bracket / no
// terminal punctuation on a long reply) so we don't nag on legitimately short factual answers.
function looksTruncated(text: string): boolean {
  const t = text.trimEnd()
  if (t.length < 40) return false
  if (/[.!?)\]}"'`]$/.test(t)) return false
  if (/\b(and|but|or|the|a|an|to|of|for|with|that|which|because|so|then|is|are|was)$/i.test(t)) return true
  return !/[.!?]$/.test(t) && t.length > 200
}

// The FM sometimes "answers" by restating the question or emitting meta-chatter
// ("Sure, I can help with that!") with no content. Cheap heuristic guard.
function isNonAnswer(text: string, message: string): boolean {
  const t = text.trim().toLowerCase()
  if (!t) return true
  if (/^(sure|okay|ok|certainly|of course|i can help|happy to help|let me)\b[^.!?]*[.!?]?$/i.test(t) && t.length < 60) return true
  // Pure echo of the prompt.
  if (t.length < message.length * 1.2 && t.replace(/[^a-z0-9]/g, '') === message.trim().toLowerCase().replace(/[^a-z0-9]/g, '')) return true
  return false
}

// ── Clock arithmetic critic ──────────────────────────────────────────────────
// The FM shows correct reasoning but slips on the final clock step ("4:00 PM + 3 hours =
// 3:00 PM"). Deterministically evaluate "<time> + N hours = <result>" / "adding N hours to
// <time> gives <result>" and splice the correct result when the stated one is wrong. 12-hour
// clock with am/pm, wrapping across noon/midnight. Zero inference.

function parseClock(h: string, m: string | undefined, ap: string | undefined): number | null {
  let hh = parseInt(h, 10)
  if (Number.isNaN(hh) || hh > 23) return null
  const mm = m ? parseInt(m, 10) : 0
  if (mm > 59) return null
  if (ap) { hh %= 12; if (/p/i.test(ap)) hh += 12 }
  return hh * 60 + mm
}

function fmtClock(mins: number, withAp: boolean): string {
  const t = ((mins % 1440) + 1440) % 1440
  let h = Math.floor(t / 60)
  const m = t % 60
  const mm = String(m).padStart(2, '0')
  if (!withAp) return `${h}:${mm}`
  const ap = h >= 12 ? 'PM' : 'AM'
  h %= 12; if (h === 0) h = 12
  return `${h}:${mm} ${ap}`
}

const CLOCK_TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?`

export interface ClockCorrection { expr: string; was: string; now: string }

// Result token: an optional stray leading sign (the FM writes "= -4:00 PM"), then a clock time.
const CLOCK_RESULT = String.raw`(-?\s*${CLOCK_TIME})`

// Each descriptor: the regex + which capture groups hold start-time / delta / result, plus the
// operation sign. `startAt`/`deltaAt` index into the match; the result is always the 4 groups
// beginning at `resultAt` (whole, hh, mm, ap).
interface ClockPattern { re: RegExp; sign: 1 | -1; startAt: number; deltaAt: number; resultAt: number }

function clockPatterns(): ClockPattern[] {
  return [
    // "4:00 PM + 3 hours = 7:00 PM" / "4 PM plus 3 hours is 7 PM"
    { re: new RegExp(String.raw`${CLOCK_TIME}\s*(?:\+|plus)\s*(\d{1,2})\s*hours?\s*(?:=|is|equals?|gives?)\s*${CLOCK_RESULT}`, 'gi'), sign: 1, startAt: 1, deltaAt: 4, resultAt: 5 },
    // "9:00 PM - 4 hours = 5:00 PM" / "9 PM minus 4 hours is 5 PM"
    { re: new RegExp(String.raw`${CLOCK_TIME}\s*(?:-|−|minus)\s*(\d{1,2})\s*hours?\s*(?:=|is|equals?|gives?)\s*${CLOCK_RESULT}`, 'gi'), sign: -1, startAt: 1, deltaAt: 4, resultAt: 5 },
    // "adding 3 hours to 4:00 PM gives 7:00 PM"
    { re: new RegExp(String.raw`adding\s*(\d{1,2})\s*hours?\s*to\s*${CLOCK_TIME}\s*(?:=|is|equals?|gives?|results? in)\s*${CLOCK_RESULT}`, 'gi'), sign: 1, startAt: 2, deltaAt: 1, resultAt: 5 },
    // "subtract 4 hours from 9:00 PM = 5:00 PM"
    { re: new RegExp(String.raw`subtract(?:ing)?\s*(\d{1,2})\s*hours?\s*from\s*${CLOCK_TIME}\s*(?:=|is|equals?|gives?|results? in)\s*${CLOCK_RESULT}`, 'gi'), sign: -1, startAt: 2, deltaAt: 1, resultAt: 5 },
  ]
}

export function correctClockArithmetic(text: string): { text: string; corrections: ClockCorrection[] } {
  const corrections: ClockCorrection[] = []
  for (const { re, sign, startAt, deltaAt, resultAt } of clockPatterns()) {
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const start = parseClock(m[startAt], m[startAt + 1], m[startAt + 2])
      const delta = parseInt(m[deltaAt], 10)
      const resultWhole = m[resultAt]
      const stated = parseClock(m[resultAt + 1], m[resultAt + 2], m[resultAt + 3])
      if (start === null || stated === null || Number.isNaN(delta)) continue
      const correct = ((start + sign * delta * 60) % 1440 + 1440) % 1440
      if (correct === stated && !/^\s*-/.test(resultWhole)) continue // right value AND no stray sign
      const withAp = /[ap]\.?m/i.test(resultWhole)
      const now = fmtClock(correct, withAp)
      corrections.push({ expr: `${fmtClock(start, true)} ${sign < 0 ? '-' : '+'} ${delta}h`, was: resultWhole.trim(), now })
      const idx = m.index + m[0].lastIndexOf(resultWhole)
      text = text.slice(0, idx) + now + text.slice(idx + resultWhole.length)
      re.lastIndex = idx + now.length
    }
  }
  return { text, corrections }
}

/**
 * Run the Stage-1 deterministic critics over a drafted answer.
 * Returns the (possibly arithmetic-corrected) text and any issues that need a repair round.
 * Never throws, never calls a model.
 */
export function critiqueAnswer(draft: string, message: string): { text: string; issues: Issue[] } {
  const issues: Issue[] = []
  let text = draft ?? ''

  if (!text.trim()) {
    issues.push({ kind: 'empty', detail: 'The answer was empty.' })
    return { text, issues }
  }

  // ── Arithmetic critic — deterministic oracle, corrects in place (no re-prompt needed). ──
  try {
    const { text: fixed, corrections } = correctArithmeticCascade(text)
    if (corrections.length) {
      text = fixed
      issues.push({
        kind: 'arithmetic',
        detail: corrections.map(c => `${c.expr} = ${c.now} (answer said ${c.was})`).join('; '),
        fixedText: fixed,
      })
    }
  } catch { /* non-blocking: keep the original text */ }

  // ── Clock arithmetic critic — corrects "<time> + N hours = <wrong time>" in place. ──
  try {
    const { text: fixed, corrections } = correctClockArithmetic(text)
    if (corrections.length) {
      text = fixed
      issues.push({
        kind: 'clock',
        detail: corrections.map(c => `${c.expr} = ${c.now} (answer said ${c.was})`).join('; '),
        fixedText: fixed,
      })
    }
  } catch { /* non-blocking */ }

  // ── Consistency critic — self-contradiction (reassigned values, always/never, etc.). ──
  // Not deterministically fixable, so it triggers an FM repair round rather than an in-place edit.
  try {
    const { passed, issues: consIssues } = verifyConsistency(text, message)
    if (!passed && consIssues.length) {
      issues.push({ kind: 'contradiction', detail: consIssues.join('; ') })
    }
  } catch { /* non-blocking */ }

  if (isNonAnswer(text, message)) {
    issues.push({ kind: 'nonanswer', detail: 'The reply acknowledged the request but did not actually answer it.' })
  } else if (looksTruncated(text)) {
    issues.push({ kind: 'truncated', detail: 'The answer appears cut off before finishing.' })
  }

  return { text, issues }
}

/** True when the only issues were deterministically fixed in place (no FM repair round needed). */
export function allFixedInPlace(issues: Issue[]): boolean {
  return issues.length > 0 && issues.every(i => !!i.fixedText)
}
