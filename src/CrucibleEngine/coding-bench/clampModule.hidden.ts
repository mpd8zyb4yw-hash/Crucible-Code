// Hidden adversarial suite for clampModule (fuzz-family-matched generation task).
// Tests the agent NEVER saw. Imported as: npx tsx this-file from __audit__ dir.
// The produced code lives at ../src/clamp.ts; scaffold at ../src/types.ts.

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
  const { clampVolume } = await import(path.join(SRC, 'clamp.js')).catch(
    () => import(path.join(SRC, 'clamp.ts') as string),
  ) as { clampVolume: (value: number, min: number, max: number) => number }

  check('in-range value unchanged', clampVolume(5, 0, 10), 5)
  check('below min clamps to min', clampVolume(-3, 0, 10), 0)
  check('above max clamps to max', clampVolume(15, 0, 10), 10)
  check('exact lower boundary', clampVolume(0, 0, 10), 0)
  check('exact upper boundary', clampVolume(10, 0, 10), 10)
  check('negative range in-range', clampVolume(-5, -10, -1), -5)
  check('negative range below min', clampVolume(-20, -10, -1), -10)
  check('negative range above max', clampVolume(0, -10, -1), -1)
  check('fractional value in-range', clampVolume(0.5, 0, 1), 0.5)

  console.log(`\n${passed + failed} checks — ${failed === 0 ? 'ALL PASS' : `${failed} FAILURE(s)`}`)
  if (failed > 0) process.exitCode = 1
})().catch((e) => { console.error(e); process.exitCode = 1 })
