// Pure bench for stripAgentScaffold — strips leaked agent scaffold ("FINAL_ANSWER:" + a
// duplicated body) from a user-facing answer. No model calls.
// Run: npx tsx src/CrucibleEngine/agent/__fmReact_bench.ts  (npm run fmreact:bench)
import { stripAgentScaffold } from './fmReact'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

console.log('== the reported mantis bug: preamble + FINAL_ANSWER + duplicate ==')
{
  const body = 'Mantis shrimp see polarized light and strike with immense force. They are remarkable animals.'
  const leaked = `${body}\n\nFINAL_ANSWER: ${body}`
  const out = stripAgentScaffold(leaked)
  check('marker is gone', !/FINAL_ANSWER/i.test(out), out.slice(0, 60))
  check('only one copy of the body remains', (out.match(/polarized light/g) || []).length === 1)
  check('the answer content is preserved', out.includes('remarkable animals'))
}

console.log('== marker variants ==')
check('FINAL_ANSWER: inline', stripAgentScaffold('FINAL_ANSWER: Tokyo is the capital.') === 'Tokyo is the capital.')
check('FINAL ANSWER (space)', !/FINAL/i.test(stripAgentScaffold('FINAL ANSWER: 42')))
check('lowercase final_answer', !/final_answer/i.test(stripAgentScaffold('reasoning here\nfinal_answer: done')))
check('leading ANSWER: label', stripAgentScaffold('ANSWER: 42') === '42')
check('takes text after the LAST marker', stripAgentScaffold('FINAL_ANSWER: draft\nFINAL_ANSWER: final') === 'final')

console.log('== clean text is untouched ==')
{
  const clean = 'Tokyo is the capital of Japan. It is the largest metropolitan area in the world.'
  check('normal answer unchanged', stripAgentScaffold(clean) === clean)
  check('answer that merely mentions "final answer" in prose is kept', /the final answer/i.test(stripAgentScaffold('So the final answer works out cleanly here without markers.')))
  check('empty → empty', stripAgentScaffold('') === '')
  check('idempotent', stripAgentScaffold(stripAgentScaffold('FINAL_ANSWER: x is y and z')) === 'x is y and z')
}

console.log(`\n${pass}/${pass + fail} passed`)
if (fail > 0) process.exit(1)
