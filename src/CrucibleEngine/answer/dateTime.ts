// ═══════════════════════════════════════════════════════════════════════════════
// Answer engine — DATE/CALENDAR recomputation (VGR for date answers)
// ═══════════════════════════════════════════════════════════════════════════════
//
// wordProblem.ts covers problems that reduce to arithmetic over plain numbers. Calendar
// questions ("what date is 45 days after March 3, 2026?", "how many days between X and Y?",
// "what day of the week is/was <date>?") do NOT reduce to a numeric expression — they need
// calendar semantics (month lengths, leap years, weekday cycles) that a ~3B model reliably
// fumbles. Same doctrine split as wordProblem:
//   • SETUP (which date, which operation, which offset) — the model PROPOSES it as strict JSON;
//   • CALENDAR ARITHMETIC — the MACHINE does it (UTC Date math, deterministic, un-foolable);
//   • K independent setups must reach a QUORUM on the computed RESULT, else ABSTAIN (null).
//
// Scope guard: only SELF-CONTAINED questions (explicit dates in the text). Anything anchored
// to "today/tomorrow/now" needs the current clock — that is the volatile-lookup lane, not this
// one — so detection refuses it and the caller falls through to the normal draft path.
// ═══════════════════════════════════════════════════════════════════════════════

import { fmComplete } from '../agent/fmReact'
import type { Completer } from './wordProblem'

export interface DateRecomputation {
  /** Human-readable machine-computed result ("June 12, 2026" | "Tuesday" | "142 days"). */
  result: string
  /** Which kind of calendar question this was. */
  kind: 'date' | 'weekday' | 'days-between'
  /** Winning setup, for the verify report. */
  setup: string
  agreement: number
  samples: number
}

// ── Detection ─────────────────────────────────────────────────────────────────────

