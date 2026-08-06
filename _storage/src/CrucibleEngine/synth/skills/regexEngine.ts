// Verified primitive: a small backtracking regex engine (full-match) supporting literals,
// '.', '*', '+', '?', character classes [abc]/[a-z], and '\\' escaping. General; the
// "pattern matching / mini regex" task family maps onto it.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — verified mini regex engine (full match).
// Supports: literals, '.', '*', '+', '?', char classes [abc] / [a-z], and '\\\\' escaping.

interface Tok { kind: 'lit' | 'dot' | 'class'; ch?: string; test?: (c: string) => boolean; quant: '' | '*' | '+' | '?' }

function parse(p: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  while (i < p.length) {
    let tok: Tok
    const c = p[i]
    if (c === '\\\\') { tok = { kind: 'lit', ch: p[i + 1], quant: '' }; i += 2 }
    else if (c === '.') { tok = { kind: 'dot', quant: '' }; i++ }
    else if (c === '[') {
      const j = p.indexOf(']', i)
      const body = p.slice(i + 1, j < 0 ? p.length : j)
      const singles: string[] = []
      const ranges: Array<[string, string]> = []
      for (let k = 0; k < body.length; k++) {
        if (body[k + 1] === '-' && k + 2 < body.length) { ranges.push([body[k], body[k + 2]]); k += 2 }
        else singles.push(body[k])
      }
      tok = { kind: 'class', quant: '', test: (ch: string) => singles.includes(ch) || ranges.some(([a, b]) => ch >= a && ch <= b) }
      i = (j < 0 ? p.length : j + 1)
    } else { tok = { kind: 'lit', ch: c, quant: '' }; i++ }
    if (p[i] === '*' || p[i] === '+' || p[i] === '?') { tok.quant = p[i] as Tok['quant']; i++ }
    toks.push(tok)
  }
  return toks
}

function single(tok: Tok, ch: string | undefined): boolean {
  if (ch === undefined) return false
  if (tok.kind === 'dot') return true
  if (tok.kind === 'lit') return ch === tok.ch
  return tok.test!(ch)
}

function matchFrom(toks: Tok[], ti: number, text: string, si: number): boolean {
  if (ti === toks.length) return si === text.length
  const tok = toks[ti]
  if (tok.quant === '*' || tok.quant === '+') {
    const positions: number[] = []
    let k = si
    if (tok.quant === '+') { if (!single(tok, text[k])) return false; k++ }
    positions.push(k)
    while (single(tok, text[k])) { k++; positions.push(k) }
    for (let p = positions.length - 1; p >= 0; p--) {   // greedy with backtrack
      if (matchFrom(toks, ti + 1, text, positions[p])) return true
    }
    return false
  }
  if (tok.quant === '?') {
    if (single(tok, text[si]) && matchFrom(toks, ti + 1, text, si + 1)) return true
    return matchFrom(toks, ti + 1, text, si)
  }
  return single(tok, text[si]) && matchFrom(toks, ti + 1, text, si + 1)
}

export function regexMatch(pattern: string, text: string): boolean {
  return matchFrom(parse(pattern), 0, text, 0)
}
`

registerSkill({
  id: 'regex-engine',
  summary: 'Mini backtracking regex engine (full match): literals, . * + ?, char classes, escaping.',
  match(s: SpecFeatures): number {
    let score = 0
    if (s.has(/regex|regular expression/i)) score += 0.5
    if (s.has(/\bregexMatch\b/)) score += 0.3
    if (s.has(/character class|char class|\[abc\]|\[a-z\]/i)) score += 0.2
    if (s.has(/backtrack/i)) score += 0.15
    if (s.has(/full[- ]?match|anchored/i)) score += 0.1
    return score
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/regex.ts', content: IMPL }]
  },
})
