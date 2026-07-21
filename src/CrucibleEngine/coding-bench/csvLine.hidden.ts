// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.
// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — csvLine.
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
throws('newline in input throws', () => parseCsvLine('a\nb'))

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
