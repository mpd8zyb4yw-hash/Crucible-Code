// Hermetic execution for Gate B — the spawn side of W30 (GAP_CLOSURE_ADDENDUM.md).
// The prelude (hermetic-prelude.cjs) governs what the CHILD can observe; this module
// governs how the child is LAUNCHED:
//
//   - Scrubbed environment. The oracle previously spawned candidates with
//     `env: process.env` — model-generated code inherited every API key on the box and
//     could print them into output that flows back into a model prompt. The child now
//     gets an explicit allowlist: PATH/HOME/TMPDIR (toolchain needs), pinned TZ/locale
//     (determinism), and the hermetic controls. Nothing else exists to leak.
//   - SIGKILL reaping. SIGTERM cannot stop a busy-looping candidate (node can only run
//     the JS signal handler between ticks, and a busy loop never yields), so the old
//     reap was best-effort against exactly the candidates most likely to need it.
//   - Heap cap. A runaway allocation dies at 512MB instead of pressuring an 8GB box
//     that is also holding a resident model.
//
// Kept deliberately interface-compatible with oracle.ts's RunOut so the wiring diff in
// the oracle is two lines per call site — oracle.ts belongs to Track A (W7 reorders its
// gates); this file is Track B territory (see NEXT_SESSION.md ownership).

import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync, spawn } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'
import { createRequire } from 'module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CODE_DIR = path.resolve(HERE, '../../..')

/**
 * Invoke tsx directly through node, not through npx. NODE_OPTIONS reaches every node
 * process in the spawn chain, and npx requires 'http' internally — the network denial
 * built for the CANDIDATE was killing the TOOLING (found live by __hermetic_bench: npx
 * died with HERMETIC_NET_DENIED before the probe ever ran). Cutting npx out of the chain
 * removes that entire class, plus ~300ms of npx startup per Gate-B run. Falls back to npx
 * only when tsx is not locally resolvable; the prelude's conditional arming (see
 * hermetic-prelude.cjs) keeps even that path safe.
 */
const TSX_CLI: string | null = (() => {
  try { return createRequire(path.join(CODE_DIR, 'package.json')).resolve('tsx/cli') } catch { return null }
})()

/**
 * The tsx loader as IN-PROCESS flags, not the `tsx` CLI wrapper.
 *
 * REAPING BUG (found live 2026-07-22g): `node tsx/cli entry.ts` is a DOUBLE FORK — the tsx
 * CLI re-spawns a second node process (the real loader worker) as its child, then execs the
 * candidate there. When the timeout SIGKILLs the process we spawned (the CLI wrapper), the
 * worker is orphaned to PID 1 and keeps running FOREVER — a SIGTERM-immune `for(;;){}` probe
 * from a 3s-capped run was found still busy-looping 13h later, four of them pinning four cores
 * and starving the live bench. SIGKILL cannot be ignored, so the reaper was correct; it was
 * aimed at the wrapper, not the worker.
 *
 * Fix: inject tsx's own loader flags (`--require preflight.cjs --import loader.mjs`) — exactly
 * what the CLI would have injected into its worker — directly onto OUR node invocation, so the
 * candidate runs in the single process we spawned and its pid IS the reap target. Absolute
 * paths, because the child's cwd is the candidate temp dir where bare `tsx` will not resolve.
 * Determinism's `--no-cache` becomes the loader-honored `TSX_DISABLE_CACHE=1` (see hermeticEnv).
 */
const TSX_INPROC: string[] | null = (() => {
  try {
    const req = createRequire(path.join(CODE_DIR, 'package.json'))
    const preflight = req.resolve('tsx/preflight')     // CJS require hook
    const loader = pathToFileURL(req.resolve('tsx')).href // ESM loader (dist/loader.mjs)
    return ['--require', preflight, '--import', loader]
  } catch { return null }
})()

/** Absolute path to the prelude. NODE_OPTIONS cannot quote paths containing spaces, so
 *  if this repo ever lives under one, fall back to a copy in a space-free tmp dir. */
const PRELUDE = (() => {
  const local = path.join(HERE, 'hermetic-prelude.cjs')
  if (!local.includes(' ')) return local
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-hermetic-'))
  const dest = path.join(dir, 'prelude.cjs')
  fs.copyFileSync(local, dest)
  return dest
})()

export const DEFAULT_SEED = 0xC0FFEE
const HEAP_MB = 512

export interface HermeticOut { ok: boolean; out: string; timedOut: boolean }

/**
 * The child's entire world, explicitly enumerated. PATH and HOME stay because npx/tsx
 * resolve through them; everything else the parent knows — keys, tokens, user env —
 * simply does not exist in the child.
 */
