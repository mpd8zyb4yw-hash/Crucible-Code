// Auto-distilled by Crucible — oracle-verified at distillation time. Do not edit.
// Content-addressed ID: 72878bb299e2 (sha256 of spec+content, first 12 hex chars).
import { registerSkill, type SpecFeatures } from '../../synthEngine'

const IMPL: string = "// Synthesized by Crucible — Flatten a nested object to dot-separated keys; unflatten back.\nexport function flattenObject(\n  obj: Record<string, unknown>,\n  prefix = '',\n): Record<string, unknown> {\n  const out: Record<string, unknown> = {}\n  for (const [k, v] of Object.entries(obj)) {\n    const key = prefix ? `${prefix}.${k}` : k\n    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {\n      Object.assign(out, flattenObject(v as Record<string, unknown>, key))\n    } else {\n      out[key] = v\n    }\n  }\n  return out\n}\n\nexport function unflattenObject(obj: Record<string, unknown>): Record<string, unknown> {\n  const out: Record<string, unknown> = {}\n  for (const [k, v] of Object.entries(obj)) {\n    const parts = k.split('.')\n    let cur = out\n    for (let i = 0; i < parts.length - 1; i++) {\n      if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}\n      cur = cur[parts[i]] as Record<string, unknown>\n    }\n    cur[parts[parts.length - 1]] = v\n  }\n  return out\n}\n"
const DEFAULT_PATH: string = "src/fo.ts"

registerSkill({
  id: "learned/72878bb299e2",
  summary: "Learned (distilled, oracle-verified) primitive exporting flattenObject.",
  match(s: SpecFeatures): number {
    let hits = 0
    if (s.has(/\bflattenObject\b/)) hits++
    return hits / 1
  },
  emit(s: SpecFeatures) {
    return [{ path: s.modulePath ?? DEFAULT_PATH, content: IMPL }]
  },
})
