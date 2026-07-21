// Pure, offline bench for fmReact tool-arg parsing. No model calls, no network.
// Run: npx tsx src/CrucibleEngine/agent/__toolargs_bench.ts
//
// Guards the positional-arg regression (NEXT_SESSION cont.94 item #2): a weak local model
// routinely emits a tool call WITHOUT param names — either as a bare value line
// ("TOOL: run\nmkdir dog_breeds_italy") or in function-call form ("TOOL: run(\"mkdir\", …)").
// The old parser only accepted `key: value` lines, so both shapes produced an EMPTY arg set:
// `run` executed with no command, `search` with an empty query. Those empty calls are why the
// dog-breeds task returned mangled hits like "https://www.dog breeds italy.com" instead of
// doing anything. Named args must still win — the rescue only fires when nothing parsed.
import { parseResponse, primaryParamLookup, primaryParamOf, type FmReactTool } from './fmReact'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

const noop = async () => ''
const TOOLS: FmReactTool[] = [
  { name: 'search', description: 'Search the web', params: 'query: the search query string', execute: noop },
  { name: 'run', description: 'Run a command', params: 'command: the shell command to run', execute: noop },
  { name: 'list_files', description: 'List files', params: 'path: directory path; depth: optional, default 1', execute: noop },
]
const primary = primaryParamLookup(TOOLS)
const argsOf = (raw: string) => {
  const p = parseResponse(raw, primary)
  return p.type === 'tool' ? { name: p.toolName, args: p.args ?? {} } : null
}

console.log('== primaryParamOf reads the first declared param ==')
check('search -> query', primaryParamOf(TOOLS[0]) === 'query')
check('run -> command', primaryParamOf(TOOLS[1]) === 'command')
check('multi-param list_files -> path (first only)', primaryParamOf(TOOLS[2]) === 'path')

console.log('\n== bare positional line binds to the primary param ==')
{
  const r = argsOf('TOOL: run\nmkdir dog_breeds_italy')
  check('tool is run', r?.name === 'run')
  check('command captured', r?.args.command === 'mkdir dog_breeds_italy', JSON.stringify(r?.args))
  check('no numeric-index keys', !Object.keys(r?.args ?? {}).some(k => /^\d+$/.test(k)), JSON.stringify(r?.args))
}
{
  const r = argsOf('TOOL: search\ndog breeds of italy')
  check('query captured, not empty', r?.args.query === 'dog breeds of italy', JSON.stringify(r?.args))
}

console.log('\n== function-call form is normalized ==')
{
  const r = argsOf('TOOL: run("mkdir", "dog_breeds_italy")')
  check('tool is run', r?.name === 'run', JSON.stringify(r))
  check('both positionals joined into command', r?.args.command === 'mkdir dog_breeds_italy', JSON.stringify(r?.args))
}
{
  const r = argsOf('TOOL: search(query="typescript generics")')
  check('named call-form arg keeps its name', r?.args.query === 'typescript generics', JSON.stringify(r?.args))
}

console.log('\n== named args still win (rescue must not clobber) ==')
{
  const r = argsOf('TOOL: list_files\npath: src\ndepth: 2')
  check('path named', r?.args.path === 'src', JSON.stringify(r?.args))
  check('depth named', r?.args.depth === '2', JSON.stringify(r?.args))
}
{
  // A stray prose line alongside a real named arg must NOT overwrite the named value.
  const r = argsOf('TOOL: search\nquery: real query\nI will now search for this.')
  check('named query preserved', r?.args.query === 'real query', JSON.stringify(r?.args))
}

console.log('\n== unchanged behavior: no primaryParam lookup, no rescue ==')
{
  const p = parseResponse('TOOL: run\nmkdir foo')
  check('bare arg dropped without lookup (back-compat)', p.type === 'tool' && !Object.keys(p.args ?? {}).length)
}
{
  const p = parseResponse('FINAL_ANSWER:\nThe answer is 68.', primary)
  check('final answer still parsed', p.type === 'final' && p.answer === 'The answer is 68.')
}
{
  // The pre-existing guard: a TOOL: block before FINAL_ANSWER wins (fabricated transcript).
  const p = parseResponse('TOOL: search\nquery: x\n\nFINAL_ANSWER:\nDone successfully.', primary)
  check('premature FINAL_ANSWER still discarded', p.type === 'tool' && p.toolName === 'search')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
