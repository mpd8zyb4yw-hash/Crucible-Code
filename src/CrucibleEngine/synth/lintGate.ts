// ============================================================================
// Gate A2 — known-bad-pattern lint critic (Frontier-SWE-gap Workstream 1, critic #1).
//
// Runs AFTER the tsc gate (Gate A) and BEFORE the behavioral gate (Gate B) inside the
// oracle. Catches a closed set of always-wrong code shapes that tsc cannot see and that
// a weak/property-only behavioral test may not exercise: duplicate keys, duplicate
// else-if conditions, self-comparison, constant conditions, NaN equality, etc.
//
// Design constraints, in line with the free-tier philosophy:
// - Locally-executed open-source tool (ESLint, already a repo devDependency) via its
//   in-process `Linter` API — no subprocess, no config lookup, no network, ~ms per file.
// - Correctness-only ruleset. NO style rules — a false positive here would block a
//   genuinely correct FM candidate, which is worse than missing a bug (Gate B still
//   stands behind this gate). Every rule below flags code that is essentially always a
//   bug in freshly generated code.
// - Fails OPEN: if ESLint or the TS parser can't load, the gate reports ok and the
//   oracle proceeds on Gates A+B exactly as before this file existed.
// - Synchronous (createRequire) so both verifyCandidate and verifyCandidateAsync can
//   call it; the lint itself is pure in-process AST work, no event-loop stall concern
//   at candidate-file sizes.
// ============================================================================
import { createRequire } from 'module'
import type { SynthFile } from './synthEngine'
import { recordGate } from '../debug/gateTelemetry'

export interface LintVerdict {
  ok: boolean
  detail: string        // '' when ok; first violation formatted for the retry prompt otherwise
  ran: boolean          // false when ESLint was unavailable and the gate was skipped
}

// Correctness-only core rules. Each catches an "always a bug" shape tsc misses.
const RULES: Record<string, unknown> = {
  'for-direction': 'error',            // loop counter moves away from its bound → infinite loop
  'no-compare-neg-zero': 'error',      // x === -0 is always x === 0; Object.is intended
  'no-constant-condition': ['error', { checkLoops: false }], // if (true) / if (x = 1) shapes
  'no-dupe-else-if': 'error',          // later branch unreachable — classic FM copy-paste slip
  'no-dupe-keys': 'error',             // object literal silently drops the first value
  'no-duplicate-case': 'error',        // later case unreachable
  'no-self-assign': 'error',           // a = a — usually a mistyped variable name
  'no-self-compare': 'error',          // a === a — usually a mistyped variable name
  'no-unsafe-negation': 'error',       // !key in obj — negates the key, not the expression
  'use-isnan': 'error',                // x === NaN is always false
  'no-unreachable': 'error',           // code after return/throw (tsc only suggests by default)
}

type LintFn = (code: string, filename: string) => Array<{ ruleId: string | null; line: number; message: string }>
let cached: LintFn | null | undefined  // undefined = not attempted; null = unavailable, fail open

function getLinter(): LintFn | null {
  if (cached !== undefined) return cached
  try {
    const require = createRequire(import.meta.url)
    const { Linter } = require('eslint')
    const tsParser = require('@typescript-eslint/parser')
    const linter = new Linter()
    const config = {
      files: ['**/*.ts', '**/*.tsx'],   // flat-config requires an explicit file matcher
      languageOptions: {
        parser: tsParser.default ?? tsParser,
        parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      },
      rules: RULES,
    }
    cached = (code: string, filename: string) =>
      (linter.verify(code, config as any, { filename }) as any[])
        .filter(m => m.severity === 2)
        .map(m => ({ ruleId: m.ruleId ?? null, line: m.line, message: m.message }))
  } catch {
    cached = null // fail open — oracle behaves exactly as pre-Gate-A2
  }
  return cached
}

/** Lint every candidate file; first violation fails the gate with a retry-actionable detail. */
export function lintCandidates(files: SynthFile[]): LintVerdict {
  const lint = getLinter()
  if (!lint) {
    recordGate({ gate: 'gateA2_lint', ran: false, reason: 'eslint or @typescript-eslint/parser failed to load' })
    return { ok: true, detail: '', ran: false }
  }
  for (const f of files) {
    if (!/\.tsx?$/.test(f.path)) continue
    let messages: ReturnType<LintFn>
    try { messages = lint(f.content, f.path) } catch { continue } // parse handled by Gate A
    if (messages.length) {
      const m = messages[0]
      recordGate({ gate: 'gateA2_lint', ran: true, reason: `rejected: ${m.ruleId ?? 'unknown-rule'}` })
      return {
        ok: false, ran: true,
        detail: `lint (${m.ruleId ?? 'unknown-rule'}) at ${f.path}:${m.line} — ${m.message}`,
      }
    }
  }
  recordGate({ gate: 'gateA2_lint', ran: true, reason: 'clean' })
  return { ok: true, detail: '', ran: true }
}
