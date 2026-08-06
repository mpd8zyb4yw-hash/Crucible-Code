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
import { parseResponse, parseToolBlocks } from './fmReact'

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

// ── MULTI-BLOCK RESPONSES (2026-08-04) ──────────────────────────────────────────
// THE LIVE CASE, captured from a real agent run. Asked to count the lines in notes.txt and
// write the count into count.txt, the head read the file and then answered with BOTH steps in
// one completion:
//
//     TOOL: read_file
//     path: /Users/justin/Documents/probe/notes.txt
//     TOOL: write_file
//     path: /Users/justin/Documents/probe/count.txt
//     content: 4
//
// parseResponse takes the FIRST block by design, so it re-proposed the read it had already
// done, hit the repeated-call guard, and looped until the raw text shipped as the answer. The
// write — correct path, correct content — sat unread in the same message. parseToolBlocks is
// what lets the loop look past the duplicate to the step that has not run.
const MULTI = 'TOOL: read_file\npath: /tmp/p/notes.txt\nTOOL: write_file\npath: /tmp/p/count.txt\ncontent: 4'
const blocks = parseToolBlocks(MULTI, primary)
check('both TOOL: blocks are recovered, in order',
  blocks.length === 2 && blocks[0].toolName === 'read_file' && blocks[1].toolName === 'write_file',
  JSON.stringify(blocks))
check('each block keeps its OWN args — no bleed between blocks',
  blocks[0].args.path === '/tmp/p/notes.txt' &&
  blocks[1].args.path === '/tmp/p/count.txt' && blocks[1].args.content === '4',
  JSON.stringify(blocks))
check('parseResponse still takes the FIRST block (fabricated later blocks stay unexecuted)',
  (parseResponse(MULTI, primary, () => true) as any).toolName === 'read_file')

// A trailing FINAL_ANSWER must close the last block rather than becoming an arg of it.
const withFinal = parseToolBlocks('TOOL: search\nquery: cats\nFINAL_ANSWER: done\nextra: junk', primary)
check('FINAL_ANSWER closes the block and its trailer is not absorbed as args',
  withFinal.length === 1 && withFinal[0].args.query === 'cats' && withFinal[0].args.extra === undefined,
  JSON.stringify(withFinal))

check('a response with no TOOL: block yields nothing',
  parseToolBlocks('FINAL_ANSWER: just an answer', primary).length === 0)

// The bare-positional rescue must work per-block, not only for the first.
const bare = parseToolBlocks('TOOL: search\ncats\nTOOL: browse_page\nhttps://example.com', primary)
check('a bare positional binds to each block\'s own primary param',
  bare.length === 2 && bare[0].args.query === 'cats' && bare[1].args.url === 'https://example.com',
  JSON.stringify(bare))

// Decorated headers (the model bolds the protocol because the prompt shows it in backticks).
const decorated = parseToolBlocks('**TOOL: search**\nquery: dogs', primary)
check('a decorated TOOL: header is still recognised',
  decorated.length === 1 && decorated[0].toolName === 'search', JSON.stringify(decorated))

console.log(`\nTOTAL: ${pass}/${pass + fail}`)
if (fail) process.exit(1)
