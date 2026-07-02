// Auto-distilled by Crucible — oracle-verified at distillation time. Do not edit.
// Content-addressed ID: bc67de0ca5b9 (sha256 of spec+content, first 12 hex chars).
import { registerSkill, type SpecFeatures } from '../../synthEngine'

const IMPL: string = "// Synthesized by Crucible — Fuzzy string match score and Levenshtein edit distance.\nexport function editDistance(a: string, b: string): number {\n  const m = a.length, n = b.length\n  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>\n    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0))\n  for (let i = 1; i <= m; i++)\n    for (let j = 1; j <= n; j++)\n      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]\n        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1])\n  return dp[m][n]\n}\n\nexport function fuzzyScore(pattern: string, text: string): number {\n  if (!pattern) return 1\n  if (!text) return 0\n  const p = pattern.toLowerCase(), t = text.toLowerCase()\n  let score = 0, pi = 0, consecutive = 0\n  for (let ti = 0; ti < t.length && pi < p.length; ti++) {\n    if (t[ti] === p[pi]) {\n      score += 1 + consecutive\n      consecutive++\n      pi++\n    } else consecutive = 0\n  }\n  return pi === p.length ? score / (text.length + pattern.length) : 0\n}\n"
const DEFAULT_PATH: string = "src/editDistance.ts"

registerSkill({
  id: "learned/bc67de0ca5b9",
  summary: "Learned (distilled, oracle-verified) primitive exporting editDistance.",
  match(s: SpecFeatures): number {
    let hits = 0
    if (s.has(/\beditDistance\b/)) hits++
    return hits / 1
  },
  emit(s: SpecFeatures) {
    return [{ path: s.modulePath ?? DEFAULT_PATH, content: IMPL }]
  },
})
