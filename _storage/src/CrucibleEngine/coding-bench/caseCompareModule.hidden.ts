// Hidden adversarial suite for caseCompareModule (fuzz-family-matched generation task,
// `comparator` family — arity-2, `compare*` name convention, string-typed params).
// Tests the agent NEVER saw. Imported as: npx tsx this-file from __audit__ dir.
// The produced code lives at ../src/caseCompare.ts; no scaffold (standalone task).

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
  const { compareCaseInsensitive } = await import(path.join(SRC, 'caseCompare.js')).catch(
    () => import(path.join(SRC, 'caseCompare.ts') as string),
  ) as { compareCaseInsensitive: (a: string, b: string) => number }

  check('equal case-insensitive: "abc" vs "ABC"', compareCaseInsensitive('abc', 'ABC'), 0)
  check('equal same case', compareCaseInsensitive('foo', 'foo'), 0)
  check('"Apple" vs "banana" — a before b', compareCaseInsensitive('Apple', 'banana') < 0, true)
  check('"Banana" vs "apple" — b after a (case-insensitive)', compareCaseInsensitive('Banana', 'apple') > 0, true)
  check('antisymmetric sign flip', Math.sign(compareCaseInsensitive('cat', 'DOG')) === -Math.sign(compareCaseInsensitive('DOG', 'cat')), true)
  check('returns a number', typeof compareCaseInsensitive('x', 'y'), 'number')

  console.log(`\n${passed + failed} checks — ${failed === 0 ? 'ALL PASS' : `${failed} FAILURE(s)`}`)
  if (failed > 0) process.exitCode = 1
})().catch((e) => { console.error(e); process.exitCode = 1 })
