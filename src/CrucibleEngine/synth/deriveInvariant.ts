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

/** Find a sibling context file that exports a zero-arg getter returning an array — the
 *  project's own existing (protected) data source, e.g. `getAllTransactions(): Transaction[]`. */
function findContextGetter(contextFiles: OracleContextFile[]): { name: string; rel: string; content: string } | null {
  for (const cf of contextFiles) {
    let content: string
    try { content = fs.readFileSync(cf.src, 'utf8') } catch { continue }
    const m = content.match(/export function (\w+)\s*\(\s*\)\s*:\s*\w+\[\]/)
    if (m) return { name: m[1], rel: cf.rel, content }
  }
  return null
}

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

  const getter = findContextGetter(contextFiles)
  if (!getter) return null
  const recordHint = Math.max(1, (getter.content.match(/\{\s*id\s*:/g) ?? []).length)

  const importCandidate = '../' + modulePath.replace(/\.tsx?$/, '')
  const importGetter = '../' + getter.rel.replace(/\.tsx?$/, '')
  const getterName = getter.name

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

/**
 * Context-getter-fed smoke test for `fn(items: T[], opts: XxxOpts): T[]`-shaped transforms
 * (sort/reorder with a config object) — the shape derive.ts's 'sort' family had to stop
 * covering once arity-gated to single-arg signatures (see the `derive.ts` 'sort' family
 * comment). Without ANY oracle, this shape ships via gate-A-only (compile-check only), which
 * cannot catch a candidate that compiles clean but throws or misbehaves at runtime.
 *
 * Confirmed live 2026-07-04: sortModule's FM output reproducibly (2/2 fires, byte-for-byte
 * identical logic) wrote `if (!Array.isArray(opts)) throw new TypeError(...)` — a copy-paste
 * mistake mirroring the correct array-check on `items` but wrongly applied to the singular
 * opts object — which threw on every legitimate call. A compile-only gate cannot see this;
 * only actually calling the function does.
 *
 * Deliberately narrow and behavior-agnostic (does NOT assert the transform's actual
 * correctness — no derived sort-order check here, since a general "sorted" property lost its
 * safety when the signature stopped being single-arg). Only asserts: doesn't throw on a
 * well-formed call, returns an array, preserves length, doesn't mutate the input. Excludes
 * `filter*`-named exports — those are already covered by derive.ts's more precise
 * `filter-opts` family and should not be double-tested here.
 */
export function deriveOptsTransformSmokeTest(
  spec: string,
  modulePath: string,
  contextFiles: OracleContextFile[],
): InvariantTests | null {
  const feats = extractFeatures(spec)
  const fn = feats.exports.find(n => /^[a-z]/.test(n) && !/^filter/i.test(n))
  if (!fn) return null

  const sig = spec.match(new RegExp(`\\bfunction\\s+${fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(([^)]*)\\)\\s*:\\s*(\\w+)\\[\\]`))
  if (!sig) return null
  const params = sig[1].split(',').map(p => p.trim())
  if (params.length !== 2) return null
  if (!/\[\]\s*$/.test(params[0])) return null   // first param must be an array
  const optsParam = params[1].match(/^\w+\s*:\s*(\w+)$/)
  if (!optsParam) return null
  const optsType = optsParam[1]
  if (!/opts?$/i.test(optsType)) return null      // second param's type name must look like an Opts bag

  // Find the opts interface's first REQUIRED field with a string-literal-union type, to build
  // a minimal well-formed call (e.g. `{ by: 'price' }` for `by: 'price' | 'name'`).
  const ifaceMatch = spec.match(new RegExp(`interface\\s+${optsType}\\s*\\{([\\s\\S]*?)\\}`))
  if (!ifaceMatch) return null
  const fieldLines = ifaceMatch[1].split('\n').map(l => l.trim()).filter(Boolean)
  let requiredField: string | null = null
  let requiredLiteral: string | null = null
  for (const line of fieldLines) {
    const fm = line.match(/^(\w+)\s*(\?)?:\s*(.+?)(?:\/\/.*)?$/)
    if (!fm) continue
    const [, fieldName, optional, type] = fm
    if (optional) continue
    const lit = type.match(/'([^']+)'/)
    if (lit) { requiredField = fieldName; requiredLiteral = lit[1]; break }
  }
  if (!requiredField || !requiredLiteral) return null

  const getter = findContextGetter(contextFiles)
  if (!getter) return null
  const recordHint = Math.max(1, (getter.content.match(/\{\s*id\s*:/g) ?? []).length)

  const importCandidate = '../' + modulePath.replace(/\.tsx?$/, '')
  const importGetter = '../' + getter.rel.replace(/\.tsx?$/, '')

  // ── Spec-gated extra assertions (each fires ONLY when the spec pins the behavior down in
  // so many words — no guessed semantics, same closed-world discipline as the base checks).
  const extraChecks: string[] = []

  // (a) false ≡ omitted equivalence: for each optional boolean opts field the spec explicitly
  // says "<field> is false or omitted", assert fn(data, {req, field:false}) deep-equals
  // fn(data, {req}). This is EXACTLY the sortModule gap the hidden suite caught (2026-07-04,
  // `inStockFirst: false` grouped like true) — converting it from a hidden-suite-only miss
  // into an oracle check the FM gets retry feedback on.
  const optionalBools = Array.from(ifaceMatch[1].matchAll(/(\w+)\s*\?\s*:\s*boolean/g), m => m[1])
  for (const f of optionalBools) {
    if (new RegExp(`\\b${f}\\b[^.\\n]{0,40}\\bfalse or omitted\\b`, 'i').test(spec)) {
      extraChecks.push(
        `if (threw === null) {
  let withFalse: any = null, withOmitted: any = null
  try { withFalse = ${fn}(data, { ${requiredField}: '${requiredLiteral}', ${f}: false } as any); withOmitted = ${fn}(data, { ${requiredField}: '${requiredLiteral}' } as any) } catch { /* base no-throw check already covers */ }
  check('${f}:false identical to ${f} omitted', JSON.stringify(withFalse) === JSON.stringify(withOmitted))
}`)
    }
  }

  // (b) default-ascending order: only when (1) the fn name says sort, (2) the spec literally
  // says direction defaults to 'asc', and (3) the required literal-union field is a
  // sort-key-style name whose literal names an actual item field — then the default call's
  // output must be non-decreasing on that item field.
  const isSortFn = /[Ss]ort/.test(fn)
  const specSaysDefaultAsc = /default\s*'asc'/.test(spec)
  const keyStyleField = /^(by|sortBy|key|field)$/.test(requiredField)
  if (isSortFn && specSaysDefaultAsc && keyStyleField) {
    extraChecks.push(
      `if (threw === null && Array.isArray(result) && data.some((x: any) => x != null && x['${requiredLiteral}'] !== undefined)) {
  check('sorted ascending by ${requiredLiteral} when direction omitted', result.every((x: any, i: number) => i === 0 || result[i - 1]['${requiredLiteral}'] <= x['${requiredLiteral}']))
}`)
  }

  const content = `// Context-invariant smoke test (opts-transform shape — Crucible synth/deriveInvariant).
import { ${fn} } from '${importCandidate}'
import { ${getter.name} } from '${importGetter}'
let failures = 0
function check(desc: string, ok: boolean) {
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + desc)
  if (!ok) failures++
}
const data: any[] = ${getter.name}() as any
const snapshot = JSON.parse(JSON.stringify(data))
let result: any = null
let threw: unknown = null
try { result = ${fn}(data, { ${requiredField}: '${requiredLiteral}' } as any) } catch (e) { threw = e }
check('does not throw on a well-formed call', threw === null)
if (threw !== null) console.log('  threw: ' + String(threw))
if (threw === null) {
  check('returns an array', Array.isArray(result))
  check('preserves length', Array.isArray(result) && result.length === data.length)
}
${extraChecks.join('\n')}
check('does not mutate input', JSON.stringify(data) === JSON.stringify(snapshot))
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`
  return {
    testFile: { path: '__invariant__/spec.test.ts', content },
    count: recordHint + extraChecks.length,
    family: 'opts-transform-smoke',
  }
}
