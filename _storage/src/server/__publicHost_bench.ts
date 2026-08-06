// ============================================================================
// Committed bench for src/server/publicHost.ts — deriving the pairing link's
// public origin from cloudflared's own ingress config instead of an env var.
// Proves: the hostname/service PAIRING is respected (a catch-all entry has no
// hostname and must not steal the previous one), the port must match, and a URL
// is never invented when the host is unknown.
// Run: npx tsx src/server/__publicHost_bench.ts
// ============================================================================
import { ingressHostForPort, normalizeHost, pairingUrl } from './publicHost'

const checks: Array<{ name: string; pass: boolean }> = []
const ok = (name: string, pass: boolean) => checks.push({ name, pass })

// The real shape of ~/.cloudflared/config.yml on this machine.
const REAL = `tunnel: 7ec0a9bb-a669-43da-885b-ac246820fd5d
credentials-file: /Users/justin/.cloudflared/7ec0a9bb.json

ingress:
  - hostname: crucible.cam
    service: http://localhost:3001
  - service: http_status:404
`

ok('finds the hostname routed to this port', ingressHostForPort(REAL, 3001) === 'crucible.cam')
ok('a different port does not match', ingressHostForPort(REAL, 3011) === null)

// The catch-all is the trap: `- service: http_status:404` follows a hostname entry,
// so a naive "last hostname seen" reader hands back crucible.cam for every port.
ok('the trailing catch-all does not inherit the previous hostname',
  ingressHostForPort(REAL, 404) === null)

const MULTI = `ingress:
  - hostname: other.example
    service: http://localhost:8080
  - hostname: crucible.cam
    service: http://localhost:3001
  - hostname: third.example
    service: http://127.0.0.1:9999
  - service: http_status:404
`
ok('picks the entry pointing at US, not simply the first',
  ingressHostForPort(MULTI, 3001) === 'crucible.cam')
ok('matches a 127.0.0.1 service as readily as localhost',
  ingressHostForPort(MULTI, 9999) === 'third.example')
ok('an unrouted port yields null even with several entries present',
  ingressHostForPort(MULTI, 5173) === null)

// Formatting variants cloudflared and hand-edits both produce.
ok('tolerates quotes around the hostname',
  ingressHostForPort(`ingress:\n  - hostname: "q.example"\n    service: "http://localhost:3001"\n`, 3001) === 'q.example')
ok('tolerates a trailing comment',
  ingressHostForPort(`ingress:\n  - hostname: c.example  # primary\n    service: http://localhost:3001 # app\n`, 3001) === 'c.example')
ok('a service with no port does not match a numeric port',
  ingressHostForPort(`ingress:\n  - hostname: n.example\n    service: http_status:404\n`, 404) === null)

// Fails closed on junk rather than returning something plausible-but-wrong.
ok('empty config yields null', ingressHostForPort('', 3001) === null)
ok('unrelated file content yields null', ingressHostForPort('hello: world\nnope: 1\n', 3001) === null)
ok('a hostname with no service at all yields null',
  ingressHostForPort('ingress:\n  - hostname: dangling.example\n', 3001) === null)

// ── Host normalisation ──────────────────────────────────────────────────────
ok('strips an https:// scheme a user typed in', normalizeHost('https://crucible.cam') === 'crucible.cam')
ok('strips an http:// scheme too', normalizeHost('http://crucible.cam') === 'crucible.cam')
ok('strips a trailing slash', normalizeHost('crucible.cam/') === 'crucible.cam')
ok('strips both together and surrounding space', normalizeHost('  https://crucible.cam/  ') === 'crucible.cam')
ok('leaves a bare host alone', normalizeHost('crucible.cam') === 'crucible.cam')

// ── URL construction ────────────────────────────────────────────────────────
ok('builds an https pairing URL', pairingUrl('crucible.cam', 'TOK') === 'https://crucible.cam/?device=TOK')
ok('forces https even if the host was given as http',
  pairingUrl('http://crucible.cam', 'TOK') === 'https://crucible.cam/?device=TOK')
ok('percent-encodes a token containing URL-significant characters',
  pairingUrl('c.example', 'a+b/c=d') === 'https://c.example/?device=a%2Bb%2Fc%3Dd')
ok('NO url is invented when the host is unknown', pairingUrl(null, 'TOK') === null)
ok('an empty host is treated as unknown, not as an empty origin', pairingUrl('   ', 'TOK') === null)

const pass = checks.filter(c => c.pass).length
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'} — ${c.name}`)
console.log(`\n${pass}/${checks.length} passed`)
if (pass !== checks.length) process.exit(1)
