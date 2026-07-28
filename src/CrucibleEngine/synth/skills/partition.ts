// Verified Tier-1A primitive: partition array by predicate.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible — partition array by predicate.
export function partition<T>(arr: T[], pred: (x: T) => boolean): [T[], T[]] {
  const yes: T[] = [], no: T[] = []
  for (const x of arr) (pred(x) ? yes : no).push(x)
  return [yes, no]
}

/** Partition by a key function returning a string/number — groups items into a Map. */
export function partitionBy<T, K extends string | number>(arr: T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>()
  for (const x of arr) {
    const k = key(x)
    const g = m.get(k)
    if (g) g.push(x); else m.set(k, [x])
  }
  return m
}
`


registerSkill({
  id: 'partition',
  summary: 'Partition array into two halves by predicate; partitionBy groups into a Map.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bpartition\b/i)) sc += 0.75
    if (s.has(/split.*array.*pred|array.*two.*group/i)) sc += 0.3
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/module.ts', content: IMPL }]
  },
})
