// ═══════════════════════════════════════════════════════════════════════════════
// Answer engine — word-problem recomputation (VGR applied to arithmetic answers)
// ═══════════════════════════════════════════════════════════════════════════════
//
// THE GAP THIS CLOSES (verify.ts header, "Stage 2 adds word-problem recomputation").
// The arithmetic critic only fixes an equation the model WROTE OUT ("60 × 2.5 = 140" → 150).
// For a word problem where the model states a bare answer ("The train travels 140 miles")
// there is no equation to check — the SETUP and the arithmetic are both untrusted, and
// self-consistency voting on the whole answer certifies a shared arithmetic bias.
//
// The doctrine (correctness from the LOOP, not the oracle) applied to answers: SEPARATE the
// two jobs the weak model conflates —
//   • SETUP  (which numbers, which operation) — the model is decent at this, it PROPOSES it;
//   • ARITHMETIC (actually computing the value) — the model is BAD at this, so the MACHINE
//     does it, deterministically. The computed value is un-foolable: no shared arithmetic slip
//     can occur because no model computes it.
// The remaining risk — a wrong SETUP — is guarded the same way VGR guards a spec: draw K
// independent extractions and require a QUORUM to agree on the evaluated value. If they don't
// agree, we ABSTAIN (return null) and leave the draft to the other critics. A wrong setup
// shared across all samples is the honest limit (documented), and far rarer than the
// arithmetic slips this eliminates outright.
//
// The model only PROPOSES expressions; evaluation + consensus are deterministic.
// ═══════════════════════════════════════════════════════════════════════════════

import { fmComplete } from '../agent/fmReact'

/** Injectable completer so the recomputation LOOP is provable without a live model. */
export type Completer = (
  messages: Array<{ role: string; content: string }>,
  opts?: { temperature?: number },
) => Promise<string>

export interface Recomputation {
  /** The machine-evaluated answer value. */
  value: number
  /** Optional unit the model attached (miles, dollars, hours…). */
  unit?: string
  /** The winning arithmetic expression (as extracted, pre-eval). */
  expression: string
  /** Fraction of valid extractions that agreed on `value`. */
  agreement: number
  /** How many extractions produced an evaluable expression. */
  samples: number
}

// ── Safe arithmetic evaluation (whitelist; never evaluates identifiers) ──────────────
// Normalizes unicode operators, then REFUSES anything containing a letter/variable, so a
// model that sneaks a symbol ("60 * t") yields null (→ that sample contributes no vote).
export function evalArithmeticExpr(raw: string): number | null {
  if (typeof raw !== 'string') return null
  const g = raw.trim()
    .replace(/[×✕✖]/g, '*').replace(/[·⋅]/g, '*')
    .replace(/[÷]/g, '/').replace(/\^/g, '**')
    .replace(/[$£€,]/g, '')           // currency + thousands separators
  if (!g) return null
  // Only digits, operators, parens, decimal points, spaces (note: ** covers ^).
  if (!/^[\d\s+\-*/.()]+$/.test(g)) return null
  if (!/[+\-*/]/.test(g)) return null // a bare number is not a computation
  try {
    // eslint-disable-next-line no-new-func — input is whitelisted to a numeric expression, strict mode
    const result = Function(`"use strict"; return (${g})`)()
    return typeof result === 'number' && isFinite(result) ? result : null
  } catch { return null }
}

// Evaluate an expression that may reference PREVIOUSLY-computed variables. Every identifier must
// resolve from `env` (a numeric value); an unknown identifier → null (the setup is not evaluable,
// so that sample contributes no vote). Substitution is word-boundary safe and parenthesized so
// signs compose correctly (`a-b` with a=3,b=-1 → `(3)-(-1)`).
export function evalWithEnv(raw: string, env: Record<string, number>): number | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let bad = false
  const substituted = raw.replace(/[A-Za-z_$][\w$]*/g, name => {
    // Leave nothing resolvable to a bare identifier: known → its value, unknown → mark invalid.
    if (Object.prototype.hasOwnProperty.call(env, name) && isFinite(env[name])) return `(${env[name]})`
    bad = true
    return name
  })
  if (bad) return null
  return evalArithmeticExpr(substituted)
}

