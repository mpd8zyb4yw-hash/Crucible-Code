import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Z-function: z[i] = length of longest s[i..] prefix matching s, O(n).
export function zFunction(s: string): number[] {
  const n = s.length; const z = new Array(n).fill(0); z[0] = n
  let l = 0, r = 0
  for (let i = 1; i < n; i++) {
    if (i < r) z[i] = Math.min(r - i, z[i - l])
    while (i + z[i] < n && s[z[i]] === s[i + z[i]]) z[i]++
    if (i + z[i] > r) { l = i; r = i + z[i] }
  }
  return z
}
export function zSearch(text: string, pattern: string): number[] {
  const s = pattern + '$' + text
  const z = zFunction(s); const hits: number[] = []
  for (let i = pattern.length + 1; i < s.length; i++)
    if (z[i] >= pattern.length) hits.push(i - pattern.length - 1)
  return hits
}
`
registerSkill({
  id: 'z-function',
  summary: 'Z-function: prefix matching array in O(n), used for string search.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bz.?function\b|\bz.?algorithm\b/i)) sc += 0.7
    if (s.has(/\bprefix.?match\b/i) && s.has(/\bo\(n\)\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/zFunction.ts', content: IMPL }]
  },
})
