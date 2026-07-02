import { parseIoExamples } from './src/CrucibleEngine/synth/proposers/examples'
import { deriveTests } from './src/CrucibleEngine/synth/derive'

function show(label: string, spec: string) {
  console.log('=== ' + label + ' ===')
  const parsed = parseIoExamples(spec)
  console.log('ENUM ex:', JSON.stringify(parsed?.examples))
  const d = deriveTests(spec, 'src/m.ts')
  if (!d) { console.log('ORACLE: NULL'); console.log(); return }
  const body = d.testFile.content
  const lhsMatches = [...body.matchAll(/const got_\d+: unknown = \((.*?)\)\n/g)].map(m => m[1])
  const rhsMatches = [...body.matchAll(/const exp_\d+: unknown = \((.*?)\)\n/g)].map(m => m[1])
  console.log('ORACLE lhs:', JSON.stringify(lhsMatches))
  console.log('ORACLE rhs:', JSON.stringify(rhsMatches))
  console.log()
}

// '==>' : examples.ts SEP matches '==' then RHS starts with '>...' which parseLiteral
//         will try to parse as a literal starting with '>' -> throws -> example skipped?
//         derive.ts SEP matches '==>' cleanly.
show('triple-eq-arrow', `
export function f(a: number): number
f(1) ==> 2
f(2) ==> 3
`)

// MIX: one line has '=>' inside a string (oracle drops it), others normal.
// Does the enumerator use the dropped line as a constraint the oracle never checks?
show('mixed-fatarrow-string', `
export function tag(s: string): string
tag('a') === 'a!'
tag('b') === 'b => c'
`)
