// Statistical honesty for every bench report (W42/W43, GAP_CLOSURE_ADDENDUM.md).
//
// The problem this kills: at n=14, a 40% pass rate has a 95% CI of roughly ±26 points, so
// most measured "improvements" are luck — and a project that tunes against luck spends weeks
// believing it is making progress. Every pass-rate report should carry its interval, and
// every before/after comparison should be judged against the minimum detectable delta.
//
// Wilson score interval, not normal approximation: correct behavior at small n and extreme
// rates (0/10 must not report an interval of exactly [0,0] — the data does not support that
// certainty), which is precisely the regime this project's benches live in.

export interface Interval { lo: number; hi: number }

const Z95 = 1.959963984540054

/** Wilson score interval for k successes in n trials. Returns proportions in [0,1]. */
export function wilson(k: number, n: number, z: number = Z95): Interval {
  if (n <= 0) return { lo: 0, hi: 1 }
  if (k < 0 || k > n || !Number.isFinite(k) || !Number.isFinite(n)) throw new RangeError(`wilson: bad k=${k} n=${n}`)
  const p = k / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) }
}

/**
 * The smallest before/after difference worth believing at this n, approximated as the
 * half-width of the Wilson interval at the observed rate (a delta smaller than the ruler's
 * own tick marks is noise). For planning, call with the rate you expect (~0.4–0.5, the
 * widest case).
 */
export function minDetectableDelta(n: number, atRate = 0.5): number {
  const k = Math.round(atRate * n)
  const iv = wilson(k, n)
  return (iv.hi - iv.lo) / 2
}

/** "4/10 (40%, 95% CI 17–69%)" — the only honest way to print a pass rate. */
export function formatRate(k: number, n: number): string {
  if (n === 0) return '0/0 (no trials — no claim)'
  const iv = wilson(k, n)
  const pct = (x: number) => `${Math.round(x * 100)}%`
  return `${k}/${n} (${pct(k / n)}, 95% CI ${pct(iv.lo)}–${pct(iv.hi)})`
}

/**
 * Is an observed before→after change actually evidence at these sample sizes? True only
 * when the two Wilson intervals do not overlap — conservative on purpose: the cost of
 * believing a phantom improvement (weeks of tuning against noise) dwarfs the cost of
 * waiting for one more data point.
 */
export function isSignificant(kBefore: number, nBefore: number, kAfter: number, nAfter: number): boolean {
  const a = wilson(kBefore, nBefore)
  const b = wilson(kAfter, nAfter)
  return a.hi < b.lo || b.hi < a.lo
}
