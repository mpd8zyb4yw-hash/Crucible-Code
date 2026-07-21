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
import { fileURLToPath } from 'url'
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
  return TSX_CLI
    ? { cmd: process.execPath, args: [TSX_CLI, '--no-cache', entryAbs] }
    : { cmd: 'npx', args: ['tsx', '--no-cache', entryAbs] }
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
    const child = spawn(cmd, args, { cwd, env: hermeticEnv(entryAbs, seed) })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    const cap = (d: Buffer) => { out += d.toString('utf8'); if (out.length > 8 * 1024 * 1024) child.kill('SIGKILL') }
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
