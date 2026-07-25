/**
 * Unhandled-rejection guard for sandboxed answer code.
 *
 * The execution verifiers run the answer's OWN code inside `vm`. A synchronous throw is caught by
 * the try/catch around `runInContext` — but ASYNC code (`async function f(){ await fetch(...) }`
 * called for its side effect) rejects on a LATER tick, after `runInContext` has already returned.
 * That rejection has no handler, so Node's default kicks in and KILLS THE HOST PROCESS. Measured
 * live (2026-07-25): an answer whose demo called `fetch` (undefined in the sandbox — network is
 * denied by design) took the whole bench process down mid-run with
 * `ReferenceError: fetch is not defined`, so the verifier crashed the engine instead of judging
 * the candidate. Untrusted-by-construction code must never be able to do that.
 *
 * The guard installs ONE process-level `unhandledRejection` listener and swallows rejections only
 * while a sandbox run is in flight (plus a short grace window, since the rejection surfaces after
 * the sync run returns). Any rejection outside that window is re-raised as an `uncaughtException`,
 * preserving Node's default crash behaviour for the host's own bugs — the guard hides sandbox
 * noise, never real failures.
 */

let active = 0
let installed = false

function onUnhandledRejection(reason: unknown): void {
  if (active > 0) return   // sandboxed answer code rejected — the verifier's verdict, not a crash
  // Not ours: restore Node's default so a genuine host bug still surfaces loudly.
  process.emit('uncaughtException', reason instanceof Error ? reason : new Error(String(reason)))
}

/**
 * Run `fn` (a synchronous `vm` execution) with sandbox rejections neutralized. The window stays
 * open for `graceMs` after `fn` returns so a rejection settling on the next tick is still covered.
 */
export function withSandboxRejectionGuard<T>(fn: () => T, graceMs = 2000): T {
  if (!installed) {
    process.on('unhandledRejection', onUnhandledRejection)
    installed = true
  }
  active++
  try {
    return fn()
  } finally {
    const t = setTimeout(() => { active-- }, graceMs)
    // Never hold the process open just to close a guard window.
    if (typeof (t as any).unref === 'function') (t as any).unref()
  }
}
