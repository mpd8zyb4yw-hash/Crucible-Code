// ═══════════════════════════════════════════════════════════════════════════════
// VGR — property-based verifier (certify tasks that have NO worked example)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Many requests state no concrete f(x)===y example ("write a function to sort an array
// ascending"). The doctrine forbids guessing an answer AND forbids memorizing one — so we
// certify against a GENERAL PROPERTY instead: a sort's output is a sorted permutation of
// its input; a codec roundtrips; a validator returns a boolean. These hold for ALL inputs,
// so a candidate that satisfies them is correct for the right reason, not pattern-matched.
//
// The family detection + property assertions are REUSED from the synth path
// (`synth/derive.ts derivePropertyTests`) — the exact high-confidence families the L0/L1
// oracle already trusts — so VGR and synth agree on what "correct by property" means. We
// only add execution: the assertions run in the same sandboxed harness as codeVerifier.
// Zero model in this file.
// ═══════════════════════════════════════════════════════════════════════════════

import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { transform } from 'esbuild'
import { extractFeatures } from '../synth/index'
import { derivePropertyTests } from '../synth/derive'
import type { Candidate, TaskSpec, Verdict } from './types'

export interface PropertyAcceptance {
  entry: string
  family: string
  /** Verbatim `prop('label', <boolean expr>)` call lines lifted from derivePropertyTests. */
  assertions: string[]
  timeoutMs?: number
  [k: string]: unknown
}

/**
 * Derive a property spec from an NL request, or null when no high-confidence family matches
 * (→ VGR abstains rather than certify against a weak/absent property). Reuses the synth
 * path's family detection so the two engines never disagree on what a property means.
 */
export function derivePropertySpec(nl: string): { entry: string; family: string; assertions: string[] } | null {
  const pt = derivePropertyTests(nl, 'src/module.ts')
  if (!pt) return null
  // Lift the assertion calls. derive wraps each as: `try { prop('label', EXPR) } catch(e) { … }`.
  // The `} catch(e) { prop(` delimiter is stable and never appears inside an assertion's own
  // EXPR, so a greedy capture up to it recovers the inner `prop(...)` verbatim. Also accept a
  // bare `prop(...)` line for robustness against future formatting.
  const assertions: string[] = []
  for (const raw of pt.testFile.content.split('\n')) {
    const l = raw.trim()
    const wrapped = /^try\s*\{\s*(prop\([\s\S]*)\s*\}\s*catch\s*\(/.exec(l)
    if (wrapped) { assertions.push(wrapped[1].trim()); continue }
    if (l.startsWith('prop(')) assertions.push(l)
  }
  if (!assertions.length) return null
  const entry = extractFeatures(nl).exports[0] ?? ''
  if (!entry) return null
  return { entry, family: pt.family, assertions }
}

/**
 * Verify a candidate against its property assertions by EXECUTION. Deterministic ground
 * truth: the candidate's own exported functions are checked against invariants that hold
 * for every correct implementation. Reports each violated property as high-info feedback.
 */
export async function verifyByProperty(candidate: Candidate<string>, spec: TaskSpec): Promise<Verdict> {
  const acc = spec.acceptance as unknown as PropertyAcceptance
  const timeoutMs = acc.timeoutMs ?? 5000
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgr-prop-'))
  const modPath = path.join(dir, 'candidate.mjs')

  try {
    // Combine candidate + an inline property harness in ONE module so the assertions'
    // references to the exported functions resolve directly (same top-level scope).
    const harness = `
;(async () => {
  const __fail = [];
  function prop(label, cond) { try { if (!cond) __fail.push(label); } catch (e) { __fail.push(label + ' [threw: ' + (e && e.message ? e.message : e) + ']'); } }
${acc.assertions.map(a => '  ' + a + ';').join('\n')}
  process.stdout.write('\\n' + JSON.stringify({ fail: __fail }) + '\\n');
})();
`
    let js: string
    try {
      const out = await transform(candidate.value + '\n' + harness, { loader: 'ts', format: 'esm', target: 'node18' })
      js = out.code
    } catch (e: any) {
      const msg = (e?.errors?.[0]?.text ?? e?.message ?? 'syntax error') as string
      return { pass: false, score: -1000, signals: [`syntax error (does not compile): ${String(msg).slice(0, 200)}`] }
    }
    fs.writeFileSync(modPath, js, 'utf-8')

    const out = await new Promise<{ stdout: string; stderr: string }>(resolve => {
      execFile('node', [modPath], { cwd: dir, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (_err, stdout, stderr) => resolve({ stdout, stderr }))
    })

    const line = out.stdout.split('\n').reverse().find(l => l.trim().startsWith('{"fail"'))
    if (!line) {
      const reason = (out.stderr.trim().split('\n').find(l => /Error/.test(l)) ?? out.stderr.trim().split('\n')[0] ?? 'no result emitted').slice(0, 200)
      return { pass: false, score: -1000, signals: [`load/runtime error: ${reason}`] }
    }
    let fail: string[] = []
    try { fail = (JSON.parse(line).fail ?? []) as string[] } catch { /* treat as pass-less */ }

    if (fail.length === 0) {
      return { pass: true, score: 0, signals: [`all ${acc.assertions.length} ${acc.family} propert${acc.assertions.length === 1 ? 'y' : 'ies'} held`] }
    }
    return {
      pass: false,
      score: -fail.length,
      signals: fail.slice(0, 6).map(f => `property violated: ${f}`),
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
}
