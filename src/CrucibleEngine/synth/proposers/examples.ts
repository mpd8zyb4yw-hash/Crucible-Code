// ============================================================================
// Spec → typed I/O examples — the input the pure-code enumerative proposer reasons over.
//
// A worked example in a spec ("editDistance('kitten','sitting') === 3") IS a behavioral
// constraint: input args → output. This module turns those lines into concrete (args, output)
// pairs WITHOUT eval — a tiny recursive-descent literal parser handles strings/numbers/arrays/
// objects/booleans safely (no `new Function`, no code execution on spec text). The enumerator
// then searches a typed program space for a function consistent with every pair, and the oracle
// re-verifies the emitted code, so a mis-parse can never ship wrong code — only miss a solution.
// ============================================================================
import { extractFeatures } from '../synthEngine'

export interface IoExample { args: unknown[]; output: unknown }
export interface Param { name: string; type: string }
export interface Signature { params: Param[]; ret: string | null }
export interface ParsedExamples {
  fnName: string
  arity: number
  examples: IoExample[]
  signature: Signature | null
}

// ── A safe literal parser (no eval). Parses the literal forms that appear in worked
//    examples: numbers, single/double/backtick strings, arrays, plain objects, booleans,
//    null/undefined/NaN/Infinity. Anything else (an identifier, a call, an operator) throws,
//    so that example is simply skipped rather than executed. ───────────────────────────────
class LitParser {
  private i = 0
  constructor(private readonly s: string) {}

  private ws(): void { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++ }

  parseValue(): unknown {
    this.ws()
    const c = this.s[this.i]
    if (c === undefined) throw new Error('unexpected end of input')
    if (c === '"' || c === "'" || c === '`') return this.parseString(c)
    if (c === '[') return this.parseArray()
    if (c === '{') return this.parseObject()
    if (c === '-' || c === '+' || (c >= '0' && c <= '9') || c === '.') return this.parseNumber()
    for (const [kw, val] of KEYWORDS) {
      if (this.s.startsWith(kw, this.i) && !/[A-Za-z0-9_$]/.test(this.s[this.i + kw.length] ?? '')) {
        this.i += kw.length
        return val
      }
    }
    throw new Error(`unexpected token '${this.s.slice(this.i, this.i + 12)}'`)
  }

  private parseString(q: string): string {
    this.i++ // opening quote
    let out = ''
    while (this.i < this.s.length) {
      const c = this.s[this.i++]
      if (c === '\\') {
        const e = this.s[this.i++]
        out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === 'b' ? '\b'
          : e === '0' ? '\0' : e === q ? q : e === '\\' ? '\\' : e ?? ''
      } else if (c === q) {
        return out
      } else {
        out += c
      }
    }
    throw new Error('unterminated string literal')
  }

  private parseNumber(): number {
    const m = /^[+-]?(?:0x[0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(this.s.slice(this.i))
    if (!m) throw new Error('malformed number')
    this.i += m[0].length
    const n = Number(m[0])
    if (Number.isNaN(n)) throw new Error('malformed number')
    return n
  }

  private parseArray(): unknown[] {
    this.i++ // [
    const arr: unknown[] = []
    this.ws()
    if (this.s[this.i] === ']') { this.i++; return arr }
    for (;;) {
      arr.push(this.parseValue())
      this.ws()
      const d = this.s[this.i++]
      if (d === ']') return arr
      if (d !== ',') throw new Error("expected ',' or ']' in array")
      this.ws()
      if (this.s[this.i] === ']') { this.i++; return arr } // tolerate trailing comma
    }
  }

  private parseObject(): Record<string, unknown> {
    this.i++ // {
    const obj: Record<string, unknown> = {}
    this.ws()
    if (this.s[this.i] === '}') { this.i++; return obj }
    for (;;) {
      this.ws()
      const c = this.s[this.i]
      let key: string
      if (c === '"' || c === "'" || c === '`') {
        key = this.parseString(c)
      } else {
        const m = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i))
        if (!m) throw new Error('malformed object key')
        key = m[0]; this.i += m[0].length
      }
      this.ws()
      if (this.s[this.i++] !== ':') throw new Error("expected ':' in object")
      obj[key] = this.parseValue()
      this.ws()
      const d = this.s[this.i++]
      if (d === '}') return obj
      if (d !== ',') throw new Error("expected ',' or '}' in object")
    }
  }

  /** Parse exactly one literal that consumes the whole string (after trimming). */
  parseWhole(): unknown {
    const v = this.parseValue()
    this.ws()
    if (this.i !== this.s.length) throw new Error(`trailing input '${this.s.slice(this.i, this.i + 12)}'`)
    return v
  }
}
const KEYWORDS: ReadonlyArray<readonly [string, unknown]> = [
  ['true', true], ['false', false], ['null', null], ['undefined', undefined],
  ['NaN', NaN], ['Infinity', Infinity],
]

