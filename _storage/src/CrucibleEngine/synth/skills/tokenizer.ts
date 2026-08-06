// Verified primitive: configurable lexer/tokenizer — rule-based, longest-match.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — configurable tokenizer.
export interface TokenRule { type: string; pattern: RegExp }
export interface LexToken { type: string; value: string; pos: number; line: number; col: number }

export class Tokenizer {
  private rules: Array<{ type: string; re: RegExp }>

  constructor(rules: TokenRule[]) {
    this.rules = rules.map(r => ({
      type: r.type,
      re: new RegExp('^(?:' + r.pattern.source + ')', r.pattern.flags.replace('g', ''))
    }))
  }

  tokenize(src: string): LexToken[] {
    const tokens: LexToken[] = []
    let pos = 0; let line = 1; let col = 1
    while (pos < src.length) {
      let matched = false
      for (const { type, re } of this.rules) {
        const m = re.exec(src.slice(pos))
        if (!m) continue
        const value = m[0]
        if (type !== 'SKIP') tokens.push({ type, value, pos, line, col })
        for (const ch of value) { if (ch === '\\n') { line++; col = 1 } else col++ }
        pos += value.length; matched = true; break
      }
      if (!matched) throw new Error(\`Unexpected char '\${src[pos]}' at line \${line} col \${col}\`)
    }
    return tokens
  }
}

// Convenience: JavaScript-like tokenizer
export const JS_RULES: TokenRule[] = [
  { type: 'SKIP',    pattern: /\\s+/ },
  { type: 'COMMENT', pattern: /\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\// },
  { type: 'NUM',     pattern: /\\d+(\\.\\d+)?/ },
  { type: 'STR',     pattern: /"([^"\\\\]|\\\\.)*"|'([^'\\\\]|\\\\.)*'/ },
  { type: 'IDENT',   pattern: /[a-zA-Z_$][\\w$]*/ },
  { type: 'OP',      pattern: /[+\\-*/%=<>!&|^~?:]+/ },
  { type: 'PUNCT',   pattern: /[(){}[\\],;.]/ },
]
`
registerSkill({
  id: 'tokenizer',
  summary: 'Rule-based longest-match tokenizer/lexer with line/col tracking.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\btokenize?r?\b|\blexer\b/i)) sc += 0.4
    if (s.has(/\btoken\b/i) && s.has(/\brule\b/i)) sc += 0.25
    if (s.has(/\blongest.?match\b/i)) sc += 0.2
    if (s.has(/\bline\b/i) && s.has(/\bcol\b|\bcolumn\b/i) && s.has(/\btoken\b/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/tokenizer.ts', content: IMPL }]
  },
})
