// ═══════════════════════════════════════════════════════════════════════════════
// FM-BACKED PLANNER — the (untrusted) decomposition proposer for solveByDecomposition
// ═══════════════════════════════════════════════════════════════════════════════
//
// solveByDecomposition needs a Planner: a function that splits a stuck goal into an
// ordered list of smaller subgoals. That is a PROPOSAL, not a judgement — a weak plan
// only wastes budget, it can never make a wrong answer pass (every rung and the whole
// composition are verifier-certified downstream). So the small on-device model is a fine
// planner: cheap, fallible, and fully contained by the verifier.
//
// The prompt asks for a strictly INCREMENTAL plan — each rung builds on the last and adds
// ONE checkable capability — because that is the shape the weak proposer can actually
// climb (see decompose.ts). We parse defensively: any of a numbered list / JSON array /
// newline bullets is accepted, and a plan that doesn't parse into ≥2 rungs returns null
// so decomposition cleanly DECLINES rather than guessing.
// ═══════════════════════════════════════════════════════════════════════════════

import { fmComplete } from '../agent/fmReact'
import type { Planner, SubGoal } from './decompose'
import type { Attempt, TaskSpec } from './types'

const SYSTEM =
  'You are a planning module. You break ONE hard goal into the smallest possible ordered ' +
  'sequence of sub-steps, where each sub-step builds directly on the previous one and adds ' +
  'exactly ONE independently-checkable piece. You never solve the goal — you only outline ' +
  'the rungs. Prefer FEWER, larger-than-trivial rungs (2–6). Each rung must be a concrete, ' +
  'verifiable milestone, not a vague phase.'

function buildUser(spec: TaskSpec, best: Attempt | null): string {
  const parts = [
    `GOAL:\n${spec.goal}`,
    best?.verdict.signals?.length
      ? `A single-shot attempt STALLED. What the verifier reported:\n${best.verdict.signals.slice(0, 6).map((s) => `- ${s}`).join('\n')}`
      : 'A single-shot attempt could not be certified.',
    'Output ONLY a numbered list of 2–6 rungs, most-foundational first. Each line: ' +
      '"N. <one concrete milestone that builds on the prior rung>". No preamble, no code.',
  ]
  return parts.join('\n\n')
}

/** Parse an FM reply into ordered subgoals. Accepts numbered lists, dashes, or a JSON array. */
export function parsePlan(raw: string): SubGoal[] {
  const text = (raw ?? '').trim()
  if (!text) return []

  // Try JSON array of strings/objects first.
  if (text.startsWith('[')) {
    try {
      const arr = JSON.parse(text)
      if (Array.isArray(arr)) {
        const goals = arr
          .map((x) => (typeof x === 'string' ? x : x?.goal ?? x?.step ?? x?.title))
          .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          .map((g) => ({ goal: g.trim() }))
        if (goals.length) return goals
      }
    } catch { /* fall through to line parsing */ }
  }

  const out: SubGoal[] = []
  for (const line of text.split('\n')) {
    // strip leading "1." / "1)" / "-" / "*" / "•"
    const m = line.match(/^\s*(?:\d+[.)]|[-*•])\s+(.*\S)\s*$/)
    if (m) {
      const goal = m[1].replace(/\*\*/g, '').trim()
      if (goal.length > 2) out.push({ goal })
    }
  }
  return out
}

