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

// ── RPN / postfix / stack-machine class ────────────────────────────────────────
// evalRPN (Reverse Polish Notation) is a SECOND task the pass@k experiment measured at 0%
// (0/10 pass@1, never solved by feedback-threaded multishot) — same "sampling can't reach it"
// wall as basicCalculator. The flat 1.5B reliably botches the two semantic traps: operand ORDER
// (`a b -` means a−b, not b−a) and truncation direction (6/−4 = −1 toward zero, not −2 floor).
// The carve ISOLATES exactly those into one tiny certified helper, `applyOp(op,a,b)`, whose seed
// cases PIN both; the composition then only has to get the stack mechanics right. Same doctrine.

/** Heuristic: does this goal look like Reverse Polish Notation / postfix stack evaluation? */
export function isRpnGoal(goal: string, entry: string): boolean {
  const g = (goal ?? '').toLowerCase()
  const e = (entry ?? '').toLowerCase()
  if (/(rpn|postfix)/.test(e)) return true
  return /(reverse polish|postfix)/.test(g) && /(evaluat|operator|\+|stack)/.test(g)
}

/**
 * The one-helper carve for the RPN/postfix class: `applyOp(op,a,b)` pins operand order + trunc
 * division; the composition (the entry itself) wires the stack. Pure, 0 model calls, class-generic.
 */
export function rpnTemplatePlan(): PlannedSubFunction[] {
  return [
    {
      name: 'isOperator',
      goal:
        'Implement `isOperator(token)` — return true if and only if the string token is EXACTLY one ' +
        'of the operators "+", "-", "*", "/". A multi-character token like "-4" or "12" is NOT an ' +
        'operator (it is a negative or multi-digit NUMBER), so length matters. Write exactly:\n' +
        "export function isOperator(token) { return token.length === 1 && '+-*/'.includes(token) }",
      cases: [
        { args: ['+'], expected: true },
        { args: ['-'], expected: true },
        { args: ['/'], expected: true },
        { args: ['-4'], expected: false },
        { args: ['12'], expected: false },
      ],
    },
    {
      name: 'applyOp',
      goal:
        'Implement `applyOp(op, a, b)` — apply ONE binary arithmetic operator to two numbers IN ORDER, ' +
        'returning `a op b` for op one of "+", "-", "*", "/". `op` is a string; `a` and `b` are numbers. ' +
        'Order matters — applyOp("-", 10, 3) returns 7, not -7. Division is integer division truncating ' +
        'TOWARD ZERO with Math.trunc — applyOp("/", 6, -4) returns -1, NOT -2. Write exactly:\n' +
        "export function applyOp(op, a, b) { return op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : Math.trunc(a / b) }",
      cases: [
        { args: ['+', 2, 1], expected: 3 },
        { args: ['-', 10, 3], expected: 7 },
        { args: ['*', 3, 4], expected: 12 },
        { args: ['/', 6, -4], expected: -1 },
        { args: ['/', 13, 5], expected: 2 },
      ],
    },
  ]
}

// ── Edit-distance / Levenshtein DP class ────────────────────────────────────────
// A THIRD task the flat 1.5B measures at 0% (flat solveCodeTask EXHAUSTS on the 6-case set; the
// two-dimensional recurrence is beyond its one-shot reach). It is a genuinely DIFFERENT algorithm
// family from the two arithmetic/stack classes — a DP table — which is why cracking it proves the
// registry generalizes past "expression evaluators". The carve is the rolling-row Levenshtein DP,
// split so EVERY hard piece is an idiom-bearing helper the weak head can one-shot:
//   1. `subCost(x, y)`            the diagonal substitution cost (0 if equal else 1)
//   2. `nextRow(prev, ca, b)`     ONE DP row from the previous — the min-of-three recurrence trap
//   3. `editRow(a, b)`            fold nextRow over a from the seed row [0..b.length] → final row
// The composition is then pure indexing: `editDistance(a,b) = editRow(a,b)[b.length]`.
//
// WHY THE FOLD IS ITS OWN HELPER (editRow), NOT LEFT TO THE COMPOSITION. Live probe (2026-07-23):
// with only subCost+nextRow, the composition rung has to invent the row-fold AND the seeding AND the
// final-cell index at once — the 1.5B re-derives a full 2D `dp[i][j]` table instead and anchors.
// Making the fold an idiom-bearing helper (editRow) that certifies in isolation leaves the
// composition a one-line index — the same "pure nesting" shape basicCalculator's compose has. Even
// so the composition needs to be TOLD that index (see composeHintFor): the helper signatures alone
// don't reveal that the answer is the last cell of editRow's output.
//
// SOUNDNESS UNCHANGED. Seeds only SEED verifiers and the composed whole is re-verified against the
// ORIGINAL cases; a wrong template can only waste budget, never certify a wrong answer.

