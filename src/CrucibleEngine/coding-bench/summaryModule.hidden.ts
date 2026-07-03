// Hidden adversarial suite for summaryModule (Phase C guard, generation-stressing task #3).
// Tests the agent NEVER saw. Imported as: npx tsx this-file from __audit__ dir.
// The produced code lives at ../src/summary.ts; scaffold at ../src/types.ts and ../src/transactions.ts.

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

// Wrapped in an async IIFE, driven with .catch() (NOT top-level await) — see filterModule.hidden.ts
// for why: the frozen snapshot dir has no package.json up its directory tree, so esbuild/tsx
// defaults to CJS there, which doesn't support top-level await.
;(async () => {
  const { summarizeByAccount } = await import(path.join(SRC, 'summary.js')).catch(
    () => import(path.join(SRC, 'summary.ts') as string),
  ) as { summarizeByAccount: (txns: any[]) => Record<string, { credits: number; debits: number; balance: number }> }

  const { getAllTransactions } = await import(path.join(SRC, 'transactions.js')).catch(
    () => import(path.join(SRC, 'transactions.ts') as string),
  ) as { getAllTransactions: () => any[] }

  const txns = getAllTransactions()
  // acct-A: credit 100 (1), debit 30 (2), debit 20 (4)  → credits=100 debits=50 balance=50
  // acct-B: credit 50 (3), debit 50 (5)                 → credits=50  debits=50 balance=0
  // acct-C: credit 75 (6)                               → credits=75  debits=0  balance=75
  const summary = summarizeByAccount(txns)

  check('exactly 3 accounts present', Object.keys(summary).sort(), ['acct-A', 'acct-B', 'acct-C'])

  check('acct-A credits', summary['acct-A']?.credits, 100)
  check('acct-A debits', summary['acct-A']?.debits, 50)
  check('acct-A balance', summary['acct-A']?.balance, 50)

  check('acct-B credits', summary['acct-B']?.credits, 50)
  check('acct-B debits', summary['acct-B']?.debits, 50)
  check('acct-B balance', summary['acct-B']?.balance, 0)

  check('acct-C credits (only credit txns)', summary['acct-C']?.credits, 75)
  check('acct-C debits — 0 for missing type, not omitted', summary['acct-C']?.debits, 0)
  check('acct-C balance', summary['acct-C']?.balance, 75)

  check('no phantom account', summary['acct-D'], undefined)

  check('empty input → empty object', summarizeByAccount([]), {})

  const single = summarizeByAccount([{ id: 99, accountId: 'solo', amount: 10, type: 'debit' }])
  check('single debit-only account', single, { solo: { credits: 0, debits: 10, balance: -10 } })

  const snapshot = JSON.parse(JSON.stringify(txns))
  summarizeByAccount(txns)
  check('no input mutation', txns, snapshot)

  console.log(`\n${passed + failed} checks — ${failed === 0 ? 'ALL PASS' : `${failed} FAILURE(s)`}`)
  if (failed > 0) process.exitCode = 1
})().catch((e) => { console.error(e); process.exitCode = 1 })
