// Extended coding-bench corpus — strings/parsing shard (W42, GAP_CLOSURE_ADDENDUM.md).
//
// Why this exists: the generated-path bench had n=10, a ±26-point noise floor at 95%.
// Every task here is authored to be CATALOG-FREE (asserted mechanically by
// __taskcorpus_bench.ts against synthesize()) so it grows the number that matters — the
// novel-code path — not the retrieval headline.
//
// Per task: `prompt` is the agent-facing spec (exact path + exact API + mechanical error
// contract, edge cases deliberately NOT enumerated); `ref` is the bench-side reference
// solution; `suite` is the hidden adversarial suite. ref+suite are ground truth for the
// harness — they must NEVER appear in any model prompt (the corpus validator certifies
// ref-passes-suite through the real hermetic oracle).
//
// Authoring discipline: embedded code contains no backticks and no dollar-brace so it can
// live inside these template literals verbatim.

export interface ExtTask {
  id: string
  title: string
  modulePath: string
  prompt: string
  /** Bench-side reference solution — never shown to the agent. */
  ref: string
  /** Hidden adversarial suite — imports '../src/<name>', runs from __audit__/. */
  suite: string
}

const CONTRACT =
  'Build the COMPLETE, production-quality implementation — no placeholders, no TODOs, no stub bodies. ' +
  'You MUST create the exact file path and export the exact API named below (an automated audit imports it verbatim). ' +
  'Verify it actually runs before reporting done.'

