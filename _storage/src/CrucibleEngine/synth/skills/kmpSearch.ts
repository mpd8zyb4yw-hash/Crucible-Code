import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — KMP string search: O(n+m) preprocessing + search.
export function kmpTable(pat: string): number[] {
  const t = new Array(pat.length).fill(0); let k = 0
  for (let i = 1; i < pat.length; i++) {
    while (k > 0 && pat[k] !== pat[i]) k = t[k - 1]
    if (pat[k] === pat[i]) k++
    t[i] = k
  }
  return t
}
export function kmpSearch(text: string, pattern: string): number[] {
  if (!pattern.length) return []
  const t = kmpTable(pattern); const hits: number[] = []; let k = 0
  for (let i = 0; i < text.length; i++) {
    while (k > 0 && text[i] !== pattern[k]) k = t[k - 1]
    if (text[i] === pattern[k]) k++
    if (k === pattern.length) { hits.push(i - k + 1); k = t[k - 1] }
  }
  return hits
}
`
registerSkill({
  id: 'kmp-search',
  summary: 'KMP string search: O(n+m) failure-function build + all-occurrences search.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bkmp\b|knuth.?morris.?pratt/i)) sc += 0.7
    if (s.has(/\bfailure.?function\b|\bpartial.?match\b/i)) sc += 0.3
    if (s.has(/\bstring.?search\b/i) && s.has(/\blinear\b/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/kmpSearch.ts', content: IMPL }]
  },
})
