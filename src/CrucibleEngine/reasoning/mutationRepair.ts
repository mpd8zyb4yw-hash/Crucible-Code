// ═══════════════════════════════════════════════════════════════════════════════
// DETERMINISTIC SINGLE-EDIT REPAIR PROPOSER
// ═══════════════════════════════════════════════════════════════════════════════
//
// NORTH STAR (see DOCTRINE.md): correctness comes from the LOOP, not the oracle.
//
// A large class of real regressions — and every operator/boundary fault the fault
// harness injects (flip-lt, flip-gt, swap-plus-minus, shift-zero) — is a SINGLE
// token edit away from correct. When we hold the buggy source (a repair task), we
// do not need the weak ~3B model to *localize* that edit: we can enumerate the
// bounded space of single-token inversions ourselves and let the deterministic
// verifier certify one. This is pure VGR — a cheap generator (mechanical mutation)
// + a sound checker (execution) + search — and it recovers exactly the faults the
// model is worst at localizing (a `>` that should be `>=` one layer down in a
// helper), in ZERO model calls.
//
// Budget discipline: search charges one model-call slot per candidate the proposer
// RETURNS (search.ts). So this proposer collapses its entire sub-search into ONE
// slot — it executes every variant internally against the spec and returns a
// candidate ONLY when one is certified. If none pass, it returns null and cedes to
// the FM at zero budget cost. It fires once per search (stateful) so later rounds
// don't redo the same dead enumeration.
// ═══════════════════════════════════════════════════════════════════════════════

import type { Candidate, Proposer, ProposeContext } from './types'
import { verifyCode } from './codeVerifier'

/**
 * Single-token inversions for each operator class the harness (and real off-by-one
 * regressions) produce. We do not know which DIRECTION the fault went, so each
 * operator offers every plausible sibling — the verifier discards the wrong ones.
 * Ordered longest-first so the tokenizer never splits `<=` into `<`.
 */
const OP_ALTERNATES: Array<[string, string[]]> = [
  ['===', ['!==']],
  ['!==', ['===']],
  ['==', ['!=']],
  ['!=', ['==']],
  ['<=', ['<', '>=', '>']],
  ['>=', ['>', '<=', '<']],
  ['&&', ['||']],
  ['||', ['&&']],
  ['<', ['<=', '>', '>=']],
  ['>', ['>=', '<', '<=']],
]

/** True when the char at `i` continues/opens a multi-char operator we handle separately. */
function partOfWiderOp(src: string, i: number, op: string): boolean {
  if (op === '<' || op === '>') {
    // reject `<<`, `>>`, `<=`, `>=`, `=>`, `<<=` … — only a bare relational `<`/`>`
    const prev = src[i - 1]
    const next = src[i + 1]
    if (next === '=' || next === op || prev === op || prev === '=') return true
  }
  if (op === '==' || op === '!=') {
    if (src[i + 2] === '=') return true // part of ===/!==
  }
  return false
}

/** All single-occurrence operator inversions of `src`. */
function operatorVariants(src: string): string[] {
  const out: string[] = []
  for (const [op, alts] of OP_ALTERNATES) {
    let from = 0
    for (;;) {
      const idx = src.indexOf(op, from)
      if (idx < 0) break
      from = idx + 1
      if (partOfWiderOp(src, idx, op)) continue
      for (const alt of alts) out.push(src.slice(0, idx) + alt + src.slice(idx + op.length))
    }
  }
  return out
}

/** Arithmetic swaps (`+`↔`-`, `*`↔`/`), skipping ++/--/+=/unary and comments. */
function arithmeticVariants(src: string): string[] {
  const out: string[] = []
  const swaps: Array<[RegExp, string]> = [
    [/(?<![+\-=*/<>!])\+(?![+=])/g, '-'],
    [/(?<![+\-=*/<>!])-(?![-=])/g, '+'],
    [/(?<![*/=])\*(?![*=])/g, '/'],
    [/(?<![*/=])\/(?![*/=])/g, '*'], // `/*`, `//`, `/=` excluded
  ]
  for (const [re, alt] of swaps) {
    let m: RegExpExecArray | null
    re.lastIndex = 0
    while ((m = re.exec(src))) {
      out.push(src.slice(0, m.index) + alt + src.slice(m.index + 1))
      if (m.index === re.lastIndex) re.lastIndex++ // zero-width guard
    }
  }
  return out
}

/** Integer-literal boundary shifts: each `n` → `n-1` and `n+1` (covers off-by-one / shift-zero). */
function boundaryVariants(src: string): string[] {
  const out: string[] = []
  const re = /(?<![\w.$])\d+(?![\w.])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const n = Number(m[0])
    if (!Number.isFinite(n)) continue
    for (const d of [1, -1]) {
      out.push(src.slice(0, m.index) + String(n + d) + src.slice(m.index + m[0].length))
    }
  }
  return out
}

/**
 * Condition-negation variants: for each `if (…)` / `while (…)`, produce a variant with
 * that condition wrapped in `!(…)`. A negated guard (the `negate-if` fault class) is
 * fixed by re-negating it — double negation executes as the original — so this reaches a
 * whole structural fault the token-level swaps cannot, while staying a single invertible
 * edit. Walks to the matching close paren so nested parens survive (mirrors faultInject).
 */
function conditionNegationVariants(src: string): string[] {
  const out: string[] = []
  const re = /\b(?:if|while)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let depth = 0
    let i = m.index + m[0].length - 1
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')' && --depth === 0) break
    }
    if (depth !== 0) continue // unbalanced — skip
    const open = m.index + m[0].length
    const cond = src.slice(open, i)
    if (!cond.trim()) continue
    out.push(src.slice(0, open) + `!(${cond})` + src.slice(i))
  }
  return out
}

/**
 * All single-edit repair candidates for `buggyCode`, de-duplicated and excluding
 * the original. Bounded, one invertible edit each — operator/arithmetic/boundary
 * token swaps plus condition negation (reaches the `negate-if` fault class).
 */
export function singleEditVariants(buggyCode: string): string[] {
  const all = [
    ...operatorVariants(buggyCode),
    ...arithmeticVariants(buggyCode),
    ...boundaryVariants(buggyCode),
    ...conditionNegationVariants(buggyCode),
  ]
  const seen = new Set<string>([buggyCode])
  const out: string[] = []
  for (const v of all) {
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

/** Hard cap on internal verify runs — keeps the sub-search bounded on pathological input. */
const MAX_VARIANTS = 400

/**
 * A repair proposer that mechanically enumerates single-token inversions of the
 * buggy source and returns the FIRST the verifier certifies — in one budget slot,
 * zero model calls. Returns null (ceding to the FM) when no single edit fixes it,
 * or on any later round (fires exactly once). Compose it AHEAD of the model:
 * `composeProposers(makeMutationRepairProposer(buggy), proposeCode)`.
 */
export function makeMutationRepairProposer(buggyCode: string): Proposer<string> {
  let fired = false
  return async (ctx: ProposeContext<string>): Promise<Candidate<string> | null> => {
    if (fired || ctx.signal?.aborted) return null
    fired = true
    const variants = singleEditVariants(buggyCode).slice(0, MAX_VARIANTS)
    for (let i = 0; i < variants.length; i++) {
      if (ctx.signal?.aborted) return null
      const candidate: Candidate<string> = { value: variants[i], fingerprint: `single-edit-${i}`, modelFree: true }
      const verdict = await verifyCode(candidate, ctx.spec)
      if (verdict.pass) return candidate
    }
    return null
  }
}
