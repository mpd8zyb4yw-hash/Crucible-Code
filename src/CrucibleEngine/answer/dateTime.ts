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

// ── Tier 1: DETERMINISTIC setup extraction (no model anywhere) ─────────────────────
//
// The arithmetic below was always exact; the SETUP was not. MEASURED 2026-08-03, the model
// read "90 days after 3 August 2026" as March 22, 2027 and "between 1 January and 3 August
// 2026" as 125 days — both wrong, both after ~10s of quorum sampling, and the quorum agreed
// with itself often enough to ship the answer with only a soft "unverified" note attached.
// Reading a date out of a sentence is a parsing job, not a reasoning job, so the machine does
// it. Anything this parser cannot read with certainty returns null and falls through to the
// existing model-proposed quorum, which is strictly better than it was: it now only sees the
// phrasings the parser declined.

const MONTH_NAMES: Record<string, number> = {}
for (let i = 0; i < MONTHS.length; i++) {
  MONTH_NAMES[MONTHS[i].toLowerCase()] = i
  MONTH_NAMES[MONTHS[i].toLowerCase().slice(0, 3)] = i
}
MONTH_NAMES['sept'] = 8

function iso(y: number, mo: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, mo, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo || dt.getUTCDate() !== d) return null
  return `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** Every explicit date literal in the message, in order of appearance, as ISO strings. */
function findDates(m: string): string[] {
  const out: Array<{ at: number; end: number; iso: string }> = []
  const push = (at: number, len: number, s: string | null) => { if (s) out.push({ at, end: at + len, iso: s }) }

  // 2026-11-01
  for (const x of m.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) push(x.index!, x[0].length, iso(+x[1], +x[2] - 1, +x[3]))
  // August 3, 2026 / Aug 3 2026
  for (const x of m.matchAll(new RegExp(`\\b(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'))) {
    push(x.index!, x[0].length, iso(+x[3], MONTH_NAMES[x[1].toLowerCase()], +x[2]))
  }
  // 3 August 2026 / 4th July 1776
  for (const x of m.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH})\\.?,?\\s+(\\d{4})\\b`, 'gi'))) {
    push(x.index!, x[0].length, iso(+x[3], MONTH_NAMES[x[2].toLowerCase()], +x[1]))
  }
  out.sort((a, b) => a.at - b.at || b.end - a.end)
  // Dedup by SPAN, not by value: one literal caught by two patterns is one date, but the same
  // date written twice ("between 2026-01-01 and 2026-01-01") is genuinely two operands.
  const kept: typeof out = []
  for (const d of out) if (!kept.some(k => d.at < k.end && k.at < d.end)) kept.push(d)
  return kept.map(d => d.iso)
}

const UNIT_RX = /\b(\d[\d,]*)\s+(day|week|month|year)s?\b/i
const AFTER_RX = /\b(after|from|later than|following|past)\b/i
const BEFORE_RX = /\b(before|prior to|earlier than|ahead of)\b/i

/** Parse a self-contained calendar question into a setup, with ZERO model involvement. */
export function parseDateSetup(message: string): DateSetup | null {
  const m = message ?? ''
  if (!isDateQuestion(m)) return null
  const dates = findDates(m)
  if (!dates.length) return null

  // "how many days between A and B" — needs exactly two dates so there is nothing to guess.
  if (/\bhow many (days|weeks|months|years)\b/i.test(m) && !UNIT_RX.test(m)) {
    if (dates.length !== 2) return null
    if (!/\b(days|weeks|months|years)\b/i.test(m)) return null
    // Only day-granularity diffs are exact without calendar-unit ambiguity.
    if (!/\bhow many days\b/i.test(m)) return null
    return { base: dates[0], op: 'diff', other: dates[1] }
  }

  // "what day of the week was <date>"
  if (/\b(day of the week|which day|what day)\b/i.test(m) && !UNIT_RX.test(m)) {
    if (dates.length !== 1) return null
    return { base: dates[0], op: 'weekday' }
  }

  // "<N> <unit> after|before <date>"
  const u = UNIT_RX.exec(m)
  if (u) {
    if (dates.length !== 1) return null
    const amount = Number(u[1].replace(/,/g, ''))
    if (!isFinite(amount) || amount < 0 || amount > 100000) return null
    const tail = m.slice(u.index + u[0].length)
    const isBefore = BEFORE_RX.test(tail)
    const isAfter = AFTER_RX.test(tail)
    // Both or neither present means the direction is genuinely ambiguous — abstain.
    if (isBefore === isAfter) return null
    return { base: dates[0], op: isBefore ? 'subtract' : 'add', amount, unit: `${u[2].toLowerCase()}s` as DateSetup['unit'] }
  }
  return null
}

/** Full deterministic solve: parse + evaluate + render. Null when not certain. */
export function solveDate(message: string): { text: string; kind: DateRecomputation['kind'] } | null {
  const setup = parseDateSetup(message)
  if (!setup) return null
  const r = evalDateSetup(setup)
  if (!r) return null
  const label = r.kind === 'weekday'
    ? `${fmtDate(parseISO(setup.base)!)} was a **${r.result}**.`
    : r.kind === 'days-between'
      ? `There are **${r.result}** between ${fmtDate(parseISO(setup.base)!)} and ${fmtDate(parseISO(setup.other!)!)}.`
      : `${setup.amount} ${setup.unit} ${setup.op === 'add' ? 'after' : 'before'} ${fmtDate(parseISO(setup.base)!)} is **${r.result}**.`
  return { text: label, kind: r.kind }
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
 * Reconcile: confirm when the draft states the machine result; otherwise splice the machine
 * date over any CONTRADICTING date the draft asserts (a date not mentioned in the question —
 * question dates are the problem's givens, never the model's claim) and append an explicit
 * verified Answer line, so no wrong date survives in the prose.
 */
export function applyDateRecomputation(draft: string, recomp: DateRecomputation, question = ''): DateReconciliation {
  if (draftStatesResult(draft, recomp)) return { text: draft, confirmed: true, corrected: false }

  let text = draft
  if (recomp.kind === 'date') {
    const norm = (s: string) => s.toLowerCase().replace(/(st|nd|rd|th)\b/g, '').replace(/,/g, '')
    const qNorm = norm(question)
    const dateToken = new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`, 'gi')
    text = text.replace(dateToken, tok => qNorm.includes(norm(tok)) ? tok : recomp.result)
  }
  return {
    text: `${text.trimEnd()}\n\n**Answer: ${recomp.result}** (machine-verified calendar computation)`,
    confirmed: false,
    corrected: true,
  }
}
