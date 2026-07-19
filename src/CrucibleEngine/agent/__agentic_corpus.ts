// ═══════════════════════════════════════════════════════════════════════════════
// Phase 0 corpus — repo-shaped tasks for measuring the AGENTIC path (cont.80).
// ═══════════════════════════════════════════════════════════════════════════════
//
// This is the corpus the agentic true-rate measurement runs against. It exists because
// verify.ts's accept condition has two unmeasured holes (both confirmed by reading, cont.80):
//
//   1. verify.ts:112 — no runnable check → {passed: true, unverified: true}. The flag is set
//      honestly and read by NOBODY: loop.ts:584/589 branch only on `!v.passed`, so it accepts.
//   2. verify.ts:151 — `npm test` green proves the PRE-EXISTING suite still passes. Nothing ties
//      it to the request. A no-op edit passes this gate.
//
// Every task below therefore ships a repo that ALREADY HAS A GREEN SUITE. That is the point: a
// no-op scores `passed: true` on the visible gate. Only the hidden spec can tell a real change
// from a no-op, and the agent never sees it.
//
// ── Why TypeScript ────────────────────────────────────────────────────────────
// The first cut of this corpus was plain CommonJS .js. Every task abstained with
// "no oracle-passing code", which reads like a proposer failure but was not: oracle.ts:101
// writes `include: [scratch/**/*.ts, scratch/**/*.tsx]` with NO .js glob, so a JS project gives
// tsc zero inputs → TS18003 every round → the out-of-depth tripwire abstains. The offline coding
// path cannot service a JavaScript repo AT ALL. That is a real finding (tracked separately), but
// it is an infra gap, not a capability measurement — so the corpus is TS, to measure the path
// that is actually supported rather than re-measuring a config bug 12 times.
//
// SHAPE RULES (what keeps this a measurement rather than a demo):
//  · Hermetic and offline — node_modules is symlinked from the repo, `npm test` is `tsx test.ts`.
//    No install, no network, sub-second.
//  · The visible suite is GREEN before the agent starts, and stays green under a no-op.
//  · `hidden` probes the REQUESTED CAPABILITY only. It is authored against the goal text, never
//    against any implementation, and is written into the tree only AFTER the agent reports done.
//  · `mustTouch` names the file a real change has to land in — the no-op detector.
//
// The hidden spec is the objective-correctness oracle (the rubric: a pass requires present +
// exercised + suite-green + OBJECTIVELY CORRECT — passing the visible test and having the
// capability are not the same thing, and we are measuring the latter).

export interface AgenticTask {
  id: string
  /** What the user asks. This is the ONLY thing the agent sees beyond the tree. */
  goal: string
  /** The repo, materialized verbatim. Must be green under `npm test` from the start. */
  files: Record<string, string>
  /** Authored from the goal alone. Written in AFTER the run. The correctness oracle. */
  hidden: string
  /**
   * A real change must land in EVERY file listed here — anything less is a no-op.
   * A bare string is the single-file case. For the multi-file tier this is the whole
   * coupled set: a refactor that edits 1 of 4 coupled files is a partial change, and
   * scoring it as work is exactly the inflation this corpus exists to catch.
   */
  mustTouch: string | string[]
  /** What a human reviewer must confirm when reading the artifact behind a mechanical pass. */
  readRubric: string
}

/** Every file a real change must land in. The single-file tier yields a 1-element list. */
export const targetsOf = (t: AgenticTask): string[] =>
  Array.isArray(t.mustTouch) ? t.mustTouch : [t.mustTouch]

/** The file coverage/instrumentation keys off. First listed is the primary. */
export const primaryTarget = (t: AgenticTask): string => targetsOf(t)[0]

const PKG = (name: string) => JSON.stringify(
  { name, version: '1.0.0', scripts: { test: 'tsx test.ts' } }, null, 2) + '\n'

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    module: 'commonjs', target: 'es2020', esModuleInterop: true,
    skipLibCheck: true, moduleResolution: 'node10',
  },
}, null, 2) + '\n'

/** Shared by every repo: package.json + tsconfig.json. */
const BASE = (name: string) => ({ 'package.json': PKG(name), 'tsconfig.json': TSCONFIG })

