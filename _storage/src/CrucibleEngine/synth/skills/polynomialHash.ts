// Verified primitive: polynomial rolling hash + Rabin-Karp multi-pattern string search.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — polynomial hash + Rabin-Karp.
const MOD1 = 1_000_000_007n; const BASE1 = 131n
const MOD2 = 998_244_353n;   const BASE2 = 137n

export class PolyHash {
  private h1: bigint[]; private h2: bigint[]
  private pw1: bigint[]; private pw2: bigint[]

  constructor(s: string) {
    const n = s.length
    this.h1 = new Array(n + 1).fill(0n); this.h2 = new Array(n + 1).fill(0n)
    this.pw1 = new Array(n + 1).fill(1n); this.pw2 = new Array(n + 1).fill(1n)
    for (let i = 0; i < n; i++) {
      const c = BigInt(s.charCodeAt(i))
      this.h1[i+1] = (this.h1[i] * BASE1 + c) % MOD1
      this.h2[i+1] = (this.h2[i] * BASE2 + c) % MOD2
      this.pw1[i+1] = this.pw1[i] * BASE1 % MOD1
      this.pw2[i+1] = this.pw2[i] * BASE2 % MOD2
    }
  }

  /** Double hash of s[l..r] (inclusive, 0-indexed). */
  get(l: number, r: number): [bigint, bigint] {
    const len = r - l + 1
    const v1 = (this.h1[r+1] - this.h1[l] * this.pw1[len] % MOD1 + MOD1 * MOD1) % MOD1
    const v2 = (this.h2[r+1] - this.h2[l] * this.pw2[len] % MOD2 + MOD2 * MOD2) % MOD2
    return [v1, v2]
  }
}

/** Rabin-Karp: find all occurrences of each pattern in text. */
export function rabinKarp(text: string, patterns: string[]): Map<string, number[]> {
  const th = new PolyHash(text); const result = new Map<string, number[]>()
  for (const pat of patterns) {
    const m = pat.length; const ph = new PolyHash(pat); const [p1, p2] = ph.get(0, m - 1); const hits: number[] = []
    for (let i = 0; i + m <= text.length; i++) {
      const [t1, t2] = th.get(i, i + m - 1)
      if (t1 === p1 && t2 === p2 && text.slice(i, i + m) === pat) hits.push(i)
    }
    result.set(pat, hits)
  }
  return result
}
`
registerSkill({
  id: 'polynomial-hash',
  summary: 'Double polynomial hash + Rabin-Karp multi-pattern string search.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\brabin.?karp\b/i)) sc += 0.5
    if (s.has(/\bpolynomial.?hash\b/i)) sc += 0.5
    if (s.has(/\brolling.?hash\b/i)) sc += 0.3
    if (s.has(/\bdouble.?hash\b/i)) sc += 0.3
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/polyHash.ts', content: IMPL }]
  },
})
