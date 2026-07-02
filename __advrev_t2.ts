import { parseIoExamples } from './src/CrucibleEngine/synth/proposers/examples'
import { deriveTests } from './src/CrucibleEngine/synth/derive'

function show(label: string, spec: string) {
  console.log('=== ' + label + ' ===')
  const parsed = parseIoExamples(spec)
  console.log('ENUMERATOR examples:', JSON.stringify(parsed?.examples))
  const d = deriveTests(spec, 'src/m.ts')
  console.log('ORACLE derived test count:', d?.count ?? 'NULL (no test!)')
  if (d) console.log('ORACLE test body:\n', d.testFile.content.split('let failures = 0')[1])
  console.log()
}

// Separators that examples.ts accepts but derive.ts does NOT: '==', 'equals', 'is'
show('double-eq', `
export function f(a: number): number
f(1) == 999
f(2) == 999
`)

show('equals-kw', `
export function g(a: number): number
g(5) equals 999
g(6) equals 999
`)
