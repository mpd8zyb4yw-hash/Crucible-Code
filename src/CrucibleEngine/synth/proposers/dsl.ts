// ============================================================================
// The typed DSL the enumerative proposer searches over. Each operator carries a PAIRED
// (eval, codegen): `ev` computes the operator on concrete example values during the search;
// `code` renders the exact same operation to TypeScript source. They are defined side-by-side
// so they cannot drift — and even if one ever did, the execution oracle re-runs the *emitted*
// code against the spec's tests, so a divergence can only cost a missed solution, never ship a
// wrong one.
//
// Values are dynamically typed by a coarse runtime "tag" (num | str | bool | num[] | str[]).
// An operator declares the tags it accepts and a function from input tags → output tag (null =
// not applicable). This keeps enumeration focused without a full type system; combinations that
// don't type out, or that throw at eval time (e.g. div-by-zero), are simply discarded.
// ============================================================================

export type Tag = 'num' | 'str' | 'bool' | 'num[]' | 'str[]'
export type InSlot = Tag | 'arr' | 'any'

export interface Op {
  name: string
  in: InSlot[]                       // arity = in.length (1 or 2)
  out: (ins: Tag[]) => Tag | null    // null ⇒ operator doesn't apply to these input tags
  ev: (...xs: any[]) => any          // evaluate on concrete example values (may throw → discarded)
  code: (...cs: string[]) => string  // render to TypeScript source (fully parenthesized)
}

export function slotAccepts(slot: InSlot, tag: Tag): boolean {
  if (slot === 'any') return true
  if (slot === 'arr') return tag === 'num[]' || tag === 'str[]'
  return slot === tag
}

const elemOf = (t: Tag): Tag | null => (t === 'num[]' ? 'num' : t === 'str[]' ? 'str' : null)

/** Coarse runtime tag of a value-vector (all examples must agree); null ⇒ unusable. */
export function tagOf(vec: unknown[]): Tag | null {
  let tag: Tag | null = null
  // Arrays: infer element type from every non-empty array; empties adopt the common element type.
  if (vec.length && vec.every(v => Array.isArray(v))) {
    let elem: 'num' | 'str' | null = null
    for (const arr of vec as unknown[][]) {
      for (const x of arr) {
        const et = typeof x === 'number' ? (Number.isFinite(x) ? 'num' : null)
          : typeof x === 'string' ? 'str' : null
        if (et === null) return null
        if (elem === null) elem = et
        else if (elem !== et) return null
      }
    }
    return elem === 'str' ? 'str[]' : 'num[]'  // all-empty ⇒ default num[] (harmless; obs-equiv handles)
  }
  for (const v of vec) {
    let t: Tag
    if (typeof v === 'number') { if (!Number.isFinite(v)) return null; t = 'num' }
    else if (typeof v === 'string') t = 'str'
    else if (typeof v === 'boolean') t = 'bool'
    else return null // undefined/null/object/function/array-mixed-with-scalar ⇒ unusable
    if (tag === null) tag = t
    else if (tag !== t) return null
  }
  return tag
}

export function tsType(tag: Tag): string {
  return tag === 'num' ? 'number' : tag === 'str' ? 'string' : tag === 'bool' ? 'boolean'
    : tag === 'num[]' ? 'number[]' : 'string[]'
}

// ── Guards keep the search from blowing up memory/time on pathological intermediates. ──
const MAX_LEN = 4096
function gLen(n: number): number { if (!Number.isInteger(n) || n < 0 || n > MAX_LEN) throw new Error('len guard'); return n }
function nz(n: number): number { if (n === 0) throw new Error('div by zero'); return n }

const num = (): Tag => 'num'
const str = (): Tag => 'str'
const bool = (): Tag => 'bool'

