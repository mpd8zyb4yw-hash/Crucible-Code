import { parseIoExamples } from './src/CrucibleEngine/synth/proposers/examples'
import { deriveTests } from './src/CrucibleEngine/synth/derive'

function show(label: string, spec: string) {
  console.log('=== ' + label + ' ===')
  const parsed = parseIoExamples(spec)
  console.log('ENUM ex:', JSON.stringify(parsed?.examples))
  const d = deriveTests(spec, 'src/m.ts')
  if (!d) { console.log('ORACLE: NULL'); console.log(); return }
  // Extract the (lhs)/(exp) the oracle actually evaluates
  const body = d.testFile.content
  const lhsMatches = [...body.matchAll(/const got_\d+: unknown = \((.*?)\)\n/g)].map(m => m[1])
  const rhsMatches = [...body.matchAll(/const exp_\d+: unknown = \((.*?)\)\n/g)].map(m => m[1])
  console.log('ORACLE lhs:', JSON.stringify(lhsMatches))
  console.log('ORACLE rhs:', JSON.stringify(rhsMatches))
  console.log()
}

// multiple calls on one line
show('two-calls', `
export function add(a: number, b: number): number
add(1, 2) === add(2, 1)
`)

// output references another call to the fn
show('output-is-call', `
export function f(a: number): number
f(2) === f(1)
`)

// nested parens in args, comma inside string
show('comma-in-str', `
export function j(s: string): number
j('a,b,c') === 3
j('x') === 1
`)

// trailing comma changing arity
show('trailing-comma', `
export function p(a: number): number
p(5,) === 6
p(6,) === 7
`)

// arrow output with trailing punctuation stripping
show('arrow-out', `
export function chunk(a: number[], n: number): number[][]
chunk([1,2,3], 2) -> [[1,2],[3]]
`)

// '=>' inside a string in the output
show('fatarrow-in-out', `
export function code(s: string): string
code('x') === 'x => y'
`)
