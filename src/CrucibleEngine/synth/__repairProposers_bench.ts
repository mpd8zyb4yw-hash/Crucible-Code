// ============================================================================
// Committed bench for repairProposers.ts — this file had NO test coverage anywhere in the
// repo despite containing 7 distinct deterministic repair functions, each confirmed against
// a real live FM failure per its own header comment. Found 2026-07-06 while adding an 8th
// repair (repairMutatingSort) for the leaderboardModule mutation bug and auditing the file
// for the same "no committed bench" test-debt pattern already closed for localHardenCheck.ts
// (cont.20), lintGate.ts/contractGate.ts (cont.24). One true-positive case per repair
// (proposeRepairs must produce the exact fixed candidate) plus a couple of no-op
// false-positive guards (repairs must not fire / must not corrupt already-correct code).
// Run: npx tsx src/CrucibleEngine/synth/__repairProposers_bench.ts
// ============================================================================
import { proposeRepairs } from './repairProposers'

interface Case {
  name: string
  candidate: string
  detail: string
  spec?: string
  // File-list context, for repairs that resolve by lookup rather than by guess. Omitted on
  // every pre-existing case: those proposers are pure (candidate, detail) transforms.
  ctx?: { modulePath: string; files: string[] }
  // Exact string the repaired candidate must equal, or null if no repair should fire at all.
  expect: string | null
  // Substring that SOME proposed repair must contain — used when pinning the whole emitted body
  // verbatim would be brittle (e.g. the multi-line quote-aware scanner). Ignored when `expect` set.
  expectIncludes?: string
  // Substring that NO proposed repair may contain — asserts a SPECIFIC proposer abstained even when
  // an unrelated proposer legitimately fires on the same input (checked before expect/expectIncludes).
  expectExcludes?: string
}

