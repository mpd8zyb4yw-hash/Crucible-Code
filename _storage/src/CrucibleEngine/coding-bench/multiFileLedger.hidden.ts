// Hidden adversarial suite for multiFileLedger (frontier-SWE multi-file task).
// Tests the agent never saw. Produced code lives at ../src/ledger.ts and ../src/report.ts;
// scaffold at ../src/types.ts. Importing report.ts exercises the ledger coupling.

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
  const { Ledger } = await import(path.join(SRC, 'ledger.js')).catch(
    () => import(path.join(SRC, 'ledger.ts') as string),
  ) as { Ledger: new () => any }
  const { categoryTotals } = await import(path.join(SRC, 'report.js')).catch(
    () => import(path.join(SRC, 'report.ts') as string),
  ) as { categoryTotals: (ledger: any) => Record<string, number> }

  const ledger = new Ledger()
  ledger.add({ id: 't1', amount: 100, category: 'income' })
  ledger.add({ id: 't2', amount: -30, category: 'food' })
  ledger.add({ id: 't3', amount: -20, category: 'food' })
  ledger.add({ id: 't4', amount: 50, category: 'income' })

  // ── balance = sum of amounts ──────────────────────────────────────────────────
  check('balance', ledger.balance(), 100)

  // ── all() returns everything in insertion order ───────────────────────────────
  check('all() ids in order', ledger.all().map((t: any) => t.id), ['t1', 't2', 't3', 't4'])

  // ── all() must return a copy — mutating it must not corrupt the ledger ─────────
  const snapshot = ledger.all()
  snapshot.push({ id: 'evil', amount: 9999, category: 'hack' })
  check('all() is a defensive copy', ledger.all().length, 4)

  // ── duplicate id throws ───────────────────────────────────────────────────────
  let threw = false
  try { ledger.add({ id: 't1', amount: 1, category: 'dup' }) } catch { threw = true }
  check('duplicate id throws', threw, true)

  // ── categoryTotals (the report layer, which imports Ledger) ────────────────────
  check('categoryTotals', categoryTotals(ledger), { income: 150, food: -50 })

  console.log(`\n${passed + failed} checks — ${failed === 0 ? 'ALL PASS' : `${failed} FAILURE(s)`}`)
  if (failed > 0) process.exitCode = 1
})().catch((e) => { console.error(e); process.exitCode = 1 })
