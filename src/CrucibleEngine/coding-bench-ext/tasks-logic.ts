// Extended coding-bench corpus — logic/state shard (W42). See tasks-strings.ts for the
// corpus rules.

import type { ExtTask } from './tasks-strings'

const CONTRACT =
  'Build the COMPLETE, production-quality implementation — no placeholders, no TODOs, no stub bodies. ' +
  'You MUST create the exact file path and export the exact API named below (an automated audit imports it verbatim). ' +
  'Verify it actually runs before reporting done.'

export const LOGIC_TASKS: ExtTask[] = [
  {
    id: 'tableMachine',
    title: 'Table-driven finite state machine with history',
    modulePath: 'src/tableMachine.ts',
    prompt: `Implement a finite state machine in TypeScript at src/tableMachine.ts. ${CONTRACT}

Export exactly:
  export interface MachineDef {
    initial: string
    transitions: Record<string, Record<string, string>>  // state -> event -> next state
  }
  export class Machine {
    constructor(def: MachineDef)
    get state(): string
    can(event: string): boolean
    send(event: string): string      // returns the new state
    get history(): string[]          // states visited, oldest first, including initial
  }

Semantics:
- send(event) moves along the transition table; can(event) reports whether send would
  succeed from the current state without changing anything.
- history includes the initial state and every state entered by a successful send; a fresh
  copy is returned on each access.
- Self-transitions (state -> same state) are legal and are recorded in history.
- Error contract: the constructor throws an Error if def.initial has no entry in
  def.transitions; send throws an Error naming the current state and the event when the
  transition is undefined (the machine state must remain unchanged).`,
    ref: `export interface MachineDef {
  initial: string
  transitions: Record<string, Record<string, string>>
}

export class Machine {
  private cur: string
  private visited: string[]
  private readonly def: MachineDef

  constructor(def: MachineDef) {
    if (!(def.initial in def.transitions)) {
      throw new Error('initial state "' + def.initial + '" has no transition entry')
    }
    this.def = def
    this.cur = def.initial
    this.visited = [def.initial]
  }

  get state(): string { return this.cur }

  can(event: string): boolean {
    const row = this.def.transitions[this.cur]
    return row !== undefined && event in row
  }

  send(event: string): string {
    const row = this.def.transitions[this.cur]
    if (row === undefined || !(event in row)) {
      throw new Error('no transition for event "' + event + '" in state "' + this.cur + '"')
    }
    this.cur = row[event]
    this.visited.push(this.cur)
    return this.cur
  }

  get history(): string[] { return [...this.visited] }
}
`,
    suite: `// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — tableMachine.
// Run: npx tsx __audit__/tableMachine.hidden.ts   (imports ../src/tableMachine)
import { Machine } from '../src/tableMachine'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

const def = {
  initial: 'idle',
  transitions: {
    idle: { start: 'running' },
    running: { pause: 'paused', stop: 'idle', tick: 'running' },
    paused: { resume: 'running', stop: 'idle' },
  },
}

const m = new Machine(def)
check('starts at initial', m.state === 'idle')
check('can on defined event', m.can('start') === true)
check('can on undefined event', m.can('stop') === false)
check('can does not change state', m.state === 'idle')
check('send returns new state', m.send('start') === 'running')
check('state updated', m.state === 'running')
check('self-transition legal', m.send('tick') === 'running')
m.send('pause')
check('chained transitions', m.state === 'paused')
m.send('resume'); m.send('stop')
check('full cycle back to idle', m.state === 'idle')
check('history includes initial and every entry',
  m.history.join('>') === 'idle>running>running>paused>running>idle')
check('history is a fresh copy', (() => { const h = m.history; h.push('x'); return m.history.length === 6 })())
let sendErr = ''
try { m.send('resume') } catch (e) { sendErr = (e as Error).message }
check('undefined transition throws', sendErr.length > 0)
check('error names the event', sendErr.includes('resume'))
check('error names the state', sendErr.includes('idle'))
check('failed send leaves state unchanged', m.state === 'idle')
let ctorThrew = false
try { new Machine({ initial: 'ghost', transitions: { idle: {} } }) } catch { ctorThrew = true }
check('unknown initial state throws at construction', ctorThrew)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`,
  },

  {
    id: 'retryDelays',
    title: 'Deterministic exponential backoff schedule',
    modulePath: 'src/retryDelays.ts',
    prompt: `Implement a backoff-schedule calculator in TypeScript at src/retryDelays.ts. ${CONTRACT}

Export exactly:
  export function retryDelays(attempts: number, baseMs: number, capMs: number, factor: number): number[]

Semantics:
- Returns the delay before each retry: attempt i (0-based) waits baseMs * factor^i,
  capped at capMs. Purely deterministic — no randomness, no jitter.
- Results are exact numbers (no rounding); attempts = 0 returns [].
- Once the cap is reached every later entry equals capMs exactly.
- Error contract (throw RangeError): attempts not a non-negative integer; baseMs <= 0;
  capMs < baseMs; factor < 1.`,
    ref: `export function retryDelays(attempts: number, baseMs: number, capMs: number, factor: number): number[] {
  if (!Number.isInteger(attempts) || attempts < 0) throw new RangeError('attempts must be a non-negative integer')
  if (!(baseMs > 0)) throw new RangeError('baseMs must be > 0')
  if (capMs < baseMs) throw new RangeError('capMs must be >= baseMs')
  if (factor < 1) throw new RangeError('factor must be >= 1')
  const out: number[] = []
  let d = baseMs
  for (let i = 0; i < attempts; i++) {
    out.push(Math.min(d, capMs))
    d = d * factor
  }
  return out
}
`,
    suite: `// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — retryDelays.
// Run: npx tsx __audit__/retryDelays.hidden.ts   (imports ../src/retryDelays)
import { retryDelays } from '../src/retryDelays'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}
const eq = (a: number[], b: number[]): boolean => JSON.stringify(a) === JSON.stringify(b)

check('doubling sequence', eq(retryDelays(4, 100, 10000, 2), [100, 200, 400, 800]))
check('cap applies', eq(retryDelays(5, 100, 500, 2), [100, 200, 400, 500, 500]))
check('cap exact from then on', eq(retryDelays(6, 1, 4, 2), [1, 2, 4, 4, 4, 4]))
check('factor 1 is constant', eq(retryDelays(3, 250, 1000, 1), [250, 250, 250]))
check('zero attempts empty', eq(retryDelays(0, 100, 1000, 2), []))
check('single attempt is base', eq(retryDelays(1, 7, 100, 3), [7]))
check('fractional factor allowed above 1', eq(retryDelays(3, 100, 1000, 1.5), [100, 150, 225]))
check('cap equal to base collapses', eq(retryDelays(3, 100, 100, 2), [100, 100, 100]))
check('deterministic across calls', eq(retryDelays(4, 100, 10000, 2), retryDelays(4, 100, 10000, 2)))
const throws = (fn: () => void): boolean => {
  try { fn(); return false } catch (e) { return e instanceof RangeError }
}
check('negative attempts throws', throws(() => retryDelays(-1, 100, 1000, 2)))
check('fractional attempts throws', throws(() => retryDelays(1.5, 100, 1000, 2)))
check('zero base throws', throws(() => retryDelays(3, 0, 1000, 2)))
check('cap below base throws', throws(() => retryDelays(3, 100, 50, 2)))
check('factor below 1 throws', throws(() => retryDelays(3, 100, 1000, 0.5)))

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`,
  },

  {
    id: 'deepEqualCyc',
    title: 'Structural deep equality with cycle detection',
    modulePath: 'src/deepEqualCyc.ts',
    prompt: `Implement structural equality in TypeScript at src/deepEqualCyc.ts. ${CONTRACT}

Export exactly:
  export function deepEqual(a: unknown, b: unknown): boolean

Semantics:
- Primitives compare with the SameValueZero rule: NaN equals NaN, +0 equals -0. All other
  primitives (and functions) compare by identity or strict equality.
- Plain objects compare by own enumerable string keys (order-independent) and recursively
  equal values; arrays compare by length and element-wise recursion. An array never equals
  a plain object.
- null equals only null; undefined equals only undefined.
- Objects of different prototypes beyond plain-object-vs-array need not be supported
  structurally EXCEPT Date (equal iff same timestamp) — everything else may fall back to
  reference equality.
- Error contract: if either input contains a reference cycle reachable during the
  comparison, throw a TypeError (do not hang).`,
    ref: `export function deepEqual(a: unknown, b: unknown): boolean {
  const seen = new WeakSet<object>()

  const isPlain = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date)

  const eq = (x: unknown, y: unknown): boolean => {
    if (typeof x !== 'object' || x === null || typeof y !== 'object' || y === null) {
      if (typeof x === 'number' && typeof y === 'number') {
        return x === y || (Number.isNaN(x) && Number.isNaN(y))
      }
      return x === y
    }
    if (x instanceof Date || y instanceof Date) {
      return x instanceof Date && y instanceof Date && x.getTime() === y.getTime()
    }
    const xArr = Array.isArray(x)
    const yArr = Array.isArray(y)
    if (xArr !== yArr) return false
    if (seen.has(x) || seen.has(y)) throw new TypeError('cyclic structure')
    seen.add(x); seen.add(y)
    try {
      if (xArr && yArr) {
        const ax = x as unknown[]
        const ay = y as unknown[]
        if (ax.length !== ay.length) return false
        for (let i = 0; i < ax.length; i++) {
          if (!eq(ax[i], ay[i])) return false
        }
        return true
      }
      if (isPlain(x) && isPlain(y)) {
        const kx = Object.keys(x)
        const ky = Object.keys(y)
        if (kx.length !== ky.length) return false
        for (const k of kx) {
          if (!Object.prototype.hasOwnProperty.call(y, k)) return false
          if (!eq(x[k], y[k])) return false
        }
        return true
      }
      return x === y
    } finally {
      seen.delete(x); seen.delete(y)
    }
  }

  return eq(a, b)
}
`,
    suite: `// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — deepEqualCyc.
// Run: npx tsx __audit__/deepEqualCyc.hidden.ts   (imports ../src/deepEqualCyc)
import { deepEqual } from '../src/deepEqualCyc'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

check('primitive equal', deepEqual(1, 1) && deepEqual('a', 'a'))
check('primitive unequal', !deepEqual(1, 2) && !deepEqual('a', 'b'))
check('NaN equals NaN', deepEqual(NaN, NaN))
check('plus and minus zero equal', deepEqual(0, -0))
check('null only equals null', deepEqual(null, null) && !deepEqual(null, undefined) && !deepEqual(null, {}))
check('nested objects equal', deepEqual({ a: { b: [1, 2] } }, { a: { b: [1, 2] } }))
check('key order irrelevant', deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }))
check('missing key unequal', !deepEqual({ a: 1 }, { a: 1, b: undefined }))
check('array length mismatch', !deepEqual([1, 2], [1, 2, 3]))
check('array vs object never equal', !deepEqual([], {}))
check('nested difference found', !deepEqual({ a: { b: 1 } }, { a: { b: 2 } }))
check('dates by timestamp', deepEqual(new Date(1000), new Date(1000)) && !deepEqual(new Date(1000), new Date(2000)))
check('date vs number unequal', !deepEqual(new Date(0), 0))
check('sibling references are not cycles', (() => {
  const shared = { v: 1 }
  return deepEqual({ x: shared, y: shared }, { x: { v: 1 }, y: { v: 1 } })
})())
check('repeated non-cyclic subtree ok', (() => {
  const sub = [1, 2]
  return deepEqual([sub, sub], [[1, 2], [1, 2]])
})())
let threw = false
try {
  const a: Record<string, unknown> = {}; a.self = a
  const b: Record<string, unknown> = {}; b.self = b
  deepEqual(a, b)
} catch (e) { threw = e instanceof TypeError }
check('cycle throws TypeError instead of hanging', threw)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`,
  },

  {
    id: 'jsonPointerGet',
    title: 'RFC 6901 JSON Pointer resolution',
    modulePath: 'src/jsonPointerGet.ts',
    prompt: `Implement JSON Pointer lookup in TypeScript at src/jsonPointerGet.ts. ${CONTRACT}

Export exactly:
  export function getPointer(doc: unknown, pointer: string): unknown

Semantics (RFC 6901):
- "" (empty pointer) returns doc itself. A pointer is otherwise a sequence of /-prefixed
  reference tokens: "/a/b" resolves doc.a.b.
- In tokens, "~1" unescapes to "/" and "~0" to "~" (in that order of application).
- Array elements are addressed by decimal index tokens; an index with a leading zero
  (other than "0" itself), a negative index, or a non-numeric token applied to an array
  resolves to undefined.
- Any missing step resolves to undefined (never throws for absent paths). Empty-string
  keys are legal: "/" addresses the "" property of doc.
- Error contract: a non-empty pointer that does not start with "/" throws a SyntaxError.`,
    ref: `export function getPointer(doc: unknown, pointer: string): unknown {
  if (pointer === '') return doc
  if (!pointer.startsWith('/')) throw new SyntaxError('pointer must start with "/"')
  const tokens = pointer.slice(1).split('/').map(t => t.replace(/~1/g, '/').replace(/~0/g, '~'))
  let cur: unknown = doc
  for (const tok of tokens) {
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9][0-9]*)$/.test(tok)) return undefined
      cur = cur[Number(tok)]
    } else if (cur !== null && typeof cur === 'object') {
      if (!Object.prototype.hasOwnProperty.call(cur, tok)) return undefined
      cur = (cur as Record<string, unknown>)[tok]
    } else {
      return undefined
    }
  }
  return cur
}
`,
    suite: `// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — jsonPointerGet.
// Run: npx tsx __audit__/jsonPointerGet.hidden.ts   (imports ../src/jsonPointerGet)
import { getPointer } from '../src/jsonPointerGet'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

const doc = {
  foo: ['bar', 'baz'],
  '': 0,
  'a/b': 1,
  'c%d': 2,
  'e^f': 3,
  'm~n': 8,
  nested: { deep: { value: 42 } },
}

check('empty pointer is whole doc', getPointer(doc, '') === doc)
check('object property', getPointer(doc, '/nested') === doc.nested)
check('deep chain', getPointer(doc, '/nested/deep/value') === 42)
check('array by index', getPointer(doc, '/foo/0') === 'bar')
check('array second element', getPointer(doc, '/foo/1') === 'baz')
check('escaped slash ~1', getPointer(doc, '/a~1b') === 1)
check('escaped tilde ~0', getPointer(doc, '/m~0n') === 8)
check('empty-string key via "/"', getPointer(doc, '/') === 0)
check('percent in key untouched', getPointer(doc, '/c%d') === 2)
check('missing key is undefined', getPointer(doc, '/nope') === undefined)
check('missing deep path is undefined', getPointer(doc, '/nested/ghost/x') === undefined)
check('array index out of range undefined', getPointer(doc, '/foo/5') === undefined)
check('leading-zero index rejected', getPointer(doc, '/foo/01') === undefined)
check('negative index rejected', getPointer(doc, '/foo/-1') === undefined)
check('non-numeric token on array rejected', getPointer(doc, '/foo/bar') === undefined)
check('index through primitive undefined', getPointer(doc, '/foo/0/x') === undefined)
let threw = false
try { getPointer(doc, 'foo') } catch (e) { threw = e instanceof SyntaxError }
check('missing leading slash throws SyntaxError', threw)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`,
  },

  {
    id: 'runLength',
    title: 'Run-length encode/decode with strict grammar',
    modulePath: 'src/runLength.ts',
    prompt: `Implement run-length coding in TypeScript at src/runLength.ts. ${CONTRACT}

Export exactly:
  export function rleEncode(s: string): string
  export function rleDecode(s: string): string

Semantics:
- Encoding: each maximal run of a repeated character becomes the character followed by its
  decimal count, count always present: "aaab" -> "a3b1". Empty string encodes to "".
- The alphabet is letters only (a-z, A-Z), case-sensitive.
- Decoding inverts encoding exactly: "a3b1" -> "aaab". Counts are positive decimal
  integers with no leading zeros and may be multi-digit ("a12" -> 12 a's).
- Error contract (throw SyntaxError): encoding input containing a non-letter; decoding
  input with a zero count, a leading-zero count, a letter with no count, a count with no
  preceding letter, or any non-alphanumeric character.
- Round-trip law: rleDecode(rleEncode(s)) === s for every legal input.`,
    ref: `export function rleEncode(s: string): string {
  if (/[^a-zA-Z]/.test(s)) throw new SyntaxError('input must be letters only')
  let out = ''
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    let j = i
    while (j < s.length && s[j] === ch) j++
    out += ch + String(j - i)
    i = j
  }
  return out
}

export function rleDecode(s: string): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (!/[a-zA-Z]/.test(ch)) throw new SyntaxError('expected letter at position ' + i)
    i += 1
    let digits = ''
    while (i < s.length && /[0-9]/.test(s[i])) { digits += s[i]; i += 1 }
    if (digits === '') throw new SyntaxError('letter without count')
    if (digits[0] === '0') throw new SyntaxError('zero or leading-zero count')
    out += ch.repeat(Number(digits))
  }
  return out
}
`,
    suite: `// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — runLength.
// Run: npx tsx __audit__/runLength.hidden.ts   (imports ../src/runLength)
import { rleEncode, rleDecode } from '../src/runLength'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}
const throwsSyn = (fn: () => void): boolean => {
  try { fn(); return false } catch (e) { return e instanceof SyntaxError }
}

check('basic encode', rleEncode('aaab') === 'a3b1')
check('single chars all count 1', rleEncode('abc') === 'a1b1c1')
check('long run multi-digit count', rleEncode('a'.repeat(12)) === 'a12')
check('case sensitivity', rleEncode('aA') === 'a1A1')
check('empty encodes empty', rleEncode('') === '')
check('re-run after gap counts separately', rleEncode('aabaa') === 'a2b1a2')
check('basic decode', rleDecode('a3b1') === 'aaab')
check('multi-digit decode', rleDecode('a12') === 'a'.repeat(12))
check('empty decodes empty', rleDecode('') === '')
check('round trip identity', rleDecode(rleEncode('aaBBBcDDDDe')) === 'aaBBBcDDDDe')
check('round trip on alternating', rleDecode(rleEncode('ababab')) === 'ababab')
check('encode rejects digit', throwsSyn(() => rleEncode('a1')))
check('encode rejects space', throwsSyn(() => rleEncode('a b')))
check('decode rejects zero count', throwsSyn(() => rleDecode('a0')))
check('decode rejects leading zero', throwsSyn(() => rleDecode('a01')))
check('decode rejects letter without count', throwsSyn(() => rleDecode('ab')))
check('decode rejects count without letter', throwsSyn(() => rleDecode('3a')))
check('decode rejects punctuation', throwsSyn(() => rleDecode('a3-b1')))

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`,
  },

  {
    id: 'posixResolve',
    title: 'POSIX path normalizer without the fs module',
    modulePath: 'src/posixResolve.ts',
    prompt: `Implement POSIX path normalization in TypeScript at src/posixResolve.ts. ${CONTRACT}
Do NOT import node's "path" or "fs" modules — this is a pure string algorithm.

Export exactly:
  export function normalizePath(p: string): string

Semantics:
- Collapse repeated slashes; resolve "." segments away; resolve ".." against the previous
  real segment.
- Absolute paths (leading "/"): ".." at the root is clamped ("/../a" -> "/a").
- Relative paths: leading ".." segments that cannot be resolved are preserved
  ("../../a" stays "../../a"; "a/../../b" -> "../b").
- A trailing slash is dropped except for the root itself ("/a/" -> "/a", "/" -> "/").
- The empty string and "." both normalize to "."; a relative path that fully cancels
  ("a/..") normalizes to ".".`,
    ref: `export function normalizePath(p: string): string {
  const absolute = p.startsWith('/')
  const parts = p.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(part)
  }
  if (absolute) return '/' + out.join('/')
  if (out.length === 0) return '.'
  return out.join('/')
}
`,
    suite: `// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — posixResolve.
// Run: npx tsx __audit__/posixResolve.hidden.ts   (imports ../src/posixResolve)
import { normalizePath } from '../src/posixResolve'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

check('already normal', normalizePath('/a/b') === '/a/b')
check('collapse repeated slashes', normalizePath('/a//b///c') === '/a/b/c')
check('dot segments removed', normalizePath('/a/./b/.') === '/a/b')
check('dotdot resolves', normalizePath('/a/b/../c') === '/a/c')
check('dotdot chain', normalizePath('/a/b/c/../../d') === '/a/d')
check('root clamp', normalizePath('/../a') === '/a')
check('root multi clamp', normalizePath('/../../a') === '/a')
check('relative preserved dotdot', normalizePath('../../a') === '../../a')
check('relative overflow becomes dotdot', normalizePath('a/../../b') === '../b')
check('relative full cancel is dot', normalizePath('a/..') === '.')
check('empty is dot', normalizePath('') === '.')
check('dot is dot', normalizePath('.') === '.')
check('trailing slash dropped', normalizePath('/a/') === '/a')
check('root stays root', normalizePath('/') === '/')
check('relative trailing slash dropped', normalizePath('a/b/') === 'a/b')
check('dotdot after real segments', normalizePath('a/b/../c') === 'a/c')
check('mixed mess', normalizePath('./a//./b/../c/') === 'a/c')
check('no path module used', !String(normalizePath).includes('require'))

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`,
  },
]