/** Heuristic: does this goal look like Levenshtein / edit-distance dynamic programming? */
export function isEditDistanceGoal(goal: string, entry: string): boolean {
  const g = (goal ?? '').toLowerCase()
  const e = (entry ?? '').toLowerCase()
  if (/(editdistance|levenshtein)/.test(e)) return true
  if (/levenshtein/.test(g)) return true
  // "edit distance" plus the three-operation signature, so we don't fire on unrelated "distance".
  const editDist = /edit distance/.test(g)
  const threeOps = /(insert).*(delet).*(substitut)|(substitut).*(insert).*(delet)/.test(g)
  return editDist && (threeOps || /minimum number of/.test(g))
}

/**
 * The three-helper carve for the edit-distance/Levenshtein class: subCost (diagonal cost), nextRow
 * (one DP row — the min-of-three recurrence), editRow (the row fold). The composition is pure
 * indexing `editRow(a,b)[b.length]` — see composeHintFor, which hands the compose rung that index.
 * Pure, 0 model calls, class-generic example I/O.
 */
export function editDistanceTemplatePlan(): PlannedSubFunction[] {
  return [
    {
      name: 'subCost',
      goal:
        'Implement `subCost(x, y)` — return 0 if the single characters x and y are equal, else 1 ' +
        '(the substitution cost of the Levenshtein recurrence). Write exactly:\n' +
        'export function subCost(x, y) { return x === y ? 0 : 1 }',
      cases: [
        { args: ['a', 'a'], expected: 0 },
        { args: ['a', 'b'], expected: 1 },
        { args: ['x', 'x'], expected: 0 },
      ],
    },
    {
      name: 'nextRow',
      goal:
        'Implement `nextRow(prev, ca, b)` — compute ONE row of the Levenshtein DP table from the ' +
        'previous row. `prev` is the previous row (an array of length b.length+1), `ca` is one ' +
        'character of the first string, `b` is the whole second string. Element 0 is prev[0]+1 (a ' +
        'deletion). For each j from 0..b.length-1 the next element is the MINIMUM of three: ' +
        'prev[j+1]+1 (deletion), cur[j]+1 (insertion), and prev[j]+subCost(ca, b[j]) (match or ' +
        'substitute). Return the new row (length b.length+1). Write exactly:\n' +
        'export function nextRow(prev, ca, b) { const cur = [prev[0] + 1]; for (let j = 0; j < b.length; j++) { cur.push(Math.min(prev[j + 1] + 1, cur[j] + 1, prev[j] + subCost(ca, b[j]))) } return cur }',
      cases: [
        { args: [[0, 1, 2, 3], 's', 'abc'], expected: [1, 1, 2, 3] },
        { args: [[0, 1, 2], 'a', 'ab'], expected: [1, 0, 1] },
        { args: [[1, 1, 2, 3], 'i', 'abc'], expected: [2, 2, 2, 3] },
      ],
    },
    {
      name: 'editRow',
      goal:
        'Implement `editRow(a, b)` — compute the FINAL row of the Levenshtein DP table for strings a ' +
        'and b. Start with the first row [0, 1, 2, ..., b.length], then update it once for EACH ' +
        'character of a using nextRow. Return the final row (an array of length b.length+1). ' +
        'Write exactly:\n' +
        'export function editRow(a, b) { let row = []; for (let j = 0; j <= b.length; j++) row.push(j); for (const ch of a) row = nextRow(row, ch, b); return row }',
      cases: [
        { args: ['', 'abc'], expected: [0, 1, 2, 3] },
        { args: ['a', 'ab'], expected: [1, 0, 1] },
        { args: ['ab', 'ab'], expected: [2, 1, 0] },
      ],
    },
  ]
}

