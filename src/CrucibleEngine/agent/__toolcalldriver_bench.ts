// Hermetic bench for the grammar-constrained tool-call driver.
//
// No model and no network: `complete` is a stub that records what it was asked and replays a
// scripted answer. What is under test is the SHAPE the driver imposes — the grammars it builds,
// the fields it asks for, and its refusal to call a mutating tool on unreadable arguments.
import { makeToolCallDriveTurn, requiredFields, toolMenu, FINISH, type Complete } from './toolCallDriver'
import type { ToolDef } from '../tools/protocol'

let pass = 0, fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

const noop = async () => ({ ok: true, output: '' } as never)
const TOOLS: ToolDef[] = [
  { name: 'write_file', description: 'Write text to a file.', mutates: true, run: noop,
    params: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean' } }, required: ['path', 'content'] } },
  { name: 'read_file', description: 'Read a file.', run: noop,
    params: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'list_dir', description: 'List a directory.', run: noop,
    params: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
]

// ── Field selection ──────────────────────────────────────────────────────────────────
check('required fields only — optional "append" is not samplable',
  JSON.stringify(requiredFields(TOOLS[0]).map(f => f.key)) === '["path","content"]',
  JSON.stringify(requiredFields(TOOLS[0])))
check('field types come from the schema',
  requiredFields(TOOLS[0]).every(f => f.type === 'string'))
check('menu names every tool', TOOLS.every(t => toolMenu(TOOLS).includes(t.name)))

// ── Stage 1 is constrained to the tool names plus FINISH ─────────────────────────────
const seen: Array<{ gbnf?: string; system: string }> = []
function stub(replies: string[]): Complete {
  let i = 0
  return async (messages, opts) => {
    seen.push({ gbnf: opts?.gbnf, system: String(messages[0]?.content ?? '') })
    return replies[Math.min(i++, replies.length - 1)]
  }
}

async function main() {
  // Happy path: select then fill.
  seen.length = 0
  let drive = makeToolCallDriveTurn(stub(['write_file', '{"path": "/tmp/a/notes.md", "content": "Crucible agent test"}']), 'Create notes.md')
  let r = await drive([{ role: 'user', content: 'go' }], TOOLS)
  check('emits exactly one tool call', r.toolCalls.length === 1, JSON.stringify(r.toolCalls))
  check('calls the selected tool', r.toolCalls[0]?.name === 'write_file')
  check('args are parsed from the constrained JSON',
    r.toolCalls[0]?.args.path === '/tmp/a/notes.md' && r.toolCalls[0]?.args.content === 'Crucible agent test',
    JSON.stringify(r.toolCalls[0]?.args))
  check('every tool call carries a unique id', typeof r.toolCalls[0]?.id === 'string' && r.toolCalls[0].id.length > 3)

  // The grammar is what makes refusal unsamplable — assert it is actually passed.
  check('stage 1 passes an enum grammar over the tool names',
    !!seen[0].gbnf && seen[0].gbnf.includes('"write_file"') && seen[0].gbnf.includes(`"${FINISH}"`),
    seen[0].gbnf ?? 'no grammar')
  check('stage 1 grammar cannot emit prose',
    !!seen[0].gbnf && !/[a-z] [a-z]/.test(seen[0].gbnf.replace(/root ::= /, '')),
    seen[0].gbnf ?? '')
  check('stage 2 passes a JSON-object grammar for the chosen tool only',
    !!seen[1].gbnf && seen[1].gbnf.includes('path') && seen[1].gbnf.includes('content') && !seen[1].gbnf.includes('append'),
    seen[1].gbnf ?? 'no grammar')

  // FINISH ends the turn with no tool calls — the loop reads that as a final answer.
  drive = makeToolCallDriveTurn(stub([FINISH]), 'anything')
  r = await drive([], TOOLS)
  check('FINISH yields zero tool calls', r.toolCalls.length === 0 && /complete/i.test(r.text))

  // A backend that ignores GBNF must not produce a mutating call on guessed arguments.
  drive = makeToolCallDriveTurn(stub(['write_file', 'I cannot do that, sorry.']), 'Create notes.md')
  r = await drive([], TOOLS)
  check('unparseable arguments produce NO tool call rather than a guessed one',
    r.toolCalls.length === 0, JSON.stringify(r.toolCalls))

  drive = makeToolCallDriveTurn(stub(['write_file', '{"path": "/tmp/a/notes.md"}']), 'Create notes.md')
  r = await drive([], TOOLS)
  check('a partial argument object produces NO call — write_file without content is a different action',
    r.toolCalls.length === 0, JSON.stringify(r.toolCalls))

  drive = makeToolCallDriveTurn(stub(['I am unable to help with that']), 'Create notes.md')
  r = await drive([], TOOLS)
  check('an off-grammar selection is reported, not mangled into a call', r.toolCalls.length === 0)

  // No tools at all is a real state (every integration disabled) and must not throw.
  drive = makeToolCallDriveTurn(stub(['write_file']), 'x')
  r = await drive([], [])
  check('empty tool list is handled without throwing', r.toolCalls.length === 0)

  console.log(`\nTOOL-CALL DRIVER BENCH: ${pass}/${pass + fail}`)
  if (fail) process.exit(1)
}
main()
