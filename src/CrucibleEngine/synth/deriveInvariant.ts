// Context-invariant test derivation — Workstream 1 critic (ROADMAP "Closing the Frontier-SWE
// Gap", Deterministic critic tooling).
//
// Gap this closes: derive.ts's deriveTests needs literal worked examples; derivePropertyTests
// needs a recognized structural family. Neither can verify a grouped-aggregation task like
// "summarize transactions by account, balance = credits - debits" — so it fell through to the
// gate-A-only (compile-check only) path, which cannot catch a field that's declared, present,
// and type-correct, but silently WRONG (e.g. left at its zero initializer and never computed).
// Confirmed live 2026-07-04: summaryModule's FM output compiled clean and matched the declared
// shape, but `balance` was never assigned — invisible to a compile-only gate, reproduced
// byte-for-byte across 3 separate fires.
//
// This deriver targets that exact shape generically: a function returning `Record<string, X>`
// where the spec pins one field of X down as the difference of two others (e.g.
// "balance = credits - debits"), AND the repo context already has an existing sibling file
// with a zero-arg getter returning the input array (the project's own "do not modify" data
// source). It builds a REAL runtime test — call the live getter, run the candidate, assert the
// relationship on every entry — rather than inventing synthetic data, so it only fires when it
// can genuinely check something true about the numbers, never a guess.
import fs from 'fs'
import { extractFeatures, type SynthFile } from './synthEngine'
import type { OracleContextFile } from './repoContext'

export interface InvariantTests { testFile: SynthFile; count: number; family: string }

export function deriveInvariantTests(
  spec: string,
  modulePath: string,
  contextFiles: OracleContextFile[],
): InvariantTests | null {
  if (!/Record<\s*string\s*,\s*\w+\s*>/.test(spec)) return null
  const rel = spec.match(/\b([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*-\s*([A-Za-z_]\w*)\b/)
  if (!rel) return null
  const [, diffField, field1, field2] = rel
  if (diffField === field1 || diffField === field2 || field1 === field2) return null

  const feats = extractFeatures(spec)
  const fn = feats.exports.find(n => /^[a-z]/.test(n))
  if (!fn) return null

  // Find a sibling context file that exports a zero-arg getter returning an array — the
  // project's own existing (protected) data source, e.g. `getAllTransactions(): Transaction[]`.
  let getterName: string | null = null
  let getterRel: string | null = null
  let recordHint = 3
  for (const cf of contextFiles) {
    let content: string
    try { content = fs.readFileSync(cf.src, 'utf8') } catch { continue }
    const m = content.match(/export function (\w+)\s*\(\s*\)\s*:\s*\w+\[\]/)
    if (m) {
      getterName = m[1]
      getterRel = cf.rel
      recordHint = Math.max(1, (content.match(/\{\s*id\s*:/g) ?? []).length)
      break
    }
  }
  if (!getterName || !getterRel) return null

  const importCandidate = '../' + modulePath.replace(/\.tsx?$/, '')
  const importGetter = '../' + getterRel.replace(/\.tsx?$/, '')

  const content = `// Context-invariant test (repo-getter-fed runtime oracle — Crucible synth/deriveInvariant).
import { ${fn} } from '${importCandidate}'
import { ${getterName} } from '${importGetter}'
let failures = 0
const data: any[] = ${getterName}() as any
const result: Record<string, any> = ${fn}(data) as any
const keys = Object.keys(result)
if (data.length > 0 && keys.length === 0) {
  console.log('FAIL — expected at least one grouped entry for non-empty input')
  failures++
}
for (const k of keys) {
  const entry = result[k]
  const expected = entry.${field1} - entry.${field2}
  const ok = entry.${diffField} === expected
  console.log((ok ? 'PASS' : 'FAIL') + ' — result["' + k + '"].${diffField} === ${field1} - ${field2}' +
    (ok ? '' : '  (got ' + entry.${diffField} + ', expected ' + expected + ')'))
  if (!ok) failures++
}
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`
  return {
    testFile: { path: '__invariant__/spec.test.ts', content },
    count: recordHint,
    family: 'grouped-ledger-aggregate',
  }
}
