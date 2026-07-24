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
// fromBase < 2 must be rejected up front even when every digit is individually valid for it
// ('0' is a legal base-1 digit). Kills or->and on the first range guard
// (!Number.isInteger(fromBase) || fromBase < 2 || ...): under && the fromBase<2 branch is
// dropped and convertBase('0', 1, 10) would return '0' instead of throwing.
check('fromBase below 2 rejected with otherwise-valid digit', throwsRange(() => convertBase('0', 1, 10)))
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
- Exactness domain: plain number arithmetic suffices. The audit keeps every input and
  every intermediate cross-product (a[0]*b[1], b[0]*a[1], a[1]*b[1], and the numerator
  sum) within Number.MAX_SAFE_INTEGER in magnitude; behavior beyond that magnitude is
  out of contract, and BigInt is not required.
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
  {
    id: 'basicCalculator',
    title: 'Evaluate an arithmetic expression with precedence, no parentheses',
    modulePath: 'src/basicCalculator.ts',
    prompt: `Implement an arithmetic expression evaluator in TypeScript at src/basicCalculator.ts. ${CONTRACT}

Export exactly:
  export function basicCalculator(expr: string): number

Semantics:
- Evaluate an arithmetic expression string of non-negative integers and the binary
  operators + - * / with STANDARD PRECEDENCE (* and / bind tighter than + and -) and NO
  parentheses. Same-precedence operators associate LEFT TO RIGHT.
- Division is INTEGER division truncating TOWARD ZERO (10/3 -> 3, exactly Math.trunc).
- Spaces may appear anywhere and are ignored ("3 + 5 / 2" is "3+5/2").
- Examples: basicCalculator("3+2*2") -> 7, basicCalculator("3+5/2") -> 5,
  basicCalculator("14-3*2") -> 8, basicCalculator("2*3+4*5") -> 26,
  basicCalculator("6/2*3") -> 9, basicCalculator("100") -> 100, basicCalculator("7-2-1") -> 4.
- This is the classic precedence-without-parentheses evaluation: the reliable route is a
  two-pass fold — tokenize, collapse every * and / left to right, then collapse + and -.`,
    ref: `export function basicCalculator(expr: string): number {
  const tokens = expr.replace(/\\s+/g, '').match(/\\d+|[-+*/]/g)
  if (!tokens) return 0
  // Pass 1: fold * and / left-to-right (integer division truncates toward zero).
  const reduced: string[] = [tokens[0]]
  for (let i = 1; i < tokens.length; i += 2) {
    const op = tokens[i], b = Number(tokens[i + 1])
    if (op === '*') reduced[reduced.length - 1] = String(Number(reduced[reduced.length - 1]) * b)
    else if (op === '/') reduced[reduced.length - 1] = String(Math.trunc(Number(reduced[reduced.length - 1]) / b))
    else { reduced.push(op); reduced.push(String(b)) }
  }
  // Pass 2: fold + and - left-to-right.
  let acc = Number(reduced[0])
  for (let i = 1; i < reduced.length; i += 2) {
    acc = reduced[i] === '+' ? acc + Number(reduced[i + 1]) : acc - Number(reduced[i + 1])
  }
  return acc
}
`,
    suite: `// HIDDEN adversarial suite for a NOVEL task (precedence-without-parens) — basicCalculator.
// Run: npx tsx __audit__/basicCalculator.hidden.ts   (imports ../src/basicCalculator)
import { basicCalculator } from '../src/basicCalculator'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

check('precedence: mul before add', basicCalculator('3+2*2') === 7)
check('single division truncates', basicCalculator(' 3/2 ') === 1)
check('precedence: div before add', basicCalculator('3+5 / 2') === 5)
check('precedence: mul before sub', basicCalculator('14-3*2') === 8)
check('two products summed', basicCalculator('2*3+4*5') === 26)
check('bare integer', basicCalculator('100') === 100)
check('chained multiply', basicCalculator('2*3*4') === 24)
check('division truncates toward zero', basicCalculator('10/3') === 3)
check('subtraction is left-associative', basicCalculator('7-2-1') === 4)
check('long addition chain', basicCalculator('1+2+3+4') === 10)
check('zero product then add', basicCalculator('0*5+3') === 3)
check('surrounding spaces ignored', basicCalculator('  42  ') === 42)
check('same-precedence div and mul left-to-right', basicCalculator('6/2*3') === 9)
check('mixed precedence with div', basicCalculator('2+3*4-6/2') === 11)
check('subtraction can go negative', basicCalculator('3-5') === -2)
check('chained division left-to-right', basicCalculator('8/2/2') === 2)
check('multi-digit operands', basicCalculator('12*12+1') === 145)
check('interior spaces ignored', basicCalculator('1 0 + 5') === 15)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`,
  },
  {
    id: 'evalRPN',
    title: 'Evaluate a Reverse Polish Notation expression',
    modulePath: 'src/evalRPN.ts',
    prompt: `Implement a Reverse Polish Notation evaluator in TypeScript at src/evalRPN.ts. ${CONTRACT}

Export exactly:
  export function evalRPN(tokens: string[]): number

Semantics:
- Evaluate a Reverse Polish Notation (postfix) expression given as an array of string tokens.
  Operators are "+", "-", "*", "/"; every other token is an integer (possibly negative, e.g. "-4").
- Operand ORDER matters: for tokens [a, b, op], compute \`a op b\` (so ["10","3","-"] is 10-3=7).
- Division is INTEGER division truncating TOWARD ZERO (so 6/-4 = -1, not -2). All intermediate
  and final results are integers. A single-number input returns that number.
- Examples: evalRPN(["2","1","+","3","*"]) -> 9, evalRPN(["4","13","5","/","+"]) -> 6,
  evalRPN(["6","-4","/"]) -> -1, evalRPN(["-7"]) -> -7, evalRPN(["10","2","-","3","*"]) -> 24.
- The reliable route is a single stack pass: push numbers; on an operator pop b then a and push
  the result of applying the operator to (a, b).`,
    ref: `export function applyOp(op: string, a: number, b: number): number {
  return op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : Math.trunc(a / b)
}

export function evalRPN(tokens: string[]): number {
  const stack: number[] = []
  for (const t of tokens) {
    if (t.length === 1 && '+-*/'.includes(t)) {
      const b = stack.pop()!
      const a = stack.pop()!
      stack.push(applyOp(t, a, b))
    } else {
      stack.push(Number(t))
    }
  }
  return stack[0]
}
`,
    suite: `// HIDDEN adversarial suite for a NOVEL task (postfix/stack, 0%-by-sampling) — evalRPN.
// Run: npx tsx __audit__/evalRPN.hidden.ts   (imports ../src/evalRPN)
import { evalRPN } from '../src/evalRPN'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

check('add then multiply', evalRPN(['2', '1', '+', '3', '*']) === 9)
check('nested with division', evalRPN(['4', '13', '5', '/', '+']) === 6)
check('division truncates toward zero on negatives', evalRPN(['6', '-4', '/']) === -1)
check('single number passthrough', evalRPN(['-7']) === -7)
check('subtract then multiply', evalRPN(['10', '2', '-', '3', '*']) === 24)
check('operand order for subtraction', evalRPN(['10', '3', '-']) === 7)
check('operand order for division', evalRPN(['20', '4', '/']) === 5)
check('chained subtraction', evalRPN(['5', '1', '2', '-', '-']) === 6)
check('negative operands', evalRPN(['-3', '-2', '*']) === 6)
check('truncates toward zero positive', evalRPN(['7', '2', '/']) === 3)
check('longer expression', evalRPN(['15', '7', '1', '1', '+', '-', '/', '3', '*']) === 9)
check('multi-digit', evalRPN(['100', '50', '-']) === 50)
check('add negatives', evalRPN(['-5', '3', '+']) === -2)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`,
  },
  {
    id: 'editDistance',
    title: 'Levenshtein edit distance between two strings',
    modulePath: 'src/editDistance.ts',
    prompt: `Implement the Levenshtein edit distance in TypeScript at src/editDistance.ts. ${CONTRACT}

Export exactly:
  export function editDistance(a: string, b: string): number

Semantics:
- Return the Levenshtein edit distance between a and b: the MINIMUM number of single-character
  insertions, deletions, or substitutions needed to turn a into b.
- Substituting a character for an equal character costs 0; substituting for a different one costs
  1; each insertion and each deletion costs 1.
- Either string may be empty; editDistance("", b) is b.length and editDistance(a, "") is a.length.
- The distance is symmetric: editDistance(a, b) === editDistance(b, a).
- Examples: editDistance("kitten", "sitting") -> 3, editDistance("flaw", "lawn") -> 2,
  editDistance("", "abc") -> 3, editDistance("abc", "abc") -> 0,
  editDistance("sunday", "saturday") -> 3.
- The reliable route is the rolling-row dynamic program: seed the row [0..b.length], then for each
  character of a compute the next row as min(delete, insert, match/substitute); the answer is the
  last cell of the final row.`,
    ref: `export function subCost(x: string, y: string): number {
  return x === y ? 0 : 1
}

export function nextRow(prev: number[], ca: string, b: string): number[] {
  const cur = [prev[0] + 1]
  for (let j = 0; j < b.length; j++) {
    cur.push(Math.min(prev[j + 1] + 1, cur[j] + 1, prev[j] + subCost(ca, b[j])))
  }
  return cur
}

export function editRow(a: string, b: string): number[] {
  let row: number[] = []
  for (let j = 0; j <= b.length; j++) row.push(j)
  for (const ch of a) row = nextRow(row, ch, b)
  return row
}

export function editDistance(a: string, b: string): number {
  return editRow(a, b)[b.length]
}
`,
    suite: `// HIDDEN adversarial suite for a NOVEL task (edit-distance DP, 0%-by-sampling) — editDistance.
// Run: npx tsx __audit__/editDistance.hidden.ts   (imports ../src/editDistance)
import { editDistance } from '../src/editDistance'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

check('classic kitten/sitting', editDistance('kitten', 'sitting') === 3)
check('overlapping flaw/lawn', editDistance('flaw', 'lawn') === 2)
check('empty to three', editDistance('', 'abc') === 3)
check('three to empty', editDistance('abc', '') === 3)
check('identical is zero', editDistance('abc', 'abc') === 0)
check('sunday/saturday', editDistance('sunday', 'saturday') === 3)
check('both empty', editDistance('', '') === 0)
check('single insertion', editDistance('cat', 'cats') === 1)
check('single deletion', editDistance('cats', 'cat') === 1)
check('single substitution', editDistance('cat', 'cot') === 1)
check('symmetric', editDistance('intention', 'execution') === editDistance('execution', 'intention'))
check('intention/execution value', editDistance('intention', 'execution') === 5)
check('prefix', editDistance('abcdef', 'abc') === 3)
check('full replace', editDistance('abc', 'xyz') === 3)
check('repeated chars', editDistance('aaa', 'aa') === 1)
check('transposition costs two', editDistance('ab', 'ba') === 2)
check('long common middle', editDistance('sunny', 'snowy') === 3)
check('case sensitive', editDistance('Abc', 'abc') === 1)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`,
  },
  {
    id: 'calculatorWithParens',
    title: 'Evaluate an arithmetic expression with precedence AND parentheses',
    modulePath: 'src/calculatorWithParens.ts',
    prompt: `Implement a parenthesised arithmetic expression evaluator in TypeScript at src/calculatorWithParens.ts. ${CONTRACT}

Export exactly:
  export function calculatorWithParens(expr: string): number

Semantics:
- Evaluate an arithmetic expression string of non-negative integers, the binary operators
  + - * / with STANDARD PRECEDENCE (* and / bind tighter than + and -), AND round PARENTHESES
  "(" ")" that override precedence. Same-precedence operators associate LEFT TO RIGHT.
- Division is INTEGER division truncating TOWARD ZERO (10/3 -> 3, exactly Math.trunc).
- Spaces may appear anywhere and are ignored ("( 3 + 5 ) / 2" is "(3+5)/2").
- Examples: calculatorWithParens("(3+2)*2") -> 10, calculatorWithParens("2*(3+4)") -> 14,
  calculatorWithParens("(1+2)*(3+4)") -> 21, calculatorWithParens("3+2*2") -> 7,
  calculatorWithParens("((2+3))*2") -> 10, calculatorWithParens("100") -> 100,
  calculatorWithParens("2*(3+4*(5-1))") -> 38.
- The parenless two-pass fold does NOT generalise here — grouping requires Dijkstra's
  SHUNTING-YARD algorithm. The reliable route is three helpers: tokenize the string into
  number/operator/parenthesis string tokens, convert infix to postfix (Reverse Polish
  Notation) with an operator stack, then evaluate the postfix with a number stack —
  calculatorWithParens(s) = evalPostfix(toPostfix(tokenize(s))).`,
    ref: `export function tokenize(s: string): string[] {
  return s.replace(/\\s+/g, '').match(/\\d+|[-+*/()]/g) || []
}

export function precedence(op: string): number {
  return op === '*' || op === '/' ? 2 : 1
}

// Dijkstra's shunting-yard: infix token stream → Reverse Polish Notation. All operators
// are left-associative, so an incoming operator pops every stacked operator of GREATER-OR-
// EQUAL precedence (never past an open paren) before it is pushed.
export function toPostfix(tokens: string[]): string[] {
  const out: string[] = []
  const ops: string[] = []
  for (const t of tokens) {
    if (t === '(') ops.push(t)
    else if (t === ')') {
      while (ops.length && ops[ops.length - 1] !== '(') out.push(ops.pop()!)
      ops.pop() // discard the matching '('
    } else if (t.length === 1 && '+-*/'.includes(t)) {
      while (ops.length && ops[ops.length - 1] !== '(' && precedence(ops[ops.length - 1]) >= precedence(t)) out.push(ops.pop()!)
      ops.push(t)
    } else out.push(t)
  }
  while (ops.length) out.push(ops.pop()!)
  return out
}

export function evalPostfix(postfix: string[]): number {
  const st: number[] = []
  for (const t of postfix) {
    if (t.length === 1 && '+-*/'.includes(t)) {
      const b = st.pop()!
      const a = st.pop()!
      st.push(t === '+' ? a + b : t === '-' ? a - b : t === '*' ? a * b : Math.trunc(a / b))
    } else st.push(Number(t))
  }
  return st[0]
}

export function calculatorWithParens(expr: string): number {
  return evalPostfix(toPostfix(tokenize(expr)))
}
`,
    suite: `// HIDDEN adversarial suite for a NOVEL task (shunting-yard / parenthesised precedence) — calculatorWithParens.
// Run: npx tsx __audit__/calculatorWithParens.hidden.ts   (imports ../src/calculatorWithParens)
import { calculatorWithParens } from '../src/calculatorWithParens'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

check('parens override add-before-mul', calculatorWithParens('(3+2)*2') === 10)
check('parens on the right', calculatorWithParens('2*(3+4)') === 14)
check('two parenthesised groups', calculatorWithParens('(1+2)*(3+4)') === 21)
check('precedence still holds without parens', calculatorWithParens('3+2*2') === 7)
check('redundant nested parens', calculatorWithParens('((2+3))*2') === 10)
check('bare integer', calculatorWithParens('100') === 100)
check('deeply nested', calculatorWithParens('2*(3+4*(5-1))') === 38)
check('spaces ignored', calculatorWithParens('( 3 + 5 ) / 2') === 4)
check('division truncates toward zero after group', calculatorWithParens('(10)/3') === 3)
check('left-associative subtraction inside parens', calculatorWithParens('(7-2-1)') === 4)
check('parens change division grouping', calculatorWithParens('8/(2*2)') === 2)
check('same expr without parens differs', calculatorWithParens('8/2*2') === 8)
check('leading group then mul', calculatorWithParens('(2+3)*(4)') === 20)
check('nested subtraction goes through zero', calculatorWithParens('(2-(3+1))') === -2)
check('multi-digit inside group', calculatorWithParens('(12+8)/5') === 4)
check('chain of groups left-to-right', calculatorWithParens('(6/2)*(3-1)') === 6)
check('no parens mixed precedence', calculatorWithParens('2+3*4-6/2') === 11)
check('group forces early subtraction', calculatorWithParens('10-(2+3)') === 5)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`,
  },
  {
    id: 'coinChange',
    title: 'Fewest coins to make an amount (unbounded-supply DP)',
    modulePath: 'src/coinChange.ts',
    prompt: `Implement the minimum-coins problem in TypeScript at src/coinChange.ts. ${CONTRACT}

Export exactly:
  export function coinChange(coins: number[], amount: number): number

Semantics:
- Return the FEWEST number of coins needed to make exactly \`amount\`, where each coin
  denomination in \`coins\` is available in UNLIMITED supply. Return -1 if no combination of
  the given coins sums to amount.
- amount is a non-negative integer; coins are positive integers (in any order, possibly with
  denominations larger than amount, which are simply unusable).
- coinChange(coins, 0) is 0 for any coins (zero coins make zero). coinChange([], amount) is 0
  when amount is 0, else -1.
- Examples: coinChange([1,2,5], 11) -> 3 (5+5+1), coinChange([2], 3) -> -1,
  coinChange([1], 0) -> 0, coinChange([2,5,10], 27) -> 4 (10+10+5+2),
  coinChange([186,419,83,408], 6249) -> 20, coinChange([1,5,6,9], 11) -> 2 (5+6).
- The reliable route is a bottom-up dynamic program over amounts 0..amount: dp[0]=0 and every
  other dp entry starts at a sentinel meaning "unreachable" (amount+1 works — no answer can
  exceed amount coins); for each coin relax dp[a]=min(dp[a], dp[a-coin]+1) sweeping a upward so
  the coin can be reused. The answer is dp[amount], or -1 if it stayed at the sentinel. A greedy
  largest-coin-first approach is WRONG in general (e.g. coins [1,5,6,9], amount 11).`,
    ref: `export function initDp(amount: number): number[] {
  const dp = new Array(amount + 1).fill(amount + 1)
  dp[0] = 0
  return dp
}

// One relaxation pass for a single coin of UNBOUNDED supply. Sweeping the amount ASCENDING
// lets the same coin be reused any number of times. Pure — never mutates the input array.
export function relaxCoin(dp: number[], coin: number): number[] {
  const out = dp.slice()
  for (let a = coin; a < out.length; a++) out[a] = Math.min(out[a], out[a - coin] + 1)
  return out
}

export function coinChange(coins: number[], amount: number): number {
  let dp = initDp(amount)
  for (const c of coins) dp = relaxCoin(dp, c)
  return dp[amount] > amount ? -1 : dp[amount]
}
`,
    suite: `// HIDDEN adversarial suite for a NOVEL task (min-coins DP; greedy is provably wrong) — coinChange.
// Run: npx tsx __audit__/coinChange.hidden.ts   (imports ../src/coinChange)
import { coinChange } from '../src/coinChange'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

check('canonical 11 from 1,2,5', coinChange([1, 2, 5], 11) === 3)
check('impossible amount', coinChange([2], 3) === -1)
check('zero amount is zero coins', coinChange([1], 0) === 0)
check('empty coins nonzero amount', coinChange([], 7) === -1)
check('empty coins zero amount', coinChange([], 0) === 0)
check('exact single coin', coinChange([7], 7) === 1)
check('greedy trap prefers two coins', coinChange([1, 5, 6, 9], 11) === 2)
check('classic greedy-fails set', coinChange([1, 3, 4], 6) === 2)
check('all ones', coinChange([1], 5) === 5)
check('large mixed', coinChange([2, 5, 10], 27) === 4)
check('denomination larger than amount ignored', coinChange([5, 10], 3) === -1)
check('reuse same coin', coinChange([3], 9) === 3)
check('unordered coins', coinChange([25, 10, 5, 1], 30) === 2)
check('hard 6249', coinChange([186, 419, 83, 408], 6249) === 20)
check('prime amount', coinChange([2, 3], 7) === 3)
check('single ok exact', coinChange([2, 5], 10) === 2)
check('cannot make odd from evens', coinChange([2, 4], 7) === -1)
check('minimal for 6 from 1,3,4', coinChange([1, 3, 4], 6) === 2)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`,
  },
]
