// Deterministic candidate-repair proposers — pure-code mutations of a FAILED FM candidate,
// re-gated by the same oracle that rejected the original. Zero model inference.
//
// Rationale ("the intelligence lives in the system"): the on-device FM reproducibly makes a
// small class of mechanical slips it cannot self-correct within its round budget (confirmed
// live 2026-07-04: the never-assigned derived field on summaryModule — byte-identical across
// 3 fires — and the copy-pasted `Array.isArray(opts)` throw-guard on sortModule — identical
// across 2 fires). Both slips are DETECTABLE from the oracle's failure detail and FIXABLE by
// a deterministic source transform. So instead of burning another FM round hoping the model
// notices, we propose the mechanical fix ourselves and let the oracle judge it.
//
// Safety invariant (same as every proposer in this engine): a repair is a PROPOSAL, never a
// ship. Every proposed repair goes back through verifyCandidateAsync (tsc + the full derived
// test) before it can be accepted. A wrong or misfired transform is rejected exactly like a
// wrong FM candidate — the WRONG=0 floor is untouched. Repairs are keyed off the closed-world
// failure shapes OUR OWN derivers emit (deriveInvariant.ts), not arbitrary test output.
//
// COMPOSITION (added 2026-07-04, after the ledger showed a second summaryModule shape): the
// FM doesn't always fail the SAME way. One run omits the derived field's ASSIGNMENT (compiles,
// wrong value — caught by the runtime invariant test); another run omits the field from the
// object literal ENTIRELY (a straight tsc TS2741 "missing in type" error, rejected before the
// runtime test even runs). Fixing only the first shape left the second one dead on arrival —
// no amount of runtime-test repair helps code that doesn't compile. So `repairMissingField`
// (detail-driven, fixes TS2741 with a type-appropriate stub default) and `repairDerivedField`
// (SPEC-driven — parses "X = A - B" straight from the spec text, not from `detail`, so it can
// run regardless of which failure shape triggered this round) are composed: every detail-driven
// repair candidate is ALSO passed through the spec-driven repair, so "stub the missing field"
// and "compute the missing field correctly" can land in the SAME round instead of needing two.

import path from 'path'

/**
 * What a repair needs to know about the file it is repairing, beyond its text. Optional
 * everywhere: the nine original proposers are pure (candidate, detail) transforms and stay
 * that way. Only import-path repair needs to LOOK UP what files actually exist, because the
 * alternative — guessing a path from its shape — is inference, and inference is what this
 * engine exists to avoid.
 */
export type RepairContext = {
  /** Project-relative posix path of the file `candidate` is the content of. */
  modulePath: string
  /** Project-relative posix paths of every file the oracle staged alongside it. */
  files: readonly string[]
}

/** For an extensionless import base, the file paths TS would try, in order. Mirrors
 *  oracle.ts's `importResolutionCandidates` — kept local so this module stays leaf-level. */
function resolutionCandidates(baseRel: string): string[] {
  if (/\.(ts|tsx|js|mjs|cjs)$/.test(baseRel)) return [baseRel]
  return [`${baseRel}.ts`, `${baseRel}.tsx`, `${baseRel}/index.ts`, `${baseRel}.js`, `${baseRel}/index.js`]
}

const rxEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const stripExt = (s: string) => s.replace(/\.(ts|tsx|js|mjs|cjs)$/, '')

/** Rewrite every `'<from>'` module specifier to `'<to>'`, in import/require position only. */
function replaceSpecifier(src: string, from: string, to: string): string {
  return src.replace(
    new RegExp(`((?:from|import|require)\\s*\\(?\\s*)(['"])${rxEscape(from)}\\2`, 'g'),
    `$1$2${to}$2`,
  )
}

/** Drop whole import statements bound to `spec` (named, default, namespace, type-only, bare). */
function dropImportsOf(src: string, spec: string): string | null {
  const q = rxEscape(spec)
  const re = new RegExp(`^\\s*import\\s(?:[^'"]*from\\s*)?['"]${q}['"];?\\s*$`)
  const lines = src.split('\n')
  const kept = lines.filter(l => !re.test(l))
  return kept.length !== lines.length ? kept.join('\n') : null
}

/**
 * A relative specifier that does not resolve. Repair it by LOOKUP, never by guess: the
 * specifier's basename must name exactly one staged file, and that file's real relative path
 * replaces the specifier. Zero matches or more than one ⇒ null.
 */
function rewriteRelativeSpecifier(candidate: string, spec: string, ctx: RepairContext): string | null {
  const files = ctx.files.map(f => f.replace(/\\/g, '/'))
  const modulePath = ctx.modulePath.replace(/\\/g, '/')
  const dir = path.posix.dirname(modulePath)

  // If it already resolves, this TS2307 is about something else and the import is not ours
  // to touch. (Rewriting a correct import would be the false-certify direction — cont.85.)
  const asWritten = path.posix.normalize(path.posix.join(dir, spec))
  if (resolutionCandidates(asWritten).some(c => files.includes(c))) return null

  const want = stripExt(path.posix.basename(spec))
  const hits = files.filter(f => f !== modulePath && stripExt(path.posix.basename(f)) === want)
  if (hits.length !== 1) return null   // absent, or ambiguous — abstain rather than guess

  let rel = stripExt(path.posix.relative(dir, hits[0]))
  if (!rel.startsWith('.')) rel = `./${rel}`
  if (rel === spec) return null
  const out = replaceSpecifier(candidate, spec, rel)
  return out !== candidate ? out : null
}