const SYSTEM = [
  'You translate a math WORD PROBLEM into ONE arithmetic expression that computes its answer.',
  'You are inside a verification system: DO NOT compute the result yourself — a separate',
  'deterministic evaluator will. Your only job is to produce the correct arithmetic SETUP.',
  '',
  'Output STRICT JSON and nothing else, shape:',
  '{ "expression": "<arithmetic using only numbers and + - * / ( )>", "unit": "<unit word or empty>" }',
  '',
  '- Use ONLY numbers and the operators + - * / and parentheses. NO variables, NO words, NO "=".',
  '- Encode the whole computation in the single expression (nest with parentheses as needed).',
  '- If the problem cannot be reduced to one arithmetic expression, output {"expression":"","unit":""}.',
].join('\n')

/** Parse the model's JSON (tolerating a ```json fence and surrounding prose). */
function parseExpr(text: string): { expression: string; unit: string } | null {
  if (!text) return null
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = (fence ? fence[1] : text).trim()
  const start = body.indexOf('{'); const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const o = JSON.parse(body.slice(start, end + 1))
    if (o && typeof o.expression === 'string') return { expression: o.expression, unit: typeof o.unit === 'string' ? o.unit : '' }
  } catch { /* not JSON */ }
  return null
}

const MULTI_SYSTEM = [
  'You translate a multi-step math WORD PROBLEM into an ORDERED sequence of arithmetic steps.',
  'You are inside a verification system: DO NOT compute any result yourself — a deterministic',
  'evaluator will. Your only job is the correct SETUP.',
  '',
  'Output STRICT JSON and nothing else, shape:',
  '{ "steps": [ { "var": "<name>", "expr": "<arithmetic over numbers and EARLIER vars>" } ], "answer": "<var name>", "unit": "<unit or empty>" }',
  '',
  '- Each `expr` uses ONLY numbers, the operators + - * / ( ), and variable names defined in',
  '  EARLIER steps. No "=", no functions, no words inside expr.',
  '- `answer` names the step variable that holds the final answer.',
  '- If it cannot be reduced to arithmetic steps, output {"steps":[],"answer":"","unit":""}.',
].join('\n')

interface Step { var: string; expr: string }

/** Parse the multi-step JSON (tolerating a fence / surrounding prose). */
function parseSteps(text: string): { steps: Step[]; answer: string; unit: string } | null {
  if (!text) return null
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = (fence ? fence[1] : text).trim()
  const start = body.indexOf('{'); const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const o = JSON.parse(body.slice(start, end + 1))
    if (o && Array.isArray(o.steps) && typeof o.answer === 'string') {
      const steps: Step[] = []
      for (const s of o.steps) if (s && typeof s.var === 'string' && typeof s.expr === 'string') steps.push({ var: s.var, expr: s.expr })
      return { steps, answer: o.answer, unit: typeof o.unit === 'string' ? o.unit : '' }
    }
  } catch { /* not JSON */ }
  return null
}

/** Evaluate an ordered step DAG deterministically → the value of `answer`, or null if any step
 * fails to resolve (unknown var, non-arithmetic, or the answer var is never defined). */
export function evalSteps(steps: Step[], answer: string): number | null {
  if (!steps.length || !answer) return null
  const env: Record<string, number> = {}
  for (const s of steps) {
    if (!/^[A-Za-z_$][\w$]*$/.test(s.var)) return null
    const v = evalWithEnv(s.expr, env)
    if (v === null) return null
    env[s.var] = v
  }
  return Object.prototype.hasOwnProperty.call(env, answer) ? env[answer] : null
}

