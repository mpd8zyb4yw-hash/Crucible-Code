// ============================================================================
// Committed bench for src/chat/streamFailure.ts — the guard that turns a silently
// swallowed SSE error back into a message the user can act on. This is the exact
// defect that made "sending anything from mobile does nothing" look like a broken
// button instead of a 403 the server was explaining clearly every time.
// Run: npx tsx src/chat/__streamFailure_bench.ts
// ============================================================================
import { streamFailure } from './streamFailure'

const checks: Array<{ name: string; pass: boolean }> = []
const ok = (name: string, pass: boolean) => checks.push({ name, pass })
const BASE = 'http://192.168.1.9:3001'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// ── The happy path must stay out of the way ─────────────────────────────────
ok('a 200 with a body is not a failure',
  (await streamFailure(new Response('data: {}\n\n', { status: 200 }), BASE)) === null)

// ── The bug this exists to prevent ──────────────────────────────────────────
const guard = await streamFailure(
  json(403, { error: 'Crucible is on-device only. Reach it from this Mac or your local network.' }),
  BASE,
)
ok('a 403 is reported, not swallowed', guard !== null)
ok('the 403 carries the SERVER\'s own words, not a generic message',
  !!guard?.startsWith('Crucible is on-device only.'))
ok('the 403 names the status code so it can be looked up', !!guard?.includes('403'))

// ── Every other failure shape ───────────────────────────────────────────────
const five = await streamFailure(json(500, { error: 'Engine crashed' }), BASE)
ok('a 500 with an error field surfaces that field', five === 'Engine crashed (HTTP 500)')

const html = await streamFailure(new Response('<html>502 Bad Gateway</html>', { status: 502 }), BASE)
ok('a non-JSON body falls back to a status message rather than throwing',
  html === `Crucible answered HTTP 502 at 192.168.1.9:3001.`)
ok('the fallback names the host actually being talked to (the phone\'s real gripe)',
  !!html?.includes('192.168.1.9:3001') && !html.includes('http://'))

const emptyJson = await streamFailure(json(404, {}), BASE)
ok('JSON with no error field still reports the status',
  emptyJson === 'Crucible answered HTTP 404 at 192.168.1.9:3001.')

const nullErr = await streamFailure(json(400, { error: null }), BASE)
ok('a null error field does not render the string "null"',
  !!nullErr && !nullErr.includes('null'))

const nonString = await streamFailure(json(400, { error: { nested: 'object' } }), BASE)
ok('a non-string error field does not crash the guard', typeof nonString === 'string')

// ── The 200-with-no-body case: not an error, still not a stream ─────────────
const noBody = await streamFailure(new Response(null, { status: 204 }), BASE)
ok('a 204/empty 200 is reported rather than silently doing nothing',
  noBody === 'Crucible returned an empty response.')

// ── Contract the call sites depend on ───────────────────────────────────────
// A null return must GUARANTEE res.body is readable, since every call site then
// does `res.body!.getReader()`.
const okRes = new Response('x', { status: 200 })
ok('null return implies a readable body (the call sites assert this)',
  (await streamFailure(okRes, BASE)) === null && okRes.body !== null)

const pass = checks.filter(c => c.pass).length
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'} — ${c.name}`)
console.log(`\n${pass}/${checks.length} passed`)
if (pass !== checks.length) process.exit(1)
