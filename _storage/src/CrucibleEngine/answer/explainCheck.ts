// ═══════════════════════════════════════════════════════════════════════════════
// Answer engine — EXPLAIN-intent verification (sub-claim spot checks)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Explanations were the last totally-unverified answer lane. A full entailment check of free
// prose is beyond a deterministic critic, but explanations FAIL in a characteristic way: the
// narrative is fine while one embedded FACT is confabulated (a wrong year, a wrong inventor,
// a wrong constant). Those embedded facts ARE checkable:
//
//   1. DETERMINISTIC extraction — sentences carrying a checkable assertion (a number/year/
//      unit, or an attribution "X was invented/discovered by Y") are pulled out; fuzzy prose
//      ("this builds intuition") is not checkable and is left alone.
//   2. DECORRELATED verification — each claim is judged in ISOLATION by K independent FM
//      passes ("is this statement accurate — yes/no/unsure"). Verifying one isolated claim
//      is a far easier task than generating the whole explanation, and the K verdicts are
//      decorrelated from the generation pass that produced the error.
//   3. Quorum — a claim a MAJORITY refutes is flagged; the answer ships with an explicit
//      caution naming the exact sentence (honesty over confidence, abstain-shaped). A claim
//      with no quorum either way is left unflagged (the checker must not vandalize good
//      explanations — precision over recall).
//
// This is the weakest verifier in the engine BY DESIGN (model-judged, not machine-computed)
// and is labeled as a spot check, never as "machine-verified".
// ═══════════════════════════════════════════════════════════════════════════════

import { fmComplete } from '../agent/fmReact'
import type { Completer } from './wordProblem'
import { convert } from './unitConvert'

export interface ExplainCheck {
  /** How many claims were extracted and checked. */
  checked: number
  /** Claims a majority of independent verdicts refuted. */
  flagged: string[]
  /** Total verdict calls spent. */
  verdicts: number
}

// ── Deterministic checkable-claim extraction ─────────────────────────────────────────

const ATTRIBUTION = /\b(?:was|were|is|are)\s+(?:invented|discovered|created|founded|developed|designed|written|coined|proposed|introduced)\s+by\b/i
const HAS_YEAR = /\b(1[5-9]\d{2}|20\d{2})\b/
const HAS_MEASURE = /\b\d[\d,]*(?:\.\d+)?\s*(?:%|percent|km|kilometers?|miles?|meters?|feet|kg|pounds?|tons?|°?[CF]\b|degrees|years?|centuries|bytes?|bits?|hz|ghz|mhz)\b/i

/** Split prose into sentences (cheap; good enough for claim isolation). */
function sentences(text: string): string[] {
  return (text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')     // never treat code as prose claims
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 20 && s.length < 300)
}

/** Extract up to `cap` checkable factual sub-claims from an explanation, deterministically. */
export function extractCheckableClaims(text: string, cap = 3): string[] {
  const out: string[] = []
  for (const s of sentences(text)) {
    if (ATTRIBUTION.test(s) || HAS_YEAR.test(s) || HAS_MEASURE.test(s)) out.push(s)
    if (out.length >= cap) break
  }
  return out
}

// ── Deterministic pre-pass: conversion claims the MACHINE can judge outright ──────────
// "1 mile = 1.60934 km" / "60 mph is about 96.6 km/h" — the unit table IS ground truth for
// these, so they never reach (or waste) an FM verdict. Wrong beyond 1% → flagged with
// machine certainty; right → confirmed, claim removed from the FM-verdict pool.

const CONV_CLAIM = /(-?\d[\d,]*(?:\.\d+)?)\s*([a-zA-Z°][a-zA-Z/°]{0,12})\s*(?:=|is|equals?|≈|~|about|approximately|roughly)+\s*(?:about |approximately |roughly )?(-?\d[\d,]*(?:\.\d+)?)\s*([a-zA-Z°][a-zA-Z/°]{0,12})/

/** 'right' | 'wrong' when the table can judge the claim; null when it can't. */
export function judgeConversionClaim(claim: string): 'right' | 'wrong' | null {
  const m = CONV_CLAIM.exec(claim)
  if (!m) return null
  const a = Number(m[1].replace(/,/g, '')); const b = Number(m[3].replace(/,/g, ''))
  const expected = convert(a, m[2], m[4])
  if (expected === null || !isFinite(a) || !isFinite(b)) return null
  if (expected === 0) return Math.abs(b) < 1e-9 ? 'right' : 'wrong'
  return Math.abs(b - expected) / Math.abs(expected) <= 0.01 ? 'right' : 'wrong'
}

// ── Decorrelated verdicts ────────────────────────────────────────────────────────────

const VERDICT_SYSTEM = [
  'You are a fact checker. You will be shown ONE statement. Judge ONLY whether it is factually',
  'accurate. Reply with exactly one word: "yes" (accurate), "no" (inaccurate), or "unsure".',
].join('\n')

function parseVerdict(raw: string): 'yes' | 'no' | 'unsure' {
  const t = (raw ?? '').trim().toLowerCase()
  if (/^\s*yes\b/.test(t)) return 'yes'
  if (/^\s*no\b/.test(t)) return 'no'
  return 'unsure'
}

/**
 * Spot-check an explanation's embedded factual claims. Returns null when the draft contains
 * no checkable claims (nothing to do). A claim is flagged only when a MAJORITY of K verdicts
 * says "no" — unsure/split never flags (precision over recall).
 */
export async function checkExplanation(
  draft: string,
  opts: { verdictsPerClaim?: number; maxClaims?: number; complete?: Completer } = {},
): Promise<ExplainCheck | null> {
  const claims = extractCheckableClaims(draft, opts.maxClaims ?? 3)
  if (!claims.length) return null
  const k = Math.max(2, opts.verdictsPerClaim ?? 2)
  const complete = opts.complete ?? fmComplete

  const flagged: string[] = []
  let verdicts = 0
  const forModel: string[] = []
  for (const claim of claims) {
    const machine = judgeConversionClaim(claim)
    if (machine === 'wrong') flagged.push(claim)
    else if (machine === null) forModel.push(claim)
    // 'right' → confirmed by the table, nothing more to do.
  }
  for (const claim of forModel) {
    const results = await Promise.all(Array.from({ length: k }, async (_, i) => {
      try {
        return parseVerdict(await complete(
          [{ role: 'system', content: VERDICT_SYSTEM }, { role: 'user', content: `Statement:\n"${claim}"` }],
          { temperature: i === 0 ? 0.1 : 0.6 },
        ))
      } catch { return 'unsure' as const }
    }))
    verdicts += results.length
    const no = results.filter(r => r === 'no').length
    if (no > results.length / 2) flagged.push(claim)
  }
  return { checked: claims.length, flagged, verdicts }
}

/** Append an explicit caution naming refuted claims (never silently ship them). */
export function applyExplainCheck(draft: string, check: ExplainCheck): string {
  if (!check.flagged.length) return draft
  const listed = check.flagged.map(c => `- "${c}"`).join('\n')
  return `${draft.trimEnd()}\n\n*Caution — independent spot checks could not confirm the following, treat with skepticism:*\n${listed}`
}