export const OPS: Op[] = [
  // ── number → number ──
  { name: 'neg',  in: ['num'], out: num, ev: a => -a,            code: a => `(-${a})` },
  { name: 'abs',  in: ['num'], out: num, ev: a => Math.abs(a),   code: a => `Math.abs(${a})` },
  { name: 'inc',  in: ['num'], out: num, ev: a => a + 1,         code: a => `(${a} + 1)` },
  { name: 'dec',  in: ['num'], out: num, ev: a => a - 1,         code: a => `(${a} - 1)` },
  { name: 'dbl',  in: ['num'], out: num, ev: a => a * 2,         code: a => `(${a} * 2)` },
  { name: 'sq',   in: ['num'], out: num, ev: a => a * a,         code: a => `(${a} * ${a})` },
  { name: 'sign', in: ['num'], out: num, ev: a => Math.sign(a),  code: a => `Math.sign(${a})` },

  // ── (number, number) → number ──
  { name: 'add', in: ['num', 'num'], out: num, ev: (a, b) => a + b, code: (a, b) => `(${a} + ${b})` },
  { name: 'sub', in: ['num', 'num'], out: num, ev: (a, b) => a - b, code: (a, b) => `(${a} - ${b})` },
  { name: 'mul', in: ['num', 'num'], out: num, ev: (a, b) => a * b, code: (a, b) => `(${a} * ${b})` },
  { name: 'div', in: ['num', 'num'], out: num, ev: (a, b) => a / nz(b),               code: (a, b) => `(${a} / ${b})` },
  { name: 'idiv', in: ['num', 'num'], out: num, ev: (a, b) => Math.trunc(a / nz(b)),  code: (a, b) => `Math.trunc(${a} / ${b})` },
  { name: 'mod', in: ['num', 'num'], out: num, ev: (a, b) => a % nz(b),               code: (a, b) => `(${a} % ${b})` },
  { name: 'max', in: ['num', 'num'], out: num, ev: (a, b) => Math.max(a, b), code: (a, b) => `Math.max(${a}, ${b})` },
  { name: 'min', in: ['num', 'num'], out: num, ev: (a, b) => Math.min(a, b), code: (a, b) => `Math.min(${a}, ${b})` },

  // ── comparisons / logic → boolean ──
  { name: 'eqNum', in: ['num', 'num'], out: bool, ev: (a, b) => a === b, code: (a, b) => `(${a} === ${b})` },
  { name: 'ltNum', in: ['num', 'num'], out: bool, ev: (a, b) => a < b,   code: (a, b) => `(${a} < ${b})` },
  { name: 'gtNum', in: ['num', 'num'], out: bool, ev: (a, b) => a > b,   code: (a, b) => `(${a} > ${b})` },
  { name: 'eqStr', in: ['str', 'str'], out: bool, ev: (a, b) => a === b, code: (a, b) => `(${a} === ${b})` },
  { name: 'not',   in: ['bool'], out: bool, ev: a => !a,            code: a => `(!${a})` },
  { name: 'and',   in: ['bool', 'bool'], out: bool, ev: (a, b) => a && b, code: (a, b) => `(${a} && ${b})` },
  { name: 'or',    in: ['bool', 'bool'], out: bool, ev: (a, b) => a || b, code: (a, b) => `(${a} || ${b})` },

  // ── string → … ──
  { name: 'len',     in: ['str'], out: num, ev: a => a.length,                    code: a => `(${a}).length` },
  { name: 'upper',   in: ['str'], out: str, ev: a => a.toUpperCase(),             code: a => `(${a}).toUpperCase()` },
  { name: 'lower',   in: ['str'], out: str, ev: a => a.toLowerCase(),             code: a => `(${a}).toLowerCase()` },
  { name: 'trim',    in: ['str'], out: str, ev: a => a.trim(),                    code: a => `(${a}).trim()` },
  { name: 'revStr',  in: ['str'], out: str, ev: a => a.split('').reverse().join(''), code: a => `(${a}).split('').reverse().join('')` },
  { name: 'chars',   in: ['str'], out: () => 'str[]', ev: a => a.split(''),       code: a => `(${a}).split('')` },
  { name: 'concat',  in: ['str', 'str'], out: str, ev: (a, b) => a + b,           code: (a, b) => `(${a} + ${b})` },
  { name: 'repeat',  in: ['str', 'num'], out: str, ev: (a, b) => a.repeat(gLen(b)), code: (a, b) => `(${a}).repeat(${b})` },
  { name: 'charAt',  in: ['str', 'num'], out: str, ev: (a, b) => a.charAt(b),     code: (a, b) => `(${a}).charAt(${b})` },
  { name: 'sliceStr', in: ['str', 'num'], out: str, ev: (a, b) => a.slice(b),     code: (a, b) => `(${a}).slice(${b})` },
  { name: 'splitBy', in: ['str', 'str'], out: () => 'str[]', ev: (a, b) => a.split(b), code: (a, b) => `(${a}).split(${b})` },
  { name: 'includes', in: ['str', 'str'], out: bool, ev: (a, b) => a.includes(b), code: (a, b) => `(${a}).includes(${b})` },
  { name: 'startsWith', in: ['str', 'str'], out: bool, ev: (a, b) => a.startsWith(b), code: (a, b) => `(${a}).startsWith(${b})` },
  { name: 'endsWith', in: ['str', 'str'], out: bool, ev: (a, b) => a.endsWith(b), code: (a, b) => `(${a}).endsWith(${b})` },
  { name: 'indexOf', in: ['str', 'str'], out: num, ev: (a, b) => a.indexOf(b),    code: (a, b) => `(${a}).indexOf(${b})` },

  // ── array (polymorphic over element type) ──
  { name: 'arrLen', in: ['arr'], out: num, ev: a => a.length,            code: a => `(${a}).length` },
  { name: 'head',   in: ['arr'], out: ins => elemOf(ins[0]), ev: a => { if (!a.length) throw new Error('empty'); return a[0] },             code: a => `(${a})[0]` },
  { name: 'last',   in: ['arr'], out: ins => elemOf(ins[0]), ev: a => { if (!a.length) throw new Error('empty'); return a[a.length - 1] }, code: a => `(${a})[(${a}).length - 1]` },
  { name: 'reverse', in: ['arr'], out: ins => ins[0], ev: a => [...a].reverse(),  code: a => `[...(${a})].reverse()` },
  { name: 'tail',   in: ['arr'], out: ins => ins[0], ev: a => a.slice(1),         code: a => `(${a}).slice(1)` },
  { name: 'init',   in: ['arr'], out: ins => ins[0], ev: a => a.slice(0, -1),     code: a => `(${a}).slice(0, -1)` },
  { name: 'uniq',   in: ['arr'], out: ins => ins[0], ev: a => [...new Set(a)],    code: a => `[...new Set(${a})]` },
  { name: 'take',   in: ['arr', 'num'], out: ins => ins[0], ev: (a, b) => a.slice(0, gLen(Math.max(0, b))), code: (a, b) => `(${a}).slice(0, ${b})` },
  { name: 'drop',   in: ['arr', 'num'], out: ins => ins[0], ev: (a, b) => a.slice(gLen(Math.max(0, b))),    code: (a, b) => `(${a}).slice(${b})` },
  { name: 'concatArr', in: ['arr', 'arr'], out: ins => (ins[0] === ins[1] ? ins[0] : null), ev: (a, b) => a.concat(b), code: (a, b) => `(${a}).concat(${b})` },

  // ── num[] specific ──
  { name: 'sum',   in: ['num[]'], out: num, ev: a => a.reduce((s: number, x: number) => s + x, 0), code: a => `(${a}).reduce((s: number, x: number) => s + x, 0)` },
  { name: 'prod',  in: ['num[]'], out: num, ev: a => a.reduce((s: number, x: number) => s * x, 1), code: a => `(${a}).reduce((s: number, x: number) => s * x, 1)` },
  { name: 'maxArr', in: ['num[]'], out: num, ev: a => { if (!a.length) throw new Error('empty'); return Math.max(...a) }, code: a => `Math.max(...(${a}))` },
  { name: 'minArr', in: ['num[]'], out: num, ev: a => { if (!a.length) throw new Error('empty'); return Math.min(...a) }, code: a => `Math.min(...(${a}))` },
  { name: 'sortAsc',  in: ['num[]'], out: () => 'num[]', ev: a => [...a].sort((x: number, y: number) => x - y), code: a => `[...(${a})].sort((x: number, y: number) => x - y)` },
  { name: 'sortDesc', in: ['num[]'], out: () => 'num[]', ev: a => [...a].sort((x: number, y: number) => y - x), code: a => `[...(${a})].sort((x: number, y: number) => y - x)` },
  { name: 'mapInc', in: ['num[]'], out: () => 'num[]', ev: a => a.map((x: number) => x + 1),       code: a => `(${a}).map((x: number) => x + 1)` },
  { name: 'mapDbl', in: ['num[]'], out: () => 'num[]', ev: a => a.map((x: number) => x * 2),       code: a => `(${a}).map((x: number) => x * 2)` },
  { name: 'mapSq',  in: ['num[]'], out: () => 'num[]', ev: a => a.map((x: number) => x * x),       code: a => `(${a}).map((x: number) => x * x)` },
  { name: 'mapNeg', in: ['num[]'], out: () => 'num[]', ev: a => a.map((x: number) => -x),          code: a => `(${a}).map((x: number) => -x)` },
  { name: 'mapAbs', in: ['num[]'], out: () => 'num[]', ev: a => a.map((x: number) => Math.abs(x)), code: a => `(${a}).map((x: number) => Math.abs(x))` },
  { name: 'filterPos',  in: ['num[]'], out: () => 'num[]', ev: a => a.filter((x: number) => x > 0),        code: a => `(${a}).filter((x: number) => x > 0)` },
  { name: 'filterNeg',  in: ['num[]'], out: () => 'num[]', ev: a => a.filter((x: number) => x < 0),        code: a => `(${a}).filter((x: number) => x < 0)` },
  { name: 'filterEven', in: ['num[]'], out: () => 'num[]', ev: a => a.filter((x: number) => x % 2 === 0),  code: a => `(${a}).filter((x: number) => x % 2 === 0)` },
  { name: 'filterOdd',  in: ['num[]'], out: () => 'num[]', ev: a => a.filter((x: number) => x % 2 !== 0),  code: a => `(${a}).filter((x: number) => x % 2 !== 0)` },
  { name: 'range0', in: ['num'], out: () => 'num[]', ev: a => Array.from({ length: gLen(a) }, (_: unknown, i: number) => i),     code: a => `Array.from({ length: ${a} }, (_, i) => i)` },
  { name: 'range1', in: ['num'], out: () => 'num[]', ev: a => Array.from({ length: gLen(a) }, (_: unknown, i: number) => i + 1), code: a => `Array.from({ length: ${a} }, (_, i) => i + 1)` },

  // ── str[] specific ──
  { name: 'joinEmpty', in: ['str[]'], out: str, ev: a => a.join(''),  code: a => `(${a}).join('')` },
  { name: 'joinSpace', in: ['str[]'], out: str, ev: a => a.join(' '), code: a => `(${a}).join(' ')` },
  { name: 'joinComma', in: ['str[]'], out: str, ev: a => a.join(','), code: a => `(${a}).join(',')` },
  { name: 'sortStr',   in: ['str[]'], out: () => 'str[]', ev: a => [...a].sort(),                  code: a => `[...(${a})].sort()` },
  { name: 'mapUpper',  in: ['str[]'], out: () => 'str[]', ev: a => a.map((x: string) => x.toUpperCase()), code: a => `(${a}).map((x: string) => x.toUpperCase())` },
  { name: 'mapLower',  in: ['str[]'], out: () => 'str[]', ev: a => a.map((x: string) => x.toLowerCase()), code: a => `(${a}).map((x: string) => x.toLowerCase())` },
  { name: 'mapLen',    in: ['str[]'], out: () => 'num[]', ev: a => a.map((x: string) => x.length),        code: a => `(${a}).map((x: string) => x.length)` },
]

