// Verified Tier-1A primitive: group array elements by a key function.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible — groupBy utility.
export function groupBy<T>(
  arr: T[],
  key: (item: T) => string | number,
): Record<string, T[]> {
  const out: Record<string, T[]> = {}
  for (const item of arr) {
    const k = String(key(item))
    if (!out[k]) out[k] = []
    out[k].push(item)
  }
  return out
}
`

registerSkill({
  id: 'group-by',
  summary: 'Group array elements into a Record by a key function.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bgroup[- ]?by\b/i)) sc += 0.7
    if (s.has(/\bgroupBy\b/)) sc += 0.3
    if (s.has(/bucket.*by|partition.*by.*key/i)) sc += 0.2
    if (s.has(/group.*array.*key|key.*function.*group/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/groupBy.ts', content: IMPL }]
  },
})
