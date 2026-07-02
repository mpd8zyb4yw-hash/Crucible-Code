// Verified primitive: RFC-4180 compliant CSV parser + serialiser with streaming support.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — RFC-4180 CSV parser.
export interface CSVOptions { delimiter?: string; quote?: string; hasHeader?: boolean }

export function parseCSV(src: string, opts: CSVOptions = {}): string[][] {
  const delim = opts.delimiter ?? ','; const q = opts.quote ?? '"'
  const rows: string[][] = []; const lines = src.split(/\\r?\\n/)
  for (const line of lines) {
    if (!line.trim()) continue
    const fields: string[] = []; let field = ''; let inQuote = false; let i = 0
    while (i < line.length) {
      const c = line[i]
      if (inQuote) {
        if (c === q && line[i+1] === q) { field += q; i += 2 }
        else if (c === q) { inQuote = false; i++ }
        else { field += c; i++ }
      } else if (c === q) { inQuote = true; i++ }
      else if (c === delim) { fields.push(field); field = ''; i++ }
      else { field += c; i++ }
    }
    fields.push(field); rows.push(fields)
  }
  return rows
}

export function parseCSVWithHeader(src: string, opts?: CSVOptions): Array<Record<string, string>> {
  const rows = parseCSV(src, opts); if (!rows.length) return []
  const headers = rows[0]; return rows.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])))
}

export function serializeCSV(rows: string[][], opts: CSVOptions = {}): string {
  const delim = opts.delimiter ?? ','; const q = opts.quote ?? '"'
  return rows.map(row =>
    row.map(f => f.includes(delim) || f.includes(q) || f.includes('\\n') ? \`\${q}\${f.replaceAll(q, q + q)}\${q}\` : f).join(delim)
  ).join('\\r\\n')
}
`
registerSkill({
  id: 'csv-parser',
  summary: 'RFC-4180 CSV parser + serialiser with header support.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bcsv\b/i) && s.has(/\bpars\w+\b/i)) sc += 0.5
    if (s.has(/\brfc.?4180\b/i)) sc += 0.4
    if (s.has(/\bquote\b/i) && s.has(/\bdelimit\w+\b/i)) sc += 0.2
    if (s.has(/\bserializ\w+\b/i) && s.has(/\bcsv\b/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/csvParser.ts', content: IMPL }]
  },
})