export interface FmPlannerOpts {
  /** Override the planning temperature (a little exploration helps here). Default 0.4. */
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  /**
   * Set false to DISABLE the deterministic precedence-aware template fast-path (see
   * `precedenceTemplatePlan`) and always ask the model. Default on — the template is the
   * whole lever for the arithmetic/parser class the FM planner can't carve itself.
   */
  template?: boolean
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-FUNCTION PLANNER — logic decomposition for STRUCTURALLY-hard functions
// ═══════════════════════════════════════════════════════════════════════════════
//
// Live verification (cont.72b) found the case-subset curriculum useless for a tight
// function like parseClock: EVERY case needs the correct parse first, so splitting the
// acceptance set gives no easier rung. The difficulty there is STRUCTURAL, not additive.
// The right axis is to split the IMPLEMENTATION into smaller pure helper functions —
// each with its own tiny spec the weak model CAN certify — then a final rung that wires
// the certified helpers and is verified against the ORIGINAL cases.
//
// This planner is UNTRUSTED like every other: it proposes helper names + example I/O.
// Those examples seed each helper's Verifier, so a WRONG example only means a helper
// certifies the wrong thing and the composition then fails the original cases → honest
// collapse. It can never make a wrong whole look right (composition re-verify owns truth).

/** One planned helper function: a name, a one-line goal, and example I/O that seed its Verifier. */
export interface PlannedSubFunction {
  name: string
  goal: string
  cases: { args: unknown[]; expected: unknown }[]
}

const SUBFN_SYSTEM =
  'You are a decomposition planner. Given ONE hard function to implement, you propose 2–4 SMALLER, ' +
  'PURE helper functions it can be built from — each doing one simple, self-contained job that a weak ' +
  'model can get right on its own. For each helper give a name, a one-line purpose, and 2–3 concrete ' +
  'input/output examples. You never write the code. Prefer helpers that carve off the tricky parsing / ' +
  'edge-case logic into isolated, independently-testable pieces.'

function buildSubFnUser(goal: string, entry: string, sampleCases: unknown[]): string {
  return [
    `TOP-LEVEL FUNCTION: ${entry}`,
    `GOAL:\n${goal}`,
    sampleCases.length ? `Example top-level behavior:\n${JSON.stringify(sampleCases.slice(0, 4))}` : '',
    'Output ONLY a JSON array of 2–4 helpers, each: ' +
      '{"name":"<camelCaseHelper>","purpose":"<one line>","examples":[{"args":[...],"expected":<value>}]}. ' +
      'No prose, no code, no markdown fences — just the JSON array.',
  ].filter(Boolean).join('\n\n')
}

/** Parse an FM reply into planned helper functions. Tolerates ```json fences and stray prose. */
export function parseSubFunctionPlan(raw: string): PlannedSubFunction[] {
  let text = (raw ?? '').trim()
  if (!text) return []
  // strip a ```json … ``` fence if present
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) text = fence[1].trim()
  // grab the first bracketed array if there's leading/trailing prose
  const arrStart = text.indexOf('[')
  const arrEnd = text.lastIndexOf(']')
  if (arrStart > 0 || arrEnd < text.length - 1) {
    if (arrStart >= 0 && arrEnd > arrStart) text = text.slice(arrStart, arrEnd + 1)
  }
  let arr: unknown
  try { arr = JSON.parse(text) } catch { return [] }
  if (!Array.isArray(arr)) return []

  const out: PlannedSubFunction[] = []
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const name = typeof o.name === 'string' ? o.name.trim() : ''
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue // must be a valid identifier
    const rawEx = Array.isArray(o.examples) ? o.examples : Array.isArray(o.cases) ? o.cases : []
    const cases = rawEx
      .map((e) => (e && typeof e === 'object' ? e as Record<string, unknown> : null))
      .filter((e): e is Record<string, unknown> => !!e && Array.isArray(e.args) && 'expected' in e)
      .map((e) => ({ args: e.args as unknown[], expected: e.expected }))
    if (!cases.length) continue // a helper with no checkable examples can't be a rung
    const goal = typeof o.purpose === 'string' && o.purpose.trim() ? o.purpose.trim()
      : typeof o.goal === 'string' && o.goal.trim() ? o.goal.trim() : name
    out.push({ name, goal, cases })
  }
  return out
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRECEDENCE-AWARE TEMPLATE — the algorithm-shaped carve for the arithmetic/parser class
// ═══════════════════════════════════════════════════════════════════════════════
//
// The live probe (2026-07-22k) found the FM sub-function planner USELESS on basicCalculator
// (evaluate `3+2*2`=7, */ before +-, no parens): it re-bakes the whole precedence problem
// into ONE un-nameable "evaluator" helper the 1.5B still can't one-shot → decompose-failed at
// −4. But for this class the correct carve is KNOWN — the textbook two-pass fold:
//     tokenize  →  fold * and / left-to-right  →  fold + and - left-to-right
// each pass a helper the weak model CAN one-shot. So for this class we SKIP the model planner
// and emit a deterministic ALGORITHM-shaped plan (0 model calls).
//
// SOUNDNESS UNCHANGED. This plan is UNTRUSTED like every plan (decompose.ts): the example I/O
// below only SEEDS each rung's verifier, and the composed whole is re-verified against the
// ORIGINAL cases. A wrong template can only waste budget — it can never certify a wrong answer.
// It changes the PATH the planner proposes, never the TRUTH the verifier owns.
//
// THE CARVE IS FOUR helpers, chosen so each rung works WITH the 1.5B's natural grain rather
// than against it — the key lesson from two live probes (2026-07-22k/l):
//   1. `tokenizeExpr(s): string[]`            regex split → ALL STRING tokens
//   2. `parseTokens(t: string[]): (num|str)[]` map Number over the digit tokens
//   3. `foldMulDiv(items): (num|str)[]`        collapse * and / (operands already numeric)
//   4. `foldAddSub(items): number`            numeric left-to-right fold → the answer
// WHY FOUR, NOT THREE. Tokenizing naturally yields STRINGS (the canonical
// `s.replace(/\s+/g,'').match(/\d+|[-+*/]/g)` idiom); arithmetic naturally yields NUMBERS. The
// first probe used unquoted-number tokens → tokenizeExpr's every draw was all-strings → failed
// JSON-stringify equality → never certified. The second used all-STRING tokens → tokenizeExpr
// certified in ONE call, but then foldMulDiv had to compute 3*2=6 and re-STRINGIFY it, which the
// model kept forgetting → stalled. Splitting out `parseTokens` gives each helper a single
// natural-typed job: tokenize stays string-only, the folds stay number-only, and the one type
// conversion is its own trivial `.map(Number)` rung. Composition = foldAddSub(foldMulDiv(
// parseTokens(tokenizeExpr(s)))). Sound regardless: seeds only SEED verifiers; the whole is
// re-verified against the ORIGINAL cases.