/**
 * TS2307 "Cannot find module 'X'" — two distinct real failures behind one diagnostic.
 *
 * (a) X is RELATIVE and wrong. Measured live on extract-duplicated-discount (run 56499):
 *     writing src/discount.ts, the FM emitted `from './src/checkout'` for what is a SIBLING
 *     ('./checkout'). oracle.ts deliberately keeps this fatal instead of suffix-matching it
 *     away (that suffix match was the cont.85 false-certify bug), so the FM IS shown the
 *     error — and re-emits it every round, because nothing repairs it. Three rounds burn,
 *     the tripwire fires, the task abstains. Fixed by resolving the specifier against the
 *     staged file list.
 *
 * (b) X is BARE and absent. Measured live on sync-store-to-async: `await-promise`, which does
 *     not exist. Note the sibling case in the same corpus imports `@angular/core`, which DOES
 *     exist on npm but is not a dependency here — from inside an offline sandbox the two are
 *     indistinguishable, which is precisely why a registry-404 gate cannot cover this class
 *     and tsc can. Drop the import statement.
 *
 * Both branches are proposals, not ships: the repaired candidate goes back through the same
 * oracle. If a dropped import was load-bearing, the result fails TS2304 "Cannot find name"
 * and is discarded exactly like any wrong FM candidate. This cannot false-certify.
 */
export function repairUnresolvableImport(
  candidate: string,
  detail: string,
  ctx?: RepairContext,
): string | null {
  const specs = new Set<string>()
  for (const m of detail.matchAll(/TS2307: Cannot find module '([^']+)'/g)) specs.add(m[1])
  if (!specs.size) return null

  // The diagnostic names the IMPORTING file, which is not necessarily this candidate. A
  // TS2307 located in a sibling is proposeSiblingRepairs' job; rewriting our own imports to
  // chase another file's error would be a misfire. (Only one fatal line reaches `detail` —
  // oracle.ts returns `fatal[0]` — so this check is per-round, not per-error.)
  if (ctx) {
    const loc = /^(?:typecheck:\s*)?(.*?)\(\d+,\d+\): error TS2307:/m.exec(detail.trim())
    if (loc) {
      const errPath = loc[1].replace(/\\/g, '/')
      const modulePath = ctx.modulePath.replace(/\\/g, '/')
      if (errPath !== modulePath && !errPath.endsWith(`/${modulePath}`)) return null
    }
  }

  let out = candidate
  for (const spec of specs) {
    // A relative specifier can only be repaired by lookup, so without context we abstain
    // rather than guess. A bare one is context-free: absent is absent.
    const fixed = /^\.\.?\//.test(spec)
      ? (ctx ? rewriteRelativeSpecifier(out, spec, ctx) : null)
      : dropImportsOf(out, spec)
    if (fixed) out = fixed
  }
  return out !== candidate ? out : null
}

/** Best-effort default literal for a TS primitive type name. */
function defaultForType(t: string): string {
  if (t === 'string') return "''"
  if (t === 'boolean') return 'false'
  if (t === 'number') return '0'
  return 'null'
}

/**
 * TS2741 "Property 'X' is missing in type '{ a: T; b: T }' but required in type 'Y'" — the
 * object literal is missing a required field entirely (a straight compile error, not a value
 * bug). Finds a single-line-ish object literal in source containing all the OTHER fields the
 * error names, and appends the missing field with a stub default inferred from Y's own
 * declaration in the candidate (falls back to '0' if Y isn't found locally).
 */
function repairMissingField(candidate: string, detail: string): string | null {
  const m = detail.match(/Property '(\w+)' is missing in type '\{([^}]*)\}' but required in type '(\w+)'/)
  if (!m) return null
  const [, missingField, presentFieldsRaw, requiredType] = m
  const presentFields = Array.from(presentFieldsRaw.matchAll(/(\w+):/g), x => x[1])
  if (!presentFields.length) return null

  let defaultVal = '0'
  const ifaceMatch = candidate.match(new RegExp(`interface\\s+${requiredType}\\s*\\{([\\s\\S]*?)\\}`))
  if (ifaceMatch) {
    const fieldType = ifaceMatch[1].match(new RegExp(`\\b${missingField}\\s*\\??:\\s*(\\w+)`))
    if (fieldType) defaultVal = defaultForType(fieldType[1])
  }

  // Match an object literal containing ALL present fields as keys (order-independent, no
  // nested braces inside — the exact shape our own bug class produces), not already containing
  // the missing field, and splice the stub field in before its closing brace.
  const keyPattern = presentFields.map(f => `${f}\\s*:`).join('[\\s\\S]*?')
  const literalRx = new RegExp(`\\{[^{}]*?${keyPattern}[^{}]*?\\}`, 'g')
  let replaced = false
  const repaired = candidate.replace(literalRx, (lit) => {
    if (replaced || new RegExp(`\\b${missingField}\\s*:`).test(lit)) return lit
    replaced = true
    return lit.replace(/\}\s*$/, `, ${missingField}: ${defaultVal} }`)
  })
  return replaced ? repaired : null
}

/**
 * SPEC-driven (not detail-driven): if the spec pins a field down as the difference of two
 * others (e.g. "balance = credits - debits" — same regex deriveInvariant.ts uses to build the
 * runtime test), inject an assignment loop before every `return <ident>` so the field is
 * actually computed, whatever `detail` currently says. Runs unconditionally so it composes
 * with detail-driven repairs above (stub-then-compute) instead of needing its own round.
 */
