// Hermetic bench for the grammar-constrained tool-call driver.
//
// No model and no network: `complete` is a stub that records what it was asked and replays a
// scripted answer. What is under test is the SHAPE the driver imposes — the grammars it builds,
// the fields it asks for, and its refusal to call a mutating tool on unreadable arguments.
import { makeToolCallDriveTurn, requiredFields, toolMenu, resolveBackReference, plannedTools, deriveArgs, FINISH, type Complete } from './toolCallDriver'
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

  // Cross-turn pronoun resolution. The GUARD is the load-bearing half: two earlier attempts at
  // this broke goals that name their own file, so those cases are pinned here.
  const LW = '/tmp/a/draft.txt'
  check('a bare back-reference resolves to the last written file',
    resolveBackReference('Now add the word world to the end of that same file.', LW).includes(LW))
  check('a goal naming its own file is NEVER redirected (append-to-file regression)',
    resolveBackReference('Append the line reviewed to log.txt, keeping what is already there.', LW)
      === 'Append the line reviewed to log.txt, keeping what is already there.')
  check('a goal naming two files of its own is untouched (two-files-one-goal regression)',
    !resolveBackReference('Create first.txt containing alpha and second.txt containing bravo.', LW).includes(LW))
  check('with nothing written yet the goal is unchanged',
    resolveBackReference('Add world to that same file.', null) === 'Add world to that same file.')
  check('a goal with no back-reference is unchanged',
    resolveBackReference('Create a file called draft.txt containing hello.', LW).includes('draft.txt'))

  // Specialist tools must not be offered when their precondition is absent.
  // MEASURED (follow-up-turn turn one): filter_rows was chosen for "create draft.txt containing
  // hello" and errored with File not found, killing the run.
  const SPEC: ToolDef[] = [
    ...TOOLS,
    { name: 'append_file', description: 'Append to a file.', mutates: true, run: noop,
      params: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
    { name: 'rename_symbol', description: 'Rename a symbol.', mutates: true, run: noop,
      params: { type: 'object', properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } }, required: ['path', 'old', 'new'] } },
    { name: 'filter_rows', description: 'Filter CSV rows.', mutates: true, run: noop,
      params: { type: 'object', properties: { path: { type: 'string' }, out: { type: 'string' }, condition: { type: 'string' } }, required: ['path', 'out', 'condition'] } },
  ]
  const offered = (goal: string) => (plannedTools(SPEC, goal, 0) ?? []).map(t => t.name)
  check('MEASURED: filter_rows is NOT offered for a plain create-a-file goal',
    !offered('Create a file called draft.txt in /tmp/a containing the word hello.').includes('filter_rows'),
    JSON.stringify(offered('Create a file called draft.txt in /tmp/a containing the word hello.')))
  check('rename_symbol is NOT offered for a plain create-a-file goal',
    !offered('Create a file called draft.txt in /tmp/a containing the word hello.').includes('rename_symbol'))
  check('write_file IS still offered for a plain create-a-file goal',
    offered('Create a file called draft.txt in /tmp/a containing the word hello.').includes('write_file'))
  check('filter_rows IS offered when the goal states a row condition',
    offered('Write /tmp/a/adults.csv containing only the rows where age is 18 or over.').includes('filter_rows'))
  // A rename-across-files goal plans READ (which files exist?) then WRITE, so the rename is
  // step 1 — step 0 is correctly list_dir.
  const renameGoal = 'In /tmp/a, rename the function oldName to newName in the .js files.'
  check('rename_symbol IS offered at the WRITE step of a rename goal',
    (plannedTools(SPEC, renameGoal, 1) ?? []).map(t => t.name).includes('rename_symbol'),
    JSON.stringify((plannedTools(SPEC, renameGoal, 1) ?? []).map(t => t.name)))

  // A rename's arguments are stated by the goal, so the model is not asked for them at all.
  // MEASURED (multi-file-edit): three consecutive iterations produced NO tool call because FILL
  // could not assemble these three strings, and iteration 5 emitted exactly this call.
  const renameTool = SPEC.find(t => t.name === 'rename_symbol')!
  const rf = requiredFields(renameTool)
  const d = deriveArgs(renameTool, 'In the folder /tmp/a, rename the function oldName to newName in the .js files.', rf)
  check('MEASURED: rename_symbol arguments are derived, not generated',
    !!d && d.path === '/tmp/a' && d.old === 'oldName' && d.new === 'newName', JSON.stringify(d))
  check('a rename goal with no folder is NOT derived (partial is treated as none)',
    deriveArgs(renameTool, 'rename the function oldName to newName', rf) === null)
  check('a non-rename goal derives nothing',
    deriveArgs(renameTool, 'In /tmp/a, write notes.md containing hello.', rf) === null)
  check('other tools are never derived', deriveArgs(TOOLS[0], 'In /tmp/a, rename the function a to b', requiredFields(TOOLS[0])) === null)

  // read_file returns "N<TAB>line"; the head copies the numbers into what it writes, and
  // normalises the tab to a space on the way. MEASURED (dedupe-lines): the written file came out
  // as "1 a@x.com / 2 b@x.com / 3 a@x.com" and the dedupe silently failed — every line now had a
  // unique prefix.
  const numbered = '1 a@x.com\n2 b@x.com\n3 c@x.com'
  drive = makeToolCallDriveTurn(stub(['write_file', JSON.stringify({ path: '/tmp/a/u.txt', content: numbered })]), 'Write /tmp/a/u.txt')
  r = await drive([], TOOLS)
  check('MEASURED: read_file line numbers are stripped from written content',
    r.toolCalls[0]?.args.content === 'a@x.com\nb@x.com\nc@x.com', JSON.stringify(r.toolCalls[0]?.args.content))

  // The guard: genuinely numbered content is not mangled. These do not ascend by one.
  const realList = '1 buy milk\n5 call bank\n9 write report'
  drive = makeToolCallDriveTurn(stub(['write_file', JSON.stringify({ path: '/tmp/a/t.txt', content: realList })]), 'Write /tmp/a/t.txt')
  r = await drive([], TOOLS)
  check('a non-sequential numbered list is left alone', r.toolCalls[0]?.args.content === realList,
    JSON.stringify(r.toolCalls[0]?.args.content))

  console.log(`\nTOOL-CALL DRIVER BENCH: ${pass}/${pass + fail}`)
  if (fail) process.exit(1)
}
main()
