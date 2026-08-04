// ============================================================================
// Committed bench for src/server/pairing.ts — the off-LAN paired-device token.
// This is the ONLY thing standing between the open internet and the user's mail,
// calendar and agent tools when the tunnel is up, so it is tested as a security
// boundary: fail-closed by default, no plaintext at rest, revocation is real,
// and a near-miss token never authenticates.
// Run: npx tsx src/server/__pairing_bench.ts
// ============================================================================
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  PairingStore, generateToken, sha256, tokenMatchesHash, findDevice, extractToken,
  type PairedDevice,
} from './pairing'

const checks: Array<{ name: string; pass: boolean }> = []
const ok = (name: string, pass: boolean) => checks.push({ name, pass })

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-pair-'))
const file = path.join(tmp, 'nested', 'paired-devices.json')

// ── Fail closed ─────────────────────────────────────────────────────────────
const store = new PairingStore(file)
ok('a store with no file is empty (guard keeps pre-pairing behaviour)', store.isEmpty())
ok('no token verifies against an empty store', store.verify(generateToken()) === null)
ok('the empty string never verifies', store.verify('') === null)

// ── Minting ─────────────────────────────────────────────────────────────────
const { token, device } = store.create('Justin iPhone')
ok('create() returns a usable token', typeof token === 'string' && token.length >= 40)
ok('the store is no longer empty after pairing', !store.isEmpty())
ok('the minted token verifies', store.verify(token)?.id === device.id)
ok('a DIFFERENT token does not verify', store.verify(generateToken()) === null)

// A near-miss: same length, one character changed. This is the case a naive
// prefix/substring comparison would get wrong.
const nearMiss = (token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'))
ok('a token differing by one character does not verify', store.verify(nearMiss) === null)
ok('a truncated token does not verify', store.verify(token.slice(0, 20)) === null)
ok('the token with trailing whitespace does not verify', store.verify(token + ' ') === null)

// ── No plaintext at rest ────────────────────────────────────────────────────
const onDisk = fs.readFileSync(file, 'utf8')
ok('the plaintext token is NOT written to disk', !onDisk.includes(token))
ok('the sha256 of the token IS what is stored', onDisk.includes(sha256(token)))
ok('the device list view never exposes the hash',
  store.list().every(d => !('hash' in (d as Record<string, unknown>))))
const mode = fs.statSync(file).mode & 0o777
ok(`the device file is written 0600 (got ${mode.toString(8)})`, mode === 0o600)

// ── Persistence across restarts ─────────────────────────────────────────────
const reopened = new PairingStore(file)
ok('a token still verifies after the store is reloaded from disk', reopened.verify(token)?.id === device.id)
ok('list() survives a reload', reopened.list().length === 1 && reopened.list()[0].label === 'Justin iPhone')

// ── Revocation ──────────────────────────────────────────────────────────────
const second = store.create('iPad')
ok('two devices can be paired independently',
  store.verify(token) !== null && store.verify(second.token) !== null)
ok('revoking one device kills exactly that token',
  store.revoke(second.device.id) === true &&
  store.verify(second.token) === null &&
  store.verify(token) !== null)
ok('revoking an unknown id reports false', store.revoke('not-a-real-id') === false)
ok('a revoked token stays dead after a reload',
  new PairingStore(file).verify(second.token) === null)
ok('revokeAll clears every device and fails closed again',
  store.revokeAll() === 1 && store.isEmpty() && store.verify(token) === null)

// ── Primitives ──────────────────────────────────────────────────────────────
ok('tokenMatchesHash accepts the right token', tokenMatchesHash('abc', sha256('abc')))
ok('tokenMatchesHash rejects the wrong token', !tokenMatchesHash('abd', sha256('abc')))
ok('tokenMatchesHash rejects a malformed (short) stored hash', !tokenMatchesHash('abc', 'deadbeef'))
ok('generateToken does not repeat',
  new Set(Array.from({ length: 500 }, generateToken)).size === 500)

// findDevice must not early-return — it scans every device regardless of match.
const devices: PairedDevice[] = ['a', 'b', 'c'].map((l, i) => ({
  id: `id${i}`, label: l, hash: sha256(`tok${i}`), createdAt: 0, lastSeenAt: null,
}))
ok('findDevice locates a match anywhere in the list',
  findDevice(devices, 'tok0')?.id === 'id0' && findDevice(devices, 'tok2')?.id === 'id2')
ok('findDevice returns null for an unknown token', findDevice(devices, 'nope') === null)
ok('findDevice returns null for an empty token even with devices present',
  findDevice(devices, '') === null)

// ── Token extraction ────────────────────────────────────────────────────────
ok('token is read from the x-crucible-device header',
  extractToken({ 'x-crucible-device': 'T0K' }) === 'T0K')
ok('an array-valued header takes its first entry',
  extractToken({ 'x-crucible-device': ['T0K', 'other'] }) === 'T0K')
ok('the header WINS over the query param',
  extractToken({ 'x-crucible-device': 'HEAD' }, '/api/x?device=QUERY') === 'HEAD')
ok('the ?device= param is honoured for WebSocket upgrades',
  extractToken({}, '/api/screen-stream-ws?device=WSTOK&t=1') === 'WSTOK')
ok('no header and no param yields the empty string (which never verifies)',
  extractToken({}, '/api/screen-stream-ws') === '')
ok('a malformed URL does not throw', extractToken({}, '::::') === '')

// ── A corrupt store must fail CLOSED, not open ──────────────────────────────
const badFile = path.join(tmp, 'corrupt.json')
fs.writeFileSync(badFile, '{ this is not json')
const badStore = new PairingStore(badFile)
ok('an unparseable device file is treated as "nothing paired"',
  badStore.isEmpty() && badStore.verify(token) === null)

fs.rmSync(tmp, { recursive: true, force: true })

const pass = checks.filter(c => c.pass).length
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'} — ${c.name}`)
console.log(`\n${pass}/${checks.length} passed`)
if (pass !== checks.length) process.exit(1)