function repairDerivedField(candidate: string, spec: string): string | null {
  const rel = spec.match(/\b([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*-\s*([A-Za-z_]\w*)\b/)
  if (!rel) return null
  const [, field, a, b] = rel
  if (field === a || field === b || a === b) return null
  const returnedIdents = new Set(
    Array.from(candidate.matchAll(/\breturn\s+([A-Za-z_$][\w$]*)\s*[;\n}]/g), m => m[1])
      .filter(v => !['null', 'undefined', 'true', 'false', 'this', 'void'].includes(v)),
  )
  let best: string | null = null
  for (const v of returnedIdents) {
    const fix = `for (const __k of Object.keys(${v})) { (${v} as any)[__k].${field} = (${v} as any)[__k].${a} - (${v} as any)[__k].${b} }\n  `
    const repaired = candidate.replace(new RegExp(`(\\breturn\\s+${v}\\b)`, 'g'), `${fix}$1`)
    if (repaired !== candidate) best = repaired   // last matching returned-ident wins; good enough for single-return functions
  }
  return best
}

/**
 * "Dynamic key extracted then used as a bracket-index" bug — confirmed live 2026-07-04 on a
 * sortModule fire: `const key = opts.by === 'price' ? a.price : a.name` correctly extracts the
 * comparison VALUE for `a`, but the comparator then writes `b[key]` — indexing `b` by that
 * VALUE (a number/string) instead of mirroring the same field-selection ternary on `b`. Since
 * `b[19.99]` is `undefined`, every comparison degenerates and the sort order breaks, caught by
 * the opts-transform-smoke family's spec-gated "sorted ascending when direction omitted" check.
 * Deterministic repair: mirror the exact ternary structure that built the key for `a` onto the
 * bracket-indexed variable, replacing `b[key]` with `(opts.by === 'price' ? b.price : b.name)`.
 * Gated on BOTH the syntactic pattern AND the specific sortedness-check failure, keeping it
 * closed-world (tied to an assertion family we ourselves derive) rather than a generic rewrite.
 */
function repairDynamicKeyIndex(candidate: string, detail: string): string | null {
  if (!/FAIL — sorted ascending by \w+ when direction omitted/.test(detail)) return null
  const decl = candidate.match(
    /const\s+(\w+)\s*=\s*([\w.]+)\s*===\s*('[^']*'|"[^"]*")\s*\?\s*(\w+)\.(\w+)\s*:\s*\4\.(\w+)/,
  )
  if (!decl) return null
  const [, keyVar, condExpr, condValue, itemVar, field1, field2] = decl
  const otherVars = new Set(
    Array.from(candidate.matchAll(new RegExp(`\\b${itemVar}\\s*,\\s*(\\w+)\\)\\s*=>`, 'g')), m => m[1]),
  )
  let repaired = candidate
  let changed = false
  for (const other of otherVars) {
    const bracketRx = new RegExp(`\\b${other}\\[${keyVar}\\]`, 'g')
    if (bracketRx.test(repaired)) {
      changed = true
      repaired = repaired.replace(bracketRx, `(${condExpr} === ${condValue} ? ${other}.${field1} : ${other}.${field2})`)
    }
  }
  return changed ? repaired : null
}

/**
 * "Explicit-value check instead of default-negative check" on an optional 'asc'|'desc' field —
 * confirmed live 2026-07-04 alongside the dynamic-key-index bug on the SAME sortModule fire:
 * the comparator gates ascending behavior on `opts.direction === 'asc'`, which is FALSE when
 * `direction` is omitted (undefined !== 'asc'), so the else branch — written for 'desc' — runs
 * by default. The spec pins `direction` default to 'asc'; the exhaustive, safe fix for a field
 * typed `'asc' | 'desc' | undefined` is to treat everything that ISN'T explicitly 'desc' as
 * ascending. Gated on the same sortedness-check failure as the repair above so it only fires
 * when we have a concrete, derived reason to suspect the default branch is wrong.
 */
function repairDefaultDirectionCheck(candidate: string, detail: string): string | null {
  if (!/FAIL — sorted ascending by \w+ when direction omitted/.test(detail)) return null
  const rx = /(\w+)\.direction\s*===\s*'asc'/g
  if (!rx.test(candidate)) return null
  const repaired = candidate.replace(rx, "$1.direction !== 'desc'")
  return repaired !== candidate ? repaired : null
}

/**
 * One-sided case-insensitive comparison — confirmed live 2026-07-04 on a filterModule fire
 * (found via the `testTail` fix that stopped hiding this failure from the retry prompt): the
 * candidate lowercases the FIELD being searched (`user.name.toLowerCase()`) but never
 * lowercases the SEARCH TERM itself (`opts.query`), so `.includes(opts.query)` only matches
 * when the query happens to already be lowercase — searching "ALPHA" misses "alpha". Repair:
 * wrap the `.includes(...)` argument in `.toLowerCase()` wherever it's compared against an
 * already-lowercased field and isn't already lowercased itself.
 */
function repairOneSidedCaseInsensitive(candidate: string, detail: string): string | null {
  if (!/FAIL — query filter case-insensitive/.test(detail)) return null
  const rx = /\.toLowerCase\(\)\.includes\(\s*([A-Za-z_][\w.]*)\s*\)/g
  let changed = false
  const repaired = candidate.replace(rx, (whole, arg) => {
    if (/\.toLowerCase\(\)$/.test(arg)) return whole   // already lowercased, not the bug
    changed = true
    return `.toLowerCase().includes(${arg}.toLowerCase())`
  })
  return changed ? repaired : null
}

/**
 * Classic `if (opts.active && !user.active) continue` guard bug — confirmed live 2026-07-04 on
 * the SAME filterModule fire as the case-insensitive bug above. `opts.active && ...` is FALSE
 * (so the guard is skipped, filtering nothing) whenever `opts.active` is explicitly `false` —
 * the exact case the caller wants to filter ON. The correct check needs to distinguish "no
 * filter given" (`undefined`) from "filter for false" — `opts.active !== undefined` — then
 * exclude on inequality (`user.active !== opts.active`), not truthiness. Repair targets the
 * exact syntactic shape found live: `<field>.active && !<item>.active` used as a skip/continue
 * condition, rewritten to the undefined-aware inequality form.
 */
function repairActiveFalseGuard(candidate: string, detail: string): string | null {
  if (!/FAIL — active=false returns only inactive/.test(detail)) return null
  const rx = /(\w+)\.active\s*&&\s*!\s*(\w+)\.active\b/g
  if (!rx.test(candidate)) return null
  const repaired = candidate.replace(rx, "$1.active !== undefined && $2.active !== $1.active")
  return repaired !== candidate ? repaired : null
}

/**
 * `paramName.sort(...)` mutates its argument in place instead of returning a new array —
 * confirmed live 2026-07-05/06 on a leaderboardModule fire (`sortScoresAscending(scores) {
 * return scores.sort(...) }`), caught by localHardenFuzz's `sort-no-mutate` property (see
 * localHardenFuzzWorker.cjs). The regex only matches a bare `identifier.sort(` — it
 * structurally cannot match an already-safe `[...identifier].sort(` (a `]` sits between the
 * identifier and the dot) or `identifier.slice().sort(` (a `)` sits between them), so this
 * repair is a no-op on already-correct code and only fires on the exact mutating shape.
 * Gated on the fuzz layer's own mutation-failure message so it only proposes this rewrite
 * when there's a concrete, derived reason to suspect an in-place sort.
 */
function repairMutatingSort(candidate: string, detail: string): string | null {
  if (!/mutates its input argument in place/.test(detail)) return null
  const rx = /\b([A-Za-z_$][\w$]*)\.sort\(/g
  if (!rx.test(candidate)) return null
  const repaired = candidate.replace(rx, '[...$1].sort(')
  return repaired !== candidate ? repaired : null
}

/**
 * String-building function that fails only by SEPARATOR RUNS / edge separators — confirmed
 * live 2026-07-06 across 9 consecutive FM rounds on a slugify request through the user-skill
 * pipeline: every candidate mapped disallowed chars to '-' correctly but never collapsed the
 * resulting '--' runs nor trimmed leading/trailing dashes (`got "a--b-"` vs `want "a-b"`,
 * byte-similar shape every round; the FM demonstrably cannot self-correct this within its
 * round budget). Detection is closed-world: parse every `FAIL — name(...) === "want"
 * (got "got")` pair our own derive.ts behavioral test emits, and propose a repair ONLY when
 * a single separator char ('-' or '_') explains EVERY failure — i.e. collapsing runs of it
 * and trimming it from both ends turns each `got` into exactly its `want`. The transform
 * renames the offending exported function to a private raw implementation and re-exports a
 * wrapper that applies that exact normalization to string results. The oracle re-gates the
 * repaired candidate in full, so a case this normalization would break is rejected as usual.
 */
function repairSeparatorRunNormalize(candidate: string, detail: string): string | null {
  const pairs = Array.from(
    detail.matchAll(/FAIL — ([A-Za-z_$][\w$]*)\([^\n]*?\) === ("(?:[^"\\]|\\.)*")\s+\(got ("(?:[^"\\]|\\.)*")\)/g),
    m => ({ name: m[1], want: m[2], got: m[3] }),
  )
  if (!pairs.length) return null
  const names = new Set(pairs.map(p => p.name))
  if (names.size !== 1) return null
  const fnName = pairs[0].name

  let sep: string | null = null
  for (const s of ['-', '_']) {
    const esc = s === '-' ? '\\-' : s
    const fixesAll = pairs.every(p => {
      try {
        const got = JSON.parse(p.got) as string
        const want = JSON.parse(p.want) as string
        const norm = got
          .replace(new RegExp(`${esc}{2,}`, 'g'), s)
          .replace(new RegExp(`^${esc}+|${esc}+$`, 'g'), '')
        return norm === want && got !== want
      } catch { return false }
    })
    if (fixesAll) { sep = s; break }
  }
  if (!sep) return null

  // Only the plain `export function <name>(...)` declaration shape (what the FM emits).
  if (!new RegExp(`\\bexport\\s+function\\s+${fnName}\\s*\\(`).test(candidate)) return null
  const raw = `__raw_${fnName}`
  if (candidate.includes(raw)) return null
  const esc = sep === '-' ? '\\-' : sep
  const renamed = candidate
    .replace(new RegExp(`\\b${fnName}\\b`, 'g'), raw)
    .replace(new RegExp(`\\bexport\\s+function\\s+${raw}\\b`), `function ${raw}`)
  return `${renamed}
export function ${fnName}(...__args: Parameters<typeof ${raw}>): ReturnType<typeof ${raw}> {
  const __r = ${raw}(...__args)
  return (typeof __r === 'string' ? __r.replace(/${esc}{2,}/g, ${JSON.stringify(sep)}).replace(/^${esc}+|${esc}+$/g, '') : __r) as ReturnType<typeof ${raw}>
}
`
}

/**
 * Spurious Array.isArray guard on a non-array opts parameter — the FM copy-pastes the
 * (correct) items-array validation onto the singular opts object, making the function throw
 * on every legitimate call. Strip exactly that guard.
 */
function repairArrayGuard(candidate: string, detail: string): string | null {
  if (!/does not throw on a well-formed call/.test(detail) || !/threw:/.test(detail)) return null
  const guardRx = /[ \t]*if\s*\(\s*!Array\.isArray\(\s*opts\s*\)\s*\)\s*(?:\{[^{}]*\}|throw[^;]*;|[^;{]*;)\s*\n?/g
  if (!guardRx.test(candidate)) return null
  guardRx.lastIndex = 0
  const repaired = candidate.replace(guardRx, '')
  return repaired !== candidate ? repaired : null
}

/**
 * TS2440 "Import declaration conflicts with local declaration of 'X'" — on a multi-file
 * refactor the FM writes the file that DEFINES `X` but also carries over the import of `X`
 * from the pre-refactor version. The local declaration is the one the spec asked for, so the
 * universal fix is to drop `X` from its import clause (and drop the statement entirely if the
 * clause empties out). If the local declaration were the spurious one instead, tsc rejects the
 * repaired candidate exactly like any other wrong proposal — this is a proposal, not a ship.
 */
export function repairImportLocalConflict(candidate: string, detail: string): string | null {
  const names = new Set<string>()
  for (const m of detail.matchAll(/TS2440: Import declaration conflicts with local declaration of '([^']+)'/g)) {
    names.add(m[1])
  }
  if (!names.size) return null

  const lines = candidate.split('\n')
  const out: string[] = []
  let changed = false
  for (const line of lines) {
    // Only named-import clauses can be pruned specifier-by-specifier; a default or namespace
    // import binds the whole module to that name, so there is nothing to prune — drop it whole.
    const named = line.match(/^(\s*import\s*\{)([^}]*)(\}\s*from\s*['"][^'"]+['"];?\s*)$/)
    if (named) {
      const kept = named[2].split(',').map(s => s.trim()).filter(Boolean).filter(spec => {
        // `a as b` binds `b` locally; the conflict is with the LOCAL name.
        const local = spec.split(/\s+as\s+/).pop()!.trim()
        return !names.has(local)
      })
      if (kept.length !== named[2].split(',').map(s => s.trim()).filter(Boolean).length) {
        changed = true
        if (kept.length) out.push(`${named[1]} ${kept.join(', ')} ${named[3]}`)
        continue   // clause emptied — drop the whole statement
      }
      out.push(line)
      continue
    }
    const whole = line.match(/^\s*import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s*(?:,|from)\s/)
    if (whole && names.has(whole[1])) { changed = true; continue }
    out.push(line)
  }
  return changed ? out.join('\n') : null
}

