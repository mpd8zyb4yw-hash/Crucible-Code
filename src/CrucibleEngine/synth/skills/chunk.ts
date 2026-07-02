// Verified Tier-1A primitive: split array into fixed-size chunks.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible — array chunking.
export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return []
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}
`

registerSkill({
  id: 'chunk',
  summary: 'Split an array into sub-arrays of at most size elements.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bchunk\b/i)) sc += 0.65
    if (s.has(/split.*into.*batch|batch.*size|batch.*array/i)) sc += 0.3
    if (s.has(/fixed[- ]?size.*group|group.*fixed[- ]?size/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/chunk.ts', content: IMPL }]
  },
})