// ── Coin-change MINIMUM-COINS DP class ──────────────────────────────────────────
/** Heuristic: does this goal look like "fewest coins to make an amount" (unbounded-supply min-coins DP)? */
export function isCoinChangeGoal(goal: string, entry: string): boolean {
  const g = (goal ?? '').toLowerCase()
  const e = (entry ?? '').toLowerCase()
  if (/coinchange/.test(e)) return true
  // "coin(s)"/"denomination(s)" as the unit, a MINIMISATION cue, and an "amount"/"total" target.
  const coinUnit = /\bcoins?\b|denomination/.test(g)
  const minimise = /(fewest|minimum number|minimum count|least number|smallest number|min(?:imum)? coins?)/.test(g)
  const target = /\bamount\b|\btotal\b|\bsum\b|make change/.test(g)
  return coinUnit && minimise && target
}

/**
 * The three-helper carve for the coin-change min-coins class: initDp (the amount+1 "infinity"
 * sentinel table), relaxCoin (one unbounded-coin relaxation pass — the DP recurrence), and the
 * entry coinChange (fold relaxCoin over the coins, read dp[amount]). The amount+1 sentinel avoids
 * Infinity entirely, so every rung's example I/O is small integers. Composition is the fold —
 * see composeHintFor. Pure, 0 model calls, class-generic example I/O.
 */
export function coinChangeTemplatePlan(): PlannedSubFunction[] {
  return [
    {
      name: 'initDp',
      goal:
        'Implement `initDp(amount)` — build the initial min-coins DP table: an array of length ' +
        'amount+1 where every entry is the sentinel amount+1 (a stand-in for "unreachable", since no ' +
        'real answer can exceed amount coins), EXCEPT index 0 which is 0 (zero coins make amount 0). ' +
        'Write exactly:\n' +
        'export function initDp(amount) { const dp = new Array(amount + 1).fill(amount + 1); dp[0] = 0; return dp }',
      cases: [
        { args: [3], expected: [0, 4, 4, 4] },
        { args: [0], expected: [0] },
        { args: [1], expected: [0, 2] },
      ],
    },
    {
      name: 'relaxCoin',
      goal:
        'Implement `relaxCoin(dp, coin)` — one relaxation pass for a single coin of UNBOUNDED supply. ' +
        'Copy dp, then for each amount a from coin up to dp.length-1 set out[a] = min(out[a], ' +
        'out[a-coin]+1). Sweeping a ASCENDING lets the same coin be reused any number of times. ' +
        'Return the new array; do NOT mutate the input. Write exactly:\n' +
        'export function relaxCoin(dp, coin) { const out = dp.slice(); for (let a = coin; a < out.length; a++) out[a] = Math.min(out[a], out[a - coin] + 1); return out }',
      cases: [
        { args: [[0, 4, 4, 4], 1], expected: [0, 1, 2, 3] },
        { args: [[0, 4, 4, 4], 2], expected: [0, 4, 1, 4] },
        { args: [[0, 1, 2, 3], 2], expected: [0, 1, 1, 2] },
      ],
    },
    {
      name: 'coinChange',
      goal:
        'Implement `coinChange(coins, amount)` — the FEWEST coins (each denomination available in ' +
        'unlimited supply) that sum to exactly amount, or -1 if no combination does. Start from ' +
        'initDp(amount), then fold relaxCoin over every coin. The answer is dp[amount] unless it is ' +
        'still greater than amount (the untouched sentinel → unreachable), in which case return -1. ' +
        'Uses initDp and relaxCoin. Write exactly:\n' +
        'export function coinChange(coins, amount) { let dp = initDp(amount); for (const c of coins) dp = relaxCoin(dp, c); return dp[amount] > amount ? -1 : dp[amount] }',
      cases: [
        { args: [[1, 2, 5], 11], expected: 3 },
        { args: [[2], 3], expected: -1 },
        { args: [[1], 0], expected: 0 },
        { args: [[2, 5, 10], 27], expected: 4 },
      ],
    },
  ]
}