// Detail-driven single-bug fixes. More than one can legitimately apply to the SAME candidate
// (confirmed live 2026-07-04: one sortModule fire had both the dynamic-key-index bug and the
// default-direction-check bug at once) — `proposeRepairs` below tries each alone AND all of
// them composed in sequence, so a candidate with N independent slips gets one shot at a fully
// repaired variant instead of needing N separate rounds to discover each in isolation.
/**
 * `.sort()` comparator that returns a BOOLEAN instead of a number — the single most common slip
 * the on-device FM makes on any sort task (confirmed live 2026-07-23: on sortModule it wasted 2
 * of 3 rounds on the identical `error TS2345: '(a,b) => boolean' is not assignable to '… => number'`,
 * writing `return a < b` or `return cond ? a < b : a > b`). tsc rejects it before the logic oracle
 * even runs, so a logic-correct candidate dies on a purely mechanical mistake. Rewrite every
 * boolean-relational return into the numeric `-1|0|1` form. Gated on the comparator TS2345 detail
 * so it only fires when tsc actually flagged a `=> number` mismatch; re-gated by the full oracle,
 * so if the rewrite were to break anything (e.g. a genuine boolean predicate elsewhere) that
 * candidate is rejected exactly like any other — WRONG=0 untouched, and it only ever fires on a
 * candidate that ALREADY failed, so there is no passing candidate to spoil.
 */
