// Verified Tier-1A primitive: deep clone a plain object/array tree.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible — deep clone (plain objects, arrays, primitives).
export function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T
  if (Array.isArray(value)) return value.map(deepClone) as unknown as T
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(value as object)) {
    out[k] = deepClone((value as Record<string, unknown>)[k])
  }
  return out as T
}
`

registerSkill({
  id: 'deep-clone',
  summary: 'Recursively deep-clone a plain value (object, array, Date, primitive).',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/deep[- ]?clone/i)) sc += 0.7
    if (s.has(/\bdeepClone\b/)) sc += 0.3
    if (s.has(/deep[- ]?copy|clone.*deep/i)) sc += 0.5
    if (s.has(/structural.*copy|copy.*nested/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/deepClone.ts', content: IMPL }]
  },
})