// ── Shunting-yard PARENTHESISED calculator class ────────────────────────────────
// A FOURTH template class, and the one that most directly answers the "cold agent path" gap
// (NEXT_SESSION item, 2026-07-23): the parenless two-pass fold (precedenceTemplatePlan) provably
// CANNOT evaluate `(2+3)*4` — grouping breaks the flat left-to-right fold entirely — so a
// parenthesised calculator is a genuinely DISTINCT algorithm (Dijkstra's shunting-yard: an operator
// stack that reorders the stream into postfix, then a stack machine that evaluates it). It is the
// representative we wanted precisely because the hard rung, `toPostfix`, is NON-synth-constructible:
// enumerative program search over the corpus's tiny operator set can stumble onto editDistance-shaped
// table code, but it will not synthesise a correct precedence-climbing operator stack — so this class
// forces GENERATION on the decompose path even from a cold library. The carve is the textbook pipeline,
// each stage an idiom-bearing helper the weak head can one-shot:
//   1. `tokenize(s): string[]`          regex split → string tokens INCLUDING '(' and ')'
//   2. `precedence(op): number`         2 for * and /, 1 for + and - (the only comparison toPostfix needs)
//   3. `toPostfix(tokens): string[]`    shunting-yard: operator stack → RPN token stream (calls precedence)
//   4. `evalPostfix(postfix): number`   stack machine over the RPN stream → the answer (operand order + trunc div)
// Composition is pure nesting `evalPostfix(toPostfix(tokenize(s)))`, but the compose rung is still handed
// that one-liner (composeHintFor) — with FOUR unfamiliar helper names the 1.5B otherwise mis-orders the
// pipeline or tries to re-fold precedence inline. SOUNDNESS UNCHANGED: seeds only SEED verifiers and the
// composed whole is re-verified against the ORIGINAL cases; a wrong template only wastes budget.

/** Heuristic: does this goal look like "evaluate an arithmetic expression WITH parentheses"? */
export function isShuntingYardGoal(goal: string, entry: string): boolean {
  const g = (goal ?? '').toLowerCase()
  const e = (entry ?? '').toLowerCase()
  // Name the algorithm or the entry → unambiguous.
  if (/shunting.?yard/.test(g)) return true
  if (/shunt/.test(e)) return true
  // Otherwise: an arithmetic-expression evaluator that EXPLICITLY involves parentheses/grouping.
  // A raw "paren" mention is not enough — the parenless basicCalculator goal literally says "no
  // parentheses", so a NEGATED mention ("no/without parentheses") must NOT count, else this would
  // steal that class from precedenceTemplatePlan.
  const mentionsParens = /parenthes|\bparens?\b|bracket|grouping|\(\s*\)/.test(g)
  const negatedParens = /\b(no|without|not|excluding|ignore|ignoring|omit|omitting|drop|dropping)\b[^.]{0,24}\b(paren|bracket|group)/.test(g)
  const parenSignal = mentionsParens && !negatedParens
  const hasOps = /[+\-].*[*/]|[*/].*[+\-]/.test(g) || /\boperator/.test(g)
  const exprLang = /(evaluat|calculat|expression|arithmetic|precedence|order of operations)/.test(g)
  return parenSignal && hasOps && exprLang
}

/**
 * The four-helper carve for the parenthesised-calculator class: tokenize (→string tokens incl parens),
 * precedence (the * /-over-+ - comparison), toPostfix (the shunting-yard reorder — the generation-forcing
 * rung), evalPostfix (the RPN stack machine). Composition is `evalPostfix(toPostfix(tokenize(s)))` — handed
 * to the compose rung by composeHintFor. Pure, 0 model calls, class-generic example I/O.
 */
