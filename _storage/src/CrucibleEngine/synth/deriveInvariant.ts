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

  // ── Strong path (2026-07-24): RECOMPUTE the expected per-group sums from the real getter data
  // and assert them. The weak balance-formula check below passes any internally-consistent-but-
  // WRONG sums (summaryModule shipped wrong credits/debits that still satisfied balance ===
  // credits - debits → oracle-GREEN / hidden-RED). Only taken when the FULL aggregation semantics
  // parse cleanly; otherwise fall back to the weak check — a misparsed recompute would FALSE-REJECT
  // correct code (cont.85: a verifier fails in two directions). Parses: the group key, each summed
  // field's source amount + type value ("<field> = sum of <amt> for … '<typeVal>'"), and the
  // discriminator field name (the data-literal key carrying those type values).
  const rxEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const groupKey = spec.match(/\bgroup(?:ed)?\s+\w+\s+by\s+(\w+)/i)?.[1]
  // The type value is a BARE quoted word (e.g. 'credit'); the non-greedy `[^\n]*?` skips a
  // possessive apostrophe ("that account's 'credit' transactions") that a `[^']*` would trip on.
  // `[\s\S]*?` (not `[^\n]`) because the rule prose wraps across lines ("sum of amount for\n
  // that account's 'credit' transactions"); non-greedy still stops at the first bare-word quote.
  const sum1 = spec.match(new RegExp(`\\b${rxEsc(field1)}\\b[^=\\n]*=\\s*sum of\\s+(\\w+)\\s+for[\\s\\S]*?'(\\w+)'`, 'i'))
  const sum2 = spec.match(new RegExp(`\\b${rxEsc(field2)}\\b[^=\\n]*=\\s*sum of\\s+(\\w+)\\s+for[\\s\\S]*?'(\\w+)'`, 'i'))
  const typeVal1 = sum1?.[2], typeVal2 = sum2?.[2]
  const typeField = typeVal1
    ? getter.content.match(new RegExp(`(\\w+)\\s*:\\s*'${rxEsc(typeVal1)}'`))?.[1]
    : undefined
  const canRecompute = !!(groupKey && sum1 && sum2 && typeField && typeVal2 && sum1[1] === sum2[1])
  const sumField = sum1?.[1]

  const weak = `// Context-invariant test (repo-getter-fed runtime oracle — Crucible synth/deriveInvariant).
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
  const strong = `// Context-invariant test (recompute-from-source — Crucible synth/deriveInvariant).
import { ${fn} } from '${importCandidate}'
import { ${getterName} } from '${importGetter}'
let failures = 0
const data: any[] = ${getterName}() as any
const result: Record<string, any> = ${fn}(data) as any
const exp: Record<string, { ${field1}: number; ${field2}: number }> = {}
for (const t of data) {
  const g = String(t['${groupKey}'])
  if (!exp[g]) exp[g] = { ${field1}: 0, ${field2}: 0 }
  if (t['${typeField}'] === '${typeVal1}') exp[g].${field1} += t['${sumField}']
  if (t['${typeField}'] === '${typeVal2}') exp[g].${field2} += t['${sumField}']
}
const expKeys = Object.keys(exp).sort()
const gotKeys = Object.keys(result).sort()
if (JSON.stringify(expKeys) !== JSON.stringify(gotKeys)) {
  console.log('FAIL — account keys ' + JSON.stringify(gotKeys) + ' !== expected ' + JSON.stringify(expKeys))
  failures++
}
for (const g of expKeys) {
  const e: any = result[g] || {}
  const checks: Array<[string, number]> = [['${field1}', exp[g].${field1}], ['${field2}', exp[g].${field2}], ['${diffField}', exp[g].${field1} - exp[g].${field2}]]
  for (const [f, want] of checks) {
    const ok = e[f] === want
    console.log((ok ? 'PASS' : 'FAIL') + ' — result["' + g + '"].' + f + ' === ' + want + (ok ? '' : '  (got ' + e[f] + ')'))
    if (!ok) failures++
  }
}
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
`
  const content = canRecompute ? strong : weak
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

  // (c) full sort-by-requested-key correctness across every {by} × {direction} combination
  // (non-grouped call only). This is the check that catches the exact sortModule capability
  // miss the weak (b) check let through: the FM correctly sorted the grouped branch but its
  // non-grouped branch HARDCODED one key (ignored opts.by='name') and mistie-broke — invisible
  // to (b) (which only tests the first literal, ascending). Sound: validated offline that a
  // correct multi-key sort passes ALL combos and the FM's hardcoded-key impl fails 6/6. Only
  // the sort family with a key-style literal-union field reaches this, so no other task is
  // affected. Every value comes from the spec's own type unions + its stated tie-break — no
  // guessed semantics.
  const literalsOf = (fieldName: string): string[] => {
    const line = fieldLines.find(l => new RegExp(`^${fieldName}\\s*\\??\\s*:`).test(l))
    return line ? Array.from(line.matchAll(/'([^']+)'/g), m => m[1]) : []
  }
  const dirField = fieldLines
    .map(l => l.match(/^(\w+)\s*\?\s*:\s*(?:'[^']+'\s*\|\s*)*'[^']+'/))
    .find(m => m && /^(direction|order|dir|sort)$/i.test(m[1]))?.[1] ?? null
  // Tie-break key: only when the spec pins it down in words ("break by id ascending").
  const tieMatch = spec.match(/\bties?\b[^.]{0,60}?\bbreak[^.]{0,20}?\bby\s+(\w+)\s+ascending\b/i)
    ?? spec.match(/\bbreak[^.]{0,20}?\bby\s+(\w+)\s+ascending\b/i)
  const tieField = tieMatch?.[1] ?? null
  if (isSortFn && keyStyleField) {
    const byValues = literalsOf(requiredField)
    const dirValues: Array<{ tag: string; suffix: string; desc: boolean }> = dirField
      ? [
          { tag: 'default', suffix: '', desc: false },
          ...literalsOf(dirField).map(v => ({ tag: v, suffix: `, ${dirField}: '${v}'`, desc: /desc/i.test(v) })),
        ]
      : [{ tag: 'default', suffix: '', desc: false }]
    for (const bv of byValues) {
      for (const dv of dirValues) {
        const neg = dv.desc ? '  c = -c\n' : ''
        const tieClause = tieField
          ? `    if (c === 0 && a['${tieField}'] !== undefined && a['${tieField}'] > b['${tieField}']) return false\n`
          : ''
        extraChecks.push(
          `if (threw === null && data.some((x: any) => x != null && x['${bv}'] !== undefined)) {
  let __r: any = null
  try { __r = ${fn}(data, { ${requiredField}: '${bv}'${dv.suffix} } as any) } catch { /* base no-throw check covers throwing */ }
  const __ok = Array.isArray(__r) && __r.length === data.length && __r.every((x: any, i: number) => {
    if (i === 0) return true
    const a = __r[i - 1], b = x
    let c = a['${bv}'] < b['${bv}'] ? -1 : a['${bv}'] > b['${bv}'] ? 1 : 0
${neg}    if (c > 0) return false
${tieClause}    return true
  })
  check('sorted by ${bv} ${dv.tag} (non-grouped)${tieField ? ', ties by ' + tieField + ' asc' : ''}', __ok)
}`)
      }
    }
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
