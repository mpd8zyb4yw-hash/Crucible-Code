// Hidden adversarial suite for tagSetModule (fuzz-family-matched generation task —
// exercises the `set-op-union` AND `set-op-intersect` families in one task, arity-2).
// Tests the agent NEVER saw. Imported as: npx tsx this-file from __audit__ dir.
// The produced code lives at ../src/tags.ts; scaffold at ../src/types.ts.

import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'src')

let passed = 0; let failed = 0
function check(desc: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`  ${ok ? 'PASS' : 'FAIL'} — ${desc}`)
  if (!ok) console.log(`         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`)
  ok ? passed++ : failed++
}
// Order is unspecified for set-ops (per the task's rules), so compare as sorted sets,
// not exact array equality.
function checkSet(desc: string, got: string[], want: string[]) {
  const norm = (xs: string[]) => JSON.stringify([...new Set(xs)].sort())
  const ok = Array.isArray(got) && norm(got) === norm(want) && got.length === new Set(got).size
  console.log(`  ${ok ? 'PASS' : 'FAIL'} — ${desc}`)
  if (!ok) console.log(`         got  ${JSON.stringify(got)}\n         want (as set) ${JSON.stringify(want)}`)
  ok ? passed++ : failed++
}

;(async () => {
  const { unionTags, intersectTags } = await import(path.join(SRC, 'tags.js')).catch(
    () => import(path.join(SRC, 'tags.ts') as string),
  ) as { unionTags: (a: string[], b: string[]) => string[]; intersectTags: (a: string[], b: string[]) => string[] }

  checkSet('union: disjoint sets', unionTags(['a', 'b'], ['c']), ['a', 'b', 'c'])
  checkSet('union: overlapping sets dedupe', unionTags(['a', 'b'], ['b', 'c']), ['a', 'b', 'c'])
  checkSet('union: duplicates within one side dedupe', unionTags(['a', 'a'], []), ['a'])
  checkSet('union: both empty', unionTags([], []), [])
  {
    const a = ['x', 'y']; const snapshotA = [...a]
    const b = ['y', 'z']; const snapshotB = [...b]
    unionTags(a, b)
    check('union: does not mutate either input', [a, b], [snapshotA, snapshotB])
  }

  checkSet('intersect: overlapping sets', intersectTags(['a', 'b', 'c'], ['b', 'c', 'd']), ['b', 'c'])
  checkSet('intersect: no overlap', intersectTags(['a', 'b'], ['c', 'd']), [])
  checkSet('intersect: either side empty', intersectTags(['a', 'b'], []), [])
  checkSet('intersect: duplicates within a side collapse', intersectTags(['a', 'a', 'b'], ['a']), ['a'])
  {
    const a = ['x', 'y']; const snapshotA = [...a]
    const b = ['y', 'z']; const snapshotB = [...b]
    intersectTags(a, b)
    check('intersect: does not mutate either input', [a, b], [snapshotA, snapshotB])
  }

  console.log(`\n${passed + failed} checks — ${failed === 0 ? 'ALL PASS' : `${failed} FAILURE(s)`}`)
  if (failed > 0) process.exitCode = 1
})().catch((e) => { console.error(e); process.exitCode = 1 })
