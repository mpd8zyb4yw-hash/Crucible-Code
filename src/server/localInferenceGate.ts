// ── The on-device availability latch ──────────────────────────────────────────────────────
//
// THE BUG THIS EXISTS TO FIX (measured 2026-08-04, two consecutive boots, same machine, same
// healthy daemon):
//
//   boot A  [Local] Apple Foundation Models bridge up — on-device inference active
//   boot B  [Local] FM bridge not running — local inference inactive (external pool only)
//
// Nothing about the daemon changed between them — it answered `{"available":true}` on port
// 11435 throughout, and still did after boot B's agent turns had all failed. What changed was
// who won a race: the probe is one `fetch` with a 2s timeout, fired at boot alongside corpus
// loading, the model hunter and the Python prewarm, and its result was latched into a module
// flag FOR THE LIFETIME OF THE PROCESS.
//
// That flag gates every tool-executing layer in the agent path (the content path, the Layer 2
// FM planner, and Layer 2.5's fmReact — the only executor that actually calls tools). So a lost
// 2-second race silently converted the agent into a prose generator: zero tool calls, a plan
// narrated in future tense as the "answer", `agent_done ok:true` and `verify passed:true`.
// Restarting the server "fixed" it, which is exactly why it read as random breakage.
//
// The rule here is deliberately one-directional:
//
//   · while DOWN, re-probe (rate-limited) — a boot-time miss must be recoverable, and the
//     daemon may simply have been slower to start than the server was;
//   · once UP, latch and stop probing — the flag is read on the hot path, and a transient
//     health-check blip must not be able to take working tools away mid-session. A daemon that
//     dies later surfaces as a failed CALL, which every layer already handles by falling
//     through, rather than as a silent capability downgrade.
//
// So this can only ever ENABLE tools that were wrongly disabled. It can never disable working
// ones. See `__localInferenceGate_bench.ts`.

export interface LocalInferenceGate {
  /** True when on-device inference may be used. Re-probes at most once per TTL while down. */
  ready(): Promise<boolean>
  /** Last known state, without probing — for diagnostics and non-blocking reads. */
  lastKnown(): boolean
  /** Probe count, for the bench. */
  probes(): number
}

export function makeLocalInferenceGate(opts: {
  /** Resolves true when the on-device bridge is usable. Must not throw. */
  probe: () => Promise<boolean>
  /** Minimum gap between probes while DOWN. */
  ttlMs?: number
  now?: () => number
  /** Called once, when the gate first flips up — so the log line still happens exactly once. */
  onUp?: () => void
}): LocalInferenceGate {
  const ttlMs = opts.ttlMs ?? 15_000
  const now = opts.now ?? (() => Date.now())
  let up = false
  let lastProbeAt = -Infinity
  let probeCount = 0
  // Collapse concurrent callers onto ONE probe: the agent path can ask several times inside a
  // single request, and N parallel health checks against a daemon that is busy starting up is
  // the very contention that loses the race in the first place.
  let inflight: Promise<boolean> | null = null

  return {
    lastKnown: () => up,
    probes: () => probeCount,
    async ready(): Promise<boolean> {
      if (up) return true
      if (inflight) return inflight
      if (now() - lastProbeAt < ttlMs) return false
      lastProbeAt = now()
      probeCount++
      inflight = (async () => {
        let ok = false
        try { ok = await opts.probe() } catch { ok = false }
        if (ok && !up) { up = true; try { opts.onUp?.() } catch {} }
        return up
      })()
      try { return await inflight } finally { inflight = null }
    },
  }
}
