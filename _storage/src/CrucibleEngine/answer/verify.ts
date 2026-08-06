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
  kind: 'arithmetic' | 'clock' | 'contradiction' | 'empty' | 'truncated' | 'nonanswer' | 'rolebleed'
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

// ── Role-bleed critic ────────────────────────────────────────────────────────────────────
// A weak FM handed a conversation that ends in OUR OWN clarifying question ("what kind of game
// — puzzle, arcade, or something else?") plus a short user fragment ("something totally unique")
// often continues the USER's turn instead of responding to it: it elaborates the REQUEST in the
// first person ("I'd like to build a game that combines puzzle-solving and strategy…"). The reply
// is fluent, on-topic, and passes every existing critic — non-answer, truncation and consistency
// all read it as fine — yet it answers nobody. Measured 4/4 live on 2026-07-19 (cont.97d).
//
// The signal is VOICE, not topic: an assistant states what IT will do ("I'll build…", "Here's…"),
// never what the user WANTS ("I'd like…", "could you build me…"). We flag only a leading
// first-person DESIRE (or a second-person REQUEST) aimed at producing the artifact, so ordinary
// assistant hedging ("I'd like to clarify one thing") is untouched by the META_USE exclusion.
const ROLE_DESIRE = /^\s*(?:and\s+|also,?\s+)?(?:i(?:'d| would)\s+(?:like|love)|i\s+want|i\s+need|i(?:'m| am)\s+looking\s+for|my\s+idea\s+is)\b/i
// Assistant-legitimate uses of "I'd like to …" — meta/dialogue acts, not artifact requests.
const META_USE = /^\s*(?:and\s+|also,?\s+)?i(?:'d| would)\s+(?:like|love)\s+to\s+(?:clarify|confirm|check|know|understand|suggest|propose|recommend|note|point\s+out|mention|help|make\s+sure|start\s+by|offer|flag|highlight)\b/i
// A second-person request: the reply asks the ASSISTANT to build — i.e. it is the user's turn.
const ROLE_REQUEST = /^\s*(?:could|can|would|will)\s+you\s+(?:please\s+)?(?:build|create|make|write|design|develop|code|help)\b|^\s*please\s+(?:build|create|make|write|design|develop|code)\b/i
// The desire's DIRECT OBJECT must be the artifact — checked against the text immediately following
// the desire phrase, never searched loosely across the sentence. That distinction is what separates
// "I need AN APP that…" (the user's voice) from "I need A BIT MORE DETAIL before I can build this"
// (the assistant's), which a loose search for a creation verb anywhere wrongly flagged.
// "…to build" (speaker builds) and "…YOU to build" (speaker directs the assistant to build) are
// both the requester's voice. The second form was a live miss on 2026-07-19: "I'd like you to
// create a unique puzzle game" survived a repair round because the object was "you", not the artifact.
const DESIRE_TO_CREATE = /^\s*(?:you\s+)?(?:to\s+)?(?:build|create|make|design|develop|code|write|generate)\b/i
const DESIRE_FOR_ARTIFACT = /^\s*(?:a|an|the|some)\s+(?:[\w-]+\s+){0,3}(?:game|app|application|website|site|tool|program|script|feature|dashboard|extension|bot|api|library|page|widget)\b/i

export function looksRoleBled(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  // Judge the OPENING clause: role is established up front, and a long answer that merely quotes
  // the user later ("you said you'd like a game…") is not itself written in the user's voice.
  const head = t.slice(0, 200)
  const firstSentence = (head.split(/(?<=[.!?])\s/)[0] ?? head)
  if (ROLE_REQUEST.test(firstSentence)) return true
  const desire = ROLE_DESIRE.exec(firstSentence)
  if (!desire) return false
  if (META_USE.test(firstSentence)) return false
  const rest = firstSentence.slice(desire[0].length)
  return DESIRE_TO_CREATE.test(rest) || DESIRE_FOR_ARTIFACT.test(rest)
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
// A code-generation reply must actually contain code. A bare verdict ("Answer: true"), a plain
// prose sentence, or an empty fence is a non-answer no matter how the prose critics read it — this
// is the guard that stops the reason-prompt "Answer:" collapse from shipping on a code ask.
function isCodeNonAnswer(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  const fence = t.match(/```[^\n]*\n([\s\S]*?)```/)
  if (fence) return fence[1].trim().length < 10        // fenced but effectively empty
  // No fence: accept only if it still looks like source (has code punctuation across several lines).
  const codey = /[;{}()=]|=>|\bfunction\b|\bclass\b|\bdef\b|\breturn\b|\bconst\b|\blet\b|\bimport\b/
  return !(codey.test(t) && t.split('\n').length >= 3)
}

export function critiqueAnswer(
  draft: string,
  message: string,
  opts: { intent?: string } = {},
): { text: string; issues: Issue[] } {
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

  // Code asks bypass the PROSE critics below: the consistency/non-answer/truncation heuristics are
  // tuned for natural-language answers and both miss code-specific failures and false-positive on
  // valid source (reassigned locals read as "contradictions", a trailing `}` reads as "truncated").
  // A code reply gets exactly one check — does it actually contain code — routed through the same
  // 'nonanswer' repair path so a bare "Answer:" collapse triggers a real regeneration.
  if (opts.intent === 'code') {
    if (isCodeNonAnswer(text)) {
      issues.push({ kind: 'nonanswer', detail: 'A code implementation was requested but the reply contained no usable code.' })
    }
    return { text, issues }
  }

  // ── Consistency critic — self-contradiction (reassigned values, always/never, etc.). ──
  // Not deterministically fixable, so it triggers an FM repair round rather than an in-place edit.
  try {
    const { passed, issues: consIssues } = verifyConsistency(text, message)
    if (!passed && consIssues.length) {
      issues.push({ kind: 'contradiction', detail: consIssues.join('; ') })
    }
  } catch { /* non-blocking */ }

  // Role bleed outranks the non-answer/truncation critics: a reply written in the user's voice is
  // a specific, differently-repaired defect (regenerate in the assistant's voice — see the
  // forward-only branch in answerEngine), and it is fluent enough that neither of them fires.
  if (looksRoleBled(text)) {
    issues.push({ kind: 'rolebleed', detail: 'The reply was written in the user\'s voice — it restated the request instead of responding to it.' })
  } else if (isNonAnswer(text, message)) {
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
