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
import { join, dirname } from 'path'
import { debugBus } from '../debug/bus'

export type BonsaiMode = 'background' | 'focus'

// process.cwd(), not __dirname/import.meta: this file is loaded as ESM (no __dirname) but is
// typechecked under a CJS-module tsconfig (which rejects import.meta). Both entry points —
// the server and the npm scripts — run from the repo root.
const ROOT = process.env.CRUCIBLE_ROOT || process.cwd()
const BIN = process.env.CRUCIBLE_BONSAI_BIN || join(ROOT, '.crucible', 'prismml-bin', 'llama-server')
const PORT = Number(process.env.CRUCIBLE_BONSAI_PORT || 8080)
const BASE = `http://127.0.0.1:${PORT}`

/**
 * THE REPAIR SEAT GOES TO THE FASTEST MODEL THAT CAN ACTUALLY DO THE JOB — measured, not assumed.
 *
 * cont.88 proved the Apple FM cannot copy an identifier out of clean evidence (0/3) while
 * Bonsai-27B can (3/3), and the obvious-but-wrong conclusion was "we need the 27B". cont.89 tested
 * the MIDDLE of the range that A/B skipped, same fixture, same prompt, EXECUTING oracle:
 *
 *   model              size     copies z.ipv4   EXECUTES   speed
 *   qwen2.5-1.5b       1.1 GB       3/3           3/3      30.4 tok/s
 *   phi-3.5-mini       2.4 GB       3/3           3/3       8.7 tok/s
 *   Bonsai-27B Q1_0    3.8 GB       3/3           3/3       2.5 tok/s
 *   gemma-2-2b         1.7 GB       1/3           2/3      11.0 tok/s
 *
 * A 1.5B does it as well as the 27B, **12x faster and 3.5x smaller**. So the FM's failure was
 * never about parameter count — it is that specific model. Putting a 27B on the interactive path
 * would have cost ~150s per repair and 3.8GB of an 8GB machine to buy exactly nothing.
 *
 * Order below is "cheapest proven engine first". Bonsai stays as a fallback because it IS proven,
 * and because a harder task than identifier-copying may yet need it — but it is no longer the
 * default, and nothing should put it on an interactive path without measuring first.
 */
const REPAIR_MODELS = [
  'qwen2.5-1.5b-instruct-q4_k_m.gguf',   // 3/3 executes @ 30.4 tok/s — the seat
  'phi-3.5-mini-instruct-q4_k_m.gguf',   // 3/3 executes @ 8.7 tok/s
  'Bonsai-27B-Q1_0.gguf',                // 3/3 executes @ 2.5 tok/s — proven, but slow and big
]

function resolveModel(): string {
  const override = process.env.CRUCIBLE_BONSAI_MODEL
  if (override) return override
  for (const name of REPAIR_MODELS) {
    const p = join(ROOT, '.crucible', 'models', name)
    if (existsSync(p)) return p
  }
  return join(ROOT, '.crucible', 'models', REPAIR_MODELS[0])
}

const MODEL = resolveModel()
/** A 27B needs the wired-memory dance below; a 1.5B does not. */
const IS_BIG = /bonsai/i.test(MODEL)

/**
 * The seated model's short name, for telemetry and for the user-facing "bringing in X" line.
 * Derived from the resolved path — never hardcoded: the seat said "bonsai" while actually
 * running qwen2.5-1.5b, which is exactly the kind of quiet lie that makes a trace unreadable.
 */
export function repairModelName(): string {
  const base = MODEL.split('/').pop() ?? MODEL
  return base.replace(/\.gguf$/i, '').replace(/-instruct.*$/i, '').replace(/-Q\d.*$/i, '').toLowerCase()
}

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
  // A SMALL model does not need the wired-memory tradeoff at all: qwen2.5-1.5b is ~1.1GB, so
  // GPU offload costs little wired memory and buys real speed. The -ngl 0 rule exists because
  // a 27B pins 6.6GB of an 8GB machine — that reasoning does not transfer to a 1.5B.
  if (!IS_BIG) return [...common, '-ngl', '99', '-c', '4096']
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
    // The PrismML llama-server binary was built with an @rpath pointing at the (now-gone) build
    // tree, so dyld cannot find its sibling dylibs (libllama-server-impl.dylib et al.) unless we
    // point DYLD_LIBRARY_PATH at the binary's own directory. WITHOUT THIS the child exits on
    // launch with "Library not loaded", ensureBonsai() times out, and every head/repair call
    // silently falls back to the Apple FM — which is exactly the bug that made the sidecar look
    // seated while never actually running (cont.90). The libs live next to the binary.
    const binDir = dirname(BIN)
    const child = spawn(BIN, argsFor(m), {
      stdio: 'ignore',
      detached: false,
      env: {
        ...process.env,
        DYLD_LIBRARY_PATH: [binDir, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(':'),
        DYLD_FALLBACK_LIBRARY_PATH: [binDir, process.env.DYLD_FALLBACK_LIBRARY_PATH].filter(Boolean).join(':'),
      },
    })
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

/**
 * Streaming completion — same OpenAI `/v1/chat/completions` SSE shape the Apple FM daemon speaks
 * (llama-server is OpenAI-compatible), so the caller's delta parser is identical. Serialized on
 * the same queue as bonsaiComplete: one generation at a time on an 8GB box. Used when the local
 * model LEADS as the head (see CRUCIBLE_HEAD) so the interactive draft streams token-by-token
 * exactly as the FM path did. Throws on an unavailable sidecar so the caller can fall back to FM.
 */
export async function sidecarStream(
  messages: Array<{ role: string; content: string }>,
  onDelta: (delta: string) => void,
  opts: BonsaiOpts = {},
): Promise<string> {
  const run = async (): Promise<string> => {
    if (!await ensureBonsai()) throw new Error('bonsai sidecar unavailable')
    clearIdle()
    try {
      const body: Record<string, unknown> = {
        model: 'bonsai',
        messages,
        stream: true,
        max_tokens: opts.maxTokens ?? 1536,
        temperature: opts.temperature ?? 0.2,
      }
      if (!opts.think) body.chat_template_kwargs = { enable_thinking: false }
      const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 900_000),
      })
      if (!res.ok || !res.body) throw new Error(`sidecar HTTP ${res.status}`)
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let full = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop() ?? ''
        for (const part of parts) {
          const line = part.split('\n').find(l => l.startsWith('data:'))
          if (!line) continue
          const p = line.slice(5).trim()
          if (p === '[DONE]') continue
          let ev: any
          try { ev = JSON.parse(p) } catch { continue }
          const delta = ev?.choices?.[0]?.delta?.content ?? ''
          if (delta) { full += delta; try { onDelta(delta) } catch { /* sink errors */ } }
        }
      }
      return full.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
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