/** Heuristic: does this goal look like "evaluate an arithmetic expression with * / + - precedence"? */
export function isArithmeticExprGoal(goal: string, entry: string): boolean {
  const g = (goal ?? '').toLowerCase()
  const e = (entry ?? '').toLowerCase()
  const nameHit = /(calc|calculat|evalexpr|evaluate|arithmetic|expression|shunt|infix)/.test(e)
  // Operator set + precedence/expression language. Require BOTH an arithmetic-operator signal
  // and an expression/precedence signal so we don't fire on unrelated "add"/"multiply" tasks.
  const hasOps = /[*/].*[+\-]|[+\-].*[*/]|\*\s*and\s*\/|multiplication|division/.test(g)
  const exprLang = /(precedence|arithmetic expression|expression string|evaluate .*expression|operator|no parentheses|without parentheses|order of operations)/.test(g)
  const strongGoal = /precedence/.test(g) && /[+\-]/.test(g) && /[*/]/.test(g)
  return strongGoal || (nameHit && (hasOps || exprLang)) || (hasOps && exprLang)
}

/**
 * The deterministic four-helper carve for the arithmetic-expression class, each rung typed to the
 * 1.5B's natural grain: tokenize (→strings), parseTokens (→numbers), foldMulDiv, foldAddSub.
 * Composition wires them as `foldAddSub(foldMulDiv(parseTokens(tokenizeExpr(s))))`. Pure, 0 model
 * calls, class-generic example I/O. See the block above for why FOUR rather than three.
 */
