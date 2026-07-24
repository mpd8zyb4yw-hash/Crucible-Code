// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE SELF-CHECK — deterministic, model-free guard on the decompose registry.
// Run:  npx tsx src/CrucibleEngine/reasoning/__template_selfcheck.ts
// ═══════════════════════════════════════════════════════════════════════════════
//
// WHY. Every template class (fmPlanner.ts) hands the weak FM a "Write exactly:\n<code>"
// reference snippet per helper, plus a small cases[] batch. Those snippets are LOAD-BEARING
// — when the FM copies them, they ARE the certified solution — yet nothing tested them
// except a live run that happened to copy them verbatim. A typo in a snippet (or a
// cases[] entry that disagrees with its own snippet) would silently degrade a whole class
// and only surface as a mystery live regression.
//
// This executes each class's snippets THE WAY the composed module runs them — all helpers
// of the class defined together (so nextRow can call subCost, coinChange can call initDp),
// then every helper's own cases[] asserted against them. Pure JS, no model, no network,
// runs in milliseconds. If it's green, every template snippet computes what its cases claim;
// a registry edit that breaks a class fails HERE, before it ever reaches the live head.
//
// Adding a template class? Add one row to CLASSES and its snippets are guarded too.

import {
  precedenceTemplatePlan, rpnTemplatePlan, editDistanceTemplatePlan,
  shuntingYardTemplatePlan, coinChangeTemplatePlan,
} from './fmPlanner'
import type { PlannedSubFunction } from './fmPlanner'

const CLASSES: { label: string; plan: PlannedSubFunction[] }[] = [
  { label: 'basicCalculator (parenless fold)', plan: precedenceTemplatePlan() },
  { label: 'evalRPN (postfix stack)', plan: rpnTemplatePlan() },
  { label: 'editDistance (Levenshtein DP)', plan: editDistanceTemplatePlan() },
  { label: 'calculatorWithParens (shunting-yard)', plan: shuntingYardTemplatePlan() },
  { label: 'coinChange (min-coins DP)', plan: coinChangeTemplatePlan() },
]

let failures = 0
const check = (label: string, cond: boolean, detail = '') => {
  console.log(`${cond ? '  PASS' : '  FAIL'} — ${label}${cond ? '' : ' :: ' + detail.slice(0, 200)}`)
  if (!cond) failures++
}

// Pull the reference code that follows the final "Write exactly:" in a helper goal.
function extractSnippet(goal: string): string | null {
  const idx = goal.lastIndexOf('Write exactly:')
  if (idx === -1) return null
  return goal.slice(idx + 'Write exactly:'.length).trim()
}

// Build one runnable module from ALL of a class's helper snippets (so inter-helper calls
// resolve), returning the named functions. Snippets are plain JS `export function …`.
function buildModule(plan: PlannedSubFunction[]): Record<string, (...a: any[]) => any> {
  const names = plan.map(h => h.name)
  const src = plan.map(h => {
    const s = extractSnippet(h.goal)
    if (!s) throw new Error(`helper ${h.name} has no "Write exactly:" snippet`)
    return s.replace(/^export\s+/gm, '')
  }).join('\n\n')
  // eslint-disable-next-line no-new-func
  const factory = new Function(`"use strict";\n${src}\nreturn { ${names.join(', ')} }`)
  return factory()
}

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

for (const cls of CLASSES) {
  let mod: Record<string, (...a: any[]) => any>
  try {
    mod = buildModule(cls.plan)
  } catch (e: any) {
    check(`${cls.label}: snippets form a runnable module`, false, String(e?.message ?? e))
    continue
  }
  check(`${cls.label}: snippets form a runnable module`, true)
  for (const h of cls.plan) {
    check(`${cls.label} · ${h.name} is defined and callable`, typeof mod[h.name] === 'function')
    if (typeof mod[h.name] !== 'function') continue
    let allOk = true
    let firstBad = ''
    for (const c of h.cases) {
      let got: unknown
      try { got = mod[h.name](...(c.args as unknown[])) } catch (e: any) { got = `THREW ${e?.message ?? e}` }
      if (!eq(got, c.expected)) {
        allOk = false
        firstBad = `${h.name}(${JSON.stringify(c.args).slice(1, -1)}) → ${JSON.stringify(got)} ≠ ${JSON.stringify(c.expected)}`
        break
      }
    }
    check(`${cls.label} · ${h.name}: all ${h.cases.length} snippet cases hold`, allOk, firstBad)
  }
}

console.log(failures === 0 ? '\nALL PASS — every template snippet computes what its cases claim' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
