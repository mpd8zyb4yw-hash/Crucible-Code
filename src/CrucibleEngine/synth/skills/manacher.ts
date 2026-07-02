import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Manacher's algorithm: all palindromic substrings in O(n).
export function manacher(s: string): { center: number[]; longestStart: number; longestLen: number } {
  const t = ('#' + s.split('').join('#') + '#')
  const n = t.length; const p = new Array(n).fill(0)
  let c = 0, r = 0
  for (let i = 0; i < n; i++) {
    const mirror = 2 * c - i
    if (i < r) p[i] = Math.min(r - i, p[mirror])
    while (i + p[i] + 1 < n && i - p[i] - 1 >= 0 && t[i + p[i] + 1] === t[i - p[i] - 1]) p[i]++
    if (i + p[i] > r) { c = i; r = i + p[i] }
  }
  let maxLen = 0, maxIdx = 0
  for (let i = 0; i < n; i++) if (p[i] > maxLen) { maxLen = p[i]; maxIdx = i }
  return { center: p, longestStart: (maxIdx - maxLen) >> 1, longestLen: maxLen }
}
export function longestPalindrome(s: string): string {
  const { longestStart, longestLen } = manacher(s)
  return s.slice(longestStart, longestStart + longestLen)
}
`
registerSkill({
  id: 'manacher',
  summary: "Manacher's algorithm: all palindromic substrings in O(n).",
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bmanacher\b/i)) sc += 0.7
    if (s.has(/\bpalindrom\w+\b/i) && s.has(/\bo\(n\)\b/i)) sc += 0.3
    if (s.has(/\blongest.?palindrom\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/manacher.ts', content: IMPL }]
  },
})
