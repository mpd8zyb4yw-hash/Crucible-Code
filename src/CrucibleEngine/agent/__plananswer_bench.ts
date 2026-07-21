// Pure, offline bench for the planned-task answer composition. No model calls, no network.
// Run: npx tsx src/CrucibleEngine/agent/__plananswer_bench.ts
//
// Guards the step-label leakage regression (cont.96). runPlannedTask's `summary` is the INTERNAL
// ledger — one `<step intent> → <compressed result>` line per completed step — and server.ts used
// to ship it verbatim as the final answer. A live automation run for the brief "State the sum of
// 17 and 4, and nothing else" therefore returned:
//
//   perform addition → The sum of 17 and 4 is 21.
//   display result → 17 + 17 = 34
//
// i.e. the agent's own plan labels in front of the user. `answer` (composeAnswer) is the
// user-facing text: results only, de-duplicated, never model-generated.
import { composeAnswer, stripLedgerLabels } from './planner'
import { isAllToolResidue } from './loop'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

const steps = (...intents: string[]) => intents.map((intent, i) => ({ id: `s${i + 1}`, intent })) as any

console.log('== composeAnswer strips nothing but internal scaffolding ==')
{
  const out = composeAnswer(['The sum of 17 and 4 is 21.'])
  check('single step returns its text verbatim', out === 'The sum of 17 and 4 is 21.', JSON.stringify(out))
  check('no intent label present', !/→/.test(out), out)
}
{
  const out = composeAnswer(['First finding.', 'Second finding.'])
  check('multiple steps joined by a blank line', out === 'First finding.\n\nSecond finding.', JSON.stringify(out))
}
{
  const out = composeAnswer(['The sum of 17 and 4 is 21.', '  the SUM of 17 and 4 is 21.  '])
  check('restated step is de-duplicated', out === 'The sum of 17 and 4 is 21.', JSON.stringify(out))
}
{
  check('empty/blank results drop out', composeAnswer(['', '   ', 'Real.']) === 'Real.')
  check('no results yields empty string', composeAnswer([]) === '')
}

console.log('\n== stripLedgerLabels recovers results from a persisted ledger ==')
{
  const s = steps('perform addition', 'display result')
  const out = stripLedgerLabels(
    ['perform addition → The sum of 17 and 4 is 21.', 'display result → 21'],
    s,
  )
  check('label removed from line 1', out[0] === 'The sum of 17 and 4 is 21.', JSON.stringify(out[0]))
  check('label removed from line 2', out[1] === '21', JSON.stringify(out[1]))
}
{
  // A RESULT that merely contains " → " must not be truncated — only a real intent prefix is.
  const s = steps('summarize migration')
  const out = stripLedgerLabels(['summarize migration → renamed foo → bar in 3 files'], s)
  check('only the intent prefix is stripped', out[0] === 'renamed foo → bar in 3 files', JSON.stringify(out[0]))
}
{
  // An unrecognized prefix is left alone rather than guessed at.
  const out = stripLedgerLabels(['not a step intent → keep this whole line'], steps('something else'))
  check('unknown prefix left intact', out[0] === 'not a step intent → keep this whole line', JSON.stringify(out[0]))
}

console.log('\n== tool residue never becomes the answer ==')
{
  check('"exit 0" dropped', composeAnswer(['exit 0']) === '', JSON.stringify(composeAnswer(['exit 0'])))
  check('decorated "`exit 0`" dropped', composeAnswer(['`exit 0`']) === '')
  check('"Done." dropped', composeAnswer(['Done.']) === '')
  check('"Command executed successfully." dropped', composeAnswer(['Command executed successfully.']) === '')
  const mixed = composeAnswer(['exit 0', 'The sum of 17 and 4 is 21.'])
  check('residue dropped, real result kept', mixed === 'The sum of 17 and 4 is 21.', JSON.stringify(mixed))
}
{
  // A bare number is residue for a WHOLE-TASK final but is a legitimate STEP answer — never
  // discard something that could be the actual result.
  check('bare number kept', composeAnswer(['21']) === '21')
  check('bare decimal kept', composeAnswer(['3.5']) === '3.5')
  check('negative number kept', composeAnswer(['-4']) === '-4')
}

console.log('\n== isAllToolResidue: JOINED tool output (Layer 2 FM plan path) ==')
{
  // The live repro: a two-step shell plan whose summary is the joined raw output. Pure residue,
  // but matches no single-token rule — this is what shipped "exit 0\n\nexit 0" as the answer.
  check('two joined "exit 0"s are residue', isAllToolResidue('exit 0\n\nexit 0'))
  check('single "exit 0" still residue', isAllToolResidue('exit 0'))
  check('three mixed status lines are residue', isAllToolResidue('exit 0\nDone.\nCommand executed successfully.'))
  check('empty string is not residue', !isAllToolResidue(''))
  check('whitespace only is not residue', !isAllToolResidue('   \n  '))
}
{
  // A REAL answer must survive even when one of its lines looks like an acknowledgement.
  check('real answer with a "Done." line is kept', !isAllToolResidue('The sum of 17 and 4 is 21.\nDone.'))
  check('real prose kept', !isAllToolResidue('The sum of 17 and 4 is 21.'))
  check('answer ending in a bare number kept', !isAllToolResidue('The total is:\n21\nwhich is correct.'))
}

console.log('\n== the live regression, end to end ==')
{
  const s = steps('perform addition', 'display result')
  const ledger = ['perform addition → The sum of 17 and 4 is 21.', 'display result → The sum of 17 and 4 is 21.']
  const answer = composeAnswer(stripLedgerLabels(ledger, s))
  check('no step labels reach the user', !/perform addition|display result/.test(answer), answer)
  check('no ledger arrows reach the user', !/→/.test(answer), answer)
  check('answer is the finding itself', answer === 'The sum of 17 and 4 is 21.', JSON.stringify(answer))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
