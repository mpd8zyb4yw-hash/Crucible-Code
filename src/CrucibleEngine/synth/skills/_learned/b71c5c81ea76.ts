// Auto-distilled by Crucible — oracle-verified at distillation time. Do not edit.
// Content-addressed ID: b71c5c81ea76 (sha256 of spec+content, first 12 hex chars).
import { registerSkill, type SpecFeatures } from '../../synthEngine'

const IMPL: string = "// Synthesized by Crucible — Capitalize the first letter of each word (title case).\nexport function capitalize(str: string): string {\n  return str.replace(/\\b\\w/g, c => c.toUpperCase())\n}\n"
const DEFAULT_PATH: string = "src/cap.ts"

registerSkill({
  id: "learned/b71c5c81ea76",
  summary: "Learned (distilled, oracle-verified) primitive exporting capitalize.",
  match(s: SpecFeatures): number {
    let hits = 0
    if (s.has(/\bcapitalize\b/)) hits++
    return hits / 1
  },
  emit(s: SpecFeatures) {
    return [{ path: s.modulePath ?? DEFAULT_PATH, content: IMPL }]
  },
})
