// ═══════════════════════════════════════════════════════════════════════════════
// Answer engine — EVERYDAY MONEY MATH (percent-of, tip, discount, tax, split)
// ═══════════════════════════════════════════════════════════════════════════════
//
// directArithmetic only fires on a bare expression ("17 times 23"). The four most common
// numeric questions a person actually asks are not bare expressions — they carry a word that
// SUPPLIES the operation ("of", "tip", "off", "tax", "split ... ways"). MEASURED 2026-08-03,
// each of these routed to the model and to consensus sampling: median 6.6s for a calculation
// a machine does in microseconds, with two of the four over budget.
//
// These are decidable, so they are computed, not sampled. Every one of them also has a SECOND
// number the asker wants and usually has to ask for separately — the total after the tip, the
// price after the discount, the remainder that will not divide evenly — so the answer carries
// it. A split that does not divide evenly is the interesting case: three ways on $137.50 is
// $45.83 with a cent left over, and rounding it silently to $45.83 × 3 = $137.49 loses money.
// ═══════════════════════════════════════════════════════════════════════════════

const NUM = String.raw`(-?\d[\d,]*(?:\.\d+)?)`
const n = (s: string) => Number(s.replace(/,/g, ''))

/** Currency-ish rendering: two decimals when it is money, minimal digits otherwise. */
function money(v: number, cur: string): string {
  return `${cur}${v.toFixed(2)}`
}
function plain(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4)))
}

const WORD_N: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  twelve: 12, half: 2,
}

export interface MoneyAnswer { text: string; kind: 'percent' | 'tip' | 'discount' | 'tax' | 'split' }

/**
 * Solve an everyday money/percentage question deterministically. Null whenever the phrasing is
 * not one of these exact shapes — a near-miss must fall through to the ordinary path rather
 * than be answered with a formula the asker did not mean.
 */
export function solveMoneyMath(message: string): MoneyAnswer | null {
  const m = (message ?? '').trim()
  if (!m || !/\d/.test(m)) return null
  const cur = /[£€]/.test(m) ? (m.includes('£') ? '£' : '€') : '$'

  // ── Split: "split $137.50 three ways", "divide $60 between 4 people" ───────────────
  const sp = new RegExp(String.raw`\b(?:split|divide|share)\b[^\d]{0,20}[£$€]?${NUM}\s*(?:\b(?:between|among|amongst|across|by)\b\s*)?(?:${NUM}|(${Object.keys(WORD_N).join('|')}))\s*(?:ways?|people|persons?|of us|friends|shares?)?\b`, 'i').exec(m)
  if (sp && /\b(ways?|people|persons?|of us|friends|shares?|between|among|amongst)\b/i.test(m)) {
    const total = n(sp[1])
    const parts = sp[2] ? n(sp[2]) : WORD_N[(sp[3] ?? '').toLowerCase()]
    if (isFinite(total) && parts >= 2 && parts <= 1000 && Number.isInteger(parts)) {
      // Work in cents so the remainder is exact rather than a float artefact.
      const cents = Math.round(total * 100)
      const each = Math.floor(cents / parts)
      const rem = cents - each * parts
      const base = `**${money(each / 100, cur)}** each, splitting ${money(total, cur)} ${parts} ways.`
      const tail = rem === 0
        ? ''
        : ` It does not divide evenly — ${rem} ${rem === 1 ? 'person pays' : 'people pay'} one cent more (${money((each + 1) / 100, cur)}), which is what makes the ${parts} shares add back to ${money(total, cur)}.`
      return { text: base + tail, kind: 'split' }
    }
  }

  // ── Tip: "20% tip on $84", "how much is a 15 percent tip on 63.40" ─────────────────
  const tip = new RegExp(String.raw`${NUM}\s*(?:%|percent)\s*(?:tip|gratuity)\b[^\d]{0,15}[£$€]?${NUM}`, 'i').exec(m)
    ?? new RegExp(String.raw`\b(?:tip|gratuity)\b[^\d]{0,20}${NUM}\s*(?:%|percent)\s*(?:on|for|of)\s*[£$€]?${NUM}`, 'i').exec(m)
  if (tip) {
    const pct = n(tip[1]); const bill = n(tip[2])
    if (isFinite(pct) && isFinite(bill)) {
      const amt = bill * pct / 100
      return { text: `A ${plain(pct)}% tip on ${money(bill, cur)} is **${money(amt, cur)}**, for a total of ${money(bill + amt, cur)}.`, kind: 'tip' }
    }
  }

  // ── Discount: "$85 with 20% off", "20% off 85" ─────────────────────────────────────
  const disc = new RegExp(String.raw`${NUM}\s*(?:%|percent)\s*off\b[^\d]{0,15}[£$€]?${NUM}`, 'i').exec(m)
    ?? new RegExp(String.raw`[£$€]?${NUM}\b[^\d]{0,15}${NUM}\s*(?:%|percent)\s*off\b`, 'i').exec(m)
  if (disc) {
    const a = n(disc[1]); const b = n(disc[2])
    // Whichever regex matched, the PERCENT is the one adjacent to "% off".
    const pctFirst = /^\s*-?[\d,.]+\s*(?:%|percent)\s*off/i.test(disc[0])
    const pct = pctFirst ? a : b
    const price = pctFirst ? b : a
    if (isFinite(pct) && isFinite(price) && pct <= 100) {
      const save = price * pct / 100
      return { text: `${plain(pct)}% off ${money(price, cur)} saves ${money(save, cur)}, bringing it to **${money(price - save, cur)}**.`, kind: 'discount' }
    }
  }

  // ── Sales tax: "8% sales tax on $42" ───────────────────────────────────────────────
  const tax = new RegExp(String.raw`${NUM}\s*(?:%|percent)\s*(?:sales\s*)?(?:tax|vat)\b[^\d]{0,15}[£$€]?${NUM}`, 'i').exec(m)
  if (tax) {
    const pct = n(tax[1]); const price = n(tax[2])
    if (isFinite(pct) && isFinite(price)) {
      const amt = price * pct / 100
      return { text: `${plain(pct)}% tax on ${money(price, cur)} is **${money(amt, cur)}**, for a total of ${money(price + amt, cur)}.`, kind: 'tax' }
    }
  }

  // ── Plain percent-of: "15% of 240" ─────────────────────────────────────────────────
  const pof = new RegExp(String.raw`${NUM}\s*(?:%|percent)\s+of\s+[£$€]?${NUM}`, 'i').exec(m)
  if (pof) {
    const pct = n(pof[1]); const total = n(pof[2])
    if (isFinite(pct) && isFinite(total)) {
      const v = total * pct / 100
      const hasCur = /[£$€]/.test(pof[0])
      return { text: `${plain(pct)}% of ${hasCur ? money(total, cur) : plain(total)} is **${hasCur ? money(v, cur) : plain(v)}**.`, kind: 'percent' }
    }
  }

  return null
}