function repairBooleanComparator(candidate: string, detail: string): string | null {
  // The mismatch tsc emits for a boolean-returning comparator passed to Array.prototype.sort.
  if (!/is not assignable to parameter of type '\([^)]*\)\s*=>\s*number'/.test(detail)) return null
  const OPERAND = "[\\w.$\\[\\]']+"
  let out = candidate
  // (1) ternary of comparisons: `return COND ? A < B : A > B` → numeric in both arms.
  out = out.replace(
    new RegExp(`return\\s+([^;\\n?]+?)\\s*\\?\\s*(${OPERAND})\\s*<\\s*(${OPERAND})\\s*:\\s*(${OPERAND})\\s*>\\s*(${OPERAND})\\s*;`, 'g'),
    (_m, cond, a1, b1, a2, b2) => `return ${cond} ? (${a1} < ${b1} ? -1 : ${a1} > ${b1} ? 1 : 0) : (${a2} > ${b2} ? -1 : ${a2} < ${b2} ? 1 : 0);`,
  )
  // (2) standalone boolean relational returns: `return A < B;` / `return A > B;` → numeric.
  out = out.replace(new RegExp(`return\\s+(${OPERAND})\\s*<\\s*(${OPERAND})\\s*;`, 'g'), 'return $1 < $2 ? -1 : $1 > $2 ? 1 : 0;')
  out = out.replace(new RegExp(`return\\s+(${OPERAND})\\s*>\\s*(${OPERAND})\\s*;`, 'g'), 'return $1 > $2 ? 1 : $1 < $2 ? -1 : 0;')
  return out !== candidate ? out : null
}

