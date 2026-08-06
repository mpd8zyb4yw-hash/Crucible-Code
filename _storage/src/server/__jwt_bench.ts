// ============================================================================
// Committed bench for src/server/jwt.ts — the HS256 sign/verify + cookie parsing
// extracted from server.ts (previously untestable inside the request handler).
// Proves: honest round-trip, tampered signature/body rejected, expiry enforced,
// wrong-secret rejected, malformed tokens don't throw, cookies parse + decode.
// Run: npx tsx src/server/__jwt_bench.ts
// ============================================================================
import { signJwt, verifyJwt, parseCookies } from './jwt'

const SECRET = 'test-secret-abc'
const now = 1_000_000
const good = { id: 'u1', email: 'a@b.c', exp: now + 3600 }

interface Check { name: string; pass: boolean }
const checks: Check[] = []
const ok = (name: string, pass: boolean) => checks.push({ name, pass })

// Round-trip.
const tok = signJwt(good, SECRET)
const back = verifyJwt(tok, SECRET, now)
ok('honest round-trip returns the payload', !!back && back.id === 'u1' && back.email === 'a@b.c')

// Wrong secret.
ok('a token signed with a different secret is rejected', verifyJwt(tok, 'other-secret', now) === null)

// Tampered body (swap the payload, keep the old signature).
const forged = { id: 'admin', email: 'x@y.z', exp: now + 3600 }
const tampered = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${tok.split('.')[2]}`
ok('a tampered body (reused signature) is rejected', verifyJwt(tampered, SECRET, now) === null)

// Expiry.
const expired = signJwt({ id: 'u1', email: 'a@b.c', exp: now - 1 }, SECRET)
ok('an expired token is rejected', verifyJwt(expired, SECRET, now) === null)
ok('the same token is valid before its expiry', verifyJwt(expired, SECRET, now - 100) !== null)

// Malformed inputs never throw.
ok('malformed tokens return null, never throw',
  verifyJwt('', SECRET, now) === null && verifyJwt('a.b', SECRET, now) === null && verifyJwt('...', SECRET, now) === null)

// Missing exp.
ok('a token with no numeric exp is rejected', verifyJwt(signJwt({ id: 'u1', email: 'a@b.c' }, SECRET), SECRET, now) === null)

// Cookies.
const cookies = parseCookies('crucible_session=abc%20def; theme=dark ; empty=')
ok('cookies parse, trim, and URL-decode values',
  cookies['crucible_session'] === 'abc def' && cookies['theme'] === 'dark' && cookies['empty'] === '')
ok('an empty cookie header yields an empty map', Object.keys(parseCookies('')).length === 0)

const pass = checks.filter(c => c.pass).length
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'} — ${c.name}`)
console.log(`\n${pass}/${checks.length} passed`)
if (pass !== checks.length) process.exit(1)
