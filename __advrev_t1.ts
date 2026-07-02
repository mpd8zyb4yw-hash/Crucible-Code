import { parseIoExamples } from './src/CrucibleEngine/synth/proposers/examples'

function show(label: string, spec: string) {
  console.log('=== ' + label + ' ===')
  try {
    const r = parseIoExamples(spec)
    console.log(JSON.stringify(r, (k, v) => v === undefined ? '<<undefined>>' : v, 1))
  } catch (e) {
    console.log('THREW:', String(e))
  }
  console.log()
}

// 1) 'is' inside data being matched by SEP
show('is-in-data', `
export function f(s: string): string
f('this is fine') === 'ok'
`)

// 2) '==' SEP in examples.ts but not derive.ts
show('double-eq-sep', `
export function f(a: number): number
f(1) == 2
f(2) == 3
`)

// 3) 'equals' keyword
show('equals-kw', `
export function g(a: number): number
g(5) equals 6
g(6) equals 7
`)

// 4) scientific notation / negatives
show('scinote', `
export function h(a: number): number
h(1e3) === 1000
h(-2) === -2
`)

// 5) string containing '->'
show('arrow-in-string', `
export function k(s: string): string
k('a->b') === 'a->b'
`)