export const TASKS: AgenticTask[] = [
  // ── 1. Pure add-a-branch. The simplest possible real change. ────────────────
  {
    id: 'clamp-upper-bound',
    goal: 'In src/clamp.ts, clamp() currently only enforces the lower bound. Make it enforce the upper bound too, so a value above max comes back as max.',
    mustTouch: 'src/clamp.ts',
    readRubric: 'clamp returns max for v>max, is unchanged for in-range values, and still enforces the lower bound.',
    files: {
      ...BASE('clamp-kit'),
      'src/clamp.ts': `export function clamp(v: number, min: number, max: number): number {
  if (v < min) return min;
  return v;
}
`,
      'test.ts': `import assert from 'assert';
import { clamp } from './src/clamp';
assert.strictEqual(clamp(-5, 0, 10), 0);
console.log('  ok clamps the lower bound');
assert.strictEqual(clamp(5, 0, 10), 5);
console.log('  ok leaves in-range values alone');
console.log('all passed');
`,
    },
    hidden: `import assert from 'assert';
import { clamp } from './src/clamp';
assert.strictEqual(clamp(50, 0, 10), 10, 'value above max must clamp to max');
assert.strictEqual(clamp(11, 0, 10), 10, 'just above max must clamp to max');
assert.strictEqual(clamp(10, 0, 10), 10, 'max itself is unchanged');
assert.strictEqual(clamp(-5, 0, 10), 0, 'lower bound must still work');
assert.strictEqual(clamp(5, 0, 10), 5, 'in-range must still pass through');
console.log('HIDDEN OK');
`,
  },

  // ── 2. Edge case in existing logic. A no-op looks green. ────────────────────
  {
    id: 'average-empty-array',
    goal: 'src/stats.ts average() divides by zero on an empty array and returns NaN. Make it return 0 for an empty array instead.',
    mustTouch: 'src/stats.ts',
    readRubric: 'average([]) === 0, non-empty averages unchanged, no NaN leaks.',
    files: {
      ...BASE('stats-kit'),
      'src/stats.ts': `export function average(xs: number[]): number {
  let total = 0;
  for (const x of xs) total += x;
  return total / xs.length;
}
`,
      'test.ts': `import assert from 'assert';
import { average } from './src/stats';
assert.strictEqual(average([2, 4, 6]), 4);
console.log('  ok averages a list');
assert.strictEqual(average([7]), 7);
console.log('  ok averages a single value');
console.log('all passed');
`,
    },
    hidden: `import assert from 'assert';
import { average } from './src/stats';
assert.strictEqual(average([]), 0, 'empty array must average to 0, not NaN');
assert.strictEqual(average([2, 4, 6]), 4, 'existing behaviour must hold');
assert.strictEqual(average([7]), 7, 'single value must hold');
assert.strictEqual(average([1, 2]), 1.5, 'fractional average must hold');
console.log('HIDDEN OK');
`,
  },

  // ── 3. Add a new exported function to an existing module. ───────────────────
  {
    id: 'add-titlecase',
    goal: 'Add a titleCase(s) function to src/strings.ts and export it. It should uppercase the first letter of each space-separated word and lowercase the rest. titleCase("hello world") should return "Hello World".',
    mustTouch: 'src/strings.ts',
    readRubric: 'titleCase is exported, handles multi-word, single-word, empty string, and mixed case.',
    files: {
      ...BASE('strings-kit'),
      'src/strings.ts': `export function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/\\s+/g, '-');
}
`,
      'test.ts': `import assert from 'assert';
import { slugify } from './src/strings';
assert.strictEqual(slugify('Hello World'), 'hello-world');
console.log('  ok slugifies');
console.log('all passed');
`,
    },
    hidden: `import assert from 'assert';
import * as m from './src/strings';
assert.strictEqual(typeof (m as any).titleCase, 'function', 'titleCase must be exported');
assert.strictEqual((m as any).titleCase('hello world'), 'Hello World', 'the stated example must hold');
assert.strictEqual((m as any).titleCase('a'), 'A', 'single char');
assert.strictEqual((m as any).titleCase(''), '', 'empty string');
assert.strictEqual((m as any).titleCase('MIXED case'), 'Mixed Case', 'must lowercase the tail');
assert.strictEqual(typeof m.slugify, 'function', 'slugify must survive');
assert.strictEqual(m.slugify('Hello World'), 'hello-world', 'slugify must still work');
console.log('HIDDEN OK');
`,
  },

  // ── 4. Cross-file: change a helper, a caller depends on it. ─────────────────
  {
    id: 'cross-file-currency',
    goal: 'src/format.ts formatCents() renders cents as dollars but drops the trailing zeros, so 500 renders as "$5". Make it always show exactly two decimal places, e.g. "$5.00". src/receipt.ts uses it and must keep working.',
    mustTouch: 'src/format.ts',
    readRubric: 'formatCents always yields 2dp; receipt output updated consistently; no rounding errors.',
    files: {
      ...BASE('receipt-kit'),
      'src/format.ts': `export function formatCents(cents: number): string {
  return '$' + (cents / 100);
}
`,
      'src/receipt.ts': `import { formatCents } from './format';
export function receiptLine(item: string, cents: number): string {
  return item + ': ' + formatCents(cents);
}
`,
      'test.ts': `import assert from 'assert';
import { formatCents } from './src/format';
import { receiptLine } from './src/receipt';
assert.strictEqual(formatCents(1234), '$12.34');
console.log('  ok formats a fractional amount');
assert.strictEqual(receiptLine('Tea', 1234), 'Tea: $12.34');
console.log('  ok builds a receipt line');
console.log('all passed');
`,
    },
    hidden: `import assert from 'assert';
import { formatCents } from './src/format';
import { receiptLine } from './src/receipt';
assert.strictEqual(formatCents(500), '$5.00', 'trailing zeros must be shown');
assert.strictEqual(formatCents(1234), '$12.34', 'existing behaviour must hold');
assert.strictEqual(formatCents(0), '$0.00', 'zero must render 2dp');
assert.strictEqual(formatCents(5), '$0.05', 'sub-dime must render 2dp');
assert.strictEqual(receiptLine('Tea', 500), 'Tea: $5.00', 'the caller must reflect the fix');
console.log('HIDDEN OK');
`,
  },

  // ── 5. THE NO-OP TRAP. Bug lives on a path the visible suite never runs. ────
  {
    id: 'unreached-negative-branch',
    goal: 'src/parse.ts parseQty() should reject negative quantities by returning 0, but it currently lets them through. Fix it.',
    mustTouch: 'src/parse.ts',
    readRubric: 'negatives return 0; positives and zero unchanged; non-numeric still 0.',
    files: {
      ...BASE('parse-kit'),
      'src/parse.ts': `export function parseQty(raw: string | number): number {
  const n = Number(raw);
  if (Number.isNaN(n)) return 0;
  return n;
}
`,
      'test.ts': `import assert from 'assert';
import { parseQty } from './src/parse';
assert.strictEqual(parseQty('3'), 3);
console.log('  ok parses a positive');
assert.strictEqual(parseQty('abc'), 0);
console.log('  ok rejects junk');
console.log('all passed');
`,
    },
    hidden: `import assert from 'assert';
import { parseQty } from './src/parse';
assert.strictEqual(parseQty('-3'), 0, 'negative must be rejected to 0');
assert.strictEqual(parseQty(-1), 0, 'numeric negative must be rejected to 0');
assert.strictEqual(parseQty('3'), 3, 'positive must hold');
assert.strictEqual(parseQty('0'), 0, 'zero must hold');
assert.strictEqual(parseQty('abc'), 0, 'junk must hold');
console.log('HIDDEN OK');
`,
  },

  // ── 6. Stateful class — mutation of existing behaviour. ─────────────────────
  {
    id: 'cart-remove',
    goal: 'src/cart.ts has a Cart class with add() and total(). Add a remove(name) method that removes the first item with that name and returns true, or returns false if no such item exists.',
    mustTouch: 'src/cart.ts',
    readRubric: 'remove returns true/false correctly, removes exactly one item, total reflects it, add/total intact.',
    files: {
      ...BASE('cart-kit'),
      'src/cart.ts': `export class Cart {
  items: Array<{ name: string; cents: number }> = [];
  add(name: string, cents: number): void { this.items.push({ name, cents }); }
  total(): number { return this.items.reduce((s, i) => s + i.cents, 0); }
}
`,
      'test.ts': `import assert from 'assert';
import { Cart } from './src/cart';
const c = new Cart();
c.add('a', 100); c.add('b', 250);
assert.strictEqual(c.total(), 350);
console.log('  ok adds and totals');
console.log('all passed');
`,
    },
    hidden: `import assert from 'assert';
import { Cart } from './src/cart';
const c: any = new Cart();
c.add('a', 100); c.add('b', 250); c.add('a', 50);
assert.strictEqual(typeof c.remove, 'function', 'remove must exist');
assert.strictEqual(c.remove('b'), true, 'removing an existing item returns true');
assert.strictEqual(c.total(), 150, 'total must drop by the removed item');
assert.strictEqual(c.remove('zzz'), false, 'removing a missing item returns false');
assert.strictEqual(c.total(), 150, 'a failed remove must not change the total');
assert.strictEqual(c.remove('a'), true, 'removes the FIRST match');
assert.strictEqual(c.total(), 50, 'only ONE of the duplicates is removed');
console.log('HIDDEN OK');
`,
  },

  // ── 7. Off-by-one in a loop. ───────────────────────────────────────────────
  {
    id: 'chunk-off-by-one',
    goal: 'src/chunk.ts chunk(xs, size) drops the final partial chunk. Fix it so the remaining elements come back as a last, shorter chunk.',
    mustTouch: 'src/chunk.ts',
    readRubric: 'partial tail chunk included; exact multiples unchanged; empty input yields [].',
    files: {
      ...BASE('chunk-kit'),
      'src/chunk.ts': `export function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i + size <= xs.length; i += size) {
    out.push(xs.slice(i, i + size));
  }
  return out;
}
`,
      'test.ts': `import assert from 'assert';
import { chunk } from './src/chunk';
assert.deepStrictEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
console.log('  ok chunks an exact multiple');
console.log('all passed');
`,
    },
    hidden: `import assert from 'assert';
import { chunk } from './src/chunk';
assert.deepStrictEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]], 'partial tail must be kept');
assert.deepStrictEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]], 'exact multiple must hold');
assert.deepStrictEqual(chunk([], 2), [], 'empty stays empty');
assert.deepStrictEqual(chunk([1], 3), [[1]], 'single short chunk');
console.log('HIDDEN OK');
`,
  },

  // ── 8. Two files, one requested change. Tests the caller-reconcile path. ────
  {
    id: 'validate-email-domain',
    goal: 'src/validate.ts isValidEmail() accepts anything with an @ in it. Tighten it so it also requires a dot in the domain part after the @. src/signup.ts calls it.',
    mustTouch: 'src/validate.ts',
    readRubric: 'requires dot after @; rejects a@b; accepts a@b.co; signup path consistent.',
    files: {
      ...BASE('signup-kit'),
      'src/validate.ts': `export function isValidEmail(s: string): boolean {
  return typeof s === 'string' && s.includes('@');
}
`,
      'src/signup.ts': `import { isValidEmail } from './validate';
export function signup(email: string): { ok: boolean; error?: string; email?: string } {
  if (!isValidEmail(email)) return { ok: false, error: 'bad email' };
  return { ok: true, email };
}
`,
      'test.ts': `import assert from 'assert';
import { isValidEmail } from './src/validate';
import { signup } from './src/signup';
assert.strictEqual(isValidEmail('a@b.co'), true);
console.log('  ok accepts a normal address');
assert.strictEqual(isValidEmail('nope'), false);
console.log('  ok rejects a missing @');
assert.strictEqual(signup('a@b.co').ok, true);
console.log('  ok signup accepts a good address');
console.log('all passed');
`,
    },
    hidden: `import assert from 'assert';
import { isValidEmail } from './src/validate';
import { signup } from './src/signup';
assert.strictEqual(isValidEmail('a@b'), false, 'domain without a dot must be rejected');
// The dot must be in the DOMAIN (after the @), not merely present somewhere in the string.
// Added after a read caught this: the live run shipped "includes('@') && includes('.')", which
// the first cut of this spec certified because it only ever probed 'a@b' (no dot at all, so it
// passed by luck). A mechanical oracle is only as strong as its worst probe.
assert.strictEqual(isValidEmail('a.b@c'), false, 'a dot BEFORE the @ must not satisfy the domain rule');
assert.strictEqual(isValidEmail('.@x'), false, 'a leading dot with a bare domain must be rejected');
assert.strictEqual(isValidEmail('a@b.co'), true, 'good address must hold');
assert.strictEqual(isValidEmail('nope'), false, 'no @ must hold');
assert.strictEqual(signup('a@b').ok, false, 'the caller must reflect the tightened rule');
assert.strictEqual(signup('a@b.co').ok, true, 'good signup must hold');
console.log('HIDDEN OK');
`,
  },

  // ── 9. Sort stability / comparator. A classic weak-model failure. ───────────
  {
    id: 'sort-by-then-by',
    goal: 'src/sortUsers.ts sortUsers() sorts users by age ascending. Change it to sort by age ascending, and for users of the same age, by name alphabetically.',
    mustTouch: 'src/sortUsers.ts',
    readRubric: 'primary age asc, secondary name asc; input not mutated; ties resolved.',
    files: {
      ...BASE('sortusers-kit'),
      'src/sortUsers.ts': `export interface User { name: string; age: number }
export function sortUsers(users: User[]): User[] {
  return [...users].sort((a, b) => a.age - b.age);
}
`,
      'test.ts': `import assert from 'assert';
import { sortUsers } from './src/sortUsers';
const out = sortUsers([{ name: 'z', age: 30 }, { name: 'a', age: 20 }]);
assert.deepStrictEqual(out.map(u => u.name), ['a', 'z']);
console.log('  ok sorts by age');
console.log('all passed');
`,
    },
    hidden: `import assert from 'assert';
import { sortUsers } from './src/sortUsers';
const input = [
  { name: 'zoe', age: 30 }, { name: 'adam', age: 30 },
  { name: 'mia', age: 20 }, { name: 'bob', age: 20 },
];
const out = sortUsers(input);
assert.deepStrictEqual(out.map(u => u.name), ['bob', 'mia', 'adam', 'zoe'], 'age asc then name asc');
assert.deepStrictEqual(
  sortUsers([{ name: 'z', age: 30 }, { name: 'a', age: 20 }]).map(u => u.name), ['a', 'z'],
  'existing behaviour must hold');
console.log('HIDDEN OK');
`,
  },

  // ── 10. Async. The path most weak proposers mangle. ─────────────────────────
  {
    id: 'async-retry',
    goal: 'Add a retry(fn, times) function to src/retry.ts and export it. It should await fn(), and if it throws, try again up to `times` total attempts, returning the first successful result. If every attempt throws, rethrow the last error.',
    mustTouch: 'src/retry.ts',
    readRubric: 'retries exactly the requested number of attempts, returns first success, rethrows last error, awaits properly.',
    files: {
      ...BASE('retry-kit'),
      'src/retry.ts': `export async function once<T>(fn: () => Promise<T>): Promise<T> {
  return await fn();
}
`,
      'test.ts': `import assert from 'assert';
import { once } from './src/retry';
once(async () => 42).then(v => {
  assert.strictEqual(v, 42);
  console.log('  ok once resolves');
  console.log('all passed');
});
`,
    },
    hidden: `import assert from 'assert';
import * as m from './src/retry';
(async () => {
  const retry = (m as any).retry;
  assert.strictEqual(typeof retry, 'function', 'retry must be exported');

  let calls = 0;
  const v = await retry(async () => { calls++; if (calls < 3) throw new Error('boom'); return 'ok'; }, 5);
  assert.strictEqual(v, 'ok', 'must return the first success');
  assert.strictEqual(calls, 3, 'must stop calling after the first success');

  let c2 = 0;
  await assert.rejects(
    () => retry(async () => { c2++; throw new Error('always'); }, 3),
    /always/, 'must rethrow the last error when every attempt fails');
  assert.strictEqual(c2, 3, 'must attempt exactly the requested number of times');

  let c3 = 0;
  const v3 = await retry(async () => { c3++; return 'first'; }, 4);
  assert.strictEqual(v3, 'first', 'immediate success returns');
  assert.strictEqual(c3, 1, 'a success must not retry');

  console.log('HIDDEN OK');
})().catch((e: any) => { console.error('HIDDEN FAIL: ' + e.message); process.exit(1); });
`,
  },

  // ── 11. Deliberate no-op magnet: the goal is ALREADY half-true. ─────────────
  {
    id: 'dedupe-preserve-order',
    goal: 'src/dedupe.ts dedupe() removes duplicates but scrambles the order because it uses a Set and sorts. Make it preserve the original first-seen order of the elements.',
    mustTouch: 'src/dedupe.ts',
    readRubric: 'first-seen order preserved exactly; duplicates removed; empty and all-unique cases hold.',
    files: {
      ...BASE('dedupe-kit'),
      'src/dedupe.ts': `export function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)].sort();
}
`,
      'test.ts': `import assert from 'assert';
import { dedupe } from './src/dedupe';
assert.strictEqual(dedupe(['a', 'b', 'a']).length, 2);
console.log('  ok removes duplicates');
console.log('all passed');
`,
    },
    hidden: `import assert from 'assert';
import { dedupe } from './src/dedupe';
assert.deepStrictEqual(dedupe(['c', 'a', 'c', 'b']), ['c', 'a', 'b'], 'first-seen order must be preserved');
assert.deepStrictEqual(dedupe([3, 1, 3, 2]), [3, 1, 2], 'numeric first-seen order must be preserved');
assert.deepStrictEqual(dedupe([]), [], 'empty stays empty');
assert.deepStrictEqual(dedupe(['a', 'b']), ['a', 'b'], 'all-unique holds');
console.log('HIDDEN OK');
`,
  },

  // ── 12. NO TEST SCRIPT AT ALL — the verify.ts:112 blind-pass path, direct. ──
  //     This repo deliberately has no `test` script. It is the control that isolates
  //     the unverified branch (and, on the multi-step wiring, the dead exampleGate).
  {
    id: 'no-suite-wordcount',
    goal: 'Add a wordCount(s) function to src/words.ts and export it. It should return the number of whitespace-separated words in the string. wordCount("hello world") should return 2, and wordCount("") should return 0.',
    mustTouch: 'src/words.ts',
    readRubric: 'wordCount exported; handles empty, single, multi, and repeated/leading whitespace.',
    files: {
      'package.json': JSON.stringify({ name: 'words-kit', version: '1.0.0' }, null, 2) + '\n',
      'tsconfig.json': TSCONFIG,
      'src/words.ts': `export function charCount(s: string): number {
  return s.length;
}
`,
    },
    hidden: `import assert from 'assert';
import * as m from './src/words';
const wordCount = (m as any).wordCount;
assert.strictEqual(typeof wordCount, 'function', 'wordCount must be exported');
assert.strictEqual(wordCount('hello world'), 2, 'the stated example must hold');
assert.strictEqual(wordCount(''), 0, 'the stated empty case must hold');
assert.strictEqual(wordCount('one'), 1, 'single word');
assert.strictEqual(wordCount('  a   b  '), 2, 'leading/repeated whitespace must not create phantom words');
assert.strictEqual(typeof m.charCount, 'function', 'charCount must survive');
console.log('HIDDEN OK');
`,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 2 — MULTI-FILE REFACTORS (cont.98)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Tier 1 above is median 7 LOC in a single file. That is isolated function synthesis,
  // which the goal text explicitly excludes ("non-trivial multi-file changes, real
  // debugging, real refactors, NOT just isolated function synthesis"). A capability %
  // measured only against tier 1 says nothing about the goal — it was the single most
  // misleading artifact in the repo.
  //
  // The tier-2 shape rules, over and above the tier-1 rules:
  //  · `mustTouch` lists the WHOLE coupled set. Editing 1 of 4 coupled files is a partial
  //    change, and the runner scores it NOOP — no credit for touching the easy file.
  //  · The change cannot be localized. Each task threads a signature, a field name, or a
  //    sync→async boundary through a call chain, so a correct edit to one file makes the
  //    others fail to compile until they are reconciled too.
  //  · The hidden spec probes at the TOP of the chain (the outermost caller), so a fix that
  //    only lands in the leaf module cannot pass.

  // ── 13. Thread a new parameter down a 4-deep call chain. ───────────────────
  {
    id: 'thread-tax-rate',
    goal: 'The tax rate is hardcoded at 8% inside applyTax() in src/tax.ts, but invoices for different regions need different rates. Thread an optional tax rate parameter through the whole chain — invoice() in src/invoice.ts, orderTotal() in src/order.ts, lineTotal() in src/lineItem.ts, and applyTax() in src/tax.ts — so a caller can pass a rate to invoice() and have it reach applyTax(). When no rate is passed, the existing 8% must still be used. Tax is rounded per line, as it is today.',
    mustTouch: ['src/tax.ts', 'src/lineItem.ts', 'src/order.ts', 'src/invoice.ts'],
    readRubric: 'rate flows invoice→order→lineItem→tax; omitted rate still yields 8%; rounding stays per-line, not on the grand total.',
    files: {
      ...BASE('invoice-kit'),
      'src/tax.ts': `export function applyTax(cents: number): number {
  return Math.round(cents * 1.08);
}
`,
      'src/lineItem.ts': `import { applyTax } from './tax';
export interface Line { qty: number; unitCents: number }
export function lineTotal(line: Line): number {
  return applyTax(line.qty * line.unitCents);
}
`,
      'src/order.ts': `import { lineTotal, Line } from './lineItem';
export function orderTotal(lines: Line[]): number {
  return lines.reduce((sum, l) => sum + lineTotal(l), 0);
}
`,
      'src/invoice.ts': `import { orderTotal } from './order';
import { Line } from './lineItem';
export function invoice(customer: string, lines: Line[]): { customer: string; totalCents: number } {
  return { customer, totalCents: orderTotal(lines) };
}
`,
      'test.ts': `import assert from 'assert';
import { applyTax } from './src/tax';
import { lineTotal } from './src/lineItem';
import { orderTotal } from './src/order';
import { invoice } from './src/invoice';
assert.strictEqual(applyTax(1000), 1080);
console.log('  ok applies the default rate');
assert.strictEqual(lineTotal({ qty: 2, unitCents: 500 }), 1080);
console.log('  ok totals a line');
assert.strictEqual(orderTotal([{ qty: 2, unitCents: 500 }, { qty: 1, unitCents: 300 }]), 1404);
console.log('  ok totals an order');
assert.strictEqual(invoice('acme', [{ qty: 2, unitCents: 500 }]).totalCents, 1080);
console.log('  ok builds an invoice');
console.log('all passed');
`,
    },
    hidden: `import assert from 'assert';
import { applyTax } from './src/tax';
import { lineTotal } from './src/lineItem';
import { orderTotal } from './src/order';
import { invoice } from './src/invoice';

const LINES = [{ qty: 2, unitCents: 500 }, { qty: 1, unitCents: 300 }];

// Probed at the TOP of the chain: a leaf-only edit cannot satisfy this.
assert.strictEqual((invoice as any)('acme', LINES, 0.2).totalCents, 1560,
  'a rate passed to invoice() must reach applyTax() (1200 + 360)');
assert.strictEqual((invoice as any)('acme', LINES, 0).totalCents, 1300,
  'a zero rate must be honoured (untaxed 1000 + 300), not fall back to the 8% default');
assert.strictEqual(invoice('acme', LINES).totalCents, 1404,
  'an omitted rate must still default to 8%');

// Each intermediate link must actually carry the parameter.
assert.strictEqual((orderTotal as any)(LINES, 0.2), 1560, 'orderTotal must accept and forward a rate');
assert.strictEqual((lineTotal as any)({ qty: 2, unitCents: 500 }, 0.2), 1200, 'lineTotal must accept and forward a rate');
assert.strictEqual((applyTax as any)(1000, 0.2), 1200, 'applyTax must accept a rate');
assert.strictEqual(applyTax(1000), 1080, 'applyTax default must hold');

// Rounding must stay PER LINE. Rounding the grand total instead gives 1461 here, not 1462.
const ODD = [{ qty: 1, unitCents: 333 }, { qty: 1, unitCents: 1017 }];
assert.strictEqual((orderTotal as any)(ODD, 0.085), 1464,
  'tax must round per line (361 + 1103), not once on the grand total (which gives 1465)');
console.log('HIDDEN OK');
`,
  },

  // ── 14. Rename a domain field across every layer that names it. ────────────
  {
    id: 'rename-field-across-layers',
    goal: 'The Item field `qty` is too terse and is being confused with other counters. Rename it to `quantity` everywhere it appears — the interface in src/types.ts, the check in src/validate.ts, the accumulation in src/store.ts, and the rendering in src/report.ts. The existing suite in test.ts uses the old name and must be updated too, so `npm test` is green again afterwards. After the rename, an object that still uses the old `qty` key must no longer validate.',
    mustTouch: ['src/types.ts', 'src/validate.ts', 'src/store.ts', 'src/report.ts', 'test.ts'],
    readRubric: 'every layer names `quantity`; no `qty` survives in any of the four src files; the suite is reconciled rather than deleted or weakened; old-shaped objects fail validation; totals and rendering unchanged in behaviour.',
    files: {
      ...BASE('inventory-kit'),
      'src/types.ts': `export interface Item {
  sku: string;
  qty: number;
}
`,
      'src/validate.ts': `import { Item } from './types';
export function isValidItem(item: Item): boolean {
  return typeof item.sku === 'string' && item.sku.length > 0
    && typeof item.qty === 'number' && item.qty > 0;
}
`,
      'src/store.ts': `import { Item } from './types';
import { isValidItem } from './validate';
export class Store {
  items: Item[] = [];
  add(item: Item): boolean {
    if (!isValidItem(item)) return false;
    this.items.push(item);
    return true;
  }
  totalUnits(): number {
    return this.items.reduce((sum, i) => sum + i.qty, 0);
  }
}
`,
      'src/report.ts': `import { Item } from './types';
export function renderItem(item: Item): string {
  return item.sku + ' x' + item.qty;
}
`,
      'test.ts': `import assert from 'assert';
import { isValidItem } from './src/validate';
import { Store } from './src/store';
import { renderItem } from './src/report';
assert.strictEqual(isValidItem({ sku: 'a', qty: 2 }), true);
console.log('  ok validates an item');
const s = new Store();
s.add({ sku: 'a', qty: 2 });
s.add({ sku: 'b', qty: 3 });
assert.strictEqual(s.totalUnits(), 5);
console.log('  ok totals units');
assert.strictEqual(renderItem({ sku: 'a', qty: 2 }), 'a x2');
console.log('  ok renders an item');
console.log('all passed');
`,
    },
    hidden: `import assert from 'assert';
import fs from 'fs';
import { isValidItem } from './src/validate';
import { Store } from './src/store';
import { renderItem } from './src/report';

const item = (sku: string, quantity: number) => ({ sku, quantity }) as any;

assert.strictEqual(isValidItem(item('a', 2)), true, 'the renamed field must validate');
assert.strictEqual(isValidItem({ sku: 'a', qty: 2 } as any), false,
  'the OLD key must no longer validate — a half-done rename leaves this passing');

const s = new Store();
assert.strictEqual(s.add(item('a', 2)), true, 'store must accept the renamed shape');
s.add(item('b', 3));
assert.strictEqual(s.totalUnits(), 5, 'accumulation must read the renamed field');
assert.strictEqual(s.add({ sku: 'c', qty: 9 } as any), false, 'store must reject the old shape');
assert.strictEqual(s.totalUnits(), 5, 'a rejected add must not change the total');

assert.strictEqual(renderItem(item('a', 2)), 'a x2', 'rendering must read the renamed field');

// Structural: the rename must land in EVERY layer, not just the ones the suite exercises.
for (const f of ['src/types.ts', 'src/validate.ts', 'src/store.ts', 'src/report.ts']) {
  const src = fs.readFileSync(f, 'utf8');
  assert.ok(/\\bquantity\\b/.test(src), f + ' must use the new field name');
  assert.ok(!/\\bqty\\b/.test(src), f + ' must not still mention qty');
}
console.log('HIDDEN OK');
`,
  },

  // ── 15. Sync → async across a boundary. Every caller must be reconciled. ───
  {
    id: 'sync-store-to-async',
    goal: 'The storage layer in src/db.ts is about to be backed by a network call, so it has to become asynchronous. Make get() in src/db.ts return a Promise, and update every caller so the whole chain still works — findUser() in src/userRepo.ts, greet() in src/userService.ts, and handle() in src/api.ts. handle() should resolve to the same shape it returns today. The existing suite in test.ts calls handle() synchronously and must be updated to await it, so `npm test` is green again afterwards.',
    mustTouch: ['src/db.ts', 'src/userRepo.ts', 'src/userService.ts', 'src/api.ts', 'test.ts'],
    readRubric: 'db.get returns a Promise; every layer awaits rather than passing the raw Promise along; handle() resolves to the same shape; the suite awaits rather than being weakened; the missing-user path still yields ok:false.',
    files: {
      ...BASE('userapi-kit'),
      'src/db.ts': `const ROWS: Record<string, { name: string }> = {
  u1: { name: 'Ada' },
  u2: { name: 'Grace' },
};
export function get(id: string): { name: string } | undefined {
  return ROWS[id];
}
`,
      'src/userRepo.ts': `import { get } from './db';
export function findUser(id: string): { name: string } | undefined {
  return get(id);
}
`,
      'src/userService.ts': `import { findUser } from './userRepo';
export function greet(id: string): string | null {
  const u = findUser(id);
  if (!u) return null;
  return 'Hello ' + u.name;
}
`,
      'src/api.ts': `import { greet } from './userService';
export function handle(id: string): { ok: boolean; body: string } {
  const g = greet(id);
  if (!g) return { ok: false, body: 'not found' };
  return { ok: true, body: g };
}
`,
      'test.ts': `import assert from 'assert';
import { handle } from './src/api';
const a = handle('u1');
assert.deepStrictEqual(a, { ok: true, body: 'Hello Ada' });
console.log('  ok handles a known user');
const b = handle('nope');
assert.deepStrictEqual(b, { ok: false, body: 'not found' });
console.log('  ok handles a missing user');
console.log('all passed');
`,
    },
    hidden: `import assert from 'assert';
import { get } from './src/db';
import { findUser } from './src/userRepo';
import { greet } from './src/userService';
import { handle } from './src/api';

const isThenable = (v: any) => Boolean(v) && typeof v.then === 'function';

(async () => {
  assert.ok(isThenable((get as any)('u1')), 'db.get must return a Promise');

  // Probed at the TOP of the chain. A leaf-only edit leaves handle() returning
  // {ok:true, body:'Hello [object Promise]'} — which still LOOKS like a pass to a
  // gate that only checks the suite is green.
  const a = await (handle as any)('u1');
  assert.deepStrictEqual(a, { ok: true, body: 'Hello Ada' },
    'handle must resolve to the same shape, with the name actually awaited');
  const b = await (handle as any)('u2');
  assert.deepStrictEqual(b, { ok: true, body: 'Hello Grace' }, 'a second user must work');
  const c = await (handle as any)('nope');
  assert.deepStrictEqual(c, { ok: false, body: 'not found' }, 'the missing-user path must survive');

  // Every intermediate layer must be reconciled, not just the two ends.
  assert.deepStrictEqual(await (findUser as any)('u1'), { name: 'Ada' }, 'findUser must resolve the row');
  assert.strictEqual(await (greet as any)('u1'), 'Hello Ada', 'greet must await the user');
  assert.strictEqual(await (greet as any)('nope'), null, 'greet must still null on a miss');

  // The stringified-Promise failure mode, named explicitly.
  assert.ok(!/\\[object Promise\\]/.test(String(a.body)), 'a Promise must not be concatenated into the body');
  console.log('HIDDEN OK');
})().catch((e: any) => { console.error('HIDDEN FAIL: ' + e.message); process.exit(1); });
`,
  },

  // ── 16. Extract triplicated logic — and the copies DISAGREE. ───────────────
  //     One of the three copies has a bug. Extracting whichever copy the model reads
  //     first is a 1-in-3 coin flip; the hidden spec requires the CORRECT behaviour at
  //     all three call sites, so the task cannot be passed by mechanical copy-paste.
  {
    id: 'extract-duplicated-discount',
    goal: 'The same discount rule is copy-pasted into three modules — src/checkout.ts, src/quote.ts and src/preview.ts — and the copies have drifted apart, so the three disagree. The rule is: 10% off orders of 10000 cents or more, then 5% more off if the customer is a member, each step rounded to whole cents. Extract that rule into a single shared module src/discount.ts and make all three call sites use it, so they agree.',
    mustTouch: ['src/checkout.ts', 'src/quote.ts', 'src/preview.ts'],
    readRubric: 'one shared implementation in src/discount.ts; all three modules delegate to it rather than keeping a local copy; the threshold is >= 10000 and the member step compounds on the discounted price.',
    files: {
      ...BASE('discount-kit'),
      // The correct rule, per the goal: >=10000 → 10% off, then member → 5% more off.
      'src/checkout.ts': `export function checkoutTotal(cents: number, member: boolean): number {
  let out = cents;
  if (cents >= 10000) out = Math.round(out * 0.9);
  if (member) out = Math.round(out * 0.95);
  return out;
}
`,
      // DRIFT 1: threshold is a strict > instead of >=.
      'src/quote.ts': `export function quoteTotal(cents: number, member: boolean): number {
  let out = cents;
  if (cents > 10000) out = Math.round(out * 0.9);
  if (member) out = Math.round(out * 0.95);
  return out;
}
`,
      // DRIFT 2: the member discount is taken off the ORIGINAL price, not compounded.
      'src/preview.ts': `export function previewTotal(cents: number, member: boolean): number {
  let out = cents;
  if (cents >= 10000) out = Math.round(out * 0.9);
  if (member) out = out - Math.round(cents * 0.05);
  return out;
}
`,
      'test.ts': `import assert from 'assert';
import { checkoutTotal } from './src/checkout';
import { quoteTotal } from './src/quote';
import { previewTotal } from './src/preview';
// The visible suite only ever probes a value where all three copies happen to agree.
assert.strictEqual(checkoutTotal(20000, false), 18000);
console.log('  ok checkout discounts a large order');
assert.strictEqual(quoteTotal(20000, false), 18000);
console.log('  ok quote discounts a large order');
assert.strictEqual(previewTotal(20000, false), 18000);
console.log('  ok preview discounts a large order');
assert.strictEqual(checkoutTotal(5000, false), 5000);
console.log('  ok small orders are undiscounted');
console.log('all passed');
`,
    },
    hidden: `import assert from 'assert';
import fs from 'fs';

import { checkoutTotal } from './src/checkout';
import { quoteTotal } from './src/quote';
import { previewTotal } from './src/preview';

const fns: Array<[string, (c: number, m: boolean) => number]> = [
  ['checkout', checkoutTotal as any], ['quote', quoteTotal as any], ['preview', previewTotal as any],
];

// The correct rule, computed independently of every copy in the tree.
const expected = (cents: number, member: boolean): number => {
  let out = cents;
  if (cents >= 10000) out = Math.round(out * 0.9);
  if (member) out = Math.round(out * 0.95);
  return out;
};

const CASES: Array<[number, boolean]> = [
  [10000, false], // exactly the threshold — catches the strict-\`>\` drift in quote.ts
  [10000, true],
  [9999, false],
  [20000, true],  // compounding — catches the off-the-original drift in preview.ts
  [12345, true],
  [5000, true],
  [0, true],
];

for (const [cents, member] of CASES) {
  const want = expected(cents, member);
  for (const [name, fn] of fns) {
    assert.strictEqual(fn(cents, member), want,
      name + '(' + cents + ', ' + member + ') must be ' + want + ' — the three call sites must agree on the CORRECT rule');
  }
}

// Structural: a shared module must exist and the copies must actually be gone.
assert.ok(fs.existsSync('src/discount.ts'), 'the rule must be extracted into src/discount.ts');
const shared = fs.readFileSync('src/discount.ts', 'utf8');
assert.ok(/export/.test(shared), 'src/discount.ts must export the shared rule');
for (const f of ['src/checkout.ts', 'src/quote.ts', 'src/preview.ts']) {
  const src = fs.readFileSync(f, 'utf8');
  assert.ok(/from '\\.\\/discount'/.test(src), f + ' must import the shared rule');
  assert.ok(!/10000/.test(src), f + ' must not keep a local copy of the threshold');
}
console.log('HIDDEN OK');
`,
  },
]