export function shuntingYardTemplatePlan(): PlannedSubFunction[] {
  return [
    {
      name: 'tokenize',
      goal:
        'Implement `tokenize(s)` — split an arithmetic expression string of non-negative integers, ' +
        'the operators + - * /, and ROUND PARENTHESES ( ) into a flat array of STRING tokens, in ' +
        'order, ignoring every space. Each multi-digit integer is ONE string token; each operator ' +
        'and each parenthesis is a one-character string token. Write exactly:\n' +
        'export function tokenize(s) { return s.replace(/\\s+/g, "").match(/\\d+|[-+*/()]/g) || [] }',
      cases: [
        { args: ['3+2*2'], expected: ['3', '+', '2', '*', '2'] },
        { args: ['(1+2)*3'], expected: ['(', '1', '+', '2', ')', '*', '3'] },
        { args: [' 2 * ( 3 + 4 ) '], expected: ['2', '*', '(', '3', '+', '4', ')'] },
        { args: ['10'], expected: ['10'] },
      ],
    },
    {
      name: 'precedence',
      goal:
        'Implement `precedence(op)` — return the binding strength of a one-character operator string: ' +
        '2 for "*" and "/", 1 for "+" and "-". Write exactly:\n' +
        'export function precedence(op) { return op === "*" || op === "/" ? 2 : 1 }',
      cases: [
        { args: ['*'], expected: 2 },
        { args: ['/'], expected: 2 },
        { args: ['+'], expected: 1 },
        { args: ['-'], expected: 1 },
      ],
    },
    {
      name: 'toPostfix',
      goal:
        'Implement `toPostfix(tokens)` — convert an array of infix tokens (number-strings, the ' +
        'one-character operators + - * /, and the parentheses "(" ")") into Reverse Polish Notation ' +
        '(postfix) using Dijkstra\'s SHUNTING-YARD algorithm with an operator stack. All operators are ' +
        'LEFT-ASSOCIATIVE. Numbers go straight to the output. On an operator, first pop to the output ' +
        'every stacked operator of GREATER-OR-EQUAL precedence (never past a "("), then push it. On ' +
        '"(" push it; on ")" pop to the output until the matching "(" and discard both parens. At the ' +
        'end pop any remaining operators. Uses the helper `precedence(op)`. Write exactly:\n' +
        'export function toPostfix(tokens) { const out = []; const ops = []; for (const t of tokens) { ' +
        'if (t === "(") ops.push(t); else if (t === ")") { while (ops.length && ops[ops.length - 1] !== "(") ' +
        'out.push(ops.pop()); ops.pop(); } else if (t.length === 1 && "+-*/".includes(t)) { ' +
        'while (ops.length && ops[ops.length - 1] !== "(" && precedence(ops[ops.length - 1]) >= precedence(t)) ' +
        'out.push(ops.pop()); ops.push(t); } else out.push(t); } while (ops.length) out.push(ops.pop()); return out }',
      cases: [
        { args: [['3', '+', '2', '*', '2']], expected: ['3', '2', '2', '*', '+'] },
        { args: [['(', '1', '+', '2', ')', '*', '3']], expected: ['1', '2', '+', '3', '*'] },
        { args: [['2', '*', '3', '+', '4']], expected: ['2', '3', '*', '4', '+'] },
        { args: [['10']], expected: ['10'] },
      ],
    },
    {
      name: 'evalPostfix',
      goal:
        'Implement `evalPostfix(postfix)` — evaluate an array of Reverse Polish Notation (postfix) ' +
        'string tokens with a number stack, returning the resulting NUMBER. Push each number token ' +
        '(via Number). On a one-character operator + - * /, pop b then a and push `a op b` IN THAT ' +
        'ORDER (a is the deeper operand). Division is integer division truncating TOWARD ZERO with ' +
        'Math.trunc — so 7/2 = 3 and evalPostfix(["6","-4","/"]) would be -1, not -2. Write exactly:\n' +
        'export function evalPostfix(postfix) { const st = []; for (const t of postfix) { ' +
        'if (t.length === 1 && "+-*/".includes(t)) { const b = st.pop(), a = st.pop(); ' +
        'st.push(t === "+" ? a + b : t === "-" ? a - b : t === "*" ? a * b : Math.trunc(a / b)); } ' +
        'else st.push(Number(t)); } return st[0] }',
      cases: [
        { args: [['3', '2', '2', '*', '+']], expected: 7 },
        { args: [['1', '2', '+', '3', '*']], expected: 9 },
        { args: [['10', '2', '-', '3', '*']], expected: 24 },
        { args: [['7', '2', '/']], expected: 3 },
        { args: [['5']], expected: 5 },
      ],
    },
  ]
}

