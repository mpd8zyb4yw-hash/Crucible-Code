// Verified primitive: Pratt (top-down operator precedence) parser — expression parsing.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Pratt expression parser.
export type TokenType = 'num' | 'ident' | 'op' | 'lparen' | 'rparen' | 'eof'
export interface Token { type: TokenType; value: string }

export function tokenise(src: string): Token[] {
  const tokens: Token[] = []; let i = 0
  while (i < src.length) {
    if (/\s/.test(src[i])) { i++; continue }
    if (/\d/.test(src[i])) { let s = ''; while (i < src.length && /[\d.]/.test(src[i])) s += src[i++]; tokens.push({ type: 'num', value: s }); continue }
    if (/[a-z_]/i.test(src[i])) { let s = ''; while (i < src.length && /\w/.test(src[i])) s += src[i++]; tokens.push({ type: 'ident', value: s }); continue }
    if (src[i] === '(') { tokens.push({ type: 'lparen', value: '(' }); i++; continue }
    if (src[i] === ')') { tokens.push({ type: 'rparen', value: ')' }); i++; continue }
    tokens.push({ type: 'op', value: src[i++] })
  }
  tokens.push({ type: 'eof', value: '' })
  return tokens
}

const BP: Record<string, number> = { '+': 10, '-': 10, '*': 20, '/': 20, '^': 30, '%': 20 }

export interface ASTNode { type: string; value?: string; left?: ASTNode; right?: ASTNode }

export function parseExpr(tokens: Token[]): ASTNode {
  let pos = 0
  const peek = () => tokens[pos]
  const consume = () => tokens[pos++]

  const nud = (tok: Token): ASTNode => {
    if (tok.type === 'num') return { type: 'num', value: tok.value }
    if (tok.type === 'ident') return { type: 'ident', value: tok.value }
    if (tok.type === 'lparen') { const node = expr(0); consume(); return node }
    if (tok.type === 'op' && (tok.value === '-' || tok.value === '+'))
      return { type: 'unary', value: tok.value, right: expr(25) }
    throw new Error(\`Unexpected token: \${tok.value}\`)
  }

  const expr = (minBP: number): ASTNode => {
    let left = nud(consume())
    while (true) {
      const op = peek()
      if (op.type !== 'op') break
      const bp = BP[op.value] ?? 0
      if (bp <= minBP) break
      consume()
      const right = expr(op.value === '^' ? bp - 1 : bp)
      left = { type: 'binop', value: op.value, left, right }
    }
    return left
  }

  return expr(0)
}

export function evaluate(node: ASTNode, env: Record<string, number> = {}): number {
  if (node.type === 'num') return parseFloat(node.value!)
  if (node.type === 'ident') return env[node.value!] ?? 0
  if (node.type === 'unary') { const v = evaluate(node.right!, env); return node.value === '-' ? -v : v }
  const l = evaluate(node.left!, env); const r = evaluate(node.right!, env)
  switch (node.value) {
    case '+': return l + r; case '-': return l - r; case '*': return l * r
    case '/': return l / r; case '^': return l ** r; case '%': return l % r
  }
  throw new Error(\`Unknown op: \${node.value}\`)
}
`
registerSkill({
  id: 'pratt-parser',
  summary: 'Pratt parser: top-down operator precedence, expression AST, evaluate.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bpratt\b/i)) sc += 0.6
    if (s.has(/\btop.?down.?operator.?prece\w+\b/i)) sc += 0.4
    if (s.has(/\bexpression.?pars\w+\b/i) && s.has(/\bprecedence\b/i)) sc += 0.3
    if (s.has(/\bbinding.?power\b/i)) sc += 0.35
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/prattParser.ts', content: IMPL }]
  },
})
