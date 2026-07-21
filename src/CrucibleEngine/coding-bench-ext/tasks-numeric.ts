// Extended coding-bench corpus — numeric/date shard (W42). See tasks-strings.ts for the
// corpus rules.

import type { ExtTask } from './tasks-strings'

const CONTRACT =
  'Build the COMPLETE, production-quality implementation — no placeholders, no TODOs, no stub bodies. ' +
  'You MUST create the exact file path and export the exact API named below (an automated audit imports it verbatim). ' +
  'Verify it actually runs before reporting done.'

export const NUMERIC_TASKS: ExtTask[] = [
  {
    id: 'bankersRound',
    title: 'Half-to-even (bankers) rounding at a decimal place',
    modulePath: 'src/bankersRound.ts',
    prompt: `Implement bankers rounding in TypeScript at src/bankersRound.ts. ${CONTRACT}

Export exactly:
  export function bankersRound(value: number, decimals: number): number

Semantics:
- Round value to the given number of decimal places using HALF-TO-EVEN: a value exactly
  halfway between two neighbours rounds to the neighbour whose last digit is even
  (2.5 -> 2, 3.5 -> 4 at decimals = 0).
- Non-halfway values round normally (2.6 -> 3). Negative values mirror positives
  (-2.5 -> -2). decimals may be 0 or positive.
- The value is interpreted through its SHORTEST decimal representation — exactly the
  digits String(value) prints (the same semantics as Intl.NumberFormat halfEven). So
  String(9.95) is "9.95", a true half at 1 decimal, and it rounds to the even neighbour
  10. String(0.125) is "0.125", a true half at 2 decimals, rounding to 0.12. Do NOT
  operate on the raw binary expansion (9.95 is stored as 9.9499...; that expansion is
  irrelevant here).
- Error contract: throw a RangeError unless decimals is an integer 0..12; throw a
  TypeError if value is NaN or not finite.`,
    ref: `// Shortest-decimal-representation semantics: operate on the digits String(x) prints,
// never on the binary expansion. Matches Intl.NumberFormat roundingMode halfEven.
function decimalString(x: number): string {
  const s = String(x)
  const m = /^(\\d+)(?:\\.(\\d+))?e([+-]\\d+)$/.exec(s)
  if (!m) return s
  const ip = m[1]
  const fp = m[2] ?? ''
  const exp = Number(m[3])
  const digits = ip + fp
  const point = ip.length + exp
  if (point <= 0) return '0.' + '0'.repeat(-point) + digits
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length)
  return digits.slice(0, point) + '.' + digits.slice(point)
}

export function bankersRound(value: number, decimals: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('value must be finite')
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) throw new RangeError('decimals must be an integer 0..12')
  const neg = value < 0
  const s = decimalString(Math.abs(value))
  const dot = s.indexOf('.')
  const intPart = dot === -1 ? s : s.slice(0, dot)
  const fracPart = dot === -1 ? '' : s.slice(dot + 1)
  if (fracPart.length <= decimals) return neg && value !== 0 ? value : Math.abs(value)
  const keep = fracPart.slice(0, decimals)
  const tail = fracPart.slice(decimals)
  let unit = BigInt(intPart + keep)
  const first = tail[0]
  const rest = tail.slice(1).replace(/0+$/, '')
  const isHalf = first === '5' && rest === ''
  if (isHalf ? unit % 2n === 1n : Number(first) >= 5) unit += 1n
  const scaled = Number(unit) / Math.pow(10, decimals)
  return neg && scaled !== 0 ? -scaled : scaled
}
`,
    suite: `// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — bankersRound.
// Run: npx tsx __audit__/bankersRound.hidden.ts   (imports ../src/bankersRound)
import { bankersRound } from '../src/bankersRound'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

check('half to even down', bankersRound(2.5, 0) === 2)
check('half to even up', bankersRound(3.5, 0) === 4)
check('half at zero', bankersRound(0.5, 0) === 0)
check('half at one point five', bankersRound(1.5, 0) === 2)
check('non-half rounds normally up', bankersRound(2.6, 0) === 3)
check('non-half rounds normally down', bankersRound(2.4, 0) === 2)
check('negative mirrors positive half', bankersRound(-2.5, 0) === -2)
check('negative non-half', bankersRound(-2.6, 0) === -3)
check('two decimals half to even', bankersRound(0.125, 2) === 0.12)
check('two decimals half to even up', bankersRound(0.135, 2) === 0.14)
check('shortest-repr: 24.6765 is a true half at 3 decimals', bankersRound(24.6765, 3) === 24.676)
check('two decimals normal', bankersRound(0.126, 2) === 0.13)
check('integer passthrough', bankersRound(7, 0) === 7)
check('already at precision', bankersRound(1.23, 2) === 1.23)
check('shortest-repr: 9.95 is a true half, even neighbour is 10', bankersRound(9.95, 1) === 10)
check('carry across digits', bankersRound(9.96, 1) === 10)
check('zero stays zero', bankersRound(0, 2) === 0)
const throwsRange = (fn: () => void): boolean => {
  try { fn(); return false } catch (e) { return e instanceof RangeError }
}
const throwsType = (fn: () => void): boolean => {
  try { fn(); return false } catch (e) { return e instanceof TypeError }
}
check('negative decimals throws', throwsRange(() => bankersRound(1, -1)))
check('fractional decimals throws', throwsRange(() => bankersRound(1, 1.5)))
check('NaN throws TypeError', throwsType(() => bankersRound(NaN, 0)))
check('Infinity throws TypeError', throwsType(() => bankersRound(Infinity, 0)))

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`,
  },

  {
    id: 'baseConvert',
    title: 'Arbitrary-length base conversion 2..36',
    modulePath: 'src/baseConvert.ts',
    prompt: `Implement base conversion in TypeScript at src/baseConvert.ts. ${CONTRACT}

Export exactly:
  export function convertBase(digits: string, fromBase: number, toBase: number): string

Semantics:
- digits is a number written in fromBase using 0-9 then a-z (case-insensitive on input);
  output uses lowercase. Result is the same number written in toBase.
- Must be correct far beyond Number.MAX_SAFE_INTEGER — the audit converts strings dozens
  of digits long (use BigInt or digit-array arithmetic).
- An optional leading "-" is preserved. "0" in any base converts to "0" (never "-0").
- No leading zeros in output; input MAY carry leading zeros, which are ignored.
- Error contract (throw RangeError): fromBase or toBase outside 2..36 or not an integer;
  empty digits (or just "-"); any digit not valid in fromBase.`,
    ref: `const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

export function convertBase(digits: string, fromBase: number, toBase: number): string {
  if (!Number.isInteger(fromBase) || fromBase < 2 || fromBase > 36) throw new RangeError('fromBase out of range')
  if (!Number.isInteger(toBase) || toBase < 2 || toBase > 36) throw new RangeError('toBase out of range')
  let s = digits.toLowerCase()
  let neg = false
  if (s.startsWith('-')) { neg = true; s = s.slice(1) }
  if (s.length === 0) throw new RangeError('empty digits')
  const from = BigInt(fromBase)
  let value = 0n
  for (const ch of s) {
    const d = ALPHABET.indexOf(ch)
    if (d === -1 || d >= fromBase) throw new RangeError('invalid digit "' + ch + '" for base ' + fromBase)
    value = value * from + BigInt(d)
  }
  if (value === 0n) return '0'
  const to = BigInt(toBase)
  let out = ''
  while (value > 0n) {
    out = ALPHABET[Number(value % to)] + out
    value = value / to
  }
  return neg ? '-' + out : out
}
`,
    suite: `// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — baseConvert.
// Run: npx tsx __audit__/baseConvert.hidden.ts   (imports ../src/baseConvert)
import { convertBase } from '../src/baseConvert'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

check('binary to decimal', convertBase('1010', 2, 10) === '10')
check('decimal to hex', convertBase('255', 10, 16) === 'ff')
check('hex to binary', convertBase('ff', 16, 2) === '11111111')
check('uppercase input accepted', convertBase('FF', 16, 10) === '255')
check('output is lowercase', convertBase('255', 10, 36) === '73')
check('identity same base', convertBase('12345', 10, 10) === '12345')
check('zero in any base', convertBase('0', 2, 36) === '0')
check('negative zero collapses', convertBase('-0', 10, 2) === '0')
check('leading zeros ignored', convertBase('007', 10, 2) === '111')
check('negative preserved', convertBase('-255', 10, 16) === '-ff')
check('base 36 digits', convertBase('z', 36, 10) === '35')
const big = '123456789012345678901234567890123456789'
check('beyond MAX_SAFE_INTEGER round trip', convertBase(convertBase(big, 10, 16), 16, 10) === big)
check('long binary round trip', (() => {
  const b = '1' + '0'.repeat(100)
  return convertBase(convertBase(b, 2, 36), 36, 2) === b
})())
const throwsRange = (fn: () => void): boolean => {
  try { fn(); return false } catch (e) { return e instanceof RangeError }
}
check('base 1 throws', throwsRange(() => convertBase('1', 1, 10)))
check('base 37 throws', throwsRange(() => convertBase('1', 10, 37)))
check('digit invalid for base throws', throwsRange(() => convertBase('2', 2, 10)))
check('letter beyond base throws', throwsRange(() => convertBase('g', 16, 10)))
check('empty digits throws', throwsRange(() => convertBase('', 10, 2)))
check('bare minus throws', throwsRange(() => convertBase('-', 10, 2)))

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`,
  },

  {
    id: 'fractionAdd',
    title: 'Exact rational addition with normalization',
    modulePath: 'src/fractionAdd.ts',
    prompt: `Implement exact fraction arithmetic in TypeScript at src/fractionAdd.ts. ${CONTRACT}

Export exactly:
  export type Fraction = [number, number]   // [numerator, denominator]
  export function addFractions(a: Fraction, b: Fraction): Fraction

Semantics:
- Returns the exact sum in LOWEST TERMS: addFractions([1,2],[1,3]) is [5,6].
- Normalized sign: the denominator of the result is always positive; a negative value
  carries its sign on the numerator ([1,-2] is the same number as [-1,2]).
- Zero normalizes to [0,1] regardless of the input denominators.
- Inputs are not mutated. Integer inputs only.
- Error contract: throw a RangeError if any denominator is 0; throw a TypeError if any
  entry is not an integer (this includes NaN and Infinity).`,
    ref: `export type Fraction = [number, number]

function gcd(a: number, b: number): number {
  let x = Math.abs(a)
  let y = Math.abs(b)
  while (y !== 0) { const t = x % y; x = y; y = t }
  return x
}

export function addFractions(a: Fraction, b: Fraction): Fraction {
  for (const [n, d] of [a, b]) {
    if (!Number.isInteger(n) || !Number.isInteger(d)) throw new TypeError('entries must be integers')
    if (d === 0) throw new RangeError('zero denominator')
  }
  let num = a[0] * b[1] + b[0] * a[1]
  let den = a[1] * b[1]
  if (num === 0) return [0, 1]
  if (den < 0) { num = -num; den = -den }
  const g = gcd(num, den)
  return [num / g, den / g]
}
`,
    suite: `// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — fractionAdd.
// Run: npx tsx __audit__/fractionAdd.hidden.ts   (imports ../src/fractionAdd)
import { addFractions } from '../src/fractionAdd'
import type { Fraction } from '../src/fractionAdd'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}
const eq = (a: Fraction, b: Fraction): boolean => a[0] === b[0] && a[1] === b[1]

check('halves plus thirds', eq(addFractions([1, 2], [1, 3]), [5, 6]))
check('reduces to lowest terms', eq(addFractions([1, 4], [1, 4]), [1, 2]))
check('whole number result', eq(addFractions([1, 2], [1, 2]), [1, 1]))
check('zero normalizes', eq(addFractions([1, 3], [-1, 3]), [0, 1]))
check('zero plus zero', eq(addFractions([0, 5], [0, 7]), [0, 1]))
check('negative numerator input', eq(addFractions([-1, 2], [1, 3]), [-1, 6]))
check('negative denominator normalized', eq(addFractions([1, -2], [0, 1]), [-1, 2]))
check('both negative cancels', eq(addFractions([1, -2], [-1, 2]), [-1, 1]))
check('double negative is positive', eq(addFractions([-1, -2], [0, 1]), [1, 2]))
check('result denominator always positive', addFractions([1, -3], [1, -6])[1] > 0)
check('large coprime denominators', eq(addFractions([1, 97], [1, 89]), [186, 8633]))
check('inputs not mutated', (() => {
  const a: Fraction = [2, 4]
  addFractions(a, [1, 2])
  return a[0] === 2 && a[1] === 4
})())
const throwsRange = (fn: () => void): boolean => {
  try { fn(); return false } catch (e) { return e instanceof RangeError }
}
const throwsType = (fn: () => void): boolean => {
  try { fn(); return false } catch (e) { return e instanceof TypeError }
}
check('zero denominator throws RangeError', throwsRange(() => addFractions([1, 0], [1, 2])))
check('float entry throws TypeError', throwsType(() => addFractions([1.5, 2], [1, 2])))
check('NaN entry throws TypeError', throwsType(() => addFractions([NaN, 2], [1, 2])))

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`,
  },

  {
    id: 'dateRangeDays',
    title: 'Inclusive overlap in days between two ISO date ranges',
    modulePath: 'src/dateRangeDays.ts',
    prompt: `Implement date-range overlap in TypeScript at src/dateRangeDays.ts. ${CONTRACT}

Export exactly:
  export function overlapDays(a: [string, string], b: [string, string]): number

Semantics:
- Each range is [startISO, endISO] with date-only ISO strings ("2024-02-28"), endpoints
  INCLUSIVE, interpreted as UTC calendar days (no timezones, no clock reads).
- Returns the number of whole days both ranges share: identical single-day ranges overlap
  1; ["2024-01-01","2024-01-10"] and ["2024-01-08","2024-01-20"] overlap 3.
- Disjoint ranges return 0. Ranges touching at one shared day return 1.
- Must be correct across month ends and the Feb-29 leap boundary.
- Error contract (throw TypeError): any string not matching strict YYYY-MM-DD, or naming
  an impossible calendar date ("2023-02-29", "2024-04-31"); (throw RangeError): a range
  whose end is before its start.`,
    ref: `const ISO = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/

function toUtcDay(s: string): number {
  const m = ISO.exec(s)
  if (!m) throw new TypeError('not a YYYY-MM-DD date: ' + s)
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) throw new TypeError('impossible date: ' + s)
  const ms = Date.UTC(y, mo - 1, d)
  const dt = new Date(ms)
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new TypeError('impossible date: ' + s)
  }
  return Math.floor(ms / 86400000)
}

export function overlapDays(a: [string, string], b: [string, string]): number {
  const a0 = toUtcDay(a[0])
  const a1 = toUtcDay(a[1])
  const b0 = toUtcDay(b[0])
  const b1 = toUtcDay(b[1])
  if (a1 < a0 || b1 < b0) throw new RangeError('range end before start')
  const lo = Math.max(a0, b0)
  const hi = Math.min(a1, b1)
  return hi < lo ? 0 : hi - lo + 1
}
`,
    suite: `// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — dateRangeDays.
// Run: npx tsx __audit__/dateRangeDays.hidden.ts   (imports ../src/dateRangeDays)
import { overlapDays } from '../src/dateRangeDays'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

check('partial overlap', overlapDays(['2024-01-01', '2024-01-10'], ['2024-01-08', '2024-01-20']) === 3)
check('disjoint is zero', overlapDays(['2024-01-01', '2024-01-05'], ['2024-02-01', '2024-02-05']) === 0)
check('touching single day', overlapDays(['2024-01-01', '2024-01-05'], ['2024-01-05', '2024-01-09']) === 1)
check('containment', overlapDays(['2024-01-01', '2024-01-31'], ['2024-01-10', '2024-01-12']) === 3)
check('identical single day', overlapDays(['2024-03-03', '2024-03-03'], ['2024-03-03', '2024-03-03']) === 1)
check('identical ranges', overlapDays(['2024-01-01', '2024-01-07'], ['2024-01-01', '2024-01-07']) === 7)
check('leap day counted', overlapDays(['2024-02-28', '2024-03-01'], ['2024-02-29', '2024-03-05']) === 2)
check('non-leap february boundary', overlapDays(['2023-02-27', '2023-03-01'], ['2023-02-28', '2023-02-28']) === 1)
check('across month end', overlapDays(['2024-01-30', '2024-02-02'], ['2024-01-31', '2024-02-01']) === 2)
check('across year end', overlapDays(['2023-12-30', '2024-01-02'], ['2023-12-31', '2024-01-05']) === 3)
check('adjacent but not touching', overlapDays(['2024-01-01', '2024-01-04'], ['2024-01-05', '2024-01-09']) === 0)
const throwsType = (fn: () => void): boolean => {
  try { fn(); return false } catch (e) { return e instanceof TypeError }
}
const throwsRange = (fn: () => void): boolean => {
  try { fn(); return false } catch (e) { return e instanceof RangeError }
}
check('malformed date throws TypeError', throwsType(() => overlapDays(['2024-1-01', '2024-01-02'], ['2024-01-01', '2024-01-02'])))
check('impossible Feb 29 throws TypeError', throwsType(() => overlapDays(['2023-02-29', '2023-03-01'], ['2023-03-01', '2023-03-02'])))
check('impossible Apr 31 throws TypeError', throwsType(() => overlapDays(['2024-04-31', '2024-05-01'], ['2024-05-01', '2024-05-02'])))
check('datetime string throws TypeError', throwsType(() => overlapDays(['2024-01-01T00:00:00Z', '2024-01-02'], ['2024-01-01', '2024-01-02'])))
check('inverted range throws RangeError', throwsRange(() => overlapDays(['2024-01-05', '2024-01-01'], ['2024-01-01', '2024-01-02'])))

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`,
  },

  {
    id: 'matrixRotate',
    title: 'Rotate a rectangular matrix 90 degrees clockwise',
    modulePath: 'src/matrixRotate.ts',
    prompt: `Implement matrix rotation in TypeScript at src/matrixRotate.ts. ${CONTRACT}

Export exactly:
  export function rotate90<T>(matrix: T[][]): T[][]

Semantics:
- Returns a NEW matrix rotated 90 degrees clockwise; the input (rows and outer array) is
  not mutated. An R x C input produces a C x R output where
  output[c][R - 1 - r] === input[r][c].
- Works for non-square shapes: 1xN becomes Nx1 and vice versa.
- The empty matrix [] returns []. A matrix of empty rows ([[], []]) returns [].
- Error contract: ragged input (rows of differing lengths) throws a RangeError.`,
    ref: `export function rotate90<T>(matrix: T[][]): T[][] {
  if (matrix.length === 0) return []
  const rows = matrix.length
  const cols = matrix[0].length
  for (const row of matrix) {
    if (row.length !== cols) throw new RangeError('ragged matrix')
  }
  if (cols === 0) return []
  const out: T[][] = []
  for (let c = 0; c < cols; c++) {
    const newRow: T[] = []
    for (let r = rows - 1; r >= 0; r--) newRow.push(matrix[r][c])
    out.push(newRow)
  }
  return out
}
`,
    suite: `// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — matrixRotate.
// Run: npx tsx __audit__/matrixRotate.hidden.ts   (imports ../src/matrixRotate)
import { rotate90 } from '../src/matrixRotate'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

check('2x2 rotation', eq(rotate90([[1, 2], [3, 4]]), [[3, 1], [4, 2]]))
check('3x3 rotation', eq(rotate90([[1, 2, 3], [4, 5, 6], [7, 8, 9]]), [[7, 4, 1], [8, 5, 2], [9, 6, 3]]))
check('1xN becomes Nx1', eq(rotate90([[1, 2, 3]]), [[1], [2], [3]]))
check('Nx1 becomes 1xN reversed', eq(rotate90([[1], [2], [3]]), [[3, 2, 1]]))
check('2x3 becomes 3x2', eq(rotate90([[1, 2, 3], [4, 5, 6]]), [[4, 1], [5, 2], [6, 3]]))
check('single cell', eq(rotate90([[7]]), [[7]]))
check('empty matrix', eq(rotate90([]), []))
check('rows of zero length', eq(rotate90([[], []]), []))
check('four rotations restore square', (() => {
  const m = [[1, 2], [3, 4]]
  return eq(rotate90(rotate90(rotate90(rotate90(m)))), m)
})())
check('strings preserved', eq(rotate90([['a', 'b'], ['c', 'd']]), [['c', 'a'], ['d', 'b']]))
check('input not mutated', (() => {
  const m = [[1, 2], [3, 4]]
  rotate90(m)
  return eq(m, [[1, 2], [3, 4]])
})())
check('outer array not aliased', (() => {
  const m = [[1, 2], [3, 4]]
  const r = rotate90(m)
  r[0][0] = 99
  return m[1][0] === 3
})())
let threw = false
try { rotate90([[1, 2], [3]]) } catch (e) { threw = e instanceof RangeError }
check('ragged input throws RangeError', threw)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`,
  },
]
