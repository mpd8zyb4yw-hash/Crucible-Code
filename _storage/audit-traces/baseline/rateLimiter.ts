/**
 * Sliding-window rate limiter: at most `limit` requests per `windowMs` per key.
 *
 * True sliding window (not fixed buckets): each key keeps the timestamps of its
 * accepted requests; on each call, timestamps older than the window are evicted
 * and the decision is made on what remains.
 */
export class SlidingWindowRateLimiter {
  private hits = new Map<string, number[]>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (limit < 0) throw new RangeError('limit must be >= 0')
    if (windowMs <= 0) throw new RangeError('windowMs must be > 0')
  }

  tryAcquire(key: string): boolean {
    const t = this.now()
    const cutoff = t - this.windowMs
    const times = this.hits.get(key) ?? []
    // Evict anything at or beyond the window edge. Timestamps are ascending, so
    // findIndex gives the first survivor.
    const firstLive = times.findIndex(ts => ts > cutoff)
    const live = firstLive === -1 ? [] : times.slice(firstLive)
    if (live.length >= this.limit) { this.hits.set(key, live); return false }
    live.push(t)
    this.hits.set(key, live)
    return true
  }
}