/**
 * Dispatch a goal to its known algorithm-shaped decomposition template, or null when no class
 * matches (→ the FM planner proposes a carve instead). A registry of (class-detector → template):
 * the extensible generalization of the basicCalculator crack to any provably-0%-by-sampling class.
 */
export function templateFor(goal: string, entry: string): PlannedSubFunction[] | null {
  // MOST-SPECIFIC DETECTORS FIRST. An RPN goal ("evaluate a postfix expression with operators
  // + - * /") also trips the broader arithmetic-operator signal, so the postfix/stack detector must
  // win. A PARENTHESISED calculator ("evaluate ... with + - * / precedence AND parentheses") also
  // trips isArithmeticExprGoal's precedence signal, so the shunting-yard detector must be checked
  // BEFORE the parenless two-pass fold — routing a parens goal to precedenceTemplatePlan would carve
  // a plan that provably cannot evaluate grouping. The classes are otherwise disjoint (edit-distance
  // has no operators and matches only on "levenshtein"/"edit distance"; the parenless basicCalculator
  // goal says "no parentheses" → isShuntingYardGoal declines it), but the ordering is kept explicit so
  // adding a class can never silently mis-route an existing one.
  if (isRpnGoal(goal, entry)) return rpnTemplatePlan()
  if (isEditDistanceGoal(goal, entry)) return editDistanceTemplatePlan()
  // Coin-change is disjoint from every other class (no operators, no expression/parens language,
  // matches only on coins+minimise+amount), so ordering versus the calculators is immaterial — but
  // it is kept AFTER edit-distance and BEFORE the arithmetic detectors so the specific-first
  // discipline is visibly preserved.
  if (isCoinChangeGoal(goal, entry)) return coinChangeTemplatePlan()
  if (isShuntingYardGoal(goal, entry)) return shuntingYardTemplatePlan()
  if (isArithmeticExprGoal(goal, entry)) return precedenceTemplatePlan()
  return null
}

/**
 * A COMPOSITION IDIOM for a template class — the one-line wiring the compose rung should emit, when
 * the helper signatures alone don't reveal it. Injected into the composition rung's goal by
 * decomposeCodeBySubFunction. Null for classes whose composition is discoverable (basicCalculator's
 * pure nesting, evalRPN's stack pass). UNTRUSTED like every hint: the composed whole is re-verified
 * against the ORIGINAL cases, so a wrong idiom only wastes budget.
 *
 * Edit-distance needs it: the answer is the LAST cell of editRow's output, which no signature shows,
 * so without this the 1.5B re-derives a full 2D DP table and anchors (live probe 2026-07-23).
 */