// ── Constant pool. Common literals + any numeric/string literals that appear in the spec text
//    or the example I/O. Conditioned on which types the task actually involves, to limit blowup. ──
export interface ConstSpec { code: string; value: unknown; tag: Tag }

export function extractConstants(spec: string, presentTags: Set<Tag>): ConstSpec[] {
  const out: ConstSpec[] = []
  const pushNum = (n: number) => { if (Number.isFinite(n) && !out.some(c => c.tag === 'num' && c.value === n)) out.push({ code: numCode(n), value: n, tag: 'num' }) }
  const pushStr = (s: string) => { if (!out.some(c => c.tag === 'str' && c.value === s)) out.push({ code: JSON.stringify(s), value: s, tag: 'str' }) }

  const wantsNum = presentTags.has('num') || presentTags.has('num[]')
  const wantsStr = presentTags.has('str') || presentTags.has('str[]')

  if (wantsNum) {
    for (const n of [0, 1, 2, -1, 10]) pushNum(n)
    for (const m of spec.matchAll(/-?\b\d+(?:\.\d+)?\b/g)) { pushNum(Number(m[0])); if (out.filter(c => c.tag === 'num').length > 14) break }
  }
  if (wantsStr) {
    for (const s of ['', ' ', ',', '-', '.', '/']) pushStr(s)
    for (const m of spec.matchAll(/'([^'\\]{0,16})'|"([^"\\]{0,16})"/g)) { pushStr(m[1] ?? m[2] ?? ''); if (out.filter(c => c.tag === 'str').length > 12) break }
  }
  return out
}

function numCode(n: number): string { return n < 0 ? `(${n})` : String(n) }