export function hermeticEnv(entryAbs: string, seed: number = DEFAULT_SEED): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    TZ: 'UTC',
    LANG: 'C',
    LC_ALL: 'C',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CRUCIBLE_HERMETIC_SEED: String(seed),
    // The prelude arms only in the process whose argv carries this entry path — tooling
    // processes in the chain (npx fallback, npm) stay untouched.
    CRUCIBLE_HERMETIC_ENTRY: entryAbs,
    // The in-process tsx loader honors this instead of the `--no-cache` CLI flag we dropped
    // when we stopped shelling out through the tsx wrapper (see TSX_INPROC). Load-bearing for
    // determinism: a cache hit reads the frozen clock fewer times than a cold compile, so the
    // two accept-side runs would diverge. Both cold ⇒ identical history ⇒ identical output.
    TSX_DISABLE_CACHE: '1',
    NODE_OPTIONS: `--require ${PRELUDE} --max-old-space-size=${HEAP_MB}`,
  }
}

/**
 * The spawn vector: direct node→tsx when resolvable, npx fallback otherwise.
 * --no-cache is load-bearing for determinism, not an optimization choice: with the cache
 * on, run 1 compiles (reading the frozen clock N times) and run 2 hits the cache (reading
 * it M<N times), so the candidate sees shifted tick values and byte-identical re-runs are
 * impossible. Found live by the accept-side double-run catching its own harness — the
 * exact hidden-cross-run-state class W30 exists to kill. Both runs cold ⇒ identical
 * history ⇒ identical output.
 */
function spawnVector(entryAbs: string): { cmd: string; args: string[] } {
  // Preferred: single-process, in-process tsx loader — the candidate runs in the node we
  // spawn, so its pid is the reap target (see TSX_INPROC). --no-cache → TSX_DISABLE_CACHE env.
  if (TSX_INPROC) return { cmd: process.execPath, args: [...TSX_INPROC, entryAbs] }
  // Fallbacks still shell out through a wrapper that may double-fork; the async path spawns
  // them detached and group-kills to reap the worker regardless (see runHermeticAsync).
  if (TSX_CLI) return { cmd: process.execPath, args: [TSX_CLI, '--no-cache', entryAbs] }
  return { cmd: 'npx', args: ['tsx', '--no-cache', entryAbs] }
}

/** Blocking hermetic run of a tsx entrypoint — Gate B's synchronous path. */
export function runHermeticSync(entryAbs: string, cwd: string, timeoutMs: number, seed: number = DEFAULT_SEED): HermeticOut {
  const { cmd, args } = spawnVector(entryAbs)
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 8 * 1024 * 1024,
    env: hermeticEnv(entryAbs, seed),
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const timedOut = r.signal === 'SIGKILL' || (r.error as any)?.code === 'ETIMEDOUT'
  return { ok: r.status === 0, out, timedOut }
}

/** Non-blocking twin for the live-server path — must never stall the event loop. */
export function runHermeticAsync(entryAbs: string, cwd: string, timeoutMs: number, seed: number = DEFAULT_SEED): Promise<HermeticOut> {
  return new Promise(resolve => {
    let out = ''
    let timedOut = false
    const { cmd, args } = spawnVector(entryAbs)
    // detached: the child leads its own process group, so a group-kill reaps any worker it
    // forked (the tsx-wrapper fallbacks double-fork). The primary in-process vector is a single
    // process, so the group is just itself — group-kill is a strict superset of child.kill.
    const child = spawn(cmd, args, { cwd, env: hermeticEnv(entryAbs, seed), detached: true })
    const reap = () => {
      try { if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
      child.kill('SIGKILL') // belt-and-suspenders if the group send raced the exit
    }
    const timer = setTimeout(() => { timedOut = true; reap() }, timeoutMs)
    const cap = (d: Buffer) => { out += d.toString('utf8'); if (out.length > 8 * 1024 * 1024) reap() }
    child.stdout?.on('data', cap)
    child.stderr?.on('data', cap)
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, out: `${out}${String(e)}`, timedOut }) })
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, out, timedOut }) })
  })
}

/**
 * First line where two runs of the same entrypoint disagreed — the evidence string for a
 * NONDETERMINISTIC verdict. Kept short: it lands in a retry prompt, not a log file.
 */
export function firstDivergence(a: string, b: string): string {
  const la = a.split('\n'), lb = b.split('\n')
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) {
      return `line ${i + 1}: run1=${JSON.stringify((la[i] ?? '<absent>').slice(0, 120))} run2=${JSON.stringify((lb[i] ?? '<absent>').slice(0, 120))}`
    }
  }
  return 'exit codes differed with identical output'
}
