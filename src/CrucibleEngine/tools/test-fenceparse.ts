// DONE-WHEN: the shapes free models actually emit for a tool call all parse, near-JSON
// is repaired rather than discarded, and ordinary JSON in a final answer is NOT
// mistaken for a tool call.
// Why this matters: a failed parse is not a retry — the loop treats the text as the
// model's final answer, so the raw JSON ships to the user. Strictness costs answers.
// Deterministic: pure functions. No model calls, no network.
// Run: npx tsx src/CrucibleEngine/tools/test-fenceparse.ts
import { parseFenceToolCall, repairParseJSON } from './protocol'

let failures = 0
const check = (label: string, cond: boolean, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}${cond ? '' : ' :: ' + detail}`)
  if (!cond) failures++
}
const KNOWN = { knownTools: ['read_file', 'run', 'glob', 'update_plan'] }
const call = (t: string, o = KNOWN) => parseFenceToolCall(t, o)

// ── the canonical shape still works ─────────────────────────────────────────
{
  const c = call('```json\n{"tool": "read_file", "args": {"path": "a.ts"}}\n```')
  check('canonical fenced call parses', c?.name === 'read_file' && (c.args as any).path === 'a.ts', JSON.stringify(c))
  check('prose around the fence is tolerated',
    call('Sure, let me look.\n```json\n{"tool":"run","args":{"command":"ls"}}\n```\nOne moment.')?.name === 'run')
  check('an unfenced object still parses', call('{"tool":"glob","args":{"pattern":"*.ts"}}')?.name === 'glob')
  check('a call with no args yields empty args', JSON.stringify(call('{"tool":"run"}')?.args) === '{}')
}

// ── alias shapes free models emit ───────────────────────────────────────────
{
  check('name/arguments (OpenAI shape)',
    call('{"name":"read_file","arguments":{"path":"a.ts"}}')?.name === 'read_file')
  check('nested function object',
    call('{"function":{"name":"run","arguments":"{\\"command\\":\\"ls\\"}"}}')?.name === 'run')
  check('arguments delivered as a JSON string is parsed',
    (call('{"name":"run","arguments":"{\\"command\\":\\"ls -la\\"}"}')?.args as any)?.command === 'ls -la')
  check('tool_name/parameters', call('{"tool_name":"glob","parameters":{"pattern":"*"}}')?.name === 'glob')
  check('action/action_input (ReAct shape)',
    call('{"action":"run","action_input":{"command":"pwd"}}')?.name === 'run')
}

// ── near-JSON repair ────────────────────────────────────────────────────────
{
  check('trailing comma repaired', call('{"tool":"run","args":{"command":"ls",},}')?.name === 'run')
  check('python literals repaired',
    (call('{"tool":"run","args":{"command":"ls","quiet":True}}')?.args as any)?.quiet === true)
  check('unquoted keys repaired', call('{tool:"run",args:{command:"ls"}}')?.name === 'run')
  check('single-quoted strings repaired', call("{'tool':'run','args':{'command':'ls'}}")?.name === 'run')
  check('repairParseJSON returns null on true garbage', repairParseJSON('{not json at all') === null)
  check('a valid payload is never altered by repair',
    JSON.stringify(repairParseJSON('{"a":1}') ?? {}) === '{"a":1}')
}

// ── scanning: the first *parseable* object is not always the call ───────────
{
  check('skips a leading non-call object',
    call('{"thought":"I should list files"}\n{"tool":"run","args":{"command":"ls"}}')?.name === 'run')
  check('skips an illustrative code block and finds the real fence',
    call('Example:\n```python\nprint({"x": 1})\n```\n```json\n{"tool":"glob","args":{"pattern":"*.ts"}}\n```')?.name === 'glob')
  check('unterminated JSON does not hang or throw', call('{"tool":"run","args":{"command":') === null)
}

// ── false positives: the risk of permissive parsing ─────────────────────────
{
  check('ordinary JSON in a final answer is not a tool call',
    call('Here is the record:\n```json\n{"name":"Alice","role":"admin"}\n```') === null)
  check('an unknown tool name is rejected when the list is known',
    call('{"name":"launch_missiles","args":{}}') === null)
  check('plain prose yields null', call('The answer is 21.') === null)
  check('a non-identifier name is rejected', call('{"tool":"go do the thing","args":{}}') === null)
  check('empty input yields null', call('') === null)
}

// ── behavior with no knownTools (the conservative default) ──────────────────
{
  const bare = (t: string) => parseFenceToolCall(t)
  check('without knownTools, the canonical "tool" key still works',
    bare('{"tool":"read_file","args":{"path":"a.ts"}}')?.name === 'read_file')
  check('without knownTools, an alias name WITH args is accepted',
    bare('{"name":"read_file","arguments":{"path":"a.ts"}}')?.name === 'read_file')
  check('without knownTools, a bare {"name": ...} object is NOT a tool call',
    bare('{"name":"Alice","role":"admin"}') === null)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
