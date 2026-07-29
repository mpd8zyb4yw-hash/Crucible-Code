// Bench for the bare-call rescue in fmReact.parseResponse (cont.119). Run:
//   npx tsx src/CrucibleEngine/agent/__barecall_bench.ts
//
// THE LIVE CASE. Asked to create a set on quizlet.com, the on-device model answered:
//
//     ```typescript
//     web_open("https://quizlet.com/create-flashcard-set");
//     ```
//
// It had chosen the right tool AND the right argument, and expressed the call in the notation it
// knows best. Nothing ran; the code block shipped as the answer. Same principle `undecorate`
// exists for — a protocol the model gets 95% right must not fail closed on the other 5% — one
// step further out: not decoration AROUND the protocol, but the protocol written as source.
//
// The negative cases matter as much: this must never turn an ANSWER into an execution.
import { parseResponse } from './fmReact'

const KNOWN = new Set(['web_open', 'web_act', 'search', 'browse_page'])
const known = (n: string) => KNOWN.has(n)
const PRIMARY: Record<string, string> = { web_open: 'url', search: 'query', browse_page: 'url', web_act: 'pageId' }
const primary = (n: string) => PRIMARY[n]

let pass = 0, fail = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'OK ' : 'XX '} ${name}${ok ? '' : ` — ${detail}`}`)
  ok ? pass++ : fail++
}

const fence = parseResponse('```typescript\nweb_open("https://quizlet.com/create-flashcard-set");\n```', primary, known) as any
check('a bare call in a code fence becomes a tool call', fence.toolName === 'web_open', JSON.stringify(fence))
// The URL must survive intact: the `key: value` line parser otherwise splits it on its OWN colon
// and hands the tool { https: "//quizlet.com/..." }.
check('the url argument survives the colon', fence.args?.url === 'https://quizlet.com/create-flashcard-set', JSON.stringify(fence.args))

const prose = parseResponse('I will run search(query="italian grammar") now.', primary, known) as any
check('a bare call in prose becomes a tool call', prose.toolName === 'search' && prose.args?.query === 'italian grammar', JSON.stringify(prose))

// ── Must never hijack an answer ──
const answered = parseResponse('FINAL_ANSWER: You can use web_open("https://x.com") to read a page.', primary, known) as any
check('FINAL_ANSWER is never hijacked', answered.toolName == null, JSON.stringify(answered))

const content = parseResponse('Q: What is "il"?\nA: the (masculine)', primary, known) as any
check('ordinary content is not a tool call', content.toolName == null, JSON.stringify(content))

const unknown = parseResponse('const db = level("my-db")', primary, known) as any
check('an unknown name is never executed', unknown.toolName == null, JSON.stringify(unknown))

const explicit = parseResponse('TOOL: search\nquery: otters', primary, known) as any
check('the documented protocol still wins', explicit.toolName === 'search' && explicit.args?.query === 'otters', JSON.stringify(explicit))

// Without the predicate the rescue is inert — callers that cannot vouch for a name get old behaviour.
const noPredicate = parseResponse('web_open("https://x.com")', primary) as any
check('inert without a known-tool predicate', noPredicate.toolName == null, JSON.stringify(noPredicate))

console.log(`\nTOTAL: ${pass}/${pass + fail}`)
if (fail) process.exit(1)