/**
 * Recompute a MULTI-STEP word problem: extract K independent step-DAG setups, evaluate each
 * deterministically, and return the final value a QUORUM agrees on — or null. Generalizes
 * recomputeWordProblem to problems that need intermediate quantities (relative speed, head
 * start, compound steps). Same contract: model proposes the setup, machine does the arithmetic.
 */
export async function recomputeMultiStep(
  message: string,
  opts: { samples?: number; complete?: Completer } = {},
): Promise<Recomputation | null> {
  const samples = Math.max(3, opts.samples ?? 3)
  const complete = opts.complete ?? fmComplete

  const evaluated: Array<{ value: number; unit: string; expr: string }> = []
  for (let i = 0; i < samples; i++) {
    let raw: string
    try {
      raw = await complete(
        [{ role: 'system', content: MULTI_SYSTEM }, { role: 'user', content: `Problem:\n${message}` }],
        { temperature: i === 0 ? 0.1 : 0.5 },
      )
    } catch { continue }
    const parsed = parseSteps(raw)
    if (!parsed || !parsed.steps.length || !parsed.answer) continue
    const value = evalSteps(parsed.steps, parsed.answer)
    if (value === null) continue
    const chain = parsed.steps.map(s => `${s.var}=${s.expr}`).join('; ')
    evaluated.push({ value, unit: parsed.unit.trim(), expr: chain })
  }
  if (evaluated.length < 2) return null

  const byVal = new Map<string, { value: number; n: number; unit: string; expr: string }>()
  for (const e of evaluated) {
    const k = valueKey(e.value)
    const slot = byVal.get(k) ?? { value: e.value, n: 0, unit: e.unit, expr: e.expr }
    slot.n++
    if (!slot.unit && e.unit) slot.unit = e.unit
    byVal.set(k, slot)
  }
  const quorum = Math.max(2, Math.floor(samples / 2) + 1)
  const top = [...byVal.values()].sort((a, b) => b.n - a.n)[0]
  if (!top || top.n < quorum) return null

  return { value: top.value, unit: top.unit || undefined, expression: top.expr, agreement: top.n / evaluated.length, samples: evaluated.length }
}

/** Round to a stable key for consensus (tolerate float noise; 6 decimals is plenty). */
function valueKey(v: number): string {
  const r = Math.round(v * 1e6) / 1e6
  return Object.is(r, -0) ? '0' : String(r)
}

/**
 * Recompute a math word problem: extract K independent arithmetic SETUPS from the model,
 * evaluate each deterministically, and return the value a QUORUM agrees on — or null when no
 * quorum forms (→ caller keeps the drafted answer / other critics). The arithmetic is always
 * the machine's; only the setup is the model's, and only a corroborated setup is trusted.
 */
