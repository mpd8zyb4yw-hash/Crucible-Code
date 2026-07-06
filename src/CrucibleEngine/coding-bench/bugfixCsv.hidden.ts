// Hidden adversarial suite for bugfixCsv (frontier-SWE bug-fix task).
// Tests the agent never saw. The repaired code lives at ../src/csv.ts.

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

// Async IIFE (no top-level await — the frozen grading dir has no package.json so tsx
// emits CJS, which hard-crashes on top-level await before any check runs).
;(async () => {
  const { parseCsv } = await import(path.join(SRC, 'csv.js')).catch(
    () => import(path.join(SRC, 'csv.ts') as string),
  ) as { parseCsv: (input: string) => string[][] }

  // ── plain rows still work (don't regress the easy case) ───────────────────────
  check('plain rows', parseCsv('a,b,c\nd,e,f'), [['a', 'b', 'c'], ['d', 'e', 'f']])

  // ── quoted field with an embedded comma ───────────────────────────────────────
  check('embedded comma in quotes', parseCsv('a,"b,c",d'), [['a', 'b,c', 'd']])

  // ── escaped double-quote ("") unescapes to one " ──────────────────────────────
  check('escaped quotes', parseCsv('"she said ""hi"""'), [['she said "hi"']])

  // ── combined comma + escaped quote (the prompt's worked example) ───────────────
  check('comma + escaped quote row', parseCsv('a,"b,c","d""e"\nf,g,h'), [['a', 'b,c', 'd"e'], ['f', 'g', 'h']])

  // ── embedded newline inside a quoted field does NOT start a new row ────────────
  check('embedded newline in quotes', parseCsv('"line1\nline2",x'), [['line1\nline2', 'x']])

  // ── empty quoted field is a real empty-string field ───────────────────────────
  check('empty quoted field', parseCsv('a,"",c'), [['a', '', 'c']])

  // ── trailing newline does not add a phantom empty row ─────────────────────────
  check('trailing newline', parseCsv('a,b\n'), [['a', 'b']])

  // ── unquoted fields taken verbatim (no trimming) ──────────────────────────────
  check('no trimming of unquoted', parseCsv('a , b'), [['a ', ' b']])

  // ── CRLF line endings ─────────────────────────────────────────────────────────
  check('CRLF rows', parseCsv('a,b\r\nc,d'), [['a', 'b'], ['c', 'd']])

  console.log(`\n${passed + failed} checks — ${failed === 0 ? 'ALL PASS' : `${failed} FAILURE(s)`}`)
  if (failed > 0) process.exitCode = 1
})().catch((e) => { console.error(e); process.exitCode = 1 })
