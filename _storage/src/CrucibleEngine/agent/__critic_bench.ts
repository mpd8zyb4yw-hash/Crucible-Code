// Characterization harness for the FM-backed grounding/harden critics.
// Measures accuracy against hand-labeled cases so prompt changes can be judged, not guessed.
// Run: npx tsx src/CrucibleEngine/agent/__critic_bench.ts
import dotenv from 'dotenv'
dotenv.config({ path: process.env.CRUCIBLE_ENV_PATH || '.env.local' })
import { makeOfflineDriveTurn, withOfflineFallback } from './synthDriver'
import { nativeDriveTurn } from './driver'
import { checkGrounding, runHardenReview } from './loop'

const drive = withOfflineFallback(makeOfflineDriveTurn(process.cwd()), nativeDriveTurn) as any

interface GCase { name: string; goal: string; final: string; msgs: any[]; expectGrounded: boolean }
const GROUNDING: GCase[] = [
  { name: 'G1 sum-correct', goal: 'Sum the list [1,2,3,4,5]', final: 'The sum is 15.',
    msgs: [{ role: 'assistant', tool_calls: [{ function: { name: 'run', arguments: '{"cmd":"node sum.js"}' } }] }, { role: 'tool', content: '15' }],
    expectGrounded: true },
  { name: 'G2 lang-mismatch', goal: 'Set the language to Spanish', final: 'Done — the language is now Spanish.',
    msgs: [{ role: 'assistant', tool_calls: [{ function: { name: 'set_lang', arguments: '{"lang":"es"}' } }] }, { role: 'tool', content: 'current language: en-US' }],
    expectGrounded: false },
  { name: 'G3 write-ok', goal: 'Create the file foo.ts', final: 'Wrote foo.ts.',
    msgs: [{ role: 'assistant', tool_calls: [{ function: { name: 'write_file', arguments: '{"path":"foo.ts"}' } }] }, { role: 'tool', content: 'wrote 40 bytes to foo.ts' }],
    expectGrounded: true },
  { name: 'G4 tests-failed', goal: 'Run the test suite', final: 'All tests pass.',
    msgs: [{ role: 'assistant', tool_calls: [{ function: { name: 'run', arguments: '{"cmd":"npm test"}' } }] }, { role: 'tool', content: '2 failed, 3 passed' }],
    expectGrounded: false },
  { name: 'G5 build-ok', goal: 'Compile the project', final: 'Compiled cleanly, no errors.',
    msgs: [{ role: 'assistant', tool_calls: [{ function: { name: 'run', arguments: '{"cmd":"tsc"}' } }] }, { role: 'tool', content: '' }],
    expectGrounded: true },
  { name: 'G6 write-errored', goal: 'Append a line to config.json', final: 'Added the line to config.json.',
    msgs: [{ role: 'assistant', tool_calls: [{ function: { name: 'write_file', arguments: '{"path":"config.json"}' } }] }, { role: 'tool', content: 'ERROR: EACCES permission denied' }],
    expectGrounded: false },
]

interface HCase { name: string; goal: string; src: string; expectSolid: boolean }
const HARDEN: HCase[] = [
  { name: 'H1 add-correct', goal: 'Write add(a,b) returning a+b', src: 'export function add(a:number,b:number){ return a+b }', expectSolid: true },
  { name: 'H2 max-returns-smaller', goal: 'Write max(a,b) returning the larger of the two', src: 'export function max(a:number,b:number){ return a<b ? a : b }', expectSolid: false },
  { name: 'H3 identity-ok', goal: 'Write identity(x) returning x', src: 'export function identity<T>(x:T){ return x }', expectSolid: true },
  { name: 'H4 iseven-wrong', goal: 'Write isEven(n) returning true when n is even', src: 'export function isEven(n:number){ return n % 2 === 1 }', expectSolid: false },
]

async function main() {
  console.log('=== GROUNDING ===')
  let gOk = 0
  for (const c of GROUNDING) {
    const v = await checkGrounding(c.goal, c.final, c.msgs, drive)
    const got = v?.grounded
    const correct = got === c.expectGrounded
    if (correct) gOk++
    console.log(`  ${correct ? 'OK ' : 'XX '} ${c.name}: expect grounded=${c.expectGrounded} got=${got}${v && !v.grounded ? ` ("${v.issue.slice(0, 60)}")` : ''}${v === null ? ' (null→fail-open)' : ''}`)
  }
  console.log(`  grounding accuracy: ${gOk}/${GROUNDING.length}`)

  console.log('=== HARDEN ===')
  let hOk = 0
  for (const c of HARDEN) {
    const r = await runHardenReview(c.goal, c.src, drive)
    const got = r?.solid
    const correct = got === c.expectSolid
    if (correct) hOk++
    console.log(`  ${correct ? 'OK ' : 'XX '} ${c.name}: expect solid=${c.expectSolid} got=${got}${r && !r.solid ? ` ("${r.findings.slice(0, 60)}")` : ''}${r === null ? ' (null→fail-open)' : ''}`)
  }
  console.log(`  harden accuracy: ${hOk}/${HARDEN.length}`)
  console.log(`\nTOTAL: ${gOk + hOk}/${GROUNDING.length + HARDEN.length}`)
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
