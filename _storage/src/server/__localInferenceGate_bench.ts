// Bench for the on-device availability latch. Run:
//   npx tsx src/server/__localInferenceGate_bench.ts
//
// See localInferenceGate.ts for the measured failure. In one line: a boot-time health probe
// that lost a 2-second race disabled every tool-executing layer in the agent for the whole
// process lifetime, and the agent answered by narrating a plan it never carried out.
//
// The property under test is the ONE-DIRECTIONAL rule — recover from a false negative, never
// create one. Both directions are pinned, because a latch that only gets tested on recovery is
// the latch that starts flapping tools off mid-session.

import { makeLocalInferenceGate } from './localInferenceGate'

let pass = 0, fail = 0
const failures: string[] = []
const check = (label: string, ok: boolean, detail = '') => {
  if (ok) { pass++; return }
  fail++
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
}

// A controllable clock and a controllable daemon.
function harness(script: boolean[], ttlMs = 15_000) {
  let t = 0
  let i = 0
  const gate = makeLocalInferenceGate({
    ttlMs,
    now: () => t,
    probe: async () => script[Math.min(i++, script.length - 1)],
  })
  return { gate, advance: (ms: number) => { t += ms }, probesScripted: () => i }
}

// ── 1. THE LIVE FAILURE: a boot-time miss is recoverable ─────────────────────
console.log('\n== a lost boot race does not disable tools forever ==')
{
  // Daemon answers "no" once (it was still starting), then "yes" forever after.
  const { gate, advance } = harness([false, true])
  check('down at boot', (await gate.ready()) === false)
  advance(20_000)
  check('recovers on the next request after the TTL', (await gate.ready()) === true,
    'THE LIVE BUG: the agent would run toolless for the rest of the process')
  check('lastKnown reflects the recovery', gate.lastKnown() === true)
}

// ── 2. ONCE UP, IT LATCHES ───────────────────────────────────────────────────
// The flag is read on the hot path. A health blip must not take working tools away — a daemon
// that dies later surfaces as a failed CALL, which every layer already falls through on.
console.log('\n== once up, never probed again ==')
{
  const { gate, advance } = harness([true, false, false, false])
  check('up on the first probe', (await gate.ready()) === true)
  advance(10 * 60_000)
  check('still up after the daemon reports down', (await gate.ready()) === true,
    'a transient blip silently downgraded the agent to prose')
  check('no further probes once up', gate.probes() === 1, `probed ${gate.probes()} times`)
}

// ── 3. WHILE DOWN, PROBING IS RATE-LIMITED ───────────────────────────────────
// Every agent request would otherwise pay a 2s health-check timeout.
console.log('\n== a down daemon is not probed on every request ==')
{
  const { gate, advance } = harness([false], 15_000)
  await gate.ready(); await gate.ready(); await gate.ready()
  check('one probe inside the TTL', gate.probes() === 1, `probed ${gate.probes()} times`)
  advance(15_001)
  await gate.ready()
  check('probes again after the TTL', gate.probes() === 2, `probed ${gate.probes()} times`)
}

// ── 4. CONCURRENT CALLERS COLLAPSE ONTO ONE PROBE ────────────────────────────
// N parallel health checks against a daemon that is busy starting up is the contention that
// loses the race to begin with.
console.log('\n== concurrent readiness checks share one probe ==')
{
  let started = 0
  const gate = makeLocalInferenceGate({
    now: () => 0,
    probe: async () => { started++; await new Promise(r => setTimeout(r, 10)); return true },
  })
  const all = await Promise.all([gate.ready(), gate.ready(), gate.ready(), gate.ready()])
  check('all callers get the same answer', all.every(v => v === true), JSON.stringify(all))
  check('exactly one probe was issued', started === 1, `${started} probes`)
}

// ── 5. A THROWING PROBE IS A "DOWN", NOT A CRASH ─────────────────────────────
console.log('\n== the gate is total ==')
{
  let mode: 'throw' | 'ok' = 'throw'
  let t = 0
  const gate = makeLocalInferenceGate({
    ttlMs: 1000, now: () => t,
    probe: async () => { if (mode === 'throw') throw new Error('ECONNREFUSED'); return true },
  })
  let threw = false
  try { check('a throwing probe reads as down', (await gate.ready()) === false) }
  catch { threw = true }
  check('ready() never throws', !threw)
  mode = 'ok'; t += 2000
  check('and still recovers afterwards', (await gate.ready()) === true)
}

// ── 6. THE onUp HOOK FIRES EXACTLY ONCE ──────────────────────────────────────
// server.ts logs "on-device inference active" from it; a line per request would be noise.
console.log('\n== the up transition is announced once ==')
{
  let ups = 0
  let t = 0
  const gate = makeLocalInferenceGate({
    ttlMs: 10, now: () => t, onUp: () => { ups++ },
    probe: async () => true,
  })
  await gate.ready(); t += 100; await gate.ready(); t += 100; await gate.ready()
  check('onUp fired once', ups === 1, `fired ${ups} times`)
}

console.log(`\n${'─'.repeat(62)}`)
console.log(`local-inference-gate bench: ${pass}/${pass + fail} passed`)
if (failures.length) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log(`  ✗ ${f}`)
}
process.exit(fail === 0 ? 0 : 1)
