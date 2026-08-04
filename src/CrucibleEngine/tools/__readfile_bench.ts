// Bench for read_file's line accounting. Run:
//   npx tsx src/CrucibleEngine/tools/__readfile_bench.ts
//
// THE LIVE CASE (2026-08-04). Asked to count the lines in a 3-line notes.txt and write the
// count into count.txt, the agent wrote "4". It was not miscounting: `split('\n')` on a
// newline-terminated file yields a phantom trailing element, so read_file showed it
// "1 alpha / 2 bravo / 3 charlie / 4 " and reported totalLines: 4. The model read our own
// listing and answered from it correctly. A tool that misreports its content corrupts every
// downstream inference, which is the expensive direction.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { registry } from './registry'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'OK ' : 'XX '} ${name}${ok ? '' : ` — ${detail}`}`)
  ok ? pass++ : fail++
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cru-readfile-'))
const ctx: any = { projectPath: dir, allowMutation: true }
let seq = 0
const write = (name: string, body: string) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p }
const read = async (p: string) =>
  await registry.exec({ id: `t${++seq}`, name: 'read_file', args: { path: p } }, ctx) as any

const trailing = write('trailing.txt', 'alpha\nbravo\ncharlie\n')
const r1 = await read(trailing)
check('a newline-terminated file reports its REAL line count',
  r1.meta?.totalLines === 3, `totalLines=${r1.meta?.totalLines}`)
check('the listing has no phantom numbered empty last line',
  !/\n4\t\s*$/.test(r1.output) && r1.output.trim().endsWith('charlie'), JSON.stringify(r1.output))

const noTrailing = write('notrailing.txt', 'alpha\nbravo\ncharlie')
const r2 = await read(noTrailing)
check('a file with NO trailing newline is unchanged (still 3)',
  r2.meta?.totalLines === 3, `totalLines=${r2.meta?.totalLines}`)

const blankInside = write('blanks.txt', 'alpha\n\nbravo\n')
const r3 = await read(blankInside)
check('a genuine blank line INSIDE the file is preserved',
  r3.meta?.totalLines === 3 && /\n2\t\n/.test(r3.output + '\n'), `totalLines=${r3.meta?.totalLines}`)

const trailingBlank = write('twoblank.txt', 'alpha\n\n')
const r4 = await read(trailingBlank)
check('only ONE terminator empty is dropped, a real trailing blank line survives',
  r4.meta?.totalLines === 2, `totalLines=${r4.meta?.totalLines}`)

const empty = write('empty.txt', '')
const r5 = await read(empty)
check('an empty file does not underflow to 0 lines or crash',
  r5.ok === true && r5.meta?.totalLines === 1, JSON.stringify(r5).slice(0, 120))

const single = write('single.txt', 'only\n')
const r6 = await read(single)
check('a one-line file reports 1', r6.meta?.totalLines === 1, `totalLines=${r6.meta?.totalLines}`)

// ── The count the tool already knows must reach the MODEL ────────────────────
//
// MEASURED LIVE (2026-08-04, Mission Control, after the phantom-line fix above landed).
// Brief: "Read notes.txt in ~/Desktop/agentprobe and tell me exactly how many lines it has".
// read_file returned the correct 3-line listing — visible in the run surface as
// "1 alpha 2 beta 3 gamma" — and the answer card read:
//
//     The file notes.txt located in ~/Desktop/agentprobe has 4 lines.
//
// `meta.totalLines` was 3 and correct. But `meta` never leaves the tool layer: the executor
// hands the model `(ok) <output>`, and `output` was the bare numbered listing. So the one fact
// the tool had computed exactly was withheld, and a weak head was asked to re-derive it by
// counting — which it gets wrong. Deriving what we already know is the expensive direction:
// state it.
console.log('')
const r7 = await read(trailing)
check('the output STATES the line count, not just the listing',
  /\b3 lines\b/.test(r7.output), JSON.stringify(r7.output.slice(0, 90)))
check('the stated count agrees with meta.totalLines',
  new RegExp(`\\b${r7.meta?.totalLines} lines\\b`).test(r7.output), JSON.stringify(r7.output.slice(0, 90)))
check('the numbered listing is still intact underneath',
  /\n1\talpha\n/.test('\n' + r7.output) && r7.output.trim().endsWith('charlie'), JSON.stringify(r7.output))

const r8 = await read(single)
check('one line is "1 line", not "1 lines"',
  /\b1 line\b/.test(r8.output) && !/\b1 lines\b/.test(r8.output), JSON.stringify(r8.output))

// A partial view must say so, or "10 lines" next to a 200-line listing is a new wrong fact.
const big = write('big.txt', Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')
const r9 = await registry.exec({ id: 'big', name: 'read_file', args: { path: big, offset: 5, limit: 3 } }, ctx) as any
check('a partial read still reports the FILE total', /\b40 lines\b/.test(r9.output), JSON.stringify(r9.output.slice(0, 100)))
check('a partial read says which range it showed', /\b5\b[^\n]*\b7\b/.test(r9.output.split('\n')[0]), JSON.stringify(r9.output.split('\n')[0]))
check('a partial read returns only the requested slice',
  (r9.output.match(/^\d+\t/gm) ?? []).length === 3, JSON.stringify(r9.output))

const r10 = await read(empty)
check('an empty file does not claim lines it does not have',
  /\b(0|1) lines?\b/.test(r10.output) || r10.output.trim() === '', JSON.stringify(r10.output))

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\nTOTAL: ${pass}/${pass + fail}`)
if (fail) process.exit(1)
