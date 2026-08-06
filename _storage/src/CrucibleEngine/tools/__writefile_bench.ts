// Bench for write_file's content gate and its result string. Run:
//   npx tsx src/CrucibleEngine/tools/__writefile_bench.ts
//
// THE LIVE CASE (2026-08-04, agent mode, `on-device FM (desktop)` driver). Brief: "Count how
// many lines are in notes.txt in ~/Desktop/agentprobe and write that number into count.txt".
// notes.txt holds 3 lines. read_file returned them correctly. Then:
//
//   write_file { path: "~/Desktop/agentprobe/count.txt",
//                content: "\"The number of lines in notes.txt is: $(cat ~/…/notes.txt | wc -l)\"" }
//   → (ok) Wrote 84 chars to /Users/justin/Desktop/agentprobe/count.txt
//   FINAL_ANSWER: The number of lines in notes.txt is 84.
//
// TWO separate defects, both in this tool, and they compound:
//
//  1. The model wrote a SHELL COMMAND SUBSTITUTION and expected something to run it. Nothing
//     does — write_file writes bytes — so count.txt got 84 bytes of unexecuted shell instead of
//     "3". A file whose whole content is a promise to compute a value is not a written file,
//     and that is mechanically detectable BEFORE the bytes land.
//
//  2. "Wrote 84 chars" put a bare, task-irrelevant integer into the model's context at exactly
//     the moment it was looking for a count — and it answered 84. The char count serves no
//     downstream consumer (one producer, no parsers, grepped 2026-08-04); the path does.
//
// Both directions are pinned. A gate that only gets tested on what it should REJECT is the gate
// that refuses to write a shell script.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { registry } from './registry'

let pass = 0, fail = 0
const failures: string[] = []
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; return }
  fail++
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cru-writefile-'))
const ctx: any = { projectPath: dir, allowMutation: true }
let seq = 0
const write = async (name: string, content: string) =>
  await registry.exec({ id: `w${++seq}`, name: 'write_file', args: { path: path.join(dir, name), content } }, ctx) as any

// ── 1. THE LIVE FAILURE: unexecuted shell substitution never reaches the disk ──
console.log('\n== a promise to compute is not a written value ==')

const LIVE = '"The number of lines in notes.txt is: $(cat ~/Desktop/agentprobe/notes.txt | wc -l)"'
const r1 = await write('count.txt', LIVE)
check('the live content is REJECTED', r1.ok === false, JSON.stringify(r1.output).slice(0, 160))
check('the bad bytes never landed', !fs.existsSync(path.join(dir, 'count.txt')),
  'the file was written anyway — a rejected call must not mutate the disk')
check('the rejection tells the model what to do instead',
  /compute|literal|actual value/i.test(String(r1.output)), JSON.stringify(r1.output))

const MORE_REJECTS: Array<[string, string]> = [
  ['total.txt', 'Total: $(wc -l < data.csv)'],
  ['out.json', '{"count": $(jq length data.json)}'],
  ['report.csv', 'name,count\nnotes,$(wc -l notes.txt)'],
  ['n.txt', '`wc -l < notes.txt`'],
]
for (const [name, content] of MORE_REJECTS) {
  const r = await write(name, content)
  check(`rejected: ${name} ← ${content.slice(0, 34)}`, r.ok === false, `WROTE IT: ${r.output}`)
}

// ── 2. THE FALSE-REJECT DIRECTION ─────────────────────────────────────────────
// This syntax is ordinary — and correct — in a script, in docs, and in code. Refusing to
// write a shell script would be a far worse bug than the one above.
console.log('\n== code, scripts and docs keep their $( ) ==')

const MUST_WRITE: Array<[string, string]> = [
  ['deploy.sh', '#!/bin/bash\nCOUNT=$(wc -l < notes.txt)\necho "$COUNT"\n'],
  ['build.zsh', 'export SHA=$(git rev-parse HEAD)\n'],
  ['Makefile', 'VERSION := $(shell git describe)\nall:\n\t@echo $(VERSION)\n'],
  ['README.md', 'Run `count=$(wc -l < notes.txt)` to count the lines.\n'],
  ['ci.yml', 'jobs:\n  build:\n    steps:\n      - run: echo $(date)\n'],
  // jQuery is $( — a .js/.ts gate that flagged it would break every script this agent writes.
  ['app.js', '$(document).ready(function () { console.log("hi") })\n'],
  ['calc.ts', 'const label = `count: ${n}`\nexport default label\n'],
  // The ACTUAL correct answer to the live brief.
  ['good.txt', '3'],
  ['prose.txt', 'The number of lines in notes.txt is 3.\n'],
  // A dollar sign that opens nothing is not a substitution.
  ['price.txt', 'Total cost: $(approximately) 40 dollars — see invoice\n'],
]
for (const [name, content] of MUST_WRITE) {
  const r = await write(name, content)
  check(`written: ${name}`, r.ok === true, `REFUSED: ${r.output}`)
  if (r.ok) check(`  …bytes are verbatim: ${name}`,
    fs.readFileSync(path.join(dir, name), 'utf-8') === content, 'content was altered on the way in')
}

// ── 3. THE RESULT STRING CARRIES NO STRAY INTEGER ─────────────────────────────
// "Wrote 84 chars" is the number the model reported as the line count.
console.log('\n== the success message cannot be mistaken for task data ==')

const r2 = await write('ok.txt', 'hello world')
check('write succeeds', r2.ok === true, r2.output)
// The property is "reports no COUNT", not "contains no digit" — a real path is full of digits.
check('the success message reports no size/count',
  !/\b\d+\s*(?:chars?|characters?|bytes?|lines?)\b/i.test(String(r2.output)),
  `still offers a number to misread: ${JSON.stringify(r2.output)}`)
check('the path is still reported', String(r2.output).includes('ok.txt'), JSON.stringify(r2.output))

// ── 4. TOTALITY ───────────────────────────────────────────────────────────────
console.log('\n== the gate is total ==')
for (const [name, content] of [['empty.txt', ''], ['dollar.txt', '$'], ['open.txt', '$('], ['tick.txt', '`']] as Array<[string, string]>) {
  let ok = false, detail = ''
  try { const r = await write(name, content); ok = typeof r?.ok === 'boolean' }
  catch (e: any) { detail = `threw: ${e?.message}` }
  check(`handles ${JSON.stringify(content)}`, ok, detail)
}

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n${'─'.repeat(62)}`)
console.log(`write-file bench: ${pass}/${pass + fail} passed`)
if (failures.length) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log(`  ✗ ${f}`)
}
process.exit(fail === 0 ? 0 : 1)
