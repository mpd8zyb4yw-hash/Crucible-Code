// ═══════════════════════════════════════════════════════════════════════════════
// Answer engine — UNIT CONVERSION (the strongest tier: often ZERO model involvement)
// ═══════════════════════════════════════════════════════════════════════════════
//
// "How fast is 60 mph in km/h?" doesn't reduce to an arithmetic expression the model can set
// up reliably (it must also KNOW the factor — exactly the kind of constant a ~3B model
// approximates). But the conversion factors are FIXED, so the system carries the table:
//
//   Tier 1 — deterministic parse: "<number> <unit> (in|to|into|as) <unit>" phrasings are
//            parsed by regex and answered ENTIRELY by the machine. No model anywhere.
//   Tier 2 — model-proposed setup: odd phrasings fall back to the familiar K-quorum shape —
//            the model only extracts {value, from, to}; the factor and arithmetic stay ours.
//
// Same abstain contract as the other recomputation lanes: no parse and no quorum → null.
// ═══════════════════════════════════════════════════════════════════════════════

import { fmComplete } from '../agent/fmReact'
import type { Completer, Recomputation } from './wordProblem'

// ── Unit table: family → base unit; every unit → factor-to-base. Exact standard factors. ──

interface UnitDef { family: string; toBase: number }

const UNITS: Record<string, UnitDef> = {}
function def(family: string, entries: Record<string, number>, aliases: Record<string, string> = {}) {
  for (const [name, toBase] of Object.entries(entries)) UNITS[name] = { family, toBase }
  for (const [alias, canonical] of Object.entries(aliases)) UNITS[alias] = UNITS[canonical]
}

def('length', { m: 1, meter: 1, meters: 1, km: 1000, kilometer: 1000, kilometers: 1000, cm: 0.01, centimeter: 0.01, centimeters: 0.01, mm: 0.001, millimeter: 0.001, millimeters: 0.001, mi: 1609.344, mile: 1609.344, miles: 1609.344, ft: 0.3048, foot: 0.3048, feet: 0.3048, in: 0.0254, inch: 0.0254, inches: 0.0254, yd: 0.9144, yard: 0.9144, yards: 0.9144 })
def('mass', { kg: 1, kilogram: 1, kilograms: 1, g: 0.001, gram: 0.001, grams: 0.001, mg: 0.000001, lb: 0.45359237, lbs: 0.45359237, pound: 0.45359237, pounds: 0.45359237, oz: 0.028349523125, ounce: 0.028349523125, ounces: 0.028349523125, ton: 1000, tons: 1000, tonne: 1000, tonnes: 1000 })
def('speed', { 'm/s': 1, mps: 1, 'km/h': 1 / 3.6, kmh: 1 / 3.6, kph: 1 / 3.6, mph: 0.44704, knot: 0.514444, knots: 0.514444 })
def('time', { s: 1, sec: 1, secs: 1, second: 1, seconds: 1, min: 60, mins: 60, minute: 60, minutes: 60, h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600, day: 86400, days: 86400, week: 604800, weeks: 604800 })
def('volume', { l: 1, liter: 1, liters: 1, litre: 1, litres: 1, ml: 0.001, milliliter: 0.001, milliliters: 0.001, gal: 3.785411784, gallon: 3.785411784, gallons: 3.785411784, qt: 0.946352946, quart: 0.946352946, quarts: 0.946352946, cup: 0.2365882365, cups: 0.2365882365 })
// Temperature is affine, not linear — special-cased below.
const TEMP = new Set(['c', 'celsius', 'f', 'fahrenheit', 'k', 'kelvin', '°c', '°f'])

function canonTemp(u: string): 'c' | 'f' | 'k' | null {
  const t = u.toLowerCase().replace(/degrees?\s*/g, '').replace(/°/g, '').trim()
  if (t === 'c' || t === 'celsius' || t === 'centigrade') return 'c'
  if (t === 'f' || t === 'fahrenheit') return 'f'
  if (t === 'k' || t === 'kelvin') return 'k'
  return null
}

function normUnit(raw: string): string {
  return raw.toLowerCase().replace(/\s+per\s+/g, '/').replace(/kilometers?\/hour|km\/hr|kilometres?\/hour/g, 'km/h')
    .replace(/miles?\/hour|mi\/h/g, 'mph').replace(/meters?\/second|m\/sec/g, 'm/s').trim()
}

/** Convert value between two units deterministically; null when not convertible. */
export function convert(value: number, fromRaw: string, toRaw: string): number | null {
  if (!isFinite(value)) return null
  const from = normUnit(fromRaw); const to = normUnit(toRaw)
  const tf = canonTemp(from); const tt = canonTemp(to)
  if (tf && tt) {
    const k = tf === 'c' ? value + 273.15 : tf === 'f' ? (value - 32) * 5 / 9 + 273.15 : value
    return tt === 'c' ? k - 273.15 : tt === 'f' ? (k - 273.15) * 9 / 5 + 32 : k
  }
  const a = UNITS[from]; const b = UNITS[to]
  if (!a || !b || a.family !== b.family) return null
  return value * a.toBase / b.toBase
}

// ── Tier 1: deterministic parse ─────────────────────────────────────────────────────

