// Per-model latency tracking (rolling last-N samples → avg/p50/p95), extracted from server.ts
// so the percentile math and window behavior are unit-testable. server.ts holds one tracker
// instance and keeps thin recordLatency/getLatencyReport wrappers so call sites are unchanged.

export interface LatencyReport { avg: number; p50: number; p95: number; samples: number }

/** Nearest-rank percentile of an ASCENDING-sorted array; 0 for an empty array. */
export function percentile(sorted: number[], p: number): number {
  const idx = Math.floor(sorted.length * p)
  return sorted[Math.min(idx, sorted.length - 1)] ?? 0
}

export class LatencyTracker {
  private readonly stats: Record<string, number[]> = {}
  private readonly window: number
  constructor(window = 50) { this.window = window }

  record(modelId: string, latencyMs: number): void {
    const arr = this.stats[modelId] ?? (this.stats[modelId] = [])
    arr.push(latencyMs)
    if (arr.length > this.window) arr.shift()
  }

  report(): Record<string, LatencyReport> {
    const out: Record<string, LatencyReport> = {}
    for (const [id, samples] of Object.entries(this.stats)) {
      if (!samples.length) continue
      const sorted = [...samples].sort((a, b) => a - b)
      const avg = Math.round(samples.reduce((s, v) => s + v, 0) / samples.length)
      out[id] = { avg, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), samples: samples.length }
    }
    return out
  }
}