export const STRING_TASKS: ExtTask[] = [
  {
    id: 'templateExpand',
    title: 'Dot-path template expansion with escapes',
    modulePath: 'src/templateExpand.ts',
    prompt: `Implement a template expander in TypeScript at src/templateExpand.ts. ${CONTRACT}

Export exactly:
  export function expand(template: string, ctx: object): string

Semantics:
- Placeholders are written {path} where path is a dot-separated chain of property names,
  e.g. "Hello {user.name}" with { user: { name: "Ada" } } yields "Hello Ada".
- The resolved value is rendered with String(value).
- If any step of the path is missing, or the final value is undefined, the placeholder is
  left in the output verbatim (including its braces).
- A backslash escapes the next character: "\\{" is a literal "{" and "\\\\" is a literal
  backslash; an escaped brace never starts a placeholder.
- An unterminated "{" (no closing "}") is not a placeholder — the rest of the string is
  literal output.
- Error contract: if ctx is null or not an object, throw a TypeError.`,
    ref: `export function expand(template: string, ctx: object): string {
  if (ctx === null || typeof ctx !== 'object') throw new TypeError('ctx must be a non-null object')
  let out = ''
  let i = 0
  while (i < template.length) {
    const ch = template[i]
    if (ch === '\\\\') {
      if (i + 1 < template.length) { out += template[i + 1]; i += 2 } else { out += ch; i += 1 }
      continue
    }
    if (ch === '{') {
      const close = template.indexOf('}', i + 1)
      if (close === -1) { out += template.slice(i); break }
      const inner = template.slice(i + 1, close)
      const parts = inner.trim().split('.')
      let cur: unknown = ctx
      let ok = parts.length > 0 && inner.trim() !== ''
      for (const p of parts) {
        if (!ok) break
        if (cur !== null && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
          cur = (cur as Record<string, unknown>)[p]
        } else { ok = false }
      }
      if (ok && cur !== undefined) out += String(cur)
      else out += '{' + inner + '}'
      i = close + 1
      continue
    }
    out += ch
    i += 1
  }
  return out
}
`,
    suite: `// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — templateExpand.
// Run: npx tsx __audit__/templateExpand.hidden.ts   (imports ../src/templateExpand)
import { expand } from '../src/templateExpand'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}
function throws(name: string, fn: () => void, ctor: Function) {
  let caught: unknown = null
  try { fn() } catch (e) { caught = e }
  check(name, caught instanceof ctor)
}

check('simple replacement', expand('Hello {name}', { name: 'Ada' }) === 'Hello Ada')
check('nested dot path', expand('{a.b.c}', { a: { b: { c: 42 } } }) === '42')
check('missing path kept verbatim', expand('x {a.z} y', { a: {} }) === 'x {a.z} y')
check('undefined value kept verbatim', expand('{k}', { k: undefined }) === '{k}')
check('null renders as "null"', expand('{k}', { k: null }) === 'null')
check('boolean renders', expand('{k}', { k: false }) === 'false')
check('array index via dot', expand('{items.1}', { items: ['a', 'b'] }) === 'b')
check('escaped brace is literal', expand('\\\\{name}', { name: 'Ada' }) === '{name}')
check('escaped backslash', expand('\\\\\\\\{name}', { name: 'Ada' }) === '\\\\Ada')
check('unterminated brace is literal', expand('a {oops', { oops: 1 }) === 'a {oops')
check('adjacent placeholders', expand('{a}{b}', { a: 1, b: 2 }) === '12')
check('empty template', expand('', {}) === '')
throws('null ctx throws TypeError', () => expand('x', null as unknown as object), TypeError)
throws('string ctx throws TypeError', () => expand('x', 's' as unknown as object), TypeError)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`,
  },

  {
    id: 'csvLine',
    title: 'Single-line CSV field parser with quoting',
    modulePath: 'src/csvLine.ts',
    prompt: `Implement a CSV line parser in TypeScript at src/csvLine.ts. ${CONTRACT}

Export exactly:
  export function parseCsvLine(line: string): string[]

Semantics (RFC-4180 style, one line):
- Fields are separated by commas. An empty field is the empty string, including a trailing
  empty field after a trailing comma.
- A field wrapped in double quotes may contain commas and doubled quotes; "" inside a
  quoted field is a literal quote character.
- Whitespace is preserved exactly; no trimming.
- Error contract (throw SyntaxError): a quote character appearing inside an UNQUOTED field;
  characters after a closing quote that are not a comma or end of line; an unterminated
  quoted field; any carriage return or newline in the input.`,
    ref: `export function parseCsvLine(line: string): string[] {
  if (/[\\r\\n]/.test(line)) throw new SyntaxError('input must be a single line')
  const fields: string[] = []
  let i = 0
  for (;;) {
    let field = ''
    if (line[i] === '"') {
      i += 1
      let closed = false
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') { field += '"'; i += 2 }
          else { i += 1; closed = true; break }
        } else { field += line[i]; i += 1 }
      }
      if (!closed) throw new SyntaxError('unterminated quoted field')
      if (i < line.length && line[i] !== ',') throw new SyntaxError('unexpected character after closing quote')
    } else {
      while (i < line.length && line[i] !== ',') {
        if (line[i] === '"') throw new SyntaxError('quote inside unquoted field')
        field += line[i]; i += 1
      }
    }
    fields.push(field)
    if (i >= line.length) break
    i += 1
    if (i === line.length) { fields.push(''); break }
  }
  return fields
}
`,
    suite: `// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — csvLine.
// Run: npx tsx __audit__/csvLine.hidden.ts   (imports ../src/csvLine)
import { parseCsvLine } from '../src/csvLine'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}
function eq(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}
function throws(name: string, fn: () => void) {
  let caught: unknown = null
  try { fn() } catch (e) { caught = e }
  check(name, caught instanceof SyntaxError)
}

check('plain fields', eq(parseCsvLine('a,b,c'), ['a', 'b', 'c']))
check('empty middle field', eq(parseCsvLine('a,,c'), ['a', '', 'c']))
check('trailing comma yields trailing empty', eq(parseCsvLine('a,b,'), ['a', 'b', '']))
check('single empty line is one empty field', eq(parseCsvLine(''), ['']))
check('quoted comma', eq(parseCsvLine('"a,b",c'), ['a,b', 'c']))
check('doubled quote is literal', eq(parseCsvLine('"say ""hi""",x'), ['say "hi"', 'x']))
check('whole-line quoted field', eq(parseCsvLine('"only"'), ['only']))
check('empty quoted field', eq(parseCsvLine('""'), ['']))
check('whitespace preserved', eq(parseCsvLine(' a , b '), [' a ', ' b ']))
check('quoted field then empty', eq(parseCsvLine('"a",'), ['a', '']))
throws('unterminated quote throws', () => parseCsvLine('"abc'))
throws('quote inside unquoted throws', () => parseCsvLine('a"b,c'))
throws('junk after closing quote throws', () => parseCsvLine('"a"b,c'))
throws('newline in input throws', () => parseCsvLine('a\\nb'))

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`,
  },

  {
    id: 'wordWrap',
    title: 'Greedy word wrap with hard-break for overlong words',
    modulePath: 'src/wordWrap.ts',
    prompt: `Implement a word wrapper in TypeScript at src/wordWrap.ts. ${CONTRACT}

Export exactly:
  export function wrap(text: string, width: number): string

Semantics:
- Greedy fill: pack as many words onto a line as fit in width characters, counting the
  single spaces between them; break before the word that would overflow.
- Runs of spaces collapse to a single space; lines never begin or end with a space.
- A single word longer than width is hard-split into width-sized chunks.
- Existing newline characters in the input are hard breaks: each input line wraps
  independently, and empty input lines are preserved as empty output lines.
- Error contract: if width < 1 or not an integer, throw a RangeError.`,
    ref: `export function wrap(text: string, width: number): string {
  if (!Number.isInteger(width) || width < 1) throw new RangeError('width must be an integer >= 1')
  const outLines: string[] = []
  for (const line of text.split('\\n')) {
    const words = line.split(/ +/).filter(w => w.length > 0)
    if (words.length === 0) { outLines.push(''); continue }
    let cur = ''
    const flush = () => { if (cur.length > 0) { outLines.push(cur); cur = '' } }
    for (let w of words) {
      while (w.length > width) {
        flush()
        outLines.push(w.slice(0, width))
        w = w.slice(width)
      }
      if (w.length === 0) continue
      if (cur.length === 0) cur = w
      else if (cur.length + 1 + w.length <= width) cur += ' ' + w
      else { flush(); cur = w }
    }
    flush()
  }
  return outLines.join('\\n')
}
`,
    suite: `// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — wordWrap.
// Run: npx tsx __audit__/wordWrap.hidden.ts   (imports ../src/wordWrap)
import { wrap } from '../src/wordWrap'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}
function throws(name: string, fn: () => void) {
  let caught: unknown = null
  try { fn() } catch (e) { caught = e }
  check(name, caught instanceof RangeError)
}

check('no wrap needed', wrap('ab cd', 10) === 'ab cd')
check('simple wrap', wrap('aa bb cc', 5) === 'aa bb\\ncc')
check('exact fit boundary', wrap('aaa bb', 6) === 'aaa bb')
check('one over boundary wraps', wrap('aaa bbb', 6) === 'aaa\\nbbb')
check('overlong word hard-split', wrap('abcdefgh', 3) === 'abc\\ndef\\ngh')
check('overlong word mid-text', wrap('x abcdefg y', 3) === 'x\\nabc\\ndef\\ng y')
check('spaces collapse', wrap('a    b', 10) === 'a b')
check('leading/trailing spaces dropped', wrap('  a b  ', 10) === 'a b')
check('existing newlines are hard breaks', wrap('ab\\ncd', 10) === 'ab\\ncd')
check('empty input line preserved', wrap('ab\\n\\ncd', 10) === 'ab\\n\\ncd')
check('width 1 splits everything', wrap('ab c', 1) === 'a\\nb\\nc')
check('empty string stays empty', wrap('', 5) === '')
check('lines never exceed width', wrap('the quick brown fox jumps', 7).split('\\n').every(l => l.length <= 7))
throws('width 0 throws RangeError', () => wrap('x', 0))
throws('fractional width throws RangeError', () => wrap('x', 2.5))

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`,
  },

  {
    id: 'dedentText',
    title: 'Common-indentation stripper',
    modulePath: 'src/dedentText.ts',
    prompt: `Implement a dedenter in TypeScript at src/dedentText.ts. ${CONTRACT}

Export exactly:
  export function dedent(text: string): string

Semantics:
- Compute the minimum leading-whitespace length (spaces and tabs each count as one
  character) across all non-blank lines, then remove exactly that many leading characters
  from every non-blank line.
- Blank lines (empty or whitespace-only) become empty strings, and the line count is
  preserved exactly.
- If there are no non-blank lines, every line becomes empty.
- Relative indentation between lines is preserved.`,
    ref: `export function dedent(text: string): string {
  const lines = text.split('\\n')
  const nonBlank = lines.filter(l => l.trim() !== '')
  const indentOf = (l: string): number => {
    const m = l.match(/^[ \\t]*/)
    return m ? m[0].length : 0
  }
  const min = nonBlank.length === 0 ? 0 : Math.min(...nonBlank.map(indentOf))
  return lines.map(l => (l.trim() === '' ? '' : l.slice(min))).join('\\n')
}
`,
    suite: `// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — dedentText.
// Run: npx tsx __audit__/dedentText.hidden.ts   (imports ../src/dedentText)
import { dedent } from '../src/dedentText'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

check('uniform indent stripped', dedent('  a\\n  b') === 'a\\nb')
check('relative indent preserved', dedent('  a\\n    b') === 'a\\n  b')
check('min across lines wins', dedent('    a\\n  b') === '  a\\nb')
check('no indent unchanged', dedent('a\\nb') === 'a\\nb')
check('blank line becomes empty', dedent('  a\\n\\n  b') === 'a\\n\\nb')
check('whitespace-only line becomes empty', dedent('  a\\n   \\n  b') === 'a\\n\\nb')
check('blank lines do not affect the minimum', dedent('    a\\n \\n    b') === 'a\\n\\nb')
check('tabs count as one char each', dedent('\\ta\\n\\tb') === 'a\\nb')
check('mixed tab/space by count', dedent('\\t a\\n  b') === 'a\\nb')
check('line count preserved', dedent('  a\\n\\n  b').split('\\n').length === 3)
check('all-blank input becomes empties', dedent('  \\n \\n') === '\\n\\n')
check('empty string stays empty', dedent('') === '')
check('single line', dedent('   x') === 'x')

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`,
  },

  {
    id: 'queryDecode',
    title: 'Query-string decoder with UTF-8 percent sequences',
    modulePath: 'src/queryDecode.ts',
    prompt: `Implement a query-string decoder in TypeScript at src/queryDecode.ts. ${CONTRACT}

Export exactly:
  export function parseQuery(qs: string): Record<string, string | string[]>

Semantics:
- An optional leading "?" is ignored. Pairs are separated by "&"; empty segments are
  skipped. The first "=" splits key from value; a segment with no "=" maps the key to "".
- "+" decodes to a space in both keys and values.
- Valid percent sequences decode as UTF-8 bytes (so multi-byte sequences like %C3%A9
  decode to a single character). An INVALID percent sequence (not followed by two hex
  digits) is left in the output literally — never throw.
- A key that appears once maps to its string; a key that appears multiple times maps to an
  array of its values in order of appearance.
- The empty string (or just "?") returns {}.`,
    ref: `function decodeComponent(s: string): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === '+') { out += ' '; i += 1; continue }
    if (ch === '%' && /^[0-9A-Fa-f]{2}/.test(s.slice(i + 1, i + 3))) {
      const bytes: number[] = []
      while (i < s.length && s[i] === '%' && /^[0-9A-Fa-f]{2}/.test(s.slice(i + 1, i + 3))) {
        bytes.push(parseInt(s.slice(i + 1, i + 3), 16))
        i += 3
      }
      out += Buffer.from(bytes).toString('utf8')
      continue
    }
    out += ch
    i += 1
  }
  return out
}

export function parseQuery(qs: string): Record<string, string | string[]> {
  const src = qs.startsWith('?') ? qs.slice(1) : qs
  const out: Record<string, string | string[]> = {}
  for (const seg of src.split('&')) {
    if (seg === '') continue
    const eq = seg.indexOf('=')
    const key = decodeComponent(eq === -1 ? seg : seg.slice(0, eq))
    const val = eq === -1 ? '' : decodeComponent(seg.slice(eq + 1))
    const existing = out[key]
    if (existing === undefined) out[key] = val
    else if (Array.isArray(existing)) existing.push(val)
    else out[key] = [existing, val]
  }
  return out
}
`,
    suite: `// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — queryDecode.
// Run: npx tsx __audit__/queryDecode.hidden.ts   (imports ../src/queryDecode)
import { parseQuery } from '../src/queryDecode'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

const q1 = parseQuery('a=1&b=2')
check('basic pairs', q1.a === '1' && q1.b === '2')
check('leading question mark ignored', parseQuery('?x=y').x === 'y')
check('plus decodes to space', parseQuery('k=a+b').k === 'a b')
check('plus in key too', parseQuery('a+b=c')['a b'] === 'c')
check('percent decodes', parseQuery('k=%20').k === ' ')
check('multibyte utf8 sequence', parseQuery('k=%C3%A9').k === '\\u00e9')
check('invalid percent left literal', parseQuery('k=%ZZx').k === '%ZZx')
check('trailing lone percent literal', parseQuery('k=ab%').k === 'ab%')
const rep = parseQuery('a=1&a=2&a=3')
check('repeated key becomes array in order', Array.isArray(rep.a) && (rep.a as string[]).join(',') === '1,2,3')
check('no equals means empty value', parseQuery('flag').flag === '')
check('equals in value survives', parseQuery('a=b=c').a === 'b=c')
check('empty segments skipped', Object.keys(parseQuery('a=1&&b=2')).length === 2)
check('empty string gives empty object', Object.keys(parseQuery('')).length === 0)
check('just question mark gives empty object', Object.keys(parseQuery('?')).length === 0)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`,
  },
]
