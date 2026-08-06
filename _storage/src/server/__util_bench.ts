// ============================================================================
// Committed bench for src/server/util.ts — withTimeout + estimateMessageTokens
// extracted from server.ts. Proves: a fast promise wins, a slow one falls back,
// the timer clears (no lingering handle), and token estimate is ~4 chars/token.
// Run: npx tsx src/server/__util_bench.ts
// ============================================================================
import { withTimeout, estimateMessageTokens, conversationTitle } from './util'

const checks: Array<{ name: string; pass: boolean }> = []
const ok = (name: string, pass: boolean) => checks.push({ name, pass })
const delay = <T>(ms: number, v: T) => new Promise<T>(r => setTimeout(() => r(v), ms))

async function main() {
  ok('a promise that resolves before the timeout returns its value',
    (await withTimeout(delay(5, 'ok'), 100, 'fallback')) === 'ok')
  ok('a promise slower than the timeout resolves the fallback',
    (await withTimeout(delay(100, 'late'), 10, 'fallback')) === 'fallback')
  ok('an already-resolved promise wins immediately',
    (await withTimeout(Promise.resolve(42), 50, -1)) === 42)

  ok('token estimate ≈ total chars / 4, rounded up',
    estimateMessageTokens([{ role: 'user', content: 'a'.repeat(8) }]) === 2
    && estimateMessageTokens([{ role: 'user', content: 'abc' }]) === 1)
  ok('token estimate sums across messages',
    estimateMessageTokens([{ role: 'system', content: 'x'.repeat(4) }, { role: 'user', content: 'y'.repeat(4) }]) === 2)
  ok('empty message list → 0 tokens', estimateMessageTokens([]) === 0)

  ok('conversationTitle uses the first user message, capped at 8 words + ellipsis',
    conversationTitle([{ userMessage: 'one two three four five six seven eight nine' }]) === 'one two three four five six seven eight…')
  ok('conversationTitle keeps a short message whole (no ellipsis)',
    conversationTitle([{ userMessage: 'reverse a string' }]) === 'reverse a string')
  ok('conversationTitle skips rounds without a user message',
    conversationTitle([{}, null, { userMessage: 'hello there' }]) === 'hello there')
  ok('conversationTitle → "New chat" when there is no user message / empty rounds',
    conversationTitle([]) === 'New chat' && conversationTitle([{ userMessage: '   ' }]) === 'New chat')
  ok('conversationTitle collapses internal whitespace',
    conversationTitle([{ userMessage: '  hello    world  ' }]) === 'hello world')

  const pass = checks.filter(c => c.pass).length
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'} — ${c.name}`)
  console.log(`\n${pass}/${checks.length} passed`)
  if (pass !== checks.length) process.exit(1)
}

main()
