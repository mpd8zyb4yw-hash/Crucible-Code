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

// derive.ts SEP includes 'returns'/'gives'. examples.ts anchors SEP after the call.
// If a STRING ARG contains '=>' derive splits there. What if arg contains 'returns'?
// examples SEP is anchored after call.end so safe; derive splits on whole-line SEP.
show('returns-in-arg', `
export function f(s: string): number
f('it returns nothing') === 5
`)

// '=>' inside the ARGS (not output). examples: matchParen scans inside string ok.
// derive: SEP applied to whole trimmed line splits on the '=>' inside args -> mis-split!
show('fatarrow-in-arg', `
export function g(s: string): number
g('a => b') === 6
g('xy') === 2
`)

// '->' inside args string
show('thinarrow-in-arg', `
export function h(s: string): number
h('a -> b') === 6
`)
