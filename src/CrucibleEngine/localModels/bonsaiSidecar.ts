// ═══════════════════════════════════════════════════════════════════════════════
// Bonsai-27B sidecar — lifecycle manager for the PrismML llama-server (cont.89)
// ═══════════════════════════════════════════════════════════════════════════════
//
// WHY THIS EXISTS. Bonsai is the only engine measured to copy an identifier out of clean
// evidence (cont.88: 3/3 vs the FM's 0/3). But it runs on a PHONE-CLASS 8GB box that is
// ALREADY at ~7.4GB used / ~170MB free before anything loads, with macOS compressing ~1.7GB
// just to hold a browser and an editor. Running the model the obvious way makes the whole
// machine unusable. Measured, on this box, generating 400 tokens:
//
//   config                          wired    swap used   p99     worst stall   speed
//   baseline (no model)             1970MB     489MB    3.8ms       10ms        —
//   -ngl 99 -c 4096  (all GPU)      6587MB    2575MB   38.6ms      435ms     ~4.3 tok/s
//   taskpolicy -b -ngl 99 -t 3      6344MB    2657MB  204.8ms      495ms      slower
//   -ngl 16 (partial offload)       5387MB    3238MB   44.8ms      132ms      slower
//   -ngl 0  -c 2048  (CPU/mmap)     1540MB    1833MB   14.2ms       18ms      ~3.2 tok/s
//
// THE FINDING: it is not CPU contention, it is WIRED memory. Metal buffers are wired, so
// -ngl 99 pins 6.6GB of an 8GB machine and everything else is forced to swap — those are the
// 435ms stalls you feel. With -ngl 0 the weights are mmap'd from disk: FILE-BACKED clean
// pages the kernel can evict for free, so wired lands BELOW baseline and the worst stall
// drops 435ms → 18ms (24x better).
//
// The speed cost is SMALL, and an earlier "3x slower" reading was an artifact: that run was
// measured while a responsiveness probe was itself saturating the CPU. Clean, idle numbers are
// GPU ~5.3 tok/s vs CPU -t6 3.16 / -t4 2.53 tok/s — background mode costs ~1.7x, not 3x, and
// under real contention the gap narrows further. That is a cheap price for a usable machine.
//
// Two things that sound right and are NOT (both measured above, do not retry):
//   - `taskpolicy -b` (background QoS) makes it WORSE (p50 5.2ms → 28.5ms): E-cores stretch
//     the run, so it holds the memory longer under sustained pressure.
//   - Partial offload (-ngl 16) is the worst of both: still 5.4GB wired AND slower.
//
// So the mode is BINARY, and idle-unload matters more than either: the model is idle most of
// the time, and 3.5GB of resident weights helps nobody while it sits there.

import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { debugBus } from '../debug/bus'

export type BonsaiMode = 'background' | 'focus'

// process.cwd(), not __dirname/import.meta: this file is loaded as ESM (no __dirname) but is
// typechecked under a CJS-module tsconfig (which rejects import.meta). Both entry points —
// the server and the npm scripts — run from the repo root.
const ROOT = process.env.CRUCIBLE_ROOT || process.cwd()
const BIN = process.env.CRUCIBLE_BONSAI_BIN || join(ROOT, '.crucible', 'prismml-bin', 'llama-server')
const MODEL = process.env.CRUCIBLE_BONSAI_MODEL || join(ROOT, '.crucible', 'models', 'Bonsai-27B-Q1_0.gguf')
const PORT = Number(process.env.CRUCIBLE_BONSAI_PORT || 8080)
const BASE = `http://127.0.0.1:${PORT}`

/** Unload after this long with no requests — the single biggest courtesy to an 8GB machine. */
const IDLE_UNLOAD_MS = Number(process.env.CRUCIBLE_BONSAI_IDLE_MS || 120_000)
const START_TIMEOUT_MS = 90_000

function mode(): BonsaiMode {
  return (process.env.CRUCIBLE_BONSAI_MODE as BonsaiMode) === 'focus' ? 'focus' : 'background'
}

/**
 * `background` keeps the machine usable and is the DEFAULT — an agentic loop is something you
 * leave running while you work, so responsiveness beats tokens/sec. `focus` is for when the
 * box is yours to spend (you're away): ~3x the speed, at 435ms UI stalls.
 */
function argsFor(m: BonsaiMode): string[] {
  const common = ['-m', MODEL, '--jinja', '--host', '127.0.0.1', '--port', String(PORT)]
  // `-t 4` on a 2P+4E core box: measured, threads scale throughput when the machine is IDLE
  // (t2 1.84 / t4 2.53 / t6 3.16 tok/s) — but under real contention (you actually using the
  // machine) t4 and t6 converge (2.55 vs 2.62 tok/s) while t6 doubles the worst stall
  // (25ms → 45ms). Taking every core buys ~nothing and costs responsiveness, which is the
  // entire point of background mode.
  return m === 'focus'
    ? [...common, '-ngl', '99', '-c', '4096']
    : [...common, '-ngl', '0', '-c', '2048', '-t', '4']
}

