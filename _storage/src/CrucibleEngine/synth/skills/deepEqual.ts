// Verified Tier-1A primitive: deep structural equality.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible — deep structural equality.
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a as object).sort()
  const kb = Object.keys(b as object).sort()
  if (ka.length !== kb.length) return false
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false
    if (!deepEqual((a as any)[ka[i]], (b as any)[kb[i]])) return false
  }
  return true
}

/** Alias for deepEqual. */
export const isEqual = deepEqual
`

const SUITE = `
import { deepEqual, isEqual } from './src/module'
const ok = (b: boolean, msg: string) => { if (!b) { console.error('FAIL', msg); process.exit(1) } }
ok(deepEqual(1, 1), 'primitives equal')
ok(!deepEqual(1, 2), 'primitives not equal')
ok(deepEqual({ a: 1, b: [2, 3] }, { a: 1, b: [2, 3] }), 'nested objects')
ok(!deepEqual({ a: 1 }, { a: 2 }), 'nested mismatch')
ok(deepEqual([1,[2,3]], [1,[2,3]]), 'nested arrays')
ok(!deepEqual([1,2], [1,2,3]), 'array length mismatch')
ok(deepEqual(null, null), 'null equals null')
ok(!deepEqual(null, {}), 'null vs object')
ok(isEqual({ x: 1 }, { x: 1 }), 'alias works')
console.log('ALL PASS')
`

registerSkill({
  id: 'deepEqual',
  summary: 'Deep structural equality check (deepEqual / isEqual) for objects, arrays, and primitives.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bdeep.?equal\b|\bisEqual\b/i)) sc += 0.8
    if (s.has(/structural.?equal|equal.?deep|recursive.?equal/i)) sc += 0.5
    if (s.has(/deep.?compar|compare.*deep/i)) sc += 0.3
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    const p = s.modulePath ?? 'src/module.ts'
    return [{ path: p, content: IMPL }]
  },
  suite: SUITE,
})