const UNIT_WORD = String.raw`(?:degrees?\s+)?[°a-zA-Z][a-zA-Z/°]{0,12}(?:\s+per\s+[a-zA-Z]+)?`
const CONVERT_RX = new RegExp(String.raw`(-?\d[\d,]*(?:\.\d+)?)\s*(${UNIT_WORD})\s+(?:in|to|into|as|equals?\s+how\s+many)\s+(${UNIT_WORD})`, 'i')
const HOWMANY_RX = new RegExp(String.raw`how\s+many\s+(${UNIT_WORD})\s+(?:is|are|in|make(?:s)?(?:\s+up)?)\s+(-?\d[\d,]*(?:\.\d+)?)\s*(${UNIT_WORD})`, 'i')

export interface Conversion { value: number; from: string; to: string; result: number }

/** Parse-and-convert with zero model involvement; null when the phrasing doesn't parse. */
export function parseConversion(message: string): Conversion | null {
  const m = message ?? ''
  let value: number, from: string, to: string
  const a = CONVERT_RX.exec(m)
  const b = a ? null : HOWMANY_RX.exec(m)
  if (a) { value = Number(a[1].replace(/,/g, '')); from = a[2]; to = a[3] }
  else if (b) { value = Number(b[2].replace(/,/g, '')); from = b[3]; to = b[1] }
  else return null
  const result = convert(value, from, to)
  if (result === null) return null
  return { value, from: normUnit(from), to: normUnit(to), result }
}

/** Cheap gate: does the question look like a unit conversion at all? */
export function isConversionQuestion(message: string): boolean {
  const m = (message ?? '').toLowerCase()
  if (!/\d/.test(m)) return false
  if (!/\b(convert|in|to|into|as|how many|how fast|how far|how much|equals?)\b/.test(m)) return false
  // At least two RECOGNIZED unit words present. Ambiguous English words that double as unit
  // abbreviations ("in", single letters like m/s/h from contractions) don't count toward the
  // gate — they still parse fine inside Tier 1 where the number context disambiguates.
  const words = m.replace(/[^a-z0-9/° ]/g, ' ').split(/\s+/)
  let hits = 0
  for (const w of words) {
    if (w === 'in' || w.length < 2) continue
    if (UNITS[normUnit(w)] || canonTemp(w)) hits++
  }
  return hits >= 2 || /(celsius|fahrenheit|kelvin)/.test(m)
}

// ── Tier 2: model-proposed setup + quorum (odd phrasings only) ───────────────────────

const SYSTEM = [
  'You extract a UNIT CONVERSION request into strict JSON. DO NOT convert — a deterministic',
  'converter will. Output ONLY: { "value": <number>, "from": "<unit>", "to": "<unit>" }',
  'If the question is not a unit conversion, output {"value":null}.',
].join('\n')

function parseSetup(text: string): { value: number; from: string; to: string } | null {
  if (!text) return null
  const start = text.indexOf('{'); const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const o = JSON.parse(text.slice(start, end + 1))
    if (o && typeof o.value === 'number' && typeof o.from === 'string' && typeof o.to === 'string') return o
  } catch { /* not JSON */ }
  return null
}

/**
 * Recompute a unit conversion. Tier 1 (deterministic parse) needs no model and no quorum —
 * the table IS the ground truth. Tier 2 extracts the setup from the model K times and
 * requires a quorum on the CONVERTED result. Returns the wordProblem Recomputation shape so
 * the existing reconciliation (applyRecomputation) applies unchanged.
 */
export async function recomputeConversion(
  message: string,
  opts: { samples?: number; complete?: Completer } = {},
): Promise<Recomputation | null> {
  const direct = parseConversion(message)
  if (direct) {
    return { value: round6(direct.result), unit: direct.to, expression: `${direct.value} ${direct.from} → ${direct.to}`, agreement: 1, samples: 0 }
  }

  const samples = Math.max(3, opts.samples ?? 3)
  const complete = opts.complete ?? fmComplete
  const evaluated: Array<{ value: number; to: string; expr: string }> = []
  for (let i = 0; i < samples; i++) {
    let raw: string
    try {
      raw = await complete(
        [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Question:\n${message}` }],
        { temperature: i === 0 ? 0.1 : 0.5 },
      )
    } catch { continue }
    const s = parseSetup(raw)
    if (!s) continue
    const result = convert(s.value, s.from, s.to)
    if (result === null) continue
    evaluated.push({ value: round6(result), to: normUnit(s.to), expr: `${s.value} ${normUnit(s.from)} → ${normUnit(s.to)}` })
  }
  if (evaluated.length < 2) return null

  const byVal = new Map<string, { value: number; n: number; to: string; expr: string }>()
  for (const e of evaluated) {
    const k = String(e.value)
    const slot = byVal.get(k) ?? { value: e.value, n: 0, to: e.to, expr: e.expr }
    slot.n++
    byVal.set(k, slot)
  }
  const quorum = Math.max(2, Math.floor(samples / 2) + 1)
  const top = [...byVal.values()].sort((a, b) => b.n - a.n)[0]
  if (!top || top.n < quorum) return null
  return { value: top.value, unit: top.to, expression: top.expr, agreement: top.n / evaluated.length, samples: evaluated.length }
}

function round6(v: number): number { return Math.round(v * 1e6) / 1e6 }
