import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Suffix Array + LCP array (O(n log n) SA-IS simplified).
export function buildSuffixArray(s: string): number[] {
  const n = s.length
  const sa = Array.from({ length: n }, (_, i) => i)
  const rank = Array.from(s, c => c.charCodeAt(0))
  const tmp = new Array(n)
  for (let gap = 1; gap < n; gap <<= 1) {
    const r = rank.slice()
    sa.sort((a, b) => r[a] !== r[b] ? r[a] - r[b] : (r[a + gap] ?? -1) - (r[b + gap] ?? -1))
    tmp[sa[0]] = 0
    for (let i = 1; i < n; i++) {
      tmp[sa[i]] = tmp[sa[i-1]] + (r[sa[i]] !== r[sa[i-1]] || (r[sa[i]+gap]??-1) !== (r[sa[i-1]+gap]??-1) ? 1 : 0)
    }
    rank.splice(0, n, ...tmp)
    if (rank[sa[n-1]] === n-1) break
  }
  return sa
}
export function buildLCP(s: string, sa: number[]): number[] {
  const n = s.length; const rank = new Array(n); const lcp = new Array(n).fill(0)
  sa.forEach((v, i) => rank[v] = i)
  let h = 0
  for (let i = 0; i < n; i++) {
    if (rank[i] > 0) {
      const j = sa[rank[i] - 1]
      while (i + h < n && j + h < n && s[i+h] === s[j+h]) h++
      lcp[rank[i]] = h
      if (h) h--
    }
  }
  return lcp
}
export function searchSA(s: string, sa: number[], pattern: string): number {
  let lo = 0, hi = sa.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const cmp = s.slice(sa[mid], sa[mid] + pattern.length).localeCompare(pattern)
    if (cmp < 0) lo = mid + 1; else if (cmp > 0) hi = mid - 1; else return sa[mid]
  }
  return -1
}
`
registerSkill({
  id: 'suffix-array',
  summary: 'Suffix array + LCP: O(n log n) build, O(log n) pattern search.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bsuffix.?array\b/i)) sc += 0.6
    if (s.has(/\blcp\b|longest.?common.?prefix/i)) sc += 0.3
    if (s.has(/\bsuffix\b/i) && s.has(/\bsort\b/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/suffixArray.ts', content: IMPL }]
  },
})
