// Auto-distilled by Crucible — oracle-verified at distillation time. Do not edit.
// Content-addressed ID: 01916e41e5f6 (sha256 of spec+content, first 12 hex chars).
import { registerSkill, type SpecFeatures } from '../../synthEngine'

const IMPL: string = "// Synthesized by Crucible — Clamp a number between min and max; lerp between two values; round to N decimals.\nexport function clamp(value: number, min: number, max: number): number {\n  return Math.max(min, Math.min(max, value))\n}\n\nexport function lerp(a: number, b: number, t: number): number {\n  return a + (b - a) * t\n}\n\nexport function roundTo(value: number, decimals: number): number {\n  const factor = 10 ** decimals\n  return Math.round(value * factor) / factor\n}\n"
const DEFAULT_PATH: string = "clampMod.ts"

registerSkill({
  id: "learned/01916e41e5f6",
  summary: "Learned (distilled, oracle-verified) primitive exporting clamp.",
  match(s: SpecFeatures): number {
    let hits = 0
    if (s.has(/\bclamp\b/)) hits++
    return hits / 1
  },
  emit(s: SpecFeatures) {
    return [{ path: s.modulePath ?? DEFAULT_PATH, content: IMPL }]
  },
})
