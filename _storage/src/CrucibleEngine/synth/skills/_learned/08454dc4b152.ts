// Auto-distilled by Crucible — oracle-verified at distillation time. Do not edit.
// Content-addressed ID: 08454dc4b152 (sha256 of spec+content, first 12 hex chars).
import { registerSkill, type SpecFeatures } from '../../synthEngine'

const IMPL: string = "// Synthesized by Crucible — ordinal suffix (1st, 2nd), roman numerals, integer to words.\nexport function ordinal(n: number): string {\n  const abs = Math.abs(n)\n  const mod10 = abs % 10, mod100 = abs % 100\n  if (mod100 >= 11 && mod100 <= 13) return n + 'th'\n  if (mod10 === 1) return n + 'st'\n  if (mod10 === 2) return n + 'nd'\n  if (mod10 === 3) return n + 'rd'\n  return n + 'th'\n}\n\nconst ROMAN_VALS: [number, string][] = [\n  [1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],\n  [50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I'],\n]\n\nexport function toRoman(n: number): string {\n  if (n <= 0 || n > 3999) throw new Error('out of range')\n  let result = ''\n  for (const [val, sym] of ROMAN_VALS) { while (n >= val) { result += sym; n -= val } }\n  return result\n}\n\nexport function fromRoman(s: string): number {\n  const map: Record<string, number> = {I:1,V:5,X:10,L:50,C:100,D:500,M:1000}\n  let n = 0\n  for (let i = 0; i < s.length; i++) {\n    const cur = map[s[i]], next = map[s[i+1]]\n    n += (next && cur < next) ? -cur : cur\n  }\n  return n\n}\n"
const DEFAULT_PATH: string = "src/roman.ts"

registerSkill({
  id: "learned/08454dc4b152",
  summary: "Learned (distilled, oracle-verified) primitive exporting toRoman.",
  match(s: SpecFeatures): number {
    let hits = 0
    if (s.has(/\btoRoman\b/)) hits++
    return hits / 1
  },
  emit(s: SpecFeatures) {
    return [{ path: s.modulePath ?? DEFAULT_PATH, content: IMPL }]
  },
})
