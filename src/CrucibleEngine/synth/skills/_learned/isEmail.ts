// Auto-distilled by Crucible — oracle-verified at distillation time. Do not edit.
// Phase A durable persistence: loaded by loadLibrary on startup.
import { registerSkill, type SpecFeatures } from '../../synthEngine'

const IMPL: string = "// Synthesized by Crucible — Validate an email address format.\nexport function isEmail(str: string): boolean {\n  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(str)\n}\n"
const DEFAULT_PATH: string = "src/isEmail.ts"

registerSkill({
  id: "learned/isEmail",
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