/**
 * Balanced-paren scan for every `.sort( … )` call: returns the [argStart, argEnd) span of each
 * comparator argument (exclusive of the surrounding parens). Kept structural rather than regex
 * because a comparator body legitimately contains its own `()` (`a.id > b.id`, `(a,b) => …`),
 * and `.sort(cmp).concat(…)` has a `.concat(` whose paren must NOT be mistaken for the sort's.
 */
function sortArgSpans(src: string): Array<{ argStart: number; argEnd: number }> {
  const out: Array<{ argStart: number; argEnd: number }> = []
  const rx = /\.sort\s*\(/g
  let m: RegExpExecArray | null
  while ((m = rx.exec(src))) {
    const argStart = m.index + m[0].length
    let depth = 1
    let i = argStart
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i]
      if (ch === '(') depth++
      else if (ch === ')') depth--
    }
    if (depth === 0) out.push({ argStart, argEnd: i - 1 })
  }
  return out
}

/**
 * Canonicalize every `.sort((a, b) => …)` comparator on an opts-driven sort to the ONE correct
 * shape the spec pins down — confirmed live across 14 distinct sortModule FM candidates
 * (2026-07-22/23 ledger): the on-device 1.5B fails the sound "sorted by {by} {dir} (non-grouped),
 * ties by {tie} asc" oracle family (deriveInvariant.ts check (c)) in a HANDFUL of independent ways
 * it mixes freely — hardcoding one key (`a.price` while opts.by='name'), ignoring `direction`,
 * mistie-breaking (`primaryComparison * secondaryComparison`, which is not a comparator at all),
 * or omitting the tie-break. A "copy the grouped comparator to the non-grouped branch" unification
 * is INERT on this data — the grouped comparator is itself usually one of these wrong shapes. The
 * comparator is where all of (key / direction / tie) live, and the spec fixes all three
 * mechanically, so the doctrine-clean repair rewrites each comparator BODY to the canonical form:
 *   let __p = a[opts.by] < b[opts.by] ? -1 : a[opts.by] > b[opts.by] ? 1 : 0
 *   if (opts.direction === 'desc') __p = -__p        // direction on the PRIMARY only
 *   if (__p !== 0) return __p
 *   return a.id < b.id ? -1 : a.id > b.id ? 1 : 0     // tie ALWAYS ascending, regardless of dir
 *
 * Everything it needs is derived closed-world from the candidate's OWN echoed interface (the
 * required string-literal-union field is the sort key `by`; the optional 'asc'|'desc' field is the
 * direction) and from the oracle detail itself (`… ties by <tie> asc` names the tie field). No
 * external spec, no memorized sortModule answer — it generalizes to any (items, opts) sort task
 * whose sound oracle emits this family. Gated on that exact family and re-gated by the full oracle,
 * so a misderivation is rejected like any wrong candidate — the WRONG=0 floor is untouched. It does
 * NOT fix a candidate whose STRUCTURE is wrong (e.g. one that never branches on inStockFirst); those
 * fail the oracle and abstain honestly, exactly as before.
 */
function repairSortByKeyComparator(candidate: string, detail: string): string | null {
  if (!/FAIL — sorted by \w+[^|]*\(non-grouped\)/.test(detail)) return null

  // Sort key: the required (non-`?`) string-literal-union field in the echoed opts interface,
  // excluding the direction field (whose union is the asc/desc one).
  let keyField: string | null = null
  for (const m of candidate.matchAll(/^\s*(\w+)\s*:\s*('[^']+'(?:\s*\|\s*'[^']+')+)/gm)) {
    if (/\b(asc|desc)\b/.test(m[2])) continue
    keyField = m[1]; break
  }
  if (!keyField) return null

  // Direction: the OPTIONAL literal-union field whose values include a 'desc'-style literal.
  let dirField: string | null = null
  let descLit: string | null = null
  const dirM = candidate.match(/^\s*(\w+)\s*\?\s*:\s*('[^']+'(?:\s*\|\s*'[^']+')+)/m)
  if (dirM && /desc/i.test(dirM[2])) {
    dirField = dirM[1]
    descLit = (dirM[2].match(/'([^']*desc[^']*)'/i) ?? [])[1] ?? null
  }

  // opts parameter name: the second parameter of the exported sort function.
  const sig = candidate.match(/\bfunction\s+\w*[Ss]ort\w*\s*\(\s*\w+\s*:[^,]+,\s*(\w+)\s*:/)
  const optsVar = sig?.[1] ?? 'opts'

  // Tie-break field: named directly in the oracle detail (`… (non-grouped), ties by id asc`).
  const tieField = (detail.match(/\(non-grouped\)[^|]*?\bties by (\w+) asc/) ?? [])[1] ?? null

  const spans = sortArgSpans(candidate)
  if (!spans.length) return null

  // Rewrite right-to-left so earlier spans keep their offsets.
  let out = candidate
  let changed = false
  for (let s = spans.length - 1; s >= 0; s--) {
    const arg = out.slice(spans[s].argStart, spans[s].argEnd)
    // Only an inline two-parameter comparator arrow; a bare `.sort()` or `.sort(cmpRef)` is skipped.
    const pm = arg.match(/^\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*=>/)
    if (!pm) continue
    const [a, b] = [pm[1], pm[2]]
    const k = `${optsVar}.${keyField}`
    const lines = [
      `(${a}, ${b}) => {`,
      `    let __p = ${a}[${k}] < ${b}[${k}] ? -1 : ${a}[${k}] > ${b}[${k}] ? 1 : 0;`,
      ...(dirField && descLit ? [`    if (${optsVar}.${dirField} === '${descLit}') __p = -__p;`] : []),
      `    if (__p !== 0) return __p;`,
      ...(tieField
        ? [`    return ${a}.${tieField} < ${b}.${tieField} ? -1 : ${a}.${tieField} > ${b}.${tieField} ? 1 : 0;`]
        : [`    return 0;`]),
      `  }`,
    ]
    const canonical = lines.join('\n')
    if (canonical !== arg) {
      out = out.slice(0, spans[s].argStart) + canonical + out.slice(spans[s].argEnd)
      changed = true
    }
  }
  return changed ? out : null
}