export async function recomputeWordProblem(
  message: string,
  opts: { samples?: number; complete?: Completer } = {},
): Promise<Recomputation | null> {
  const samples = Math.max(3, opts.samples ?? 3)
  const complete = opts.complete ?? fmComplete

  const evaluated: Array<{ value: number; unit: string; expr: string }> = []
  for (let i = 0; i < samples; i++) {
    let raw: string
    try {
      raw = await complete(
        [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Problem:\n${message}` }],
        { temperature: i === 0 ? 0.1 : 0.5 },
      )
    } catch { continue }
    const parsed = parseExpr(raw)
    if (!parsed || !parsed.expression) continue
    const value = evalArithmeticExpr(parsed.expression)
    if (value === null) continue
    evaluated.push({ value, unit: parsed.unit.trim(), expr: parsed.expression.trim() })
  }
  if (evaluated.length < 2) return null // need corroboration; a lone extraction is not trusted

  // Consensus on the evaluated VALUE.
  const byVal = new Map<string, { value: number; n: number; unit: string; expr: string }>()
  for (const e of evaluated) {
    const k = valueKey(e.value)
    const slot = byVal.get(k) ?? { value: e.value, n: 0, unit: e.unit, expr: e.expr }
    slot.n++
    if (!slot.unit && e.unit) slot.unit = e.unit
    byVal.set(k, slot)
  }
  const quorum = Math.max(2, Math.floor(samples / 2) + 1)
  const top = [...byVal.values()].sort((a, b) => b.n - a.n)[0]
  if (!top || top.n < quorum) return null

  return {
    value: top.value,
    unit: top.unit || undefined,
    expression: top.expr,
    agreement: top.n / evaluated.length,
    samples: evaluated.length,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONVERGENCE — iterate() applied to the answer domain (word-problem recomputation)
// ═══════════════════════════════════════════════════════════════════════════════
//
// recomputeWordProblem draws K setups ONCE and abstains if no quorum forms. But a genuinely
// correct setup the model produces most-but-not-all of the time can lose an unlucky first
// draw (1-1-1 split, or 2 evaluable that disagree) and be abstained on — even though a
// dominant cluster EXISTS in the distribution. That is the exact shape iterate() rescues.
//
// Same contract as reasoning/iterate.ts, mapped to consensus-over-samples (search()'s
// per-candidate verifier doesn't fit — consensus is inherently multi-sample):
//   • ACCUMULATE samples across epochs instead of throwing the batch away — the pool only grows.
//   • PROGRESS = the largest agreeing value-cluster grew this epoch. Terminate when it reaches
//     quorum (solved), when growth stalls after research (abstain), or on a reality budget
//     (max samples / epochs / abort). The model NEVER decides to stop.
//   • RESEARCH on a stall is Channel-1 ONLY (safe proposer grounding): show the model the
//     CONFLICTING setups its own samples produced and ask it to re-read and pick the one that
//     matches the described operation. It cannot change ground truth — the arithmetic is still
//     the machine's, and only a quorum on the machine-evaluated VALUE certifies.
//
// SOUND / pure ADD: it only ever draws MORE independent samples and still requires a quorum on
// a deterministically-evaluated value, so it can certify MORE than single-shot, never less.
// HONEST LIMIT (same as single-shot): a wrong setup shared across ALL samples still passes —
// convergence rescues split/unlucky draws, it does NOT fix systematic setup bias.
// ═══════════════════════════════════════════════════════════════════════════════

export interface WordProblemIterateOpts {
  complete?: Completer
  /** Samples drawn per epoch. Default 3. */
  batchSize?: number
  /** Hard cap on epochs regardless of progress. Default 4. */
  maxEpochs?: number
  /** Hard ceiling on total samples drawn across all epochs (reality budget). Default 12. */
  maxSamples?: number
  /** Consecutive stalled epochs (research included) tolerated before abstaining. Default 1. */
  stallLimit?: number
  signal?: AbortSignal
  emit?: (ev: { type: string; text: string }) => void
}

export interface WordProblemIterateResult {
  /** Solved → the certified recomputation; null → honest abstain. */
  recomputation: Recomputation | null
  epochs: number
  samples: number
  /** Present when convergence EARNED the answer (a later epoch reached quorum the first missed). */
  converged?: { epochs: number; samples: number }
  detail: string
}

/**
 * Convergence loop over recomputeWordProblem's consensus. Keeps drawing independent setups
 * while the top value-cluster is still growing, folds the conflicting setups back into the
 * prompt on a stall (safe grounding), and terminates deterministically. Drop-in over
 * recomputeWordProblem — returns the same Recomputation shape (or null to abstain).
 */
export async function iterateWordProblem(
  message: string,
  opts: WordProblemIterateOpts = {},
): Promise<WordProblemIterateResult> {
  const complete = opts.complete ?? fmComplete
  const batchSize = Math.max(1, opts.batchSize ?? 3)
  const maxEpochs = Math.max(1, opts.maxEpochs ?? 4)
  const maxSamples = Math.max(batchSize, opts.maxSamples ?? 12)
  const stallLimit = Math.max(1, opts.stallLimit ?? 1)
  const emit = opts.emit ?? (() => {})

  const pool: Array<{ value: number; unit: string; expr: string }> = []
  let prevTop = 0
  let stalled = 0
  let epoch = 0
  // Budget is DRAW ATTEMPTS, not pool size — a model that keeps emitting unevaluable setups
  // must not be able to spin the loop forever (an empty pool never hits a pool-size cap).
  let attempts = 0

  // Cluster the pool by evaluated value; return the dominant cluster and its quorum threshold.
  const clusters = () => {
    const byVal = new Map<string, { value: number; n: number; unit: string; expr: string; exprs: Set<string> }>()
    for (const e of pool) {
      const k = valueKey(e.value)
      const slot = byVal.get(k) ?? { value: e.value, n: 0, unit: e.unit, expr: e.expr, exprs: new Set<string>() }
      slot.n++
      if (!slot.unit && e.unit) slot.unit = e.unit
      slot.exprs.add(e.expr)
      byVal.set(k, slot)
    }
    const ranked = [...byVal.values()].sort((a, b) => b.n - a.n)
    // Majority of the EVALUABLE pool — a genuinely-dominant setup satisfies it as n grows;
    // a true 50/50 ambiguity never does (→ honest abstain).
    const quorum = Math.max(2, Math.floor(pool.length / 2) + 1)
    return { ranked, top: ranked[0], quorum }
  }

  for (epoch = 0; epoch < maxEpochs && attempts < maxSamples; epoch++) {
    if (opts.signal?.aborted) break

    // Channel-1 research: on a split, show the model its own conflicting setups (safe grounding).
    const { ranked: preRanked } = clusters()
    let grounding = ''
    if (epoch > 0 && preRanked.length >= 2) {
      const conflicting = preRanked.slice(0, 3)
        .map(c => `  • setup "${[...c.exprs][0]}" → ${formatValue(c.value)}`)
        .join('\n')
      grounding =
        `\n\nYour previous attempts DISAGREED on the setup:\n${conflicting}\n` +
        `Re-read the problem carefully and produce the ONE setup whose operations match ` +
        `exactly what is described. Do not compute the result.`
      emit({ type: 'thought', text: `epoch ${epoch}: setups split ${preRanked.length} ways — re-grounding on the conflict` })
    } else {
      emit({ type: 'thought', text: `epoch ${epoch}: drawing ${batchSize} independent setup(s) (${pool.length}/${maxSamples} so far)` })
    }

    const room = maxSamples - attempts
    const draws = Math.min(batchSize, room)
    for (let i = 0; i < draws; i++) {
      if (opts.signal?.aborted) break
      attempts++
      let raw: string
      try {
        raw = await complete(
          [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Problem:\n${message}${grounding}` }],
          { temperature: pool.length === 0 && i === 0 ? 0.1 : 0.5 },
        )
      } catch { continue }
      const parsed = parseExpr(raw)
      if (!parsed || !parsed.expression) continue
      const value = evalArithmeticExpr(parsed.expression)
      if (value === null) continue
      pool.push({ value, unit: parsed.unit.trim(), expr: parsed.expression.trim() })
    }

    if (pool.length < 2) { prevTop = 0; continue } // no corroboration yet

    const { top, quorum } = clusters()
    if (top && top.n >= quorum) {
      emit({ type: 'thought', text: `converged: ${top.n}/${pool.length} setups agree on ${formatValue(top.value)} (quorum ${quorum})` })
      return {
        recomputation: {
          value: top.value, unit: top.unit || undefined, expression: top.expr,
          agreement: top.n / pool.length, samples: pool.length,
        },
        epochs: epoch + 1, samples: pool.length,
        converged: epoch > 0 ? { epochs: epoch + 1, samples: pool.length } : undefined,
        detail: `word-problem recomputation converged in ${epoch + 1} epoch(s): ${top.n}/${pool.length} agree on ${formatValue(top.value)}`,
      }
    }

    // Progress = the dominant cluster grew. No growth after we injected grounding → stall.
    const improved = (top?.n ?? 0) > prevTop
    if (!improved && grounding) { stalled++; if (stalled > stallLimit) break }
    else if (improved) stalled = 0
    prevTop = top?.n ?? 0
  }

  return {
    recomputation: null,
    epochs: epoch, samples: pool.length,
    detail: pool.length < 2
      ? 'no evaluable setup corroborated — abstained'
      : `no quorum after ${pool.length} sample(s) — abstained (setups genuinely disagree)`,
  }
}