export function composeHintFor(goal: string, entry: string): string | null {
  if (isEditDistanceGoal(goal, entry)) {
    return (
      'COMPOSITION: the edit distance is the LAST element of the final DP row. Write exactly:\n' +
      `export function ${entry}(a, b) { return editRow(a, b)[b.length] }`
    )
  }
  // Shunting-yard: pure nesting, but with FOUR unfamiliar helper names the 1.5B mis-orders the
  // pipeline (or re-folds precedence inline) unless handed the exact wiring. UNTRUSTED — re-verify
  // owns truth. Note this is checked AFTER edit-distance, matching templateFor's ordering, though
  // the two detectors are disjoint (no goal is both a Levenshtein and a parens calculator).
  if (isShuntingYardGoal(goal, entry)) {
    return (
      'COMPOSITION: tokenize the string, convert to postfix, then evaluate the postfix. Write exactly:\n' +
      `export function ${entry}(s) { return evalPostfix(toPostfix(tokenize(s))) }`
    )
  }
  // Coin-change: the amount+1 sentinel and the "> amount → -1" read are invisible in the helper
  // signatures, so without this the 1.5B tends to compare against Infinity or forget the -1 branch.
  // UNTRUSTED — the composed whole is re-verified against the original cases.
  if (isCoinChangeGoal(goal, entry)) {
    return (
      'COMPOSITION: seed initDp(amount), fold relaxCoin over every coin, then read dp[amount] — but ' +
      'the untouched sentinel is amount+1, so a value greater than amount means unreachable → -1. Write exactly:\n' +
      `export function ${entry}(coins, amount) { let dp = initDp(amount); for (const c of coins) dp = relaxCoin(dp, c); return dp[amount] > amount ? -1 : dp[amount] }`
    )
  }
  return null
}

/** True when some algorithm-shaped decompose template covers this goal (used to route early). */
export function hasDecomposeTemplate(goal: string, entry: string): boolean {
  return templateFor(goal, entry) !== null
}

/**
 * True for the DP-FOLD template classes — edit-distance (editRow) and coin-change (relaxCoin) —
 * whose central helper folds a per-element recurrence over a whole array. That fold is the one
 * rung the 1.5B re-derives from scratch on most draws, so it is WALL-CLOCK bound: a live 3× signal
 * (2026-07-24, shared qwen2.5-1.5b head) had editRow certify 2/3, needing 22–28 model calls at
 * ~12s each — >300s — with the one failure hitting the wall-clock, not the call, ceiling. The
 * calculators are excluded: their hardest rung (shunting-yard toPostfix) one-shots (4 calls in the
 * calculatorWithParens live probe), so they do NOT need the bigger wall.
 */
export function isDpFoldDecomposeClass(goal: string, entry: string): boolean {
  return isEditDistanceGoal(goal, entry) || isCoinChangeGoal(goal, entry)
}

/**
 * Per-rung iterate budget for the decompose path, sized to the CARVE, not an unstated default.
 * The lever the 3× signal identified is WALL-CLOCK on the DP-fold rung (planAttempts is inert for
 * a template class — its plan is deterministic, so re-running only re-certifies the easy rungs);
 * so the DP-fold classes get a materially larger wall (and headroom on calls/epochs) while every
 * other class keeps the standard budget. Verifier-gated throughout: a bigger budget only lets an
 * honest solve finish, never certifies a wrong one. Caller threads the result straight into
 * decomposeCodeBySubFunction's `iterate`.
 */
export function decomposePerRungBudget(goal: string, entry: string): { globalModelCalls: number; maxEpochs: number; wallClockMs: number } {
  if (isDpFoldDecomposeClass(goal, entry)) {
    // editRow/relaxCoin: 22–28 calls observed → 40-call headroom; >300s observed → 420s wall.
    return { globalModelCalls: 40, maxEpochs: 12, wallClockMs: 420_000 }
  }
  return { globalModelCalls: 64, maxEpochs: 10, wallClockMs: 180_000 }
}

/** Build a sub-function planner. Returns null when it can't propose ≥1 checkable helper. */
export function makeFmSubFunctionPlanner(opts: FmPlannerOpts = {}): (
  goal: string, entry: string, sampleCases: unknown[], signal?: AbortSignal,
) => Promise<PlannedSubFunction[] | null> {
  return async (goal, entry, sampleCases, signal) => {
    // ALGORITHM-SHAPED FAST-PATH: for a known 0%-by-sampling class (arithmetic expression, RPN, …)
    // the correct carve is known and the FM planner provably re-bakes it into one un-certifiable
    // helper. Emit the class template (0 model calls) instead. Still fully verifier-gated downstream.
    if (opts.template !== false) {
      const tpl = templateFor(goal, entry)
      if (tpl) return tpl
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
