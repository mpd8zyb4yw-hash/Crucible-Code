// Verified primitive: hand-written recursive-descent JSON parser (no JSON.parse).
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — recursive-descent JSON parser.
export type JSONValue = null | boolean | number | string | JSONValue[] | { [k: string]: JSONValue }

export function parseJSON(src: string): JSONValue {
  let pos = 0
  const ws = () => { while (pos < src.length && /\s/.test(src[pos])) pos++ }
  const expect = (c: string) => { if (src[pos] !== c) throw new Error(\`Expected '\${c}' at \${pos}\`); pos++ }

  const parseValue = (): JSONValue => {
    ws()
    if (src[pos] === '"') return parseString()
    if (src[pos] === '[') return parseArray()
    if (src[pos] === '{') return parseObject()
    if (src.startsWith('true', pos)) { pos += 4; return true }
    if (src.startsWith('false', pos)) { pos += 5; return false }
    if (src.startsWith('null', pos)) { pos += 4; return null }
    return parseNumber()
  }

  const parseString = (): string => {
    expect('"'); let s = ''
    while (pos < src.length && src[pos] !== '"') {
      if (src[pos] === '\\\\') {
        pos++
        switch (src[pos]) {
          case '"': s += '"'; break; case '\\\\': s += '\\\\'; break; case '/': s += '/'; break
          case 'n': s += '\\n'; break; case 't': s += '\\t'; break; case 'r': s += '\\r'; break
          case 'u': s += String.fromCharCode(parseInt(src.slice(pos + 1, pos + 5), 16)); pos += 4; break
        }
      } else s += src[pos]
      pos++
    }
    expect('"'); return s
  }

  const parseNumber = (): number => {
    const m = /^-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?/.exec(src.slice(pos))
    if (!m) throw new Error(\`Invalid number at \${pos}\`)
    pos += m[0].length; return parseFloat(m[0])
  }

  const parseArray = (): JSONValue[] => {
    expect('['); ws(); const arr: JSONValue[] = []
    if (src[pos] === ']') { pos++; return arr }
    while (true) { arr.push(parseValue()); ws(); if (src[pos] === ']') { pos++; break } expect(',') }
    return arr
  }

  const parseObject = (): { [k: string]: JSONValue } => {
    expect('{'); ws(); const obj: { [k: string]: JSONValue } = {}
    if (src[pos] === '}') { pos++; return obj }
    while (true) { ws(); const k = parseString(); ws(); expect(':'); obj[k] = parseValue(); ws(); if (src[pos] === '}') { pos++; break } expect(',') }
    return obj
  }

  const result = parseValue(); ws()
  if (pos !== src.length) throw new Error(\`Unexpected input at \${pos}\`)
  return result
}
`
registerSkill({
  id: 'json-parser',
  summary: 'Hand-written recursive-descent JSON parser — no JSON.parse dependency.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bjson.?pars\w+\b/i) && s.has(/\brecursive\b|\bhand.?writ\w+\b|\bfrom.?scratch\b/i)) sc += 0.6
    if (s.has(/\bjson\b/i) && s.has(/\bwithout\b.*\bjson\.parse\b/i)) sc += 0.5
    if (s.has(/\bparsejson\b/i)) sc += 0.4
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/jsonParser.ts', content: IMPL }]
  },
})
