// Pure, offline bench for conversation memory selection. No model calls, no network.
// Run: npx tsx src/CrucibleEngine/answer/__memory_bench.ts  (npm run memory:bench)
//
// Guards the long-horizon recall contract: turn 500 must still be able to see turn 1 when it's
// relevant, recent turns are always kept, and the window stays within budget.
import { selectMemory, buildRecallContext } from './conversationMemory'
import type { ConvTurn } from '../agent/fmReact'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

// Build a long conversation: turn 0 states a durable fact, turns 1..N are filler, and one middle
// turn mentions a distinctive entity. Each turn is padded so the whole thing blows any budget.
function longConvo(n: number): ConvTurn[] {
  const turns: ConvTurn[] = []
  turns.push({ user: 'My name is Sam and I am building a bakery inventory app.', assistant: 'Great, I can help with your bakery inventory app, Sam.' })
  for (let i = 1; i < n; i++) {
    if (i === 42) turns.push({ user: 'The database should use the Postgres HYENA schema.', assistant: 'Noted — Postgres with the HYENA schema.' })
    else turns.push({ user: `Filler question number ${i} about something generic and unrelated padded out to take space here.`, assistant: `Filler answer number ${i} responding generically with enough text to consume budget in the packer.` })
  }
  return turns
}

console.log('== turn 500 still recalls turn 1 (the name) when asked ==')
{
  const convo = longConvo(500)
  const res = selectMemory(convo, "what's my name again?", { budgetChars: 4000 })
  const hasAnchor = res.keptIndex.includes(0)
  check('turn 0 (name) is retained at turn 500', hasAnchor, `kept ${res.keptIndex.slice(0, 5)}… omitted ${res.omitted}`)
  check('window stayed small (budget respected)', res.turns.length < 30, `kept ${res.turns.length}`)
}

console.log('\n== a relevant MIDDLE turn is retrieved back into the window ==')
{
  const convo = longConvo(500)
  const res = selectMemory(convo, 'remind me which schema the Postgres database uses', { budgetChars: 4000 })
  check('turn 42 (HYENA schema) is pulled back in', res.keptIndex.includes(42), `kept ${res.keptIndex.join(',')}`)
}

console.log('\n== the most recent turns are always kept verbatim ==')
{
  const convo = longConvo(500)
  const res = selectMemory(convo, 'unrelated brand new topic zzz', { budgetChars: 4000, recentKeep: 4 })
  const last4 = [496, 497, 498, 499]
  check('last 4 turns present', last4.every(i => res.keptIndex.includes(i)), `kept tail ${res.keptIndex.slice(-6)}`)
}

console.log('\n== short conversations pass through whole ==')
{
  const convo = longConvo(5)
  const res = selectMemory(convo, 'anything', { budgetChars: 100_000 })
  check('all 5 turns kept, nothing omitted', res.keptIndex.length === 5 && res.omitted === 0)
}

console.log('\n== empty / missing history is safe ==')
{
  check('undefined → empty', selectMemory(undefined, 'hi').turns.length === 0)
  check('empty array → empty', selectMemory([], 'hi').turns.length === 0)
}

console.log('\n== recall context: two channels (recent thread + earlier-facts block) ==')
{
  const convo = longConvo(500)
  const rc = buildRecallContext(convo, "what's my name?", { budgetChars: 4000, recentKeep: 4 })
  check('recent thread is exactly the last 4 turns', rc.recentTurns.length === 4)
  check('recall block carries the turn-1 name fact', /My name is Sam/.test(rc.recallBlock), rc.recallBlock.slice(0, 80))
  check('recalledCount > 0', rc.recalledCount > 0)
  // The name is in the OLDER block, NOT duplicated in the recent thread.
  check('name is not in the recent thread (it is old)', !rc.recentTurns.some(t => /My name is Sam/.test(t.user)))
}

console.log('\n== recall context: short convo puts everything in the recent thread, no block ==')
{
  const convo = longConvo(3)
  const rc = buildRecallContext(convo, 'anything', { recentKeep: 4 })
  check('all 3 turns are recent', rc.recentTurns.length === 3)
  check('no recall block for a short convo', rc.recallBlock === '' && rc.recalledCount === 0)
}

console.log('\n== recall context: a relevant middle turn lands in the block ==')
{
  const convo = longConvo(500)
  const rc = buildRecallContext(convo, 'which schema does the Postgres database use', { budgetChars: 4000, recentKeep: 4 })
  check('HYENA schema recalled into the block', /HYENA/.test(rc.recallBlock))
}

console.log('\n== budget is actually enforced on the packed window ==')
{
  const convo = longConvo(500)
  const budget = 4000
  const res = selectMemory(convo, 'schema Postgres HYENA name Sam bakery', { budgetChars: budget })
  const packedChars = res.turns.reduce((s, t) => s + t.user.length + t.assistant.length, 0)
  // Mandatory turns (recent+anchor) can nudge slightly over; allow a small margin over budget.
  check('packed size near/under budget', packedChars <= budget * 1.6, `packed ${packedChars} vs budget ${budget}`)
}

console.log(`\n${pass}/${pass + fail} passed`)
if (fail > 0) process.exit(1)
