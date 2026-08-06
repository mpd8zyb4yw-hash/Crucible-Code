// Hidden adversarial suite for usernameModule (fuzz-family-matched generation task,
// `validator` family — arity-1, `is[A-Z]*` name convention).
// Tests the agent NEVER saw. Imported as: npx tsx this-file from __audit__ dir.
// The produced code lives at ../src/username.ts; no scaffold (standalone task).

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
  const { isValidUsername } = await import(path.join(SRC, 'username.js')).catch(
    () => import(path.join(SRC, 'username.ts') as string),
  ) as { isValidUsername: (name: string) => boolean }

  check('valid: letters only, 3 chars', isValidUsername('abc'), true)
  check('valid: letters/digits/underscore mixed', isValidUsername('Alice_99'), true)
  check('valid: exactly 20 chars', isValidUsername('a'.repeat(20)), true)
  check('valid: single letter then digits', isValidUsername('a12'), true)
  check('invalid: leading digit', isValidUsername('9abc'), false)
  check('invalid: leading underscore', isValidUsername('_abc'), false)
  check('invalid: too short (2 chars)', isValidUsername('ab'), false)
  check('invalid: too long (21 chars)', isValidUsername('a'.repeat(21)), false)
  check('invalid: contains hyphen', isValidUsername('ab-cd'), false)
  check('invalid: contains space', isValidUsername('ab cd'), false)
  check('invalid: empty string', isValidUsername(''), false)

  console.log(`\n${passed + failed} checks — ${failed === 0 ? 'ALL PASS' : `${failed} FAILURE(s)`}`)
  if (failed > 0) process.exitCode = 1
})().catch((e) => { console.error(e); process.exitCode = 1 })