export function precedenceTemplatePlan(): PlannedSubFunction[] {
  return [
    {
      name: 'tokenizeExpr',
      goal:
        'Split an arithmetic expression string of non-negative integers and the operators + - * / ' +
        'into a flat array of STRING tokens, in order, ignoring every space. Each multi-digit ' +
        'integer is ONE string token; each operator is a one-character string token. ' +
        '(The idiom `s.replace(/\\s+/g, "").match(/\\d+|[-+*/]/g)` does exactly this.)',
      cases: [
        { args: ['3+2*2'], expected: ['3', '+', '2', '*', '2'] },
        { args: [' 3/2 '], expected: ['3', '/', '2'] },
        { args: ['14 - 3*2'], expected: ['14', '-', '3', '*', '2'] },
        { args: ['2*3+4*5'], expected: ['2', '*', '3', '+', '4', '*', '5'] },
      ],
    },
    {
      name: 'parseTokens',
      goal:
        'Given an array of string tokens, return a new array where every NUMBER token (all digits) ' +
        'is converted to a number with Number(), and every OPERATOR token (+ - * /) is left as its ' +
        'one-character string. Order is preserved. (Idiom: tokens.map(t => "+-*/".includes(t) ? t : Number(t)).)',
      cases: [
        { args: [['3', '+', '2', '*', '2']], expected: [3, '+', 2, '*', 2] },
        { args: [['14', '-', '3']], expected: [14, '-', 3] },
        { args: [['5']], expected: [5] },
      ],
    },
    {
      name: 'foldMulDiv',
      goal:
        'Given an array whose elements alternate NUMBER, operator-string, NUMBER, … collapse every ' +
        '* and / LEFT TO RIGHT (integer division truncates toward zero with Math.trunc), returning ' +
        'a SHORTER array of the same shape (numbers separated by operator strings) that contains ' +
        'only + and - operators. Leave + and - untouched. Computed values stay NUMBERS. ' +
        'Idiom: `const out=[items[0]]; for(let i=1;i<items.length;i+=2){const op=items[i],b=items[i+1]; ' +
        "if(op==='*')out[out.length-1]*=b; else if(op==='/')out[out.length-1]=Math.trunc(out[out.length-1]/b); " +
        'else out.push(op,b);} return out;`',
      cases: [
        { args: [[3, '+', 2, '*', 2]], expected: [3, '+', 4] },
        { args: [[3, '/', 2]], expected: [1] },
        { args: [[3, '+', 5, '/', 2]], expected: [3, '+', 2] },
        { args: [[2, '*', 3, '+', 4, '*', 5]], expected: [6, '+', 20] },
      ],
    },
    {
      name: 'foldAddSub',
      goal:
        'Given an array whose elements alternate NUMBER, operator-string, NUMBER, … containing only ' +
        '+ and - operators, evaluate it LEFT TO RIGHT and return the resulting NUMBER. A single-number ' +
        'array returns that number. ' +
        "Idiom: `let acc=items[0]; for(let i=1;i<items.length;i+=2){acc=items[i]==='+'?acc+items[i+1]:acc-items[i+1];} return acc;`",
      cases: [
        { args: [[3, '+', 4]], expected: 7 },
        { args: [[1]], expected: 1 },
        { args: [[14, '-', 6]], expected: 8 },
        { args: [[6, '+', 20]], expected: 26 },
      ],
    },
  ]
}

/** Build a sub-function planner. Returns null when it can't propose ≥1 checkable helper. */
export function makeFmSubFunctionPlanner(opts: FmPlannerOpts = {}): (
  goal: string, entry: string, sampleCases: unknown[], signal?: AbortSignal,
) => Promise<PlannedSubFunction[] | null> {
  return async (goal, entry, sampleCases, signal) => {
    // ALGORITHM-SHAPED FAST-PATH: for the arithmetic-expression class the correct carve is known,
    // and the FM planner provably re-bakes it into one un-certifiable helper. Emit the two-pass
    // template (0 model calls) instead. Still fully verifier-gated downstream — see the block above.
    if (opts.template !== false && isArithmeticExprGoal(goal, entry)) {
      return precedenceTemplatePlan()
    }
    const raw = await fmComplete(
      [
        { role: 'system', content: SUBFN_SYSTEM },
        { role: 'user', content: buildSubFnUser(goal, entry, sampleCases) },
      ],
      { temperature: opts.temperature ?? 0.4, maxTokens: opts.maxTokens ?? 600, timeoutMs: opts.timeoutMs, signal },
    )
    const plan = parseSubFunctionPlan(raw)
    return plan.length >= 1 ? plan : null
  }
}

/** Build a Planner that asks the on-device FM for an incremental decomposition. */
export function makeFmPlanner(opts: FmPlannerOpts = {}): Planner {
  return async (spec: TaskSpec, best: Attempt | null, signal?: AbortSignal) => {
    const raw = await fmComplete(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: buildUser(spec, best) },
      ],
      { temperature: opts.temperature ?? 0.4, maxTokens: opts.maxTokens ?? 400, timeoutMs: opts.timeoutMs, signal },
    )
    const plan = parsePlan(raw)
    // < 2 rungs is not a decomposition — decline so the caller keeps its honest abstain.
    return plan.length >= 2 ? plan : null
  }
}
