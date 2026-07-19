// cont.97d repro: identity replay via the RECALL block (not a cache, not matchMeta).
// Hypothesis: the earlier "who made you?" answer is re-injected into the system prompt as an
// authoritative "Earlier in this conversation" line, and a contentless turn echoes it back.
// The cont.97c inline repro used exactly 4 turns → recentStart === 0 → recall block never built.
import { buildRecallContextAsync } from './src/CrucibleEngine/answer/conversationMemory'

const IDENTITY = 'I was made by Justin. I am Crucible, a local-first reasoning engine that runs entirely on your device.'

// >4 turns so the identity turn lands in the OLDER bucket that feeds the recall block.
const history = [
  { user: 'who made you?', assistant: IDENTITY },
  { user: 'what can you do?', assistant: 'I can reason, search, write and verify code, all on-device.' },
  { user: 'cool', assistant: 'Thanks. What would you like to build?' },
  { user: 'make me something', assistant: 'What would you like me to make? Give me a bit more detail.' },
  { user: 'a game maybe', assistant: 'What kind of game — puzzle, arcade, or something else?' },
]

const run = async (n: number, msg: string) => {
  const h = history.slice(0, n)
  const r = await buildRecallContextAsync(h, msg)
  console.log(`\n--- turns=${n}  msg=${JSON.stringify(msg)} ---`)
  console.log(`recalledCount=${r.recalledCount} omitted=${r.omitted} recentTurns=${r.recentTurns.length}`)
  console.log(`recallBlock:\n${r.recallBlock || '(EMPTY — recall never built)'}`)
  console.log(`identity text present in prompt: ${r.recallBlock.includes(IDENTITY.slice(0, 60))}`)
}

await run(4, 'something totally unique')   // the cont.97c repro shape
await run(5, 'something totally unique')   // one turn past the window
