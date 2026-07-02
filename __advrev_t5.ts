import { parseIoExamples, parseLiteral } from './src/CrucibleEngine/synth/proposers/examples'
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

// hex parse: examples.ts parseNumber accepts 0x; but tagOf/JSON; does derive (JS) agree? both 255
show('hex', `
export function f(a: number): number
f(0xff) === 255
f(0x10) === 16
`)

// unbalanced bracket inside a string arg -> matchParen treats ] as depth-- though no [ open
show('unbalanced-bracket-in-str', `
export function g(s: string): number
g('a]b') === 3
g('cd') === 2
`)

// brace in string in args
show('brace-in-str', `
export function h(s: string): number
h('a}b{c') === 5
h('z') === 1
`)

// '-' as separator token vs minus: examples has '->' and bare data
show('dash-arrow-vs-minus', `
export function k(a: number): number
k(5) -> -5
k(3) -> -3
`)

// object output with key 'is' (word boundary inside object literal text)
show('obj-key-is', `
export function m(a: number): number
m(1) === 1
m(2) === 2
`)

// Direct parseLiteral sanity on tricky values
console.log('parseLiteral 0xff =', parseLiteral('0xff'))
console.log('parseLiteral 1e3 =', parseLiteral('1e3'))
console.log('parseLiteral .5 =', parseLiteral('.5'))
console.log('parseLiteral -0 =', parseLiteral('-0'), 'Object.is(-0):', Object.is(parseLiteral('-0'), -0))
try { console.log('parseLiteral 1_000 =', parseLiteral('1_000')) } catch(e){ console.log('1_000 throws:', String(e).slice(0,40)) }
try { console.log('parseLiteral 08 =', parseLiteral('08')) } catch(e){ console.log('08 throws') }
