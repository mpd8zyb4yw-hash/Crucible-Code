// Verified Tier-1B primitive: TOML parser (subset — covers real-world config files).
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible — TOML parser (tables, key-value, arrays, inline tables).
type TomlValue = string | number | boolean | Date | TomlValue[] | Record<string, TomlValue>

function stripComment(line: string): string {
  let inStr = false, inSingle = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"' && !inSingle) inStr = !inStr
    else if (c === "'" && !inStr) inSingle = !inSingle
    else if (c === '#' && !inStr && !inSingle) return line.slice(0, i).trimEnd()
  }
  return line
}

function parseValue(raw: string): TomlValue {
  const s = raw.trim()
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\\d{4}-\\d{2}-\\d{2}(T[\\d:.+Z-]*)?$/.test(s)) { const d = new Date(s); if (!isNaN(d.getTime())) return d }
  if (/^-?\\d+(\\.\\d+)?([eE][+-]?\\d+)?$/.test(s)) return Number(s)
  if (s.startsWith('[')) {
    const inner = s.slice(1, s.lastIndexOf(']'))
    return inner.split(',').map(x => x.trim()).filter(Boolean).map(parseValue)
  }
  if (s.startsWith('{')) {
    const inner = s.slice(1, s.lastIndexOf('}'))
    const obj: Record<string, TomlValue> = {}
    for (const pair of inner.split(',')) {
      const eq = pair.indexOf('=')
      if (eq === -1) continue
      const k = pair.slice(0, eq).trim()
      obj[k] = parseValue(pair.slice(eq + 1).trim())
    }
    return obj
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
    return s.slice(1, -1).replace(/\\\\n/g, '\\n').replace(/\\\\t/g, '\\t').replace(/\\\\"/g, '"')
  return s
}

export function parseToml(src: string): Record<string, TomlValue> {
  const root: Record<string, TomlValue> = {}
  let current = root
  for (let raw of src.split('\\n')) {
    const line = stripComment(raw).trim()
    if (!line) continue
    if (line.startsWith('[[')) {
      const key = line.slice(2, line.indexOf(']]')).trim()
      if (!Array.isArray(root[key])) root[key] = []
      const entry: Record<string, TomlValue> = {}
      ;(root[key] as Record<string, TomlValue>[]).push(entry)
      current = entry
    } else if (line.startsWith('[')) {
      const key = line.slice(1, line.indexOf(']')).trim()
      current = root[key] = root[key] && typeof root[key] === 'object' && !Array.isArray(root[key]) ? root[key] as Record<string, TomlValue> : {}
    } else {
      const eq = line.indexOf('=')
      if (eq === -1) continue
      const key = line.slice(0, eq).trim()
      current[key] = parseValue(line.slice(eq + 1).trim())
    }
  }
  return root
}
`

const SUITE = `
import { parseToml } from './src/module'
const ok = (cond: boolean, msg: string) => { if (!cond) { console.error('FAIL', msg); process.exit(1) } }
const doc = parseToml(\`
title = "TOML Example"
port = 8080
debug = true
ratio = 3.14

[database]
host = "localhost"
ports = [5432, 5433]

[[servers]]
name = "alpha"

[[servers]]
name = "beta"
\`)
ok(doc['title'] === 'TOML Example', 'string')
ok(doc['port'] === 8080, 'integer')
ok(doc['debug'] === true, 'boolean')
ok(Math.abs((doc['ratio'] as number) - 3.14) < 0.001, 'float')
const db = doc['database'] as Record<string,unknown>
ok(db['host'] === 'localhost', 'table string')
ok(Array.isArray(db['ports']) && (db['ports'] as number[])[0] === 5432, 'inline array')
const servers = doc['servers'] as Record<string,unknown>[]
ok(servers.length === 2 && servers[0]['name'] === 'alpha', 'array of tables')
console.log('ALL PASS')
`

registerSkill({
  id: 'tomlParse',
  summary: 'TOML config parser: parseToml — handles tables, arrays-of-tables, inline arrays, types.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\btoml\b.*\bpars|\bpars\b.*\btoml\b|\bparseToml\b/i)) sc += 0.85
    if (s.has(/\btoml\b.*\bread|\bread\b.*\btoml\b/i)) sc += 0.5
    if (s.has(/\btoml\b.*\bconfig|\bconfig\b.*\btoml\b/i)) sc += 0.35
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/module.ts', content: IMPL }]
  },
  suite: SUITE,
})
