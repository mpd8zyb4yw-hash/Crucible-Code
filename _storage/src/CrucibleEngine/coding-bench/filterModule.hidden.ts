// Hidden adversarial suite for filterModule (Phase C guard).
// Tests the agent NEVER saw. Imported as: npx tsx this-file from __audit__ dir.
// The produced code lives at ../src/filter.ts; scaffold at ../src/types.ts and ../src/users.ts.

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

// Wrapped in an async IIFE, driven with .catch() (NOT top-level await): the frozen
// snapshot dir this file gets copied into for grading has no package.json up its
// directory tree, so esbuild/tsx defaults to CJS output there — which doesn't support
// top-level await and hard-crashes the whole hidden suite with a TransformError before
// a single check runs. `await` must not appear at module top level anywhere in this file.
;(async () => {
  // Dynamic import so a missing file gives a clear error (not a silent crash).
  const { filterUsers } = await import(path.join(SRC, 'filter.js')).catch(
    () => import(path.join(SRC, 'filter.ts') as string),
  ) as { filterUsers: (users: any[], opts: any) => any[] }

  const { getAllUsers } = await import(path.join(SRC, 'users.js')).catch(
    () => import(path.join(SRC, 'users.ts') as string),
  ) as { getAllUsers: () => any[] }

  const users = getAllUsers()  // [Alice/active, Bob/inactive, Charlie/active, Diana/active, Eve/inactive]

  // ── Empty opts returns all users unchanged ────────────────────────────────────
  check('empty opts — returns all 5', filterUsers(users, {}).length, 5)

  // ── active=true ───────────────────────────────────────────────────────────────
  const actives = filterUsers(users, { active: true })
  check('active=true — count', actives.length, 3)
  check('active=true — all active', actives.every((u: any) => u.active), true)

  // ── active=false ──────────────────────────────────────────────────────────────
  const inactives = filterUsers(users, { active: false })
  check('active=false — count', inactives.length, 2)
  check('active=false — none active', inactives.every((u: any) => !u.active), true)

  // ── query matches name (case-insensitive) ─────────────────────────────────────
  const aliSearch = filterUsers(users, { query: 'ali' })
  check('query=ali — finds Alice', aliSearch.length, 1)
  check('query=ali — correct user', aliSearch[0]?.name, 'Alice')

  // ── query matches email ───────────────────────────────────────────────────────
  const corpSearch = filterUsers(users, { query: 'corp.com' })
  check('query=corp.com — finds Diana', corpSearch.length, 1)
  check('query=corp.com — correct user', corpSearch[0]?.name, 'Diana')

  // ── query is case-insensitive ─────────────────────────────────────────────────
  const upperSearch = filterUsers(users, { query: 'CHARLIE' })
  check('query=CHARLIE (upper) — finds Charlie', upperSearch.length, 1)

  // ── both filters compose ──────────────────────────────────────────────────────
  const both = filterUsers(users, { active: true, query: 'example.com' })
  check('active=true + query=example.com — count', both.length, 2)
  check('active=true + query=example.com — all active', both.every((u: any) => u.active), true)
  check('active=true + query=example.com — names', both.map((u: any) => u.name).sort(), ['Alice', 'Charlie'])

  // ── does not mutate input ─────────────────────────────────────────────────────
  const snapshot = JSON.parse(JSON.stringify(users))
  filterUsers(users, { active: false, query: 'eve' })
  check('no input mutation', users, snapshot)

  // ── query with no match returns empty ─────────────────────────────────────────
  check('no-match query', filterUsers(users, { query: 'zzznomatch' }).length, 0)

  // ── result ──────────────────────────────────────────────────────────────────
  console.log(`\n${passed + failed} checks — ${failed === 0 ? 'ALL PASS' : `${failed} FAILURE(s)`}`)
  if (failed > 0) process.exitCode = 1
})().catch((e) => { console.error(e); process.exitCode = 1 })