// ── Reconcile the machine value with the drafted answer ──────────────────────────────

/** Format a number the way an answer reads (integer without a trailing .0; else trimmed). */
export function formatValue(v: number): string {
  if (Number.isInteger(v)) return String(v)
  return String(Math.round(v * 1e6) / 1e6)
}

/** Pull the answer number the draft asserts: the last number on an "Answer:" line, else the
 * last number overall. Returns null when the draft states no number. */
function draftAnswerNumber(draft: string): { num: number; raw: string; index: number } | null {
  const lines = draft.split('\n')
  const answerLine = lines.reverse().find(l => /\banswer\s*[:=]/i.test(l))
  const scope = answerLine ?? draft
  const matches = [...scope.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)]
  if (!matches.length) return null
  const last = matches[matches.length - 1]
  const raw = last[0]
  const num = Number(raw.replace(/,/g, ''))
  if (!isFinite(num)) return null
  // Locate the raw token in the FULL draft (last occurrence) so we can splice precisely.
  const index = draft.lastIndexOf(raw)
  return { num, raw, index }
}

export interface Reconciliation {
  text: string
  /** True when the machine value replaced a different stated number. */
  corrected: boolean
  /** True when the draft already agreed with the machine value. */
  confirmed: boolean
  /** True when reconciliation was deliberately SKIPPED (e.g. a time-of-day answer the clock critic
   * owns) — the caller must not treat the value as applied or append a bare-quantity answer line. */
  guarded?: boolean
}

