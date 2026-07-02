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

const SUITE = `
import { partition, partitionBy } from './src/module'
const ok = (b: boolean, msg: string) => { if (!b) { console.error('FAIL', msg); process.exit(1) } }
const [evens, odds] = partition([1,2,3,4,5], x => x % 2 === 0)
ok(evens.join() === '2,4', 'evens')
ok(odds.join() === '1,3,5', 'odds')
const [pass, fail] = partition([], () => true)
ok(pass.length === 0 && fail.length === 0, 'empty')
const m = partitionBy([{t:'a',v:1},{t:'b',v:2},{t:'a',v:3}], x => x.t)
ok(m.get('a')!.length === 2 && m.get('b')!.length === 1, 'partitionBy')
console.log('ALL PASS')
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
  suite: SUITE,
})
