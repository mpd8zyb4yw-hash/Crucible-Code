// Verified primitive: rate limiters — token bucket + sliding-window, both with an injectable
// clock for deterministic behavior. General; the "rate limiting / throttling" task family
// maps onto it.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — verified token-bucket + sliding-window limiters.

export class TokenBucket {
  private tokens: number
  private last: number
  constructor(private capacity: number, private refillPerSec: number, private now: () => number = Date.now) {
    this.tokens = capacity
    this.last = now()
  }
  private refill(): void {
    const t = this.now()
    const elapsedSec = (t - this.last) / 1000
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec)
      this.last = t
    }
  }
  tryRemove(tokens = 1): boolean {
    this.refill()
    if (this.tokens >= tokens) { this.tokens -= tokens; return true }
    return false
  }
}

export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>()
  constructor(private limit: number, private windowMs: number, private now: () => number = Date.now) {}
  allow(key: string): boolean {
    const t = this.now()
    const recent = (this.hits.get(key) ?? []).filter(ts => ts > t - this.windowMs)
    if (recent.length >= this.limit) { this.hits.set(key, recent); return false }
    recent.push(t)
    this.hits.set(key, recent)
    return true
  }
}
`

registerSkill({
  id: 'rate-limiter',
  summary: 'Token-bucket and sliding-window rate limiters with injectable clock.',
  match(s: SpecFeatures): number {
    let score = 0
    if (s.has(/rate[- ]?limit/i)) score += 0.4
    if (s.has(/token[- ]?bucket/i)) score += 0.3
    if (s.has(/sliding[- ]?window/i)) score += 0.3
    if (s.has(/\bTokenBucket\b/)) score += 0.25
    if (s.has(/\bSlidingWindowLimiter\b/)) score += 0.25
    if (s.has(/throttl/i)) score += 0.15
    return score
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/ratelimiter.ts', content: IMPL }]
  },
})