const CASES: Case[] = [
  {
    name: 'repairMissingField: TS2741 missing derived field gets a type-appropriate stub',
    candidate: `const out = { credits: 10, debits: 5 }`,
    detail: `Property 'balance' is missing in type '{ credits: number; debits: number }' but required in type 'AccountSummary'`,
    // Note the space-before-comma is the real (cosmetic-only, still valid TS) output shape —
    // the splice point is the original literal's own trailing space before its closing brace.
    expect: `const out = { credits: 10, debits: 5 , balance: 0 }`,
  },
  {
    name: 'repairDerivedField: spec-pinned "balance = credits - debits" gets computed before return',
    candidate: `function f(m) { return m }`,
    detail: '',
    spec: 'Rules: balance = credits - debits.',
    expect: `function f(m) { for (const __k of Object.keys(m)) { (m as any)[__k].balance = (m as any)[__k].credits - (m as any)[__k].debits }\n  return m }`,
  },
  {
    name: 'repairDynamicKeyIndex: b[key] mirrors the ternary that built key for a',
    candidate: `products.sort((a, b) => { const key = opts.by === 'price' ? a.price : a.name; return key < b[key] ? -1 : 1 })`,
    detail: `FAIL — sorted ascending by price when direction omitted`,
    expect: `products.sort((a, b) => { const key = opts.by === 'price' ? a.price : a.name; return key < (opts.by === 'price' ? b.price : b.name) ? -1 : 1 })`,
  },
  {
    name: 'repairDefaultDirectionCheck: explicit-value check flipped to default-negative check',
    candidate: `const dir = opts.direction === 'asc' ? 1 : -1`,
    detail: `FAIL — sorted ascending by price when direction omitted`,
    expect: `const dir = opts.direction !== 'desc' ? 1 : -1`,
  },
  {
    name: 'repairOneSidedCaseInsensitive: search term gets lowercased to match the already-lowercased field',
    candidate: `users.filter(u => u.name.toLowerCase().includes(opts.query))`,
    detail: `FAIL — query filter case-insensitive`,
    expect: `users.filter(u => u.name.toLowerCase().includes(opts.query.toLowerCase()))`,
  },
  {
    name: 'repairActiveFalseGuard: truthiness guard replaced with undefined-aware inequality',
    candidate: `if (opts.active && !user.active) continue`,
    detail: `FAIL — active=false returns only inactive`,
    expect: `if (opts.active !== undefined && user.active !== opts.active) continue`,
  },
  {
    name: 'repairArrayGuard: spurious Array.isArray(opts) throw-guard stripped',
    candidate: `function f(opts) {\n  if (!Array.isArray(opts)) throw new TypeError('bad');\n  return opts\n}`,
    detail: `does not throw on a well-formed call — threw: TypeError: bad`,
    expect: `function f(opts) {\nreturn opts\n}`,
  },
  {
    name: 'repairMutatingSort: bare arr.sort() rewritten to a non-mutating [...arr].sort()',
    candidate: `export function sortScoresAscending(scores: number[]): number[] { return scores.sort((a, b) => a - b) }`,
    detail: `sortScoresAscending fails the sort-no-mutate property — the function mutates its input argument in place. Return a NEW array/object instead of modifying the one passed in (e.g. use [...arr].sort(...) or arr.slice(), never arr.sort(...) directly on the parameter).`,
    expect: `export function sortScoresAscending(scores: number[]): number[] { return [...scores].sort((a, b) => a - b) }`,
  },
  {
    name: 'repairMutatingSort: no-op on already-correct spread form (no false rewrite)',
    candidate: `export function sortScoresAscending(scores: number[]): number[] { return [...scores].sort((a, b) => a - b) }`,
    detail: `mutates its input argument in place`,
    expect: null,
  },
  {
    name: 'repairMutatingSort: no-op on already-correct .slice() form (no false rewrite)',
    candidate: `export function sortScoresAscending(scores: number[]): number[] { return scores.slice().sort((a, b) => a - b) }`,
    detail: `mutates its input argument in place`,
    expect: null,
  },
  {
    name: 'repairSeparatorRunNormalize: dash runs + edge dashes explain every failure — wrapper added',
    candidate: `export function slugify(title: string): string {\n  return title.toLowerCase().replace(/[^a-z0-9]/g, '-');\n}`,
    detail: `FAIL — slugify("A  B!") === "a-b"  (got "a--b-") | FAIL — slugify("  X ") === "x"  (got "--x-") | 2 FAILURE(S)`,
    expect: `function __raw_slugify(title: string): string {\n  return title.toLowerCase().replace(/[^a-z0-9]/g, '-');\n}\nexport function slugify(...__args: Parameters<typeof __raw_slugify>): ReturnType<typeof __raw_slugify> {\n  const __r = __raw_slugify(...__args)\n  return (typeof __r === 'string' ? __r.replace(/\\-{2,}/g, "-").replace(/^\\-+|\\-+$/g, '') : __r) as ReturnType<typeof __raw_slugify>\n}\n`,
  },
  {
    name: 'repairSeparatorRunNormalize: no-op when normalization does NOT explain a failure (real logic bug)',
    candidate: `export function slugify(title: string): string {\n  return title.replace(/[^a-z0-9]/g, '-');\n}`,
    detail: `FAIL — slugify("Hello") === "hello"  (got "-----")`,
    expect: null,
  },
  {
    name: 'repairSeparatorRunNormalize: no-op on non-string want/got (numeric failures are not separator bugs)',
    candidate: `export function count(xs: string): number {\n  return xs.length;\n}`,
    detail: `FAIL — count("ab") === 2  (got 3)`,
    expect: null,
  },
  {
    name: 'no repair fires when detail matches nothing (clean candidate, no gate triggered)',
    candidate: `export function add(a: number, b: number): number { return a + b }`,
    detail: 'unrelated failure text',
    expect: null,
  },

  // ── repairUnresolvableImport (TS2307) ──────────────────────────────────────────────────
  // Both branches replay a MEASURED live failure, not an invented one: the relative case is
  // extract-duplicated-discount (run 56499, `from './src/checkout'` for a sibling), the bare
  // case is sync-store-to-async (`await-promise`, fabricated). Each burned all 3 FM rounds
  // and abstained because the compile-gate loop had no proposer for TS2307.
  {
    name: 'repairUnresolvableImport(a): wrong relative specifier resolves to the real sibling by lookup',
    candidate: `import { checkoutTotal } from './src/checkout';\n\nexport function discountFor(cents: number): number {\n  return checkoutTotal(cents, false);\n}`,
    detail: `typecheck: /tmp/crucible-oracle-nvzN3l/src/discount.ts(1,31): error TS2307: Cannot find module './src/checkout' or its corresponding type declarations.`,
    ctx: { modulePath: 'src/discount.ts', files: ['src/checkout.ts', 'src/discount.ts', 'src/quote.ts', 'src/preview.ts'] },
    expect: `import { checkoutTotal } from './checkout';\n\nexport function discountFor(cents: number): number {\n  return checkoutTotal(cents, false);\n}`,
  },
  {
    name: 'repairUnresolvableImport(b): fabricated bare package import is dropped whole',
    candidate: `import { async } from 'await-promise';\n\nexport async function get(id: string): Promise<string> {\n  return id;\n}`,
    detail: `typecheck: /tmp/crucible-oracle-aQ2x/src/db.ts(1,26): error TS2307: Cannot find module 'await-promise' or its corresponding type declarations.`,
    ctx: { modulePath: 'src/db.ts', files: ['src/db.ts'] },
    expect: `\nexport async function get(id: string): Promise<string> {\n  return id;\n}`,
  },
  {
    name: 'repairUnresolvableImport(b): type-only import of an absent package is dropped too',
    candidate: `import type { Component } from '@angular/core';\n\nexport const x = 1;`,
    detail: `typecheck: /tmp/o/src/ui.ts(1,32): error TS2307: Cannot find module '@angular/core' or its corresponding type declarations.`,
    ctx: { modulePath: 'src/ui.ts', files: ['src/ui.ts'] },
    expect: `\nexport const x = 1;`,
  },
  {
    name: 'repairUnresolvableImport(b): bare side-effect import of an absent package is dropped',
    candidate: `import 'ghost-polyfill';\n\nexport const y = 2;`,
    detail: `typecheck: /tmp/o/src/boot.ts(1,8): error TS2307: Cannot find module 'ghost-polyfill' or its corresponding type declarations.`,
    ctx: { modulePath: 'src/boot.ts', files: ['src/boot.ts'] },
    expect: `\nexport const y = 2;`,
  },
  {
    name: 'repairUnresolvableImport: ABSTAINS when the basename is ambiguous (two candidates, no guess)',
    candidate: `import { u } from './util';\n\nexport const z = u;`,
    detail: `typecheck: /tmp/o/src/main.ts(1,20): error TS2307: Cannot find module './util' or its corresponding type declarations.`,
    ctx: { modulePath: 'src/main.ts', files: ['src/a/util.ts', 'src/b/util.ts', 'src/main.ts'] },
    expect: null,
  },
  {
    name: 'repairUnresolvableImport: ABSTAINS on a relative specifier with no file context (cannot look up ⇒ will not guess)',
    candidate: `import { checkoutTotal } from './src/checkout';\n\nexport const q = checkoutTotal;`,
    detail: `typecheck: /tmp/o/src/discount.ts(1,31): error TS2307: Cannot find module './src/checkout' or its corresponding type declarations.`,
    expect: null,
  },
  {
    name: 'repairUnresolvableImport: ABSTAINS when the error is located in a DIFFERENT file (that is the sibling path’s job)',
    candidate: `import { checkoutTotal } from './discount';\n\nexport const r = checkoutTotal;`,
    detail: `typecheck: /tmp/o/src/checkout.ts(1,10): error TS2307: Cannot find module './nowhere' or its corresponding type declarations.`,
    ctx: { modulePath: 'src/discount.ts', files: ['src/discount.ts', 'src/checkout.ts'] },
    expect: null,
  },
  {
    name: 'repairUnresolvableImport: ABSTAINS when the specifier already resolves (never rewrites a correct import)',
    candidate: `import { checkoutTotal } from './checkout';\n\nexport const s = checkoutTotal;`,
    detail: `typecheck: /tmp/o/src/discount.ts(1,31): error TS2307: Cannot find module './checkout' or its corresponding type declarations.`,
    ctx: { modulePath: 'src/discount.ts', files: ['src/checkout.ts', 'src/discount.ts'] },
    expect: null,
  },
  {
    // repairSortByKeyComparator: a hardcoded-key comparator (`a.price - b.price`, ignoring
    // opts.by, direction and tie-break) is rewritten to the canonical opts-driven form. Key
    // field ('by') and direction field come from the candidate's own echoed interface; the tie
    // field ('id') is read straight out of the oracle detail's "ties by id asc". Confirmed to
    // flip 5/6 real sortModule FM candidates (2026-07-22/23 ledger) through the hidden suite.
    name: 'repairSortByKeyComparator: hardcoded-key comparator canonicalized to read opts.by + direction + tie-break',
    candidate: `import type { Product } from './types'
export interface SortOpts {
  by: 'price' | 'name'
  direction?: 'asc' | 'desc'
}
export function sortProducts(products: Product[], opts: SortOpts): Product[] {
  return [...products].sort((a, b) => a.price - b.price);
}`,
    detail: `FAIL — sorted by name asc (non-grouped), ties by id asc`,
    expect: `import type { Product } from './types'
export interface SortOpts {
  by: 'price' | 'name'
  direction?: 'asc' | 'desc'
}
export function sortProducts(products: Product[], opts: SortOpts): Product[] {
  return [...products].sort((a, b) => {
    let __p = a[opts.by] < b[opts.by] ? -1 : a[opts.by] > b[opts.by] ? 1 : 0;
    if (opts.direction === 'desc') __p = -__p;
    if (__p !== 0) return __p;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}`,
  },
  {
    // repairReturnedInPlaceSort: `return products.sort(...)` sorts the caller's array in place —
    // the non-grouped-branch mutation half of the sortModule failures. Only the bare-ident
    // `return X.sort(` shape is wrapped; already-safe copies are left alone (see abstain below).
    name: 'repairReturnedInPlaceSort: return X.sort(...) wrapped to return [...X].sort(...)',
    candidate: `export function f(products: any[]) { return products.sort((a, b) => a.id - b.id); }`,
    detail: `FAIL — does not mutate input`,
    expect: `export function f(products: any[]) { return [...products].sort((a, b) => a.id - b.id); }`,
  },
  {
    // repairReturnedInPlaceSort ABSTAINS: an already-copied `return [...x].sort(` must not be
    // double-wrapped, and the sort-comparator repair must not fire without its (non-grouped) gate.
    name: 'repairReturnedInPlaceSort: ABSTAINS on already-copied return [...x].sort(...) (no double wrap)',
    candidate: `export function f(products: any[]) { return [...products].sort((a, b) => a.id - b.id); }`,
    detail: `FAIL — does not mutate input`,
    expect: null,
  },
  {
    // repairSortByKeyComparator ABSTAINS when the failure family is NOT the sound non-grouped
    // sort-correctness check — a generic sort elsewhere must never be rewritten by this repair.
    name: 'repairSortByKeyComparator: ABSTAINS when detail is not the (non-grouped) sort family',
    candidate: `const x = arr.sort((a, b) => a.v - b.v)`,
    detail: `FAIL — unrelated behavioral check`,
    expect: null,
  },
  {
    // repairNaiveDelimiterSplit: the FM's naive `split(',')` CSV parser (returns string[][]) gets
    // replaced with a single-pass quote-aware RFC-4180 scanner. Body pinned by substring, not
    // verbatim — the whole scanner is stable but multi-line. Full correctness is covered e2e
    // (bugfixCsv flips RED→GREEN) and the oracle re-gates the result in any case.
    name: 'repairNaiveDelimiterSplit: naive split(",") CSV parser → quote-aware scanner',
    candidate: `export function parseCsv(input: string): string[][] {\n  return input.split(/\\r?\\n/).filter(l => l.length > 0).map(l => l.split(','))\n}`,
    detail: `FAIL — parseCsv('a,"b,c",d') === [['a','b,c','d']]  (got [['a','"b','c"','d']])`,
    expect: 'sentinel-unused',
    expectIncludes: 'let inQuotes = false',
  },
  {
    // repairNaiveDelimiterSplit ABSTAINS on the wrong return shape: a `string[]` splitter (one row)
    // is not the rows-of-fields structure this repair owns, so it must not fire.
    name: 'repairNaiveDelimiterSplit: ABSTAINS when the function does not return string[][]',
    candidate: `export function splitLine(input: string): string[] { return input.split(',') }`,
    detail: `FAIL — splitLine('a,b') === ['a','b']  (got something)`,
    expect: null,
  },
  {
    // repairSetOp: the FM's intersect-as-deduped-union bug (returns [...a,...b].filter(uniq)) is
    // replaced with the canonical `a.filter(x => b.includes(x))` set intersection, param names
    // preserved. Union in the same candidate is left semantically correct. Body pinned by substring.
    name: 'repairSetOp: wrong intersect (deduped union) → canonical a.filter(b.includes)',
    candidate: `export function unionTags(a: string[], b: string[]): string[] { return [...new Set([...a, ...b])] }\nexport function intersectTags(a: string[], b: string[]): string[] { return [...new Set([...a, ...b].filter((x,i,s)=>s.indexOf(x)===i))] }`,
    detail: `FAIL — intersect subset of A`,
    expect: 'sentinel-unused',
    expectIncludes: 'a.filter((__v) => b.includes(__v))',
  },
  {
    // repairSetOp ABSTAINS on a non-set-op function: a same-shaped (a[],b[])->[] that is not a
    // named set operation must not be rewritten into a set op.
    name: 'repairSetOp: ABSTAINS on a non-set-op array function',
    candidate: `export function zipPairs(a: number[], b: number[]): number[] { return a.map((x, i) => x + b[i]) }`,
    detail: `FAIL — some behavioral check`,
    expect: null,
  },
  {
    // repairGroupedLedger: a wrong grouped-ledger aggregation (here: swapped credit/debit — the
    // candidate references `t.type` so the discriminator field is inferable) is replaced with the
    // canonical group-by aggregation parameterized by the spec's parsed semantics.
    name: 'repairGroupedLedger: wrong aggregation → canonical group-by (semantics from spec)',
    candidate: `export function summarizeByAccount(transactions: Transaction[]): Record<string, AccountSummary> {\n  const out: Record<string, AccountSummary> = {}\n  for (const t of transactions) {\n    if (!out[t.accountId]) out[t.accountId] = { credits: 0, debits: 0, balance: 0 }\n    if (t.type === 'debit') out[t.accountId].credits += t.amount\n    else out[t.accountId].debits += t.amount\n    out[t.accountId].balance = out[t.accountId].credits - out[t.accountId].debits\n  }\n  return out\n}`,
    detail: `FAIL — result["acct-A"].credits === 100  (got 50)`,
    spec: `export function summarizeByAccount(transactions: Transaction[]): Record<string, AccountSummary>\nRules:\n- Group transactions by accountId.\n- credits = sum of amount for that account's 'credit' transactions; debits = sum of amount for that account's 'debit' transactions.\n- balance = credits - debits.`,
    expect: 'sentinel-unused',
    expectIncludes: `__out[__g].credits += __t['amount']`,
  },
  {
    // repairGroupedLedger ABSTAINS when the candidate gives no discriminator signal (no type check
    // to infer the field from) — it must not guess.
    name: 'repairGroupedLedger: ABSTAINS when the discriminator field cannot be inferred',
    candidate: `export function summarizeByAccount(transactions: Transaction[]): Record<string, AccountSummary> {\n  const out: Record<string, AccountSummary> = {}\n  return out\n}`,
    detail: `FAIL — result["acct-A"].credits === 100  (got 0)`,
    spec: `- Group transactions by accountId.\n- credits = sum of amount for that account's 'credit' transactions; debits = sum of amount for that account's 'debit' transactions.\n- balance = credits - debits.`,
    expect: 'sentinel-unused',
    expectExcludes: '__out[__g]',
  },
]

function main() {
  let pass = 0
  for (const c of CASES) {
    const repairs = proposeRepairs(c.candidate, c.detail, c.spec ?? '', c.ctx)
    let ok: boolean
    if (c.expectExcludes !== undefined) {
      ok = !repairs.some(r => r.includes(c.expectExcludes!))
    } else if (c.expectIncludes !== undefined) {
      ok = repairs.some(r => r.includes(c.expectIncludes!))
    } else if (c.expect === null) {
      ok = repairs.length === 0
    } else {
      ok = repairs.includes(c.expect)
    }
    if (ok) pass++
    console.log(`${ok ? 'PASS' : 'FAIL'} — ${c.name}`)
    if (!ok) console.log(`    got: ${JSON.stringify(repairs)}\n    expected: ${JSON.stringify(c.expect)}`)
  }
  console.log(`\n${pass}/${CASES.length} passed`)
  if (pass !== CASES.length) process.exit(1)
}

main()
