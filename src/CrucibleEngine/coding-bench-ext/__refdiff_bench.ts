// DONE-WHEN (W31 applied to the corpus): every reference solution agrees with an
// INDEPENDENT oracle — one that encodes the contract's meaning through a different
// formalism than the reference (point-set models, shadow structures, node builtins,
// by-construction inputs, closed forms, algebraic invariants).
//
// Why this exists (user-flagged): the refs and the hidden suites were written by the same
// session. If that session misunderstood a task, ref and suite agree with each other and
// both are wrong — the corpus validator only proves self-CONSISTENCY. A differential
// oracle decorrelates most such errors because it derives expectations from the contract
// via a different mechanism. The residual risk — the contract's plain language itself was
// misread — is covered by the one-time human skim (CONTRACTS_REVIEW.md), not by this file.
//
// Honest weakness ranking, weakest first: tableMachine (shadow is a trivial
// reimplementation of the same table lookup — low decorrelation), templateExpand (alt
// mechanism, same author). Strongest: bankersRound (Intl halfEven — an entirely foreign
// implementation), queryDecode (URLSearchParams), posixResolve (node path.posix),
// deepEqual (node assert), baseConvert (BigInt/Number.toString), point-set interval
// models, by-construction jsonPointer.
//
// Deterministic (seeded PRNG, no Math.random, no clock), model-free, in-process.
// Run: npx tsx src/CrucibleEngine/coding-bench-ext/__refdiff_bench.ts
import fs from 'fs'
import os from 'os'
import path from 'path'
import assert from 'assert'
import { pathToFileURL } from 'url'
import { EXT_TASKS } from './index'