/**
 * Reconcile a draft with the machine-recomputed value. If the draft states a DIFFERENT number,
 * splice in the correct one; if it states the same value, confirm; if it states no number,
 * append an explicit Answer line. Tolerance is relative so 149.9999998 == 150.
 */
/** The draft's answer region asserts a TIME OF DAY (7 PM, 7:00 PM, 19:00). Numeric recomputation
 * (which yields elapsed hours / a bare quantity) must NOT overwrite it — the clock critic owns
 * time-of-day answers, and splicing a bare number over "7 PM" would corrupt a correct reply. */
function answerIsTimeOfDay(draft: string): boolean {
  const lines = draft.split('\n')
  const answerLine = lines.reverse().find(l => /\banswer\s*[:=]/i.test(l))
  const scope = answerLine ?? draft
  return /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/i.test(scope) || /\b([01]?\d|2[0-3]):\d{2}\b/.test(scope)
}

export function applyRecomputation(draft: string, recomp: Recomputation): Reconciliation {
  // Safety: never override a time-of-day answer with a bare quantity (clock critic's domain).
  if (answerIsTimeOfDay(draft)) return { text: draft, corrected: false, confirmed: false, guarded: true }

  const stated = draftAnswerNumber(draft)
  const unit = recomp.unit ? ` ${recomp.unit}` : ''
  const shown = formatValue(recomp.value)

  if (!stated) {
    return { text: `${draft.trimEnd()}\n\nAnswer: ${shown}${unit}`.trim(), corrected: false, confirmed: false }
  }

  const tol = Math.max(1e-6, Math.abs(recomp.value) * 1e-6)
  if (Math.abs(stated.num - recomp.value) <= tol) {
    return { text: draft, corrected: false, confirmed: true }
  }

  // Splice the corrected number in place of the (last) stated one.
  if (stated.index >= 0) {
    const text = draft.slice(0, stated.index) + shown + draft.slice(stated.index + stated.raw.length)
    return { text, corrected: true, confirmed: false }
  }
  return { text: `${draft.trimEnd()}\n\nAnswer: ${shown}${unit}`, corrected: true, confirmed: false }
}
