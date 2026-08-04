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

// ── The tool protocol is not an answer ───────────────────────────────────────
//
// MEASURED LIVE (2026-08-04, `on-device FM (desktop)`). The run WORKED — it read notes.txt,
// wrote "3" into count.txt, and read it back to confirm — and then shipped this as the answer
// the user reads:
//
//     TOOL: search
//     query: count
//     TOOL: write_file
//     path: ~/Desktop/agentprobe/count.txt
//     content: 3
//
// stripAgentScaffold knew about FINAL_ANSWER: and bare labels, but not about the call protocol
// itself, so the one piece of scaffold the model emits on EVERY turn went straight through.
// An answer made only of tool calls is not an answer: emptying it makes the caller's
// `!fmRes.answer.trim()` check escalate, which is the honest outcome.
console.log('== leaked TOOL: protocol never reaches the user ==')
{
  const leaked = 'TOOL: search\nquery: count\nTOOL: write_file\npath: ~/Desktop/agentprobe/count.txt\ncontent: 3'
  const out = stripAgentScaffold(leaked)
  check('an all-protocol answer strips to empty', out === '', JSON.stringify(out))

  const mixed = 'I counted the lines and saved the total.\n\nTOOL: write_file\npath: count.txt\ncontent: 3'
  const outMixed = stripAgentScaffold(mixed)
  check('prose survives, the call is dropped',
    outMixed === 'I counted the lines and saved the total.', JSON.stringify(outMixed))

  check('a decorated header is stripped too',
    stripAgentScaffold('**TOOL: search**\nquery: count') === '', JSON.stringify(stripAgentScaffold('**TOOL: search**\nquery: count')))
  check('protocol after a FINAL_ANSWER marker is still stripped',
    stripAgentScaffold('FINAL_ANSWER:\nTOOL: search\nquery: x') === '')
  check('idempotent on protocol', stripAgentScaffold(stripAgentScaffold(leaked)) === '')
}

console.log('== prose that merely looks like a call is kept ==')
{
  // The false-strip direction. A colon line is ordinary English, and an answer ABOUT tools
  // must not be gutted — this is the direction that silently destroys good answers.
  const prose = 'To read a file, call the read_file tool with a path.\nNote: it returns numbered lines.'
  check('a "Note:" line is not scaffold', stripAgentScaffold(prose) === prose, JSON.stringify(stripAgentScaffold(prose)))
  const recipe = 'Ingredients:\nflour: 200g\nsugar: 100g'
  check('a key:value list with no TOOL: header survives', stripAgentScaffold(recipe) === recipe, JSON.stringify(stripAgentScaffold(recipe)))
  const after = 'TOOL: search\nquery: count\n\nI found three lines in the file.'
  check('prose after a blank line ends the block',
    stripAgentScaffold(after) === 'I found three lines in the file.', JSON.stringify(stripAgentScaffold(after)))
  check('the word "tool" in prose is untouched',
    stripAgentScaffold('The tool: a hammer.') === 'The tool: a hammer.')
}

console.log(`\n${pass}/${pass + fail} passed`)
if (fail > 0) process.exit(1)