let failures = 0
const check = (label: string, cond: boolean, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}${cond ? '' : ' :: ' + detail.slice(0, 240)}`)
  if (!cond) failures++
}

// Seeded PRNG — this bench must be replayable byte-for-byte.
let seed = 0xBEEF01
const rand = (): number => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const rint = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1))
const pick = <T,>(xs: T[]): T => xs[rint(0, xs.length - 1)]

// Materialize every ref once and import it — the refs under test are the exact strings
// the corpus ships, not copies.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-refdiff-'))
const mods: Record<string, any> = {}
for (const t of EXT_TASKS) {
  const abs = path.join(dir, t.modulePath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, t.ref)
}
for (const t of EXT_TASKS) {
  const abs = path.join(dir, t.modulePath)
  mods[t.id] = await import(pathToFileURL(abs).href)
}

const J = (v: unknown): string => JSON.stringify(v)

// ── intervalMerge / intervalSubtract vs a point-set model ───────────────────
// The contract SAYS "covers exactly the integer points" — so model intervals as literal
// integer sets and re-derive the minimal run list. A different formalism entirely.
{
  const runsFromSet = (s: Set<number>): Array<[number, number]> => {
    const pts = [...s].sort((a, b) => a - b)
    const out: Array<[number, number]> = []
    for (const p of pts) {
      const last = out[out.length - 1]
      if (last && p === last[1] + 1) last[1] = p
      else out.push([p, p])
    }
    return out
  }
  const genIvs = (n: number): Array<[number, number]> => {
    const out: Array<[number, number]> = []
    for (let i = 0; i < n; i++) {
      const s = rint(-40, 35)
      out.push([s, s + rint(0, 12)])
    }
    return out
  }
  let mergeDiv = ''
  let subDiv = ''
  for (let round = 0; round < 400 && !mergeDiv; round++) {
    const ivs = genIvs(rint(0, 6))
    const set = new Set<number>()
    for (const [s, e] of ivs) for (let p = s; p <= e; p++) set.add(p)
    const expected = runsFromSet(set)
    const got = mods.intervalMerge.mergeIntervals(ivs)
    if (J(got) !== J(expected)) mergeDiv = `in=${J(ivs)} got=${J(got)} want=${J(expected)}`
  }
  check('intervalMerge agrees with the point-set model (400 rounds)', mergeDiv === '', mergeDiv)
  for (let round = 0; round < 400 && !subDiv; round++) {
    const base = genIvs(rint(0, 5))
    const rem = genIvs(rint(0, 5))
    const bset = new Set<number>()
    for (const [s, e] of base) for (let p = s; p <= e; p++) bset.add(p)
    for (const [s, e] of rem) for (let p = s; p <= e; p++) bset.delete(p)
    const expected = runsFromSet(bset)
    const got = mods.intervalSubtract.subtractIntervals(base, rem)
    if (J(got) !== J(expected)) subDiv = `base=${J(base)} rem=${J(rem)} got=${J(got)} want=${J(expected)}`
  }
  check('intervalSubtract agrees with the point-set model (400 rounds)', subDiv === '', subDiv)
}

// ── ringBuffer / minStack / bitset vs shadow structures ─────────────────────
{
  let div = ''
  for (let round = 0; round < 60 && !div; round++) {
    const cap = rint(1, 6)
    const rb = new mods.ringBuffer.RingBuffer(cap)
    let shadow: number[] = []
    for (let op = 0; op < 80 && !div; op++) {
      const r = rand()
      if (r < 0.55) {
        const v = rint(0, 999)
        rb.push(v)
        shadow.push(v)
        if (shadow.length > cap) shadow.shift()
      } else if (shadow.length > 0) {
        const got = rb.pop()
        const want = shadow.shift()
        if (got !== want) div = `pop got=${got} want=${want}`
      }
      if (!div && J(rb.toArray()) !== J(shadow)) div = `state got=${J(rb.toArray())} want=${J(shadow)}`
      if (!div && rb.size !== shadow.length) div = `size got=${rb.size} want=${shadow.length}`
    }
  }
  check('ringBuffer agrees with a shadow array (60x80 ops)', div === '', div)
}
{
  let div = ''
  for (let round = 0; round < 60 && !div; round++) {
    const st = new mods.minStack.MinStack()
    const shadow: number[] = []
    for (let op = 0; op < 120 && !div; op++) {
      if (rand() < 0.6 || shadow.length === 0) {
        const v = rint(-500, 500)
        st.push(v); shadow.push(v)
      } else {
        const got = st.pop()
        const want = shadow.pop()
        if (got !== want) div = `pop got=${got} want=${want}`
      }
      if (!div && shadow.length > 0) {
        if (st.min() !== Math.min(...shadow)) div = `min got=${st.min()} want=${Math.min(...shadow)}`
        if (st.top() !== shadow[shadow.length - 1]) div = 'top mismatch'
      }
    }
  }
  check('minStack agrees with a shadow array + Math.min (60x120 ops)', div === '', div)
}
{
  let div = ''
  const size = 97 // odd, straddles word boundaries
  for (let round = 0; round < 40 && !div; round++) {
    const bs = new mods.bitsetRange.BitSet(size)
    const shadow: boolean[] = new Array(size).fill(false)
    for (let op = 0; op < 150 && !div; op++) {
      const i = rint(0, size - 1)
      if (rand() < 0.6) { bs.set(i); shadow[i] = true } else { bs.clear(i); shadow[i] = false }
      const a = rint(0, size)
      const b = rint(0, size)
      const lo = Math.min(a, b)
      const hi = Math.max(a, b)
      const want = shadow.slice(lo, hi).filter(Boolean).length
      const got = bs.countRange(lo, hi)
      if (got !== want) div = `countRange(${lo},${hi}) got=${got} want=${want}`
      const j = rint(0, size - 1)
      if (bs.get(j) !== shadow[j]) div = `get(${j}) mismatch`
    }
  }
  check('bitset agrees with a shadow boolean array (40x150 ops)', div === '', div)
}

// ── slidingWindowMax vs brute-force windows ─────────────────────────────────
{
  let div = ''
  for (let round = 0; round < 300 && !div; round++) {
    const n = rint(1, 40)
    const xs = Array.from({ length: n }, () => rint(-100, 100))
    const k = rint(1, n)
    const want: number[] = []
    for (let i = 0; i + k <= n; i++) want.push(Math.max(...xs.slice(i, i + k)))
    const got = mods.slidingWindowMax.slidingWindowMax(xs, k)
    if (J(got) !== J(want)) div = `xs=${J(xs)} k=${k} got=${J(got)} want=${J(want)}`
  }
  check('slidingWindowMax agrees with brute-force rescan (300 rounds)', div === '', div)
}

// ── matrixRotate vs the contract's own index formula ────────────────────────
{
  let div = ''
  for (let round = 0; round < 200 && !div; round++) {
    const R = rint(1, 6)
    const C = rint(1, 6)
    const m = Array.from({ length: R }, () => Array.from({ length: C }, () => rint(0, 99)))
    const got = mods.matrixRotate.rotate90(m)
    if (got.length !== C || (C > 0 && got[0].length !== R)) { div = `dims ${got.length}x${got[0]?.length} want ${C}x${R}`; break }
    outer: for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        if (got[c][R - 1 - r] !== m[r][c]) { div = `formula fails at r=${r} c=${c}`; break outer }
      }
    }
  }
  check('matrixRotate satisfies output[c][R-1-r] === input[r][c] (200 rounds)', div === '', div)
}

// ── deepEqual vs node assert.deepStrictEqual ────────────────────────────────
// Known, documented divergence: the contract picks SameValueZero (+0 equals -0), assert
// picks Object.is. Generators therefore never emit -0; everything else must agree.
{
  const genVal = (depth: number): unknown => {
    const r = rand()
    if (depth === 0 || r < 0.35) {
      return pick([1, 2, 'x', 'y', true, false, null, NaN, 3.5, 'long-string', 0, undefined] as unknown[])
    }
    if (r < 0.5) return new Date(rint(0, 1e6))
    if (r < 0.75) return Array.from({ length: rint(0, 3) }, () => genVal(depth - 1))
    const o: Record<string, unknown> = {}
    for (let i = 0, n = rint(0, 3); i < n; i++) o['k' + rint(0, 5)] = genVal(depth - 1)
    return o
  }
  const clone = (v: unknown): unknown => {
    if (v instanceof Date) return new Date(v.getTime())
    if (Array.isArray(v)) return v.map(clone)
    if (v !== null && typeof v === 'object') {
      const o: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v)) o[k] = clone(x)
      return o
    }
    return v
  }
  const assertEq = (a: unknown, b: unknown): boolean => {
    try { assert.deepStrictEqual(a, b); return true } catch { return false }
  }
  let div = ''
  for (let round = 0; round < 500 && !div; round++) {
    const a = genVal(3)
    const b = rand() < 0.5 ? clone(a) : genVal(3)
    const mine = mods.deepEqualCyc.deepEqual(a, b)
    const theirs = assertEq(a, b)
    if (mine !== theirs) div = `a=${J(a)} b=${J(b)} mine=${mine} assert=${theirs}`
  }
  check('deepEqual agrees with assert.deepStrictEqual (500 rounds, -0 excluded)', div === '', div)
}

// ── templateExpand vs a regex-replace mechanism ─────────────────────────────
{
  const alt = (template: string, ctx: Record<string, unknown>): string =>
    template.replace(/\\([\s\S])|\{([^}]*)\}/g, (_m, esc: string | undefined, inner: string | undefined) => {
      if (esc !== undefined) return esc
      const parts = String(inner).trim().split('.')
      let cur: unknown = ctx
      for (const p of parts) {
        if (inner!.trim() === '' || cur === null || typeof cur !== 'object' || !(p in (cur as object))) {
          return '{' + inner + '}'
        }
        cur = (cur as Record<string, unknown>)[p]
      }
      return cur === undefined ? '{' + inner + '}' : String(cur)
    })
  const ctx = { a: { b: 1 }, c: 'x', d: undefined, e: null, arr: ['p', 'q'] }
  const atoms = ['a', ' ', '{a.b}', '{c}', '{d}', '{e}', '{arr.1}', '{ghost}', '\\{', '\\\\', '{', '}', '{a.b} ', 'txt']
  let div = ''
  for (let round = 0; round < 500 && !div; round++) {
    const t = Array.from({ length: rint(0, 8) }, () => pick(atoms)).join('')
    // The regex mechanism cannot express "unterminated { swallows the rest" — align
    // domains by skipping templates with an unmatched brace (covered by the fixed suite).
    const stripped = t.replace(/\\[\s\S]/g, '').replace(/\{[^}]*\}/g, '')
    if (stripped.includes('{') || stripped.includes('}')) continue
    const got = mods.templateExpand.expand(t, ctx)
    const want = alt(t, ctx)
    if (got !== want) div = `t=${J(t)} got=${J(got)} want=${J(want)}`
  }
  check('templateExpand agrees with a regex-replace mechanism (500 rounds)', div === '', div)
}

// ── csvLine vs an always-quoting serializer (parse . serialize = id) ────────
{
  const chars = ['a', 'b', ',', '"', ' ', '', 'x,y', '""']
  let div = ''
  for (let round = 0; round < 500 && !div; round++) {
    const fields = Array.from({ length: rint(1, 6) }, () => Array.from({ length: rint(0, 4) }, () => pick(chars)).join(''))
    const line = fields.map(f => '"' + f.replace(/"/g, '""') + '"').join(',')
    const got = mods.csvLine.parseCsvLine(line)
    if (J(got) !== J(fields)) div = `fields=${J(fields)} line=${J(line)} got=${J(got)}`
  }
  check('csvLine inverts an always-quoting serializer (500 rounds)', div === '', div)
}

// ── wordWrap vs contract properties ─────────────────────────────────────────
{
  let div = ''
  for (let round = 0; round < 400 && !div; round++) {
    const width = rint(3, 12)
    const words = Array.from({ length: rint(0, 12) }, () => 'w'.repeat(rint(1, 10)))
    const input = words.join(' ')
    const out = mods.wordWrap.wrap(input, width)
    const lines: string[] = out === '' ? [''] : out.split('\n')
    if (!lines.every((l: string) => l.length <= width)) { div = `line over width: ${J(out)}`; continue }
    if (out.replace(/[\n ]/g, '') !== words.join('')) { div = `chars lost: in=${J(input)} out=${J(out)}`; continue }
    if (words.every(w => w.length <= width)) {
      for (let i = 0; i + 1 < lines.length; i++) {
        const next = lines[i + 1].split(' ')[0]
        if (lines[i].length + 1 + next.length <= width) { div = `not greedy at line ${i}: ${J(out)} width=${width}`; break }
      }
    }
  }
  check('wordWrap satisfies width/conservation/greedy properties (400 rounds)', div === '', div)
}

// ── dedent vs contract invariants ───────────────────────────────────────────
{
  const indentOf = (l: string): number => (l.match(/^[ \t]*/) as RegExpMatchArray)[0].length
  let div = ''
  for (let round = 0; round < 400 && !div; round++) {
    const n = rint(1, 8)
    const lines = Array.from({ length: n }, () => {
      if (rand() < 0.25) return rand() < 0.5 ? '' : '   '
      return (rand() < 0.5 ? ' '.repeat(rint(0, 6)) : '\t'.repeat(rint(0, 3))) + 'line' + rint(0, 9)
    })
    const input = lines.join('\n')
    const out = mods.dedentText.dedent(input).split('\n')
    if (out.length !== lines.length) { div = 'line count changed'; continue }
    const inNonBlank = lines.map((l, i) => [l, i] as const).filter(([l]) => l.trim() !== '')
    if (inNonBlank.length === 0) continue
    if (!inNonBlank.every(([l, i]) => l.endsWith(out[i]))) { div = `output not a suffix: ${J(lines)} -> ${J(out)}`; continue }
    const mins = inNonBlank.map(([, i]) => indentOf(out[i]))
    if (Math.min(...mins) !== 0) { div = `min indent after dedent is ${Math.min(...mins)}, want 0: ${J(out)}`; continue }
    const deltas = inNonBlank.map(([l, i]) => indentOf(l) - indentOf(out[i]))
    if (new Set(deltas).size !== 1) { div = `unequal strip amounts ${J(deltas)}` }
  }
  check('dedent satisfies suffix/zero-min/uniform-strip invariants (400 rounds)', div === '', div)
}

// ── posixResolve vs node path.posix.normalize ───────────────────────────────
{
  const stripTrail = (p: string): string => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p)
  let div = ''
  for (let round = 0; round < 600 && !div; round++) {
    const segs = Array.from({ length: rint(0, 7) }, () => pick(['a', 'b', 'c', '.', '..', 'dir9']))
    let input = (rand() < 0.5 ? '/' : '') + segs.join('/') + (rand() < 0.3 ? '/' : '')
    if (input.startsWith('//')) input = input.slice(1) // double-slash roots are impl-defined in POSIX; out of contract
    const got = mods.posixResolve.normalizePath(input)
    const want = stripTrail(path.posix.normalize(input === '' ? '.' : input))
    if (got !== want) div = `input=${J(input)} got=${J(got)} node=${J(want)}`
  }
  check('posixResolve agrees with path.posix.normalize (600 rounds)', div === '', div)
}

// ── runLength vs a regex-run encoder + round-trip ───────────────────────────
{
  let div = ''
  for (let round = 0; round < 500 && !div; round++) {
    const s = Array.from({ length: rint(0, 30) }, () => pick(['a', 'a', 'b', 'B', 'c'])).join('')
    const independent = s === '' ? '' : (s.match(/(.)\1*/g) as string[]).map(r => r[0] + r.length).join('')
    const enc = mods.runLength.rleEncode(s)
    if (enc !== independent) { div = `s=${J(s)} enc=${J(enc)} regex=${J(independent)}`; continue }
    if (mods.runLength.rleDecode(enc) !== s) div = `round trip broke for ${J(s)}`
  }
  check('runLength agrees with regex-run encoder + round-trips (500 rounds)', div === '', div)
}

// ── queryDecode vs URLSearchParams ──────────────────────────────────────────
{
  let div = ''
  for (let round = 0; round < 400 && !div; round++) {
    const pairs = Array.from({ length: rint(1, 5) }, () => [
      pick(['a', 'b', 'key c', 'k']),
      pick(['1', 'two words', 'v%', 'café', '']),
    ])
    const qs = pairs.map(([k, v]) => {
      const enc = (s: string) => (rand() < 0.5 ? encodeURIComponent(s) : encodeURIComponent(s).replace(/%20/g, '+'))
      return enc(k) + '=' + enc(v)
    }).join('&')
    const usp = new URLSearchParams(qs)
    const mine = mods.queryDecode.parseQuery(qs)
    for (const key of new Set(pairs.map(p => p[0]))) {
      const want = usp.getAll(key)
      const raw = mine[key]
      const got = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
      if (J(got) !== J(want)) { div = `qs=${J(qs)} key=${J(key)} got=${J(got)} usp=${J(want)}`; break }
    }
  }
  check('queryDecode agrees with URLSearchParams (400 rounds)', div === '', div)
}

// ── jsonPointer via by-construction pointers ────────────────────────────────
{
  const esc = (t: string): string => t.replace(/~/g, '~0').replace(/\//g, '~1')
  const genDoc = (depth: number): unknown => {
    if (depth === 0) return pick([1, 'leaf', true, null] as unknown[])
    if (rand() < 0.4) return Array.from({ length: rint(1, 3) }, () => genDoc(depth - 1))
    const o: Record<string, unknown> = {}
    const keys = ['plain', 'a/b', 'm~n', '', 'k' + rint(0, 9)]
    for (let i = 0, n = rint(1, 3); i < n; i++) o[pick(keys)] = genDoc(depth - 1)
    return o
  }
  let div = ''
  for (let round = 0; round < 500 && !div; round++) {
    const doc = genDoc(3)
    let node: unknown = doc
    const tokens: string[] = []
    while (rand() < 0.7) {
      if (Array.isArray(node) && node.length > 0) {
        const i = rint(0, node.length - 1)
        tokens.push(String(i)); node = node[i]
      } else if (node !== null && typeof node === 'object') {
        const ks = Object.keys(node as object)
        if (ks.length === 0) break
        const k = pick(ks)
        tokens.push(k); node = (node as Record<string, unknown>)[k]
      } else break
    }
    const pointer = tokens.length === 0 ? '' : '/' + tokens.map(esc).join('/')
    const got = mods.jsonPointerGet.getPointer(doc, pointer)
    if (got !== node) { div = `pointer=${J(pointer)} did not return the walked node`; continue }
    const bogus = pointer + '/zz~1x'
    if (mods.jsonPointerGet.getPointer(doc, bogus) !== undefined) div = `bogus pointer ${J(bogus)} not undefined`
  }
  check('jsonPointer resolves by-construction pointers to the exact node (500 rounds)', div === '', div)
}

// ── fractionAdd vs BigInt cross-multiplication invariants ───────────────────
{
  const bgcd = (a: bigint, b: bigint): bigint => {
    let x = a < 0n ? -a : a
    let y = b < 0n ? -b : b
    while (y !== 0n) { const t = x % y; x = y; y = t }
    return x
  }
  let div = ''
  for (let round = 0; round < 600 && !div; round++) {
    const a: [number, number] = [rint(-50, 50), rint(1, 50) * (rand() < 0.5 ? -1 : 1)]
    const b: [number, number] = [rint(-50, 50), rint(1, 50) * (rand() < 0.5 ? -1 : 1)]
    const [n, d] = mods.fractionAdd.addFractions(a, b)
    if (d <= 0) { div = `non-positive denominator ${d}`; continue }
    const lhs = BigInt(n) * BigInt(a[1]) * BigInt(b[1])
    const rhs = (BigInt(a[0]) * BigInt(b[1]) + BigInt(b[0]) * BigInt(a[1])) * BigInt(d)
    if (lhs !== rhs) { div = `value wrong: ${J(a)}+${J(b)} -> ${J([n, d])}`; continue }
    if (n === 0 ? d !== 1 : bgcd(BigInt(n), BigInt(d)) !== 1n) div = `not lowest terms: ${J([n, d])}`
  }
  check('fractionAdd satisfies BigInt cross-multiply + lowest-terms (600 rounds)', div === '', div)
}

// ── dateRangeDays vs day-stepping iteration ─────────────────────────────────
{
  const DAY = 86400000
  const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
  const base = Date.UTC(2023, 0, 1)
  let div = ''
  for (let round = 0; round < 400 && !div; round++) {
    const a0 = base + rint(0, 700) * DAY
    const a1 = a0 + rint(0, 40) * DAY
    const b0 = base + rint(0, 700) * DAY
    const b1 = b0 + rint(0, 40) * DAY
    let want = 0
    for (let t = a0; t <= a1; t += DAY) if (t >= b0 && t <= b1) want++
    const got = mods.dateRangeDays.overlapDays([iso(a0), iso(a1)], [iso(b0), iso(b1)])
    if (got !== want) div = `[${iso(a0)},${iso(a1)}] x [${iso(b0)},${iso(b1)}] got=${got} want=${want}`
  }
  check('dateRangeDays agrees with day-stepping iteration (400 rounds)', div === '', div)
}

// ── retryDelays vs the closed form ──────────────────────────────────────────
{
  let div = ''
  for (let round = 0; round < 500 && !div; round++) {
    const attempts = rint(0, 8)
    const baseMs = rint(1, 500)
    const capMs = baseMs + rint(0, 5000)
    const factor = pick([1, 1.25, 1.5, 2, 3])
    const got = mods.retryDelays.retryDelays(attempts, baseMs, capMs, factor)
    if (got.length !== attempts) { div = `length ${got.length} want ${attempts}`; continue }
    for (let i = 0; i < attempts; i++) {
      const want = Math.min(baseMs * Math.pow(factor, i), capMs)
      if (Math.abs(got[i] - want) > 1e-9 * Math.max(1, want)) { div = `i=${i} got=${got[i]} closed-form=${want}`; break }
    }
  }
  check('retryDelays agrees with the closed form min(base*f^i, cap) (500 rounds)', div === '', div)
}

// ── baseConvert vs BigInt literals and Number.toString ──────────────────────
{
  const HEX = '0123456789abcdef'
  let div = ''
  for (let round = 0; round < 300 && !div; round++) {
    const hex = Array.from({ length: rint(1, 24) }, () => HEX[rint(0, 15)]).join('')
    const want = BigInt('0x' + hex).toString(10)
    const got = mods.baseConvert.convertBase(hex, 16, 10)
    if (got !== want) div = `hex=${hex} got=${got} bigint=${want}`
  }
  check('baseConvert(16->10) agrees with BigInt hex literals (300 rounds)', div === '', div)
  let div2 = ''
  for (let round = 0; round < 300 && !div2; round++) {
    const n = rint(0, 2 ** 48)
    const b = rint(2, 36)
    const want = n.toString(b)
    const got = mods.baseConvert.convertBase(String(n), 10, b)
    if (got !== want) div2 = `n=${n} base=${b} got=${got} toString=${want}`
  }
  check('baseConvert(10->b) agrees with Number.toString(b) (300 rounds)', div2 === '', div2)
}

// ── bankersRound vs Intl.NumberFormat halfEven ──────────────────────────────
// A fully foreign implementation of the same contract — the strongest oracle here. Skips
// honestly (with a visible SKIP) if this node build ignores roundingMode.
{
  const nf = (d: number) => new Intl.NumberFormat('en-US', {
    maximumFractionDigits: d, minimumFractionDigits: 0,
    roundingMode: 'halfEven', useGrouping: false,
  } as Intl.NumberFormatOptions)
  const supported = nf(0).format(2.5) === '2' && nf(0).format(3.5) === '4'
  if (!supported) {
    console.log('SKIP — Intl.NumberFormat roundingMode halfEven not honored on this node build')
  } else {
    const norm = (v: number): number => (v === 0 ? 0 : v)
    let div = ''
    for (let round = 0; round < 800 && !div; round++) {
      const d = rint(0, 4)
      const v = rint(-999999, 999999) / Math.pow(10, rint(0, 4))
      const got = norm(mods.bankersRound.bankersRound(v, d))
      const want = norm(Number(nf(d).format(v)))
      if (got !== want) div = `v=${v} d=${d} got=${got} intl=${want}`
    }
    check('bankersRound agrees with Intl halfEven (800 rounds)', div === '', div)
  }
}

// ── tableMachine coherence (weakest oracle — flagged in header) ─────────────
{
  let div = ''
  for (let round = 0; round < 200 && !div; round++) {
    const states = ['s0', 's1', 's2', 's3'].slice(0, rint(2, 4))
    const events = ['a', 'b', 'c']
    const transitions: Record<string, Record<string, string>> = {}
    for (const s of states) {
      transitions[s] = {}
      for (const e of events) if (rand() < 0.6) transitions[s][e] = pick(states)
    }
    const m = new mods.tableMachine.Machine({ initial: states[0], transitions })
    let shadowState = states[0]
    const shadowHist = [states[0]]
    for (let step = 0; step < 25 && !div; step++) {
      const e = pick(events)
      const defined = transitions[shadowState][e] !== undefined
      if (m.can(e) !== defined) { div = `can(${e}) at ${shadowState} said ${m.can(e)}`; break }
      if (defined) {
        m.send(e)
        shadowState = transitions[shadowState][e]
        shadowHist.push(shadowState)
      } else {
        let threw = false
        try { m.send(e) } catch { threw = true }
        if (!threw) { div = `undefined transition did not throw (${shadowState}, ${e})`; break }
      }
      if (m.state !== shadowState) { div = `state ${m.state} want ${shadowState}`; break }
    }
    if (!div && J(m.history) !== J(shadowHist)) div = 'history diverged'
  }
  check('tableMachine coheres with table lookup + can/send agreement (200 rounds)', div === '', div)
}

fs.rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
