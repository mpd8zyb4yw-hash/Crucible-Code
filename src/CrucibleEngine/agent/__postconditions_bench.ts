// Hermetic bench for agent post-conditions. Real filesystem, temp dirs, no model.
//
// Case 2 is the measured failure: the agent said "successfully read and added" while total.txt
// did not exist. The bench asserts that this is now a FAILED verification, not a pass.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { extractPostconditions, verifyGoal, correctionFor } from './postconditions'

let pass = 0, fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

const D = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-post-'))
const w = (f: string, c: string) => { fs.writeFileSync(path.join(D, f), c); return path.join(D, f) }

// ── 1. Create-a-file goal ────────────────────────────────────────────────────────────
const g1 = `Create a file called notes.md in the folder ${D} containing exactly the line: Crucible agent test.`
let r = verifyGoal(g1)
check('missing file fails, and is not "unverified"', !r.verified && !r.unverified && r.failed.length > 0, JSON.stringify(r))
check('the failure names the file', r.failed.some(f => f.includes('notes.md')), JSON.stringify(r.failed))
w('notes.md', 'wrong content entirely')
r = verifyGoal(g1)
check('file present but wrong content still fails', !r.verified && r.failed.some(f => /does not contain/.test(f)), JSON.stringify(r.failed))
w('notes.md', 'Crucible agent test\n')
r = verifyGoal(g1)
check('correct file passes', r.verified && r.failed.length === 0, JSON.stringify(r))

// ── 2. THE MEASURED FAILURE — read one file, write another ───────────────────────────
const g2 = `Read the file prices.csv in ${D}, add up the amount column, and write the total on one line into total.txt in that same folder.`
w('prices.csv', 'item,amount\nkeyboard,49.99\n')
r = verifyGoal(g2)
check('MEASURED: "successfully read and added" with no total.txt is NOT verified', !r.verified, JSON.stringify(r))
check('the source file being present does not satisfy the goal',
  r.failed.some(f => f.includes('total.txt')) && !r.failed.some(f => f.includes('prices.csv')), JSON.stringify(r.failed))
check('the correction message is actionable', /total\.txt/.test(correctionFor(r)) && /POST-CONDITION CHECK FAILED/.test(correctionFor(r)))
w('total.txt', '292.24')
r = verifyGoal(g2)
check('writing the output file passes', r.verified, JSON.stringify(r))

// ── 3. Rename across files ───────────────────────────────────────────────────────────
const g3 = `In the folder ${D}, rename the function oldName to newName everywhere it appears in the .js files.`
w('a.js', 'function oldName(x) { return x }\n')
w('b.js', "const { oldName } = require('./a')\n")
r = verifyGoal(g3, ['a.js', 'b.js'])
check('rename with the old symbol still present fails',
  !r.verified && r.failed.some(f => /oldName.*still present/.test(f)), JSON.stringify(r.failed))
w('a.js', 'function newName(x) { return x }\n')
w('b.js', "const { newName } = require('./a')\n")
r = verifyGoal(g3, ['a.js', 'b.js'])
check('rename completed in both files passes', r.verified, JSON.stringify(r))
w('b.js', "const { oldName } = require('./a')\n")
r = verifyGoal(g3, ['a.js', 'b.js'])
check('a HALF-DONE rename fails — one file is not "mostly renamed"', !r.verified, JSON.stringify(r.failed))

// ── 4. Destructive goals invert ──────────────────────────────────────────────────────
const D2 = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-post2-'))
fs.writeFileSync(path.join(D2, 'important.txt'), 'x')
fs.writeFileSync(path.join(D2, 'also.txt'), 'y')
const g4 = `Delete every file in the folder ${D2}.`
r = verifyGoal(g4, ['important.txt', 'also.txt'])
check('files intact after a destructive goal PASSES (confirmation is required first)', r.verified, JSON.stringify(r))
fs.unlinkSync(path.join(D2, 'important.txt'))
r = verifyGoal(g4, ['important.txt', 'also.txt'])
check('a file destroyed without confirmation FAILS',
  !r.verified && r.failed.some(f => /without confirmation/.test(f)), JSON.stringify(r.failed))

// ── 5. Unverifiable goals are a THIRD state, never a pass ────────────────────────────
for (const g of ['Tell me a joke.', 'What is the capital of Australia?', 'Explain how TCP works.']) {
  const rr = verifyGoal(g)
  check(`unreadable goal is "unverified", not verified: ${g}`, rr.unverified && !rr.verified, JSON.stringify(rr))
}
check('extraction is conservative on prose', extractPostconditions('Summarize my week.').length === 0)

console.log(`\nPOSTCONDITIONS BENCH: ${pass}/${pass + fail}`)
if (fail) process.exit(1)