const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
const EXPLICIT_DATE = new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}/\\d{1,2}/\\d{2,4}\\b`, 'i')
const RELATIVE_ANCHOR = /\b(today|tomorrow|yesterday|now|this (week|month|year)|next (week|month|year))\b/i
const DATE_ASK = /\b(what (date|day)|which day|day of the week|how many (days|weeks|months|years) (are there )?(between|from|until|before|after)|(days?|weeks?|months?|years?) (after|before|from|later than))\b/i

/** True iff the question is a SELF-CONTAINED calendar computation (explicit date, no "today"). */
export function isDateQuestion(message: string): boolean {
  const m = message ?? ''
  return DATE_ASK.test(m) && EXPLICIT_DATE.test(m) && !RELATIVE_ANCHOR.test(m)
}

// ── Deterministic calendar arithmetic (UTC; no model, no locale surprises) ─────────

const DAY_MS = 86400000
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function parseISO(s: string): Date | null {
  if (typeof s !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim())
  if (!m) return null
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  // Reject rollovers (2026-02-30 → Mar 2): the model's setup was invalid, not "close enough".
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null
  return d
}

function fmtDate(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
}

export interface DateSetup {
  base: string
  op: 'add' | 'subtract' | 'diff' | 'weekday'
  amount?: number
  unit?: 'days' | 'weeks' | 'months' | 'years'
  other?: string
}

/** Evaluate one proposed setup deterministically → the result string, or null when invalid. */
export function evalDateSetup(s: DateSetup): { result: string; kind: DateRecomputation['kind'] } | null {
  const base = parseISO(s.base)
  if (!base) return null

  if (s.op === 'weekday') {
    return { result: WEEKDAYS[base.getUTCDay()], kind: 'weekday' }
  }
  if (s.op === 'diff') {
    const other = parseISO(s.other ?? '')
    if (!other) return null
    const days = Math.abs(Math.round((other.getTime() - base.getTime()) / DAY_MS))
    return { result: `${days} days`, kind: 'days-between' }
  }
  if (s.op === 'add' || s.op === 'subtract') {
    const n = typeof s.amount === 'number' && isFinite(s.amount) ? Math.trunc(s.amount) : NaN
    if (Number.isNaN(n) || n < 0 || n > 100000) return null
    const sign = s.op === 'add' ? 1 : -1
    const d = new Date(base.getTime())
    switch (s.unit) {
      case 'days': d.setUTCDate(d.getUTCDate() + sign * n); break
      case 'weeks': d.setUTCDate(d.getUTCDate() + sign * n * 7); break
      case 'months': d.setUTCMonth(d.getUTCMonth() + sign * n); break
      case 'years': d.setUTCFullYear(d.getUTCFullYear() + sign * n); break
      default: return null
    }
    return { result: fmtDate(d), kind: 'date' }
  }
  return null
}

// ── Setup extraction (model proposes; machine evaluates) ───────────────────────────

const SYSTEM = [
  'You translate a CALENDAR question into ONE structured setup that a deterministic date',
  'calculator will evaluate. DO NOT compute the answer yourself — the machine will.',
  '',
  'Output STRICT JSON and nothing else, shape:',
  '{ "base": "YYYY-MM-DD", "op": "add"|"subtract"|"diff"|"weekday", "amount": <number>, "unit": "days"|"weeks"|"months"|"years", "other": "YYYY-MM-DD" }',
  '',
  '- "base" is the date the question starts from, in ISO YYYY-MM-DD.',
  '- op "add"/"subtract": offset "base" by "amount" "unit" (e.g. 45 days after → add).',
  '- op "diff": number of days between "base" and "other" (both ISO dates; omit amount/unit).',
  '- op "weekday": the day of the week that "base" falls on (omit amount/unit/other).',
  '- If the question cannot be expressed this way, output {"base":""}.',
].join('\n')

function parseSetup(text: string): DateSetup | null {
  if (!text) return null
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = (fence ? fence[1] : text).trim()
  const start = body.indexOf('{'); const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const o = JSON.parse(body.slice(start, end + 1))
    if (o && typeof o.base === 'string' && o.base && typeof o.op === 'string') {
      return {
        base: o.base, op: o.op,
        amount: typeof o.amount === 'number' ? o.amount : (typeof o.amount === 'string' && o.amount.trim() !== '' ? Number(o.amount) : undefined),
        unit: typeof o.unit === 'string' ? o.unit.toLowerCase().replace(/s?$/, 's') as DateSetup['unit'] : undefined,
        other: typeof o.other === 'string' ? o.other : undefined,
      }
    }
  } catch { /* not JSON */ }
  return null
}

/**
 * Recompute a calendar question: K independent setups, each machine-evaluated; the RESULT a
 * quorum agrees on wins, else null (caller keeps the draft — same abstain contract as
 * recomputeWordProblem).
 */
export async function recomputeDate(
  message: string,
  opts: { samples?: number; complete?: Completer } = {},
): Promise<DateRecomputation | null> {
  const samples = Math.max(3, opts.samples ?? 3)
  const complete = opts.complete ?? fmComplete

  const evaluated: Array<{ result: string; kind: DateRecomputation['kind']; setup: string }> = []
  for (let i = 0; i < samples; i++) {
    let raw: string
    try {
      raw = await complete(
        [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Question:\n${message}` }],
        { temperature: i === 0 ? 0.1 : 0.5 },
      )
    } catch { continue }
    const setup = parseSetup(raw)
    if (!setup) continue
    const out = evalDateSetup(setup)
    if (!out) continue
    evaluated.push({ ...out, setup: JSON.stringify(setup) })
  }
  if (evaluated.length < 2) return null

  const byResult = new Map<string, { n: number; sample: typeof evaluated[0] }>()
  for (const e of evaluated) {
    const slot = byResult.get(e.result) ?? { n: 0, sample: e }
    slot.n++
    byResult.set(e.result, slot)
  }
  const quorum = Math.max(2, Math.floor(samples / 2) + 1)
  const top = [...byResult.values()].sort((a, b) => b.n - a.n)[0]
  if (!top || top.n < quorum) return null

  return {
    result: top.sample.result,
    kind: top.sample.kind,
    setup: top.sample.setup,
    agreement: top.n / evaluated.length,
    samples: evaluated.length,
  }
}

// ── Reconciliation with the drafted answer ──────────────────────────────────────────

export interface DateReconciliation { text: string; confirmed: boolean; corrected: boolean }

/** The draft already states the machine result (weekday name / formatted date / day count). */
function draftStatesResult(draft: string, recomp: DateRecomputation): boolean {
  const d = draft.toLowerCase()
  if (recomp.kind === 'weekday') return d.includes(recomp.result.toLowerCase())
  if (recomp.kind === 'days-between') {
    const n = recomp.result.split(' ')[0]
    return new RegExp(`\\b${n}\\s*days?\\b`, 'i').test(draft)
  }
  // date: accept "June 12, 2026" with or without the comma/year.
  const m = /^(\w+) (\d+), (\d+)$/.exec(recomp.result)
  if (!m) return d.includes(recomp.result.toLowerCase())
  return new RegExp(`\\b${m[1]}\\s+${m[2]}(?:st|nd|rd|th)?\\b`, 'i').test(draft)
}

/**
 * Reconcile: confirm when the draft states the machine result; otherwise append an explicit
 * verified Answer line (dates are too format-diverse to splice safely in place — a wrong date
 * mid-prose plus a correct bolded Answer line is unambiguous to the reader).
 */
export function applyDateRecomputation(draft: string, recomp: DateRecomputation): DateReconciliation {
  if (draftStatesResult(draft, recomp)) return { text: draft, confirmed: true, corrected: false }
  return {
    text: `${draft.trimEnd()}\n\n**Answer: ${recomp.result}** (machine-verified calendar computation)`,
    confirmed: false,
    corrected: true,
  }
}
