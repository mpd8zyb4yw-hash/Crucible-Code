// Self-consistency reasoning — the SYSTEM's answer to "the FM can't reliably do multi-step
// reasoning alone." A single small-FM pass sets up the wrong equation and ships a confident
// wrong number (the classic "train catch-up = 10 PM"). The fix is not a bigger model: it is to
// sample the FM MANY times, deterministically oracle-correct each sample's arithmetic, extract
// each sample's final answer, and take the VERIFIED MAJORITY VOTE. Different samples make
// different mistakes; the correct derivation is the one they most often agree on. The FM is the
// messenger (it proposes candidate derivations); the system (sampling + normalization + voting)
// is the brain that decides.
//
// Fully offline: only the local Apple FM, called K times. No external model, no escalation.
// "No token limits" (user directive) is exactly what makes this affordable — we spend more
// on-device compute to buy correctness.

import { fmComplete } from '../agent/fmReact'
import { correctArithmeticCascade } from '../domainVerifiers'
import { debugBus } from '../debug/bus'

const SAMPLES = Math.max(3, Number(process.env.CRUCIBLE_SC_SAMPLES ?? 5))
const SAMPLE_TEMP = Number(process.env.CRUCIBLE_SC_TEMP ?? 0.8)

export interface ConsensusResult {
  /** Full text of the winning sample (work shown), arithmetic-corrected. */
  text: string
  /** Normalized final-answer token the plurality agreed on (null if no extractable answer). */
  answer: string | null
  /** agreement = votes-for-winner / total-samples, in [0,1]. */
  agreement: number
  samples: number
  /** Distinct normalized answers → count, for telemetry/debugging. */
  tally: Record<string, number>
}

// ── Final-answer extraction ────────────────────────────────────────────────────
// Prefer an explicit "Answer:" line (the reason-intent prompt asks for one), else fall back to
// the last time-expression / number in the text.

function answerSegment(text: string): string {
  const m = text.match(/(?:^|\n)\s*(?:final\s+)?answer\s*[:\-]\s*(.+?)(?:\n|$)/i)
  return m ? m[1] : text
}

// Normalize a final answer to a comparable token: times → 24h "H:MM", plain numbers → their
// numeric value, otherwise a lowercased alphanumeric slug. Returns null when nothing checkable.
export function normalizeAnswer(raw: string): string | null {
  const seg = answerSegment(raw).trim()
  if (!seg) return null

  // Time of day: "7pm", "7 p.m.", "7:30 PM", "19:00".
  const t12 = seg.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i)
  if (t12) {
    let h = parseInt(t12[1], 10) % 12
    const min = t12[2] ? parseInt(t12[2], 10) : 0
    if (/p/i.test(t12[3])) h += 12
    return `t:${h}:${String(min).padStart(2, '0')}`
  }
  const t24 = seg.match(/\b(\d{1,2}):(\d{2})\b/)
  if (t24) return `t:${parseInt(t24[1], 10)}:${t24[2]}`

  // Numeric answer — take the LAST number in the segment (final result), currency/commas stripped.
  const nums = seg.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/g)
  if (nums && nums.length) {
    const n = parseFloat(nums[nums.length - 1])
    if (!Number.isNaN(n)) return `n:${n}`
  }

  // Non-numeric short answer (e.g. "yes"/"no"/an entity) — slug the first few words.
  const slug = seg.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().split(/\s+/).slice(0, 4).join(' ')
  return slug ? `s:${slug}` : null
}

/**
 * Solve a reasoning question by verified self-consistency. Draws SAMPLES step-by-step
 * derivations, oracle-corrects each, votes on the normalized final answer, and returns the
 * winning sample's full text (work shown) plus the agreement level.
 * Never throws; returns { text:'' } if the FM produced nothing.
 */
export async function solveByConsensus(
  message: string,
  system: string,
  history: Array<{ role: string; content: string }> = [],
  emit?: (e: Record<string, unknown>) => void,
): Promise<ConsensusResult> {
  const base = [{ role: 'system', content: system }, ...history, { role: 'user', content: message }]
  const samples: { text: string; norm: string | null }[] = []

  for (let i = 0; i < SAMPLES; i++) {
    emit?.({ type: 'thought', text: `Reasoning attempt ${i + 1}/${SAMPLES}…` })
    let text = ''
    try {
      // First sample at low temp (the model's best single shot); the rest hotter for diversity.
      text = (await fmComplete(base, { temperature: i === 0 ? 0.2 : SAMPLE_TEMP })).trim()
    } catch { text = '' }
    if (!text) continue
    try {
      const { text: fixed } = correctArithmeticCascade(text)
      text = fixed
    } catch { /* keep as-is */ }
    samples.push({ text, norm: normalizeAnswer(text) })
  }

  if (!samples.length) return { text: '', answer: null, agreement: 0, samples: 0, tally: {} }

  // Tally the extractable answers and pick the plurality.
  const tally: Record<string, number> = {}
  for (const s of samples) if (s.norm) tally[s.norm] = (tally[s.norm] ?? 0) + 1

  let winner: string | null = null
  let winnerVotes = 0
  for (const [k, v] of Object.entries(tally)) if (v > winnerVotes) { winner = k; winnerVotes = v }

  // The returned text is a sample that produced the winning answer (work shown). If nothing was
  // extractable at all, fall back to the longest sample (most-worked derivation).
  const winningSample = winner
    ? samples.find(s => s.norm === winner)!
    : samples.slice().sort((a, b) => b.text.length - a.text.length)[0]

  const agreement = winner ? winnerVotes / samples.length : 0
  debugBus.emit('pipeline', 'self_consistency', {
    q: message.slice(0, 60), samples: samples.length, winner, agreement: Number(agreement.toFixed(2)), tally,
  }, { severity: 'info' })

  return { text: winningSample.text, answer: winner, agreement, samples: samples.length, tally }
}
