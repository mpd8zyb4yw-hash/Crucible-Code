import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Edit distance variants: Levenshtein, Damerau-Levenshtein, LCS, alignment.
export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  const dp = Array.from({ length: m + 1 }, (_, i) => new Array(n + 1).fill(0).map((_, j) => i || j))
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1])
  return dp[m][n]
}
export function lcs(a: string, b: string): number {
  const m = a.length, n = b.length
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1])
  return dp[m][n]
}
export function damerauLevenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  const dp = Array.from({ length: m+2 }, (_, i) => new Array(n+2).fill(i))
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++) {
      const cost = a[i-1] === b[j-1] ? 0 : 1
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost)
      if (i>1&&j>1&&a[i-1]===b[j-2]&&a[i-2]===b[j-1])
        dp[i][j] = Math.min(dp[i][j], dp[i-2][j-2]+cost)
    }
  return dp[m][n]
}
`
registerSkill({
  id: 'edit-distance',
  summary: 'Edit distance: Levenshtein, Damerau-Levenshtein, LCS.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bedit.?distance\b|\blevenshtein\b/i)) sc += 0.6
    if (s.has(/\bdamerau\b/i)) sc += 0.4
    if (s.has(/\blcs\b|longest.?common.?subsequence/i)) sc += 0.25
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/editDistance.ts', content: IMPL }]
  },
})
