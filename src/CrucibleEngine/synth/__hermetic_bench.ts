// DONE-WHEN (W30, GAP_CLOSURE_ADDENDUM.md): Gate B execution is hermetic — deterministic
// across runs, offline by construction, secret-free, and reapable — AND every legitimate
// candidate shape still certifies. The negative half matters more: a sandbox that rejects
// honest clock/random-using candidates would quietly zero the generated pass rate, which is
// worse than the flakiness being prevented.
//
// Deterministic, model-free: real spawns through runHermeticSync + two full verifyCandidate
// end-to-ends. No fm calls, no network, no shared llama-server contention (Track A owns it).
// Run: npx tsx src/CrucibleEngine/synth/__hermetic_bench.ts
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync } from 'child_process'
import { runHermeticSync, DEFAULT_SEED } from './hermetic'
import { verifyCandidate } from './oracle'

let failures = 0
const check = (label: string, cond: boolean, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}${cond ? '' : ' :: ' + detail.slice(0, 300)}`)
  if (!cond) failures++
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-hermetic-bench-'))
const probe = (name: string, src: string): string => {
  const p = path.join(dir, name)
  fs.writeFileSync(p, src)
  return p
}

const EPOCH = 1750000000000

// ── clock is frozen and identical across runs ───────────────────────────────
{
  const p = probe('clock.ts', `
    console.log('now=' + Date.now())
    console.log('ctor=' + new Date().getTime())
    console.log('perf=' + Math.floor(performance.now()))
  `)
  const a = runHermeticSync(p, dir, 20_000)
  const b = runHermeticSync(p, dir, 20_000)
  check('clock probe runs clean', a.ok, a.out)
  check('two runs are byte-identical', a.ok && a.out === b.out, `a=${a.out} b=${b.out}`)
  const now = Number(/now=(\d+)/.exec(a.out)?.[1] ?? 0)
  // Wall clock in 2026 is ~1.78e12; the frozen epoch is 1.75e12. Anywhere near the epoch
  // proves the prelude is live; anywhere near wall clock proves it is not.
  check('Date.now() reads the frozen epoch, not the wall clock', now >= EPOCH && now < EPOCH + 1e7, `now=${now}`)
}

// ── PRNG is seeded: same seed ⇒ same stream, different seed ⇒ different ─────
{
  const p = probe('rand.ts', `console.log([Math.random(), Math.random(), Math.random()].join(','))`)
  const a = runHermeticSync(p, dir, 20_000, DEFAULT_SEED)
  const b = runHermeticSync(p, dir, 20_000, DEFAULT_SEED)
  const c = runHermeticSync(p, dir, 20_000, DEFAULT_SEED + 1)
  check('same seed reproduces the stream', a.ok && a.out === b.out, `a=${a.out} b=${b.out}`)
  check('a different seed produces a different stream', a.ok && c.ok && a.out !== c.out, a.out)
}

// ── timezone and locale are pinned ──────────────────────────────────────────
{
  const p = probe('tz.ts', `console.log('h=' + new Date(0).getHours())`)
  const r = runHermeticSync(p, dir, 20_000)
  check('TZ is pinned to UTC regardless of host timezone', r.ok && /h=0\b/.test(r.out), r.out)
}

// ── the parent's environment does not exist in the child ────────────────────
{
  process.env.CRUCIBLE_CANARY_SECRET = 'sk-canary-do-not-leak'
  const p = probe('env.ts', `console.log('canary=' + String(process.env.CRUCIBLE_CANARY_SECRET))`)
  const r = runHermeticSync(p, dir, 20_000)
  delete process.env.CRUCIBLE_CANARY_SECRET
  check('candidate cannot see parent env (the API-key leak is closed)',
    r.ok && r.out.includes('canary=undefined') && !r.out.includes('do-not-leak'), r.out)
}

// ── the network does not exist ──────────────────────────────────────────────
// Every net probe prints a sentinel FIRST, and the check requires it: a denial marker
// alone can come from the RUNNER crashing under the prelude (exactly what happened with
// the Module._load belt — the probes "passed" without ever executing). The sentinel
// proves candidate code was reached before the denial fired.
const deniedAtProbe = (r: { ok: boolean; out: string }) =>
  !r.ok && r.out.includes('PROBE_STARTED') && r.out.includes('HERMETIC_NET_DENIED')
{
  // No top-level await: scratch dirs have no package.json, so tsx compiles probes as CJS.
  // The deny throws synchronously when fetch is CALLED, so a bare call is enough.
  const p = probe('net-fetch.ts', `console.log('PROBE_STARTED')\nfetch('http://127.0.0.1:1/x')`)
  const r = runHermeticSync(p, dir, 20_000)
  check('fetch() is denied with the named marker', deniedAtProbe(r), r.out)
}
{
  // ESM import path — bypasses require hooks, so this proves the method-surface patches.
  const p = probe('net-http.ts', `import { get } from 'http'\nconsole.log('PROBE_STARTED')\nget('http://127.0.0.1:1/x')`)
  const r = runHermeticSync(p, dir, 20_000)
  check('http.get via ESM import is denied', deniedAtProbe(r), r.out)
}
{
  const p = probe('net-socket.ts', `import net from 'net'\nconsole.log('PROBE_STARTED')\nnet.connect({ port: 1 })`)
  const r = runHermeticSync(p, dir, 20_000)
  check('raw socket connect is denied', deniedAtProbe(r), r.out)
}

// ── a SIGTERM-immune busy loop is still reaped, within the cap ──────────────
{
  // Unique marker in the entry path so pgrep can find a survivor by name only.
  const p = probe(`spin-${DEFAULT_SEED.toString(16)}-orphanprobe.ts`, `process.on('SIGTERM', () => {})\nfor (;;) { /* busy */ }`)
  const t0 = Date.now()
  const r = runHermeticSync(p, dir, 3_000)
  const elapsed = Date.now() - t0
  check('busy loop is killed (SIGKILL, not SIGTERM)', !r.ok && r.timedOut, r.out)
  check('and within the cap plus startup slack', elapsed < 15_000, `elapsed=${elapsed}ms`)
  // REGRESSION GUARD (2026-07-22g): the tsx-CLI vector double-forked and orphaned the real
  // worker to PID 1, where a SIGTERM-immune busy loop survived a 3s cap for 13h. Prove the
  // in-process vector leaves NO process still running the probe after the reap.
  let survivors = ''
  try { survivors = execSync(`pgrep -f orphanprobe.ts || true`, { encoding: 'utf8' }).trim() }
  catch { survivors = '' }
  check('no orphaned worker survives the reap (single-process vector)', survivors === '', `surviving pids: ${survivors}`)
}

// ── a memory bomb dies at the heap cap instead of taking the box ────────────
{
  const p = probe('mem.ts', `const a: number[][] = []\nfor (;;) a.push(new Array(1e6).fill(1))`)
  const t0 = Date.now()
  const r = runHermeticSync(p, dir, 60_000)
  const elapsed = Date.now() - t0
  check('memory bomb is rejected', !r.ok, r.out.slice(-200))
  check('and dies at the heap cap, well before the time cap', elapsed < 45_000, `elapsed=${elapsed}ms`)
}

// ── END-TO-END: a legitimate candidate still certifies, deterministically ───
{
  const v = verifyCandidate(
    [{ path: 'src/add.ts', content: `export function add(a: number, b: number): number { return a + b }\n` }],
    { path: 'test.ts', content: `import { add } from './src/add'\nif (add(2, 3) !== 5) { console.log('FAIL'); process.exit(1) }\nconsole.log('PASS add'); console.log('ALL PASS')\n` },
  )
  check('a clean candidate is accepted end-to-end', v.accepted && v.gateA && v.gateB, v.detail)
}
{
  // A candidate that READS the clock is legitimate — the frozen clock must make it
  // certifiable rather than flaky. This is the negative half: over-rejection here would
  // zero out every timestamp-touching task.
  const v = verifyCandidate(
    [{ path: 'src/stamp.ts', content: `export function stamp(): string { return 'at-' + Date.now() }\n` }],
    { path: 'test.ts', content: `import { stamp } from './src/stamp'\nconsole.log(stamp())\nif (!stamp().startsWith('at-')) process.exit(1)\nconsole.log('ALL PASS')\n` },
  )
  check('a clock-reading candidate certifies (frozen, not flaky)', v.accepted, v.detail)
}
{
  // Residual entropy the prelude does NOT freeze (crypto.randomBytes) — the accept-side
  // double-run must catch it and name it, because a flaky accept poisons the flywheel.
  const v = verifyCandidate(
    [{ path: 'src/tok.ts', content: `import { randomBytes } from 'crypto'\nexport function tok(): string { return randomBytes(8).toString('hex') }\n` }],
    { path: 'test.ts', content: `import { tok } from './src/tok'\nconsole.log('tok=' + tok())\nconsole.log('ALL PASS')\n` },
  )
  check('entropy the prelude cannot freeze is caught by the double-run',
    !v.accepted && v.detail.includes('NONDETERMINISTIC'), v.detail)
}

fs.rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
