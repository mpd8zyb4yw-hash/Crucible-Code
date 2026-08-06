// Auto-distilled by Crucible — oracle-verified at distillation time. Do not edit.
// Content-addressed ID: 7e0513ea58e3 (sha256 of spec+content, first 12 hex chars).
import { registerSkill, type SpecFeatures } from '../../synthEngine'

const IMPL: string = "// Synthesized by Crucible — Validate an email address format.\nexport function isEmail(str: string): boolean {\n  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(str)\n}\n"
const DEFAULT_PATH: string = "src/isEmail.ts"

registerSkill({
  id: "learned/7e0513ea58e3",
  summary: "Learned (distilled, oracle-verified) primitive exporting isEmail.",
  match(s: SpecFeatures): number {
    let hits = 0
    if (s.has(/\bisEmail\b/)) hits++
    return hits / 1
  },
  emit(s: SpecFeatures) {
    return [{ path: s.modulePath ?? DEFAULT_PATH, content: IMPL }]
  },
})
