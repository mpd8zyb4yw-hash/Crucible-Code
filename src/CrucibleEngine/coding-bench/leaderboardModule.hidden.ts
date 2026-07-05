// Hidden adversarial suite for leaderboardModule (fuzz-family-matched generation task).
// Tests the agent NEVER saw. Imported as: npx tsx this-file from __audit__ dir.
// The produced code lives at ../src/leaderboard.ts; scaffold at ../src/types.ts.

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

;(async () => {
  const { sortScoresAscending } = await import(path.join(SRC, 'leaderboard.js')).catch(
    () => import(path.join(SRC, 'leaderboard.ts') as string),
  ) as { sortScoresAscending: (scores: number[]) => number[] }

  check('mixed scores sorted ascending', sortScoresAscending([42, 7, 100, 7, -3]), [-3, 7, 7, 42, 100])
  check('already sorted', sortScoresAscending([1, 2, 3]), [1, 2, 3])
  check('reverse sorted', sortScoresAscending([3, 2, 1]), [1, 2, 3])
  check('single element', sortScoresAscending([9]), [9])
  check('empty array', sortScoresAscending([]), [])
  check('all duplicates', sortScoresAscending([5, 5, 5]), [5, 5, 5])
  check('negatives and zero', sortScoresAscending([0, -1, 1, -2, 2]), [-2, -1, 0, 1, 2])

  const input = [3, 1, 2]
  const snapshot = [...input]
  sortScoresAscending(input)
  check('input not mutated', input, snapshot)

  console.log(`\n${passed + failed} checks — ${failed === 0 ? 'ALL PASS' : `${failed} FAILURE(s)`}`)
  if (failed > 0) process.exitCode = 1
})().catch((e) => { console.error(e); process.exitCode = 1 })
