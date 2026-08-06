// Verified primitive: parser combinator library — seq, alt, many, map, token, regex.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — parser combinators.
export interface ParseResult<T> { val: T; rest: string }
export type Parser<T> = (input: string) => ParseResult<T> | null

export const token = (s: string): Parser<string> =>
  input => input.startsWith(s) ? { val: s, rest: input.slice(s.length) } : null

export const regex = (re: RegExp): Parser<string> => {
  const anchored = new RegExp('^' + re.source, re.flags.replace('g', ''))
  return input => { const m = anchored.exec(input); return m ? { val: m[0], rest: input.slice(m[0].length) } : null }
}

export const map = <A, B>(p: Parser<A>, f: (a: A) => B): Parser<B> =>
  input => { const r = p(input); return r ? { val: f(r.val), rest: r.rest } : null }

export const seq = <T extends unknown[]>(...ps: { [K in keyof T]: Parser<T[K]> }): Parser<T> =>
  input => {
    const vals: unknown[] = []; let cur = input
    for (const p of ps) { const r = (p as Parser<unknown>)(cur); if (!r) return null; vals.push(r.val); cur = r.rest }
    return { val: vals as T, rest: cur }
  }

export const alt = <T>(...ps: Parser<T>[]): Parser<T> =>
  input => { for (const p of ps) { const r = p(input); if (r) return r } return null }

export const many = <T>(p: Parser<T>): Parser<T[]> =>
  input => { const vals: T[] = []; let cur = input; while (true) { const r = p(cur); if (!r) break; vals.push(r.val); cur = r.rest } return { val: vals, rest: cur } }

export const many1 = <T>(p: Parser<T>): Parser<T[]> =>
  input => { const r = many(p)(input); return r && r.val.length ? r : null }

export const optional = <T>(p: Parser<T>): Parser<T | null> =>
  input => { const r = p(input); return r ?? { val: null, rest: input } }

export const ws: Parser<string> = regex(/\s*/)
export const integer: Parser<number> = map(regex(/[+-]?\d+/), Number)
export const float_: Parser<number> = map(regex(/[+-]?\d+(\.\d+)?/), Number)
`
registerSkill({
  id: 'parser-combinator',
  summary: 'Parser combinators: seq, alt, many, map, token, regex, ws, integer.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bparser.?combinator\b/i)) sc += 0.6
    if (s.has(/\bparsec\b|\bmonadic.?pars\w+\b/i)) sc += 0.3
    if (s.has(/\bseq\b/i) && s.has(/\balt\b/i) && s.has(/\bmany\b/i)) sc += 0.3
    if (s.has(/\bcombinator\b/i) && s.has(/\bpars\w+\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/parser.ts', content: IMPL }]
  },
})