/**
 * `return <arr>.sort(…)` mutates `<arr>` in place before returning it — the non-grouped-branch
 * mutation half of the sortModule failures (confirmed live 2026-07-22/23: candidates that read
 * `opts.by` correctly still failed `does not mutate input` because the non-grouped path was
 * `return products.sort(…)`, sorting the caller's array). Distinct from `repairMutatingSort`,
 * which is gated on localHardenFuzz's `mutates its input argument in place` message; THIS one is
 * gated on the opts-transform oracle's own `does not mutate input` check. The regex matches only
 * the `return <bareIdent>.sort(` shape, so an already-safe `return [...x].sort(` (starts `[`) or
 * `return x.slice().sort(` (a `.slice()` sits between ident and `.sort`) cannot match — no-op on
 * correct code. Wrapping a grouped-branch `return inStockProducts.sort(…).concat(…)` is a harmless
 * extra copy (that array is already a filter() result), so the transform is safe there too.
 */
function repairReturnedInPlaceSort(candidate: string, detail: string): string | null {
  if (!/does not mutate input/.test(detail)) return null
  const repaired = candidate.replace(/return\s+([A-Za-z_$][\w$]*)\.sort\(/g, 'return [...$1].sort(')
  return repaired !== candidate ? repaired : null
}

/**
 * Naive delimited-text parser (CSV/TSV/…) that ignores quoting. The on-device FM reliably
 * writes `input.split(/\r?\n/).map(l => l.split(','))`-shaped parsers and CANNOT self-correct
 * them into RFC-4180 scanners within its round budget — measured live on bugfixCsv (2026-07-24):
 * three consecutive candidates rejected on the SAME quoted-field examples, then honest escalation
 * with no fallback in strict-offline, so the buggy scaffold shipped (the sole gen-path RED). This
 * replaces the body of a `fn(input: string): string[][]` splitter with a single-pass quote-aware
 * scanner: a quoted field may contain the delimiter and newlines literally, and a doubled quote
 * ("") is one escaped quote. General over the delimiter (comma/tab/semicolon/pipe, read from the
 * candidate's own `.split(<char>)`) and the function name — it keys on the STRUCTURE (a naive
 * split returning rows of fields), not on the task identity. The oracle re-gates the result in
 * full (universal.ts), so any spec this scanner does not match is rejected like any wrong candidate.
 */
function repairNaiveDelimiterSplit(candidate: string, detail: string): string | null {
  if (!detail) return null
  // Signature: export function NAME(PARAM: string): string[][]
  const sig = candidate.match(
    /export\s+function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*:\s*string\s*\)\s*:\s*string\s*\[\s*\]\s*\[\s*\]/,
  )
  if (!sig || sig.index === undefined) return null
  const fnName = sig[1]
  const param = sig[2]
  // Evidence it tokenizes by naive splitting (the shape we repair). Quote-aware scanners the FM
  // gets right never reach a repair (the oracle accepts them first), so no guard against those.
  if (!/\.split\s*\(/.test(candidate)) return null
  // Delimiter: read a char-literal split; default comma. `\t` handled explicitly.
  let delimLit = "','"
  const dm = candidate.match(/\.split\(\s*(['"])(\\t|[,;|\t])\1\s*\)/)
  if (dm) delimLit = dm[2] === '\\t' ? "'\\t'" : `'${dm[2]}'`

  const scanner =
`export function ${fnName}(${param}: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < ${param}.length; i++) {
    const ch = ${param}[i]
    if (inQuotes) {
      if (ch === '"') {
        if (${param}[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else field += ch
      continue
    }
    if (ch === '"') { inQuotes = true; continue }
    if (ch === ${delimLit}) { row.push(field); field = ''; continue }
    if (ch === '\\r') continue
    if (ch === '\\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    field += ch
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}`

  // Splice out the original function declaration (from `export function` to its matching brace),
  // preserving any surrounding content (imports, comments).
  const start = sig.index
  const open = candidate.indexOf('{', start + sig[0].length)
  if (open === -1) return null
  let depth = 0
  let end = -1
  let inStr: string | null = null
  for (let i = open; i < candidate.length; i++) {
    const c = candidate[i]
    if (inStr) {
      if (c === '\\') { i++; continue }
      if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  if (end === -1) return null
  const repaired = candidate.slice(0, start) + scanner + candidate.slice(end)
  return repaired !== candidate ? repaired : null
}

/** Index (exclusive) of the `}` that closes the `{` at `open` in `src`, string-aware. -1 if none. */
function matchBrace(src: string, open: number): number {
  let depth = 0
  let inStr: string | null = null
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      if (c === '\\') { i++; continue }
      if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return i + 1 }
  }
  return -1
}

/**
 * Array set-operation functions (union / intersect / difference) the on-device FM writes WRONG
 * in a recurring, non-self-correcting way — most often intersect implemented as the deduped
 * UNION (`[...a,...b].filter(uniq)`), measured live on the qwen head (tagSetModule: all 4 intersect
 * hidden checks failing). The strengthened set-op property test (synth/derive.ts, 2026-07-24) now
 * REJECTS such candidates, but the small FM can't reliably produce the fix, so the task stays
 * variance-green at best. This replaces each union/intersect/difference export BODY with its
 * canonical set implementation, preserving the declared parameter names and signature. General
 * over element type (Set + includes) and function naming; oracle-re-gated, so a spec these
 * canonical forms don't satisfy is rejected like any wrong candidate (WRONG=0 untouched).
 */
function repairSetOp(candidate: string, detail: string): string | null {
  if (!detail) return null
  const SIG = /export\s+function\s+(union\w*|intersect\w*|intersection\w*|difference\w*|subtract\w*)\s*\(\s*([A-Za-z_$][\w$]*)\s*:[^,()]*,\s*([A-Za-z_$][\w$]*)\s*:[^)]*\)\s*:\s*[^{]*\{/gi
  // Collect every set-op declaration first (splicing shifts indices), then apply right-to-left.
  const hits: Array<{ sigStart: number; open: number; a: string; b: string; kind: 'union' | 'intersect' | 'diff' }> = []
  let m: RegExpExecArray | null
  while ((m = SIG.exec(candidate)) !== null) {
    const nm = m[1].toLowerCase()
    const kind = nm.startsWith('union') ? 'union' : nm.startsWith('intersect') ? 'intersect' : 'diff'
    hits.push({ sigStart: m.index, open: SIG.lastIndex - 1, a: m[2], b: m[3], kind })
  }
  if (!hits.length) return null
  let out = candidate
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i]
    const end = matchBrace(candidate, h.open)
    if (end === -1) return null
    const body =
      h.kind === 'union'     ? `[...new Set([...${h.a}, ...${h.b}])]`
      : h.kind === 'intersect' ? `[...new Set(${h.a}.filter((__v) => ${h.b}.includes(__v)))]`
      :                          `[...new Set(${h.a}.filter((__v) => !${h.b}.includes(__v)))]`
    const header = candidate.slice(h.sigStart, h.open + 1)   // `export function …): T[] {`
    out = out.slice(0, h.sigStart) + `${header}\n  return ${body}\n}` + out.slice(end)
  }
  return out !== candidate ? out : null
}

const DETAIL_DRIVEN_REPAIRS: Array<(candidate: string, detail: string) => string | null> = [
  repairMissingField,
  repairNaiveDelimiterSplit,
  repairSetOp,
  repairImportLocalConflict,
  repairArrayGuard,
  repairDynamicKeyIndex,
  repairDefaultDirectionCheck,
  repairOneSidedCaseInsensitive,
  repairActiveFalseGuard,
  repairMutatingSort,
  repairBooleanComparator,
  repairSortByKeyComparator,
  repairReturnedInPlaceSort,
  repairSeparatorRunNormalize,
]

/** Propose zero or more deterministically-repaired variants of a rejected candidate.
 *  `ctx` is optional: without it the context-free repairs still run, and the one repair that
 *  needs a file list (relative-import resolution) abstains instead of guessing. */
export function proposeRepairs(
  candidate: string,
  detail: string,
  spec: string,
  ctx?: RepairContext,
): string[] {
  // Bound the context-aware repair into the same (candidate, detail) shape as the rest, so it
  // participates in the standalone AND composed passes below without special-casing either.
  const repairs: Array<(c: string, d: string) => string | null> = [
    ...DETAIL_DRIVEN_REPAIRS,
    (c, d) => repairUnresolvableImport(c, d, ctx),
  ]
  const stage1 = [candidate]   // seed so spec-driven repairs below can apply standalone too
  for (const repair of repairs) {
    const r = repair(candidate, detail)
    if (r) stage1.push(r)
  }
  // Composed variant: apply every applicable detail-driven repair in sequence to one candidate,
  // for the case where several independent slips co-occur (each fix is self-gated by its own
  // pattern match, so applying a non-matching one is a safe no-op).
  let composed = candidate
  for (const repair of repairs) {
    const r = repair(composed, detail)
    if (r) composed = r
  }
  if (composed !== candidate) stage1.push(composed)

  const out = new Set<string>()
  for (const c of stage1) {
    if (c !== candidate) out.add(c)               // the detail-driven repair(s) alone
    const withDerived = repairDerivedField(c, spec)
    if (withDerived && withDerived !== candidate) out.add(withDerived)   // composed with spec-driven
  }
  return Array.from(out)
}
