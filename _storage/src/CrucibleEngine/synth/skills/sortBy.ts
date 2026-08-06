// Verified Tier-1A primitive: sort array by key/comparator (sortBy / orderBy).
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible — sortBy / orderBy utilities.
export function sortBy<T>(arr: T[], key: keyof T | ((item: T) => unknown), dir: 'asc' | 'desc' = 'asc'): T[] {
  const get = typeof key === 'function' ? key : (item: T) => item[key]
  return [...arr].sort((a, b) => {
    const va = get(a), vb = get(b)
    if (va == null && vb == null) return 0
    if (va == null) return 1
    if (vb == null) return -1
    const cmp = va < vb ? -1 : va > vb ? 1 : 0
    return dir === 'desc' ? -cmp : cmp
  })
}

export interface SortSpec<T> { key: keyof T | ((item: T) => unknown); dir?: 'asc' | 'desc' }

/** Multi-key sort: orderBy(arr, [{ key: 'age', dir: 'desc' }, { key: 'name' }]) */
export function orderBy<T>(arr: T[], specs: SortSpec<T>[]): T[] {
  return [...arr].sort((a, b) => {
    for (const { key, dir = 'asc' } of specs) {
      const get = typeof key === 'function' ? key : (item: T) => item[key]
      const va = get(a), vb = get(b)
      if (va == null && vb == null) continue
      if (va == null) return 1
      if (vb == null) return -1
      const cmp = va < vb ? -1 : va > vb ? 1 : 0
      if (cmp !== 0) return dir === 'desc' ? -cmp : cmp
    }
    return 0
  })
}
`

const SUITE = `
import { sortBy, orderBy } from './src/module'
const ok = (b: boolean, msg: string) => { if (!b) { console.error('FAIL', msg); process.exit(1) } }
const arr = [{ name: 'b', age: 3 }, { name: 'a', age: 1 }, { name: 'c', age: 2 }]
const byName = sortBy(arr, 'name')
ok(byName[0].name === 'a' && byName[2].name === 'c', 'sort by name asc')
const byAgeDesc = sortBy(arr, 'age', 'desc')
ok(byAgeDesc[0].age === 3, 'sort by age desc')
const byFn = sortBy([3,1,2], x => x)
ok(byFn.join() === '1,2,3', 'sort by function')
const multi = orderBy([{a:1,b:2},{a:1,b:1},{a:2,b:3}], [{key:'a'},{key:'b',dir:'desc'}])
ok(multi[0].b === 2 && multi[1].b === 1, 'multi-key order')
ok(arr.length === 3, 'original not mutated')
console.log('ALL PASS')
`

registerSkill({
  id: 'sortBy',
  summary: 'Sort array by key or comparator function; multi-key orderBy.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bsortBy\b|\borderBy\b/i)) sc += 0.8
    if (s.has(/sort.*by.*key|order.*by.*field/i)) sc += 0.5
    if (s.has(/\bsort\b.*\barray\b.*\bkey\b|\bkey\b.*\bsort\b/i)) sc += 0.3
    // sum-by skill also exports sortBy — don't steal it
    if (s.has(/\bsumBy\b|\bminBy\b|\bmaxBy\b/i)) sc -= 2.0
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/module.ts', content: IMPL }]
  },
  suite: SUITE,
})
