// Hermetic prelude — injected into every Gate-B child via NODE_OPTIONS --require.
// (W30, GAP_CLOSURE_ADDENDUM.md. Plain CJS so --require works under any module mode.)
//
// Purpose: certification must be DETERMINISTIC and OFFLINE. A candidate that passes once
// and fails once is recorded as truth and then consumed by the distillation flywheel, the
// artifact cache, and the curriculum — a flaky certify poisons all three, silently.
//
// Design: this shim neutralizes the COMMON nondeterminism sources (clock, PRNG, timezone)
// so ordinary time/random-using candidates become deterministic rather than rejected, and
// it hard-denies the network, which certification must never touch (doctrine: 0 external
// APIs — previously unenforced at the one place model-generated code executes). Residual
// nondeterminism (crypto.randomBytes, os stats, host entropy) is NOT chased here — the
// oracle's accept-side double-run catches whatever this shim does not freeze.
//
// Honest boundary: this defends against INCOMPETENT candidates, not adversarial ones. A
// candidate that deliberately unpatches these globals can evade the shim; nothing the
// synth pipeline emits has a reason to. Escalating to true OS-level isolation is a later,
// separately-measured step (see W30 notes in GAP_CLOSURE_ADDENDUM.md).

'use strict'

// ── Conditional arming ──────────────────────────────────────────────────────
// NODE_OPTIONS reaches EVERY node process in the spawn chain — including npm/npx tooling
// on the fallback path, and npx requires 'http' internally (found live: the net-denial
// built for the candidate killed npx itself). Arm only in a process whose argv carries
// the candidate entry path, and never in npm tooling. Everywhere else this file is a
// no-op: zero global mutation, zero behavioral change.
// Exact argv[1] match: tsx respawns the exec child as `node <flags> <entry>`, so only the
// process actually running candidate code has argv[1] === entry. The tsx CLI parent
// (argv[1] = tsx's cli.mjs) and any npm tooling stay fully dormant.
const HERMETIC_ENTRY = process.env.CRUCIBLE_HERMETIC_ENTRY || ''
if (!HERMETIC_ENTRY || String(process.argv[1] || '') !== HERMETIC_ENTRY) {
  return
}

// ── Frozen clock ─────────────────────────────────────────────────────────────
// Fixed epoch + a monotonic tick per read. Two properties matter: (a) identical across
// runs, so clock-reading candidates produce identical output; (b) strictly advancing, so
// `while (Date.now() - t0 < 100)` terminates instead of spinning forever.
const EPOCH = 1750000000000
let tick = 0
const now = () => EPOCH + (++tick)

const RealDate = Date
class HermeticDate extends RealDate {
  constructor(...a) {
    if (a.length) super(...a)
    else super(now())
  }
  static now() { return now() }
}
HermeticDate.parse = RealDate.parse
HermeticDate.UTC = RealDate.UTC
// eslint-disable-next-line no-global-assign
globalThis.Date = HermeticDate

try { performance.now = () => now() - EPOCH } catch { /* perf may be frozen */ }
const hrtime = (prev) => {
  const ms = now() - EPOCH
  const s = Math.floor(ms / 1e3)
  const ns = Math.round((ms % 1e3) * 1e6)
  return prev ? [s - prev[0], ns - prev[1]] : [s, ns]
}
hrtime.bigint = () => BigInt(now()) * 1000000n
try { process.hrtime = hrtime } catch { /* read-only in some embedders */ }

// ── Seeded PRNG (mulberry32) ────────────────────────────────────────────────
let seed = (Number(process.env.CRUCIBLE_HERMETIC_SEED || 0xC0FFEE)) >>> 0
Math.random = function hermeticRandom() {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// ── Network denial ──────────────────────────────────────────────────────────
// Certification is offline by doctrine. This repo is `"type": "module"`, so candidate/test
// files execute as ESM — and ESM imports of core modules BYPASS Module._load, which makes a
// require-hook-only deny porous. Core modules are singletons, though: patching their method
// surfaces here (the prelude runs before any user code links) means every later access —
// `require('http')`, `import http from 'http'`, `import { get } from 'http'` — sees the
// denied functions. The error string is a stable, greppable marker the oracle surfaces.
const deny = (what) => function () {
  throw new Error(`HERMETIC_NET_DENIED: ${what} — the network is not available during certification`)
}

// Patch BEFORE installing the require hook, so our own requires still work.
const http = require('http')
const https = require('https')
http.get = deny('http.get'); http.request = deny('http.request')
https.get = deny('https.get'); https.request = deny('https.request')
try { require('http2').connect = deny('http2.connect') } catch { /* absent */ }
// net is denied by ARGUMENT SHAPE, not blanket: tsx's own in-child runtime connects back
// to its parent over a UNIX DOMAIN SOCKET (found live — every run died at exit on
// net.createConnection). A unix socket is local IPC and cannot reach the network, so
// path-shaped connects pass through; port/host (TCP) shapes are what "offline" forbids.
const isUnixSocketArgs = (a) => {
  const first = a && a[0]
  // node's _normalizeArgs re-enters Socket#connect with [options, cb] — unwrap it.
  if (Array.isArray(first)) return isUnixSocketArgs(first)
  if (typeof first === 'string' && !/^\d+$/.test(first)) return true
  if (first && typeof first === 'object' && first.path !== undefined && first.port === undefined) return true
  return false
}
const denyTcp = (name, real) => function (...a) {
  if (isUnixSocketArgs(a)) return real.apply(this, a)
  return deny(name)()
}
const net = require('net')
net.connect = denyTcp('net.connect', net.connect)
net.createConnection = denyTcp('net.createConnection', net.createConnection)
try { net.Socket.prototype.connect = denyTcp('net.Socket#connect', net.Socket.prototype.connect) } catch { /* frozen */ }
require('tls').connect = deny('tls.connect')
require('dgram').createSocket = deny('dgram.createSocket')
const dns = require('dns')
for (const k of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveTxt', 'resolveMx']) dns[k] = deny(`dns.${k}`)
if (dns.promises) for (const k of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
  try { dns.promises[k] = async () => { deny(`dns.promises.${k}`)() } } catch { /* frozen */ }
}

// No require-hook belt: tsx's OWN in-child runtime requires node:net for its loader IPC
// (found live — a Module._load deny killed the runner, not the candidate). Denying at the
// METHOD surface is the correct enforcement point anyway: the module may load, but every
// outbound call throws. Honest boundary: net.createServer/http.createServer stay callable
// (tsx machinery, and LISTENING is not an external call) — a candidate that binds a local
// port still cannot connect to it, because every client-side method is denied.

globalThis.fetch = deny('fetch()')
try { globalThis.WebSocket = deny('new WebSocket()') } catch { /* absent in older nodes */ }
try { globalThis.XMLHttpRequest = deny('new XMLHttpRequest()') } catch { /* not defined in node */ }