let proc: ChildProcess | null = null
let starting: Promise<boolean> | null = null
let idleTimer: NodeJS.Timeout | null = null
let queue: Promise<unknown> = Promise.resolve()

export function isBonsaiInstalled(): boolean {
  return existsSync(BIN) && existsSync(MODEL)
}

async function healthy(timeoutMs = 1500): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    return r.ok
  } catch { return false }
}

function clearIdle(): void { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null } }

function armIdle(): void {
  clearIdle()
  if (IDLE_UNLOAD_MS <= 0) return
  idleTimer = setTimeout(() => { void stopBonsai('idle') }, IDLE_UNLOAD_MS)
  idleTimer.unref?.()
}

/** Stop the sidecar and RELEASE its memory. */
export async function stopBonsai(reason = 'explicit'): Promise<void> {
  clearIdle()
  const p = proc
  proc = null
  starting = null
  if (!p || p.exitCode !== null) return
  debugBus.emit('pipeline', 'bonsai_unload', { reason }, { severity: 'info' })
  await new Promise<void>(resolve => {
    // SIGTERM, then SIGKILL if it lingers. A stranded llama-server holds GB of memory and is
    // invisible until the machine crawls — this project has already lost a session to exactly
    // that (orphan servers read as a hardware VRAM ceiling that did not exist).
    const kill9 = setTimeout(() => { try { p.kill('SIGKILL') } catch { /* gone */ } }, 5_000)
    p.once('exit', () => { clearTimeout(kill9); resolve() })
    try { p.kill('SIGTERM') } catch { clearTimeout(kill9); resolve() }
  })
}

/** Start the sidecar if it isn't already serving. Safe to call concurrently. */
export async function ensureBonsai(): Promise<boolean> {
  if (!isBonsaiInstalled()) return false
  if (proc && proc.exitCode === null && await healthy()) return true
  if (starting) return starting
  starting = (async () => {
    if (await healthy()) return true            // someone else's server is already on the port
    const m = mode()
    debugBus.emit('pipeline', 'bonsai_load', { mode: m, port: PORT }, { severity: 'info' })
    const child = spawn(BIN, argsFor(m), { stdio: 'ignore', detached: false })
    child.on('exit', code => {
      if (proc === child) { proc = null; debugBus.emit('pipeline', 'bonsai_exit', { code }, { severity: 'info' }) }
    })
    proc = child
    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (child.exitCode !== null) { proc = null; return false }
      if (await healthy()) { armIdle(); return true }
      await new Promise(r => setTimeout(r, 1000))
    }
    await stopBonsai('start-timeout')
    return false
  })()
  try { return await starting } finally { starting = null }
}

export interface BonsaiOpts {
  maxTokens?: number
  temperature?: number
  /** Thinking is OFF by default: measured 9x the cost for ZERO accuracy gain (cont.88). */
  think?: boolean
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * One grounded completion. Requests are SERIALIZED: a second concurrent generation on this box
 * doubles the memory pressure and neither finishes sooner.
 */
export async function bonsaiComplete(
  messages: Array<{ role: string; content: string }>,
  opts: BonsaiOpts = {},
): Promise<string> {
  const run = async (): Promise<string> => {
    if (!await ensureBonsai()) throw new Error('bonsai sidecar unavailable')
    clearIdle()
    try {
      const body: Record<string, unknown> = {
        model: 'bonsai',
        messages,
        max_tokens: opts.maxTokens ?? 700,
        temperature: opts.temperature ?? 0.2,
      }
      if (!opts.think) body.chat_template_kwargs = { enable_thinking: false }
      // Generation is minutes-long in background mode, so the timeout must be generous AND
      // explicit: Node's undici kills a non-streaming request at 300s by default, which reads
      // as "fetch failed" while the model is healthy and mid-generation (cont.88).
      const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 900_000),
      })
      const j = await res.json() as any
      const msg = j?.choices?.[0]?.message ?? {}
      // Bonsai is a REASONING model: with thinking on, `content` stays EMPTY until it finishes
      // and the text lands in `reasoning_content`. Reading only `content` scores a truncated
      // run as an empty answer (cont.88 lost a whole arm to this).
      return (msg.content || msg.reasoning_content || '').trim()
    } finally { armIdle() }
  }
  const next = queue.then(run, run)
  queue = next.then(() => undefined, () => undefined)
  return next
}

// Never strand the server: an orphaned llama-server holds GB and is invisible until the box
// crawls. Best-effort synchronous kill on the way out.
function killSync(): void { try { proc?.kill('SIGKILL') } catch { /* gone */ } }
process.once('exit', killSync)
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => { killSync(); process.exit(0) })
}
