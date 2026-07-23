// Shared mutation operators for the verifier teeth-checks (W32 authored corpus +
// W42.2 mined corpus). Extracted verbatim from __faultinject_bench.ts so both the
// authored-task and mined-task fault injectors mutate by the SAME deterministic rules —
// otherwise their kill-rate numbers would not be comparable.
//
// Deterministic (first-match, fixed operator order — no PRNG, no clock). Each operator
// rewrites the FIRST occurrence of its pattern that lies in executable CODE (outside
// string/template literals and comments), keeping the whole sweep replayable byte-for-byte.

export type Op = { name: string; apply: (src: string) => string | null }

// A per-char mask of "this position is executable CODE" — false inside string/template
// literals and comments. Mutating those regions yields EQUIVALENT mutants (an error-message
// '>=' or a commented-out '+' changes no behavior), which would surface as phantom coverage
// holes. Conservative on template literals: the whole `...` (incl. ${} code) is masked out,
// so we simply generate fewer mutants there rather than risk a false positive.
export const codeMask = (src: string): boolean[] => {
  const mask = new Array<boolean>(src.length).fill(true)
  let i = 0
  const set = (from: number, to: number) => { for (let k = from; k < to && k < src.length; k++) mask[k] = false }
  while (i < src.length) {
    const c = src[i], d = src[i + 1]
    if (c === '/' && d === '/') { const nl = src.indexOf('\n', i); const end = nl < 0 ? src.length : nl; set(i, end); i = end; continue }
    if (c === '/' && d === '*') { const close = src.indexOf('*/', i + 2); const end = close < 0 ? src.length : close + 2; set(i, end); i = end; continue }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++ }
      set(i, j + 1); i = j + 1; continue
    }
    i++
  }
  return mask
}

const firstCodeIndex = (src: string, mask: boolean[], needle: string): number => {
  let from = 0
  for (;;) {
    const i = src.indexOf(needle, from)
    if (i < 0) return -1
    if (mask[i]) return i
    from = i + 1
  }
}

const firstReplace = (src: string, needle: string, repl: string): string | null => {
  const i = firstCodeIndex(src, codeMask(src), needle)
  return i < 0 ? null : src.slice(0, i) + repl + src.slice(i + needle.length)
}

const firstReplaceRe = (src: string, re: RegExp, repl: string): string | null => {
  const mask = codeMask(src)
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  let m: RegExpExecArray | null
  while ((m = g.exec(src)) !== null) {
    if (mask[m.index]) return src.slice(0, m.index) + repl + src.slice(m.index + m[0].length)
    if (m.index === g.lastIndex) g.lastIndex++
  }
  return null
}

export const OPS: Op[] = [
  { name: 'ge->gt',        apply: s => firstReplace(s, '>=', '>') },
  { name: 'le->lt',        apply: s => firstReplace(s, '<=', '<') },
  { name: 'gt->ge',        apply: s => firstReplaceRe(s, /([^>=!])>([^=])/, '$1>=$2') },
  { name: 'lt->le',        apply: s => firstReplaceRe(s, /([^<=!])<([^=])/, '$1<=$2') },
  { name: 'eqeqeq->neqeq', apply: s => firstReplace(s, '===', '!==') },
  { name: 'neqeq->eqeqeq', apply: s => firstReplace(s, '!==', '===') },
  { name: 'plus->minus',   apply: s => firstReplace(s, ' + ', ' - ') },
  { name: 'minus->plus',   apply: s => firstReplace(s, ' - ', ' + ') },
  { name: 'mul->plus',     apply: s => firstReplace(s, ' * ', ' + ') },
  { name: 'and->or',       apply: s => firstReplace(s, ' && ', ' || ') },
  { name: 'or->and',       apply: s => firstReplace(s, ' || ', ' && ') },
  { name: 'true->false',   apply: s => firstReplaceRe(s, /\btrue\b/, 'false') },
  { name: 'false->true',   apply: s => firstReplaceRe(s, /\bfalse\b/, 'true') },
  { name: 'off-by-one',    apply: s => firstReplace(s, '+ 1', '+ 2') },
  { name: 'inc->dec',      apply: s => firstReplace(s, '++', '--') },
]

/** A generated mutant: the operator, the mutated source, and WHERE it struck (for triage). */
export interface Mutant {
  op: string
  src: string
  /** 1-based line of the mutation in the ORIGINAL source (from the first differing character). */
  line: number
  /** The original line's trimmed text and the mutated line's trimmed text — the before→after diff. */
  before: string
  after: string
}

/** Index of the first character where a and b differ (works for shorter- or longer-than replacements). */
const firstDiffIndex = (a: string, b: string): number => {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return n
}

/** 1-based line number of a character index. */
const lineOfIndex = (src: string, idx: number): number => {
  let line = 1
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === '\n') line++
  return line
}

const lineText = (src: string, line: number): string => (src.split('\n')[line - 1] ?? '').trim()

/** Distinct mutants of `src` (drops operators that leave the source unchanged), each with its
 *  line location and before→after line text so a surviving mutant can be triaged (equivalent vs
 *  a real coverage hole) without re-deriving where the operator struck. */
export const generateMutants = (src: string): Mutant[] => {
  const mutants: Mutant[] = []
  for (const op of OPS) {
    const m = op.apply(src)
    if (m !== null && m !== src) {
      const line = lineOfIndex(src, firstDiffIndex(src, m))
      mutants.push({ op: op.name, src: m, line, before: lineText(src, line), after: lineText(m, line) })
    }
  }
  return mutants
}