export function parseLiteral(src: string): unknown {
  return new LitParser(src.trim()).parseWhole()
}

// ── Find a call `name( … )` in a line, returning the inner-args source and the index just
//    after the matching ')'. Parens inside string literals are ignored. ───────────────────
function findCall(line: string, names: string[]): { name: string; argsSrc: string; start: number; end: number } | null {
  for (const name of names) {
    const re = new RegExp(`(?:^|[^\\w$.])(${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\s*\\(`, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(line))) {
      const start = m.index + m[0].indexOf(name)
      const open = m.index + m[0].length - 1 // index of '('
      const close = matchParen(line, open)
      if (close < 0) continue
      return { name, argsSrc: line.slice(open + 1, close), start, end: close + 1 }
    }
  }
  return null
}

/** Index of the ')' matching the '(' at `open`, skipping string literals; -1 if unbalanced. */
function matchParen(s: string, open: number): number {
  let depth = 0
  let quote = ''
  for (let i = open; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i }
  }
  return -1
}

const SEP = /^\s*(?:===|==|=>|->|→|\breturns?\b|\bgives?\b|\bequals?\b|\bis\b)\s*(.+)$/

/** Parse one spec line into an example for one of `names`, or null if it isn't a worked example. */
function exampleFromLine(rawLine: string, names: string[]): { name: string; ex: IoExample } | null {
  const line = rawLine.trim().replace(/^[-*\d.)\s]+/, '').replace(/[.;,]+\s*$/, '')
  if (!line) return null
  const call = findCall(line, names)
  if (!call) return null
  // The call must be the left-hand side: nothing but whitespace before it on the (stripped) line
  // (rejects forms like "x = f(1)" or "assert(f(1))" where the call isn't the bare LHS).
  if (line.slice(0, call.start).trim() !== '') return null
  const sepMatch = SEP.exec(line.slice(call.end))
  if (!sepMatch) return null
  let args: unknown[]
  let output: unknown
  try {
    args = parseLiteral(`[${call.argsSrc}]`) as unknown[]
    output = parseLiteral(sepMatch[1])
  } catch {
    return null // RHS or args weren't pure literals — can't use this example, skip honestly
  }
  if (!Array.isArray(args)) return null
  return { name: call.name, ex: { args, output } }
}

/** Extract `export function NAME(params): ret` signature for a given function name. */
function extractSignature(spec: string, fnName: string): Signature | null {
  const re = new RegExp(`\\bfunction\\s+${fnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(([^)]*)\\)\\s*(?::\\s*([^\\n{=;]+))?`)
  const m = re.exec(spec)
  if (!m) return null
  const paramsSrc = m[1].trim()
  const params: Param[] = paramsSrc
    ? paramsSrc.split(',').map(p => {
        const seg = p.trim().replace(/=.*/, '').trim()
        const colon = seg.indexOf(':')
        if (colon < 0) return { name: seg.replace(/[?.]/g, '').trim() || 'x', type: 'any' }
        return { name: seg.slice(0, colon).replace(/[?.]/g, '').trim(), type: seg.slice(colon + 1).trim() }
      })
    : []
  return { params, ret: m[2]?.trim() ?? null }
}

/**
 * Parse a spec into the single function-with-examples the enumerator should target. Picks the
 * exported function backed by the most worked examples; returns null if none have ≥1 usable
 * example. Examples with an off-modal arity are dropped (keeps the I/O set consistent).
 */
export function parseIoExamples(spec: string): ParsedExamples | null {
  const feats = extractFeatures(spec)
  const names = feats.exports
  if (!names.length) return null

  const byName = new Map<string, IoExample[]>()
  for (const line of spec.split('\n')) {
    const hit = exampleFromLine(line, names)
    if (!hit) continue
    if (!byName.has(hit.name)) byName.set(hit.name, [])
    byName.get(hit.name)!.push(hit.ex)
  }
  if (!byName.size) return null

  // Choose the function with the most examples (ties → first by spec order).
  let fnName = ''
  let best = 0
  for (const name of names) {
    const n = byName.get(name)?.length ?? 0
    if (n > best) { best = n; fnName = name }
  }
  if (!fnName) return null

  let examples = byName.get(fnName)!
  // Keep only the modal arity so the I/O set is shape-consistent.
  const arityCounts = new Map<number, number>()
  for (const e of examples) arityCounts.set(e.args.length, (arityCounts.get(e.args.length) ?? 0) + 1)
  let arity = 0; let arityBest = 0
  for (const [a, c] of arityCounts) if (c > arityBest) { arityBest = c; arity = a }
  examples = examples.filter(e => e.args.length === arity)
  if (!examples.length) return null

  return { fnName, arity, examples, signature: extractSignature(spec, fnName) }
}
