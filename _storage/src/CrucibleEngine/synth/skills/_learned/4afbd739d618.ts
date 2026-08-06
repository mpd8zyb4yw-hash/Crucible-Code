// Auto-distilled by Crucible — oracle-verified at distillation time. Do not edit.
// Content-addressed ID: 4afbd739d618 (sha256 of spec+content, first 12 hex chars).
import { registerSkill, type SpecFeatures } from '../../synthEngine'

const IMPL: string = "export function parseCsv(input: string): string[][] {\n  const rows: string[][] = []\n  let row: string[] = []\n  let field = ''\n  let inQuotes = false\n  for (let i = 0; i < input.length; i++) {\n    const ch = input[i]\n    if (inQuotes) {\n      if (ch === '\"') {\n        if (input[i + 1] === '\"') { field += '\"'; i++ }\n        else inQuotes = false\n      } else field += ch\n      continue\n    }\n    if (ch === '\"') { inQuotes = true; continue }\n    if (ch === ',') { row.push(field); field = ''; continue }\n    if (ch === '\\r') continue\n    if (ch === '\\n') { row.push(field); rows.push(row); row = []; field = ''; continue }\n    field += ch\n  }\n  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }\n  return rows\n}"
const DEFAULT_PATH: string = "src/csv.ts"

registerSkill({
  id: "learned/4afbd739d618",
  summary: "Learned (distilled, oracle-verified) primitive exporting parseCsv.",
  match(s: SpecFeatures): number {
    let hits = 0
    if (s.has(/\bparseCsv\b/)) hits++
    return hits / 1
  },
  emit(s: SpecFeatures) {
    return [{ path: s.modulePath ?? DEFAULT_PATH, content: IMPL }]
  },
})
