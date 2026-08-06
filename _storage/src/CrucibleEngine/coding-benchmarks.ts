// Coding stress-test & audit harness — the agent's coding-ability regression guard.
// Run with: npm run smoke:code           (requires the server running on :3001)
//   npm run smoke:code kvstore regex      (subset by task id)
//
// WHY THIS EXISTS: smoke-benchmarks.ts only exercises the research/quorum pipeline. There
// was NO measure of whether the agent can actually BUILD correct, complete code. A manual
// baseline (a persistent KV-store task) produced an empty `export {}` after the agent gamed
// its own weak test to turn the check green. This harness makes that un-gameable:
//
//   For each hard, self-contained task it fires at the live agent, it AUDITS the produced
//   code with checks the agent never saw:
//     1. compiles clean        (npx tsc --noEmit)                              [HARD]
//     2. HIDDEN adversarial suite passes (coding-bench/<id>.hidden.ts)          [HARD]
//        — exercises edge cases the prompt did NOT spell out; the agent cannot
//          see or weaken it. THIS is the senior-engineer / Claude-level bar.
//     3. the agent's own verification passed (from the SSE stream)             [SOFT]
//     4. an LLM rubric score 0-100 over the source (free Groq model)          [SOFT]
//
// Writes a scorecard to .crucible/coding-bench-last.json, diffs the previous run, and
// HARD-fails (non-zero exit) when a task that previously passed a HARD check now fails it.

import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CODE_DIR = path.resolve(HERE, '../..')          // crucible-local root (has tsx/tsc)
const HIDDEN_DIR = path.join(HERE, 'coding-bench')
const API = process.env.CRUCIBLE_API ?? 'http://localhost:3001'
const BENCH_ROOT = path.join(os.homedir(), 'Desktop', 'crucible-bench')
const SCORECARD = path.join(CODE_DIR, '.crucible', 'coding-bench-last.json')
// Rolling per-run history → true per-task PASS RATES. Every scorecard on record has been n=1, so
// a GREEN could mean "reliably solved" or "got lucky once", and the ROADMAP has repeatedly had to
// hand-estimate a "reliable floor ~9/10" from memory of past runs. One n=1 run cannot distinguish
// a real fix from variance — which is the single thing four independent sessions each flagged.
// Rather than force one 3-hour n=3 invocation, EVERY run appends here and the scorecard reports
// the rate over the last N. The ledger accumulates permanently, so the answer sharpens for free.
const HISTORY = path.join(CODE_DIR, '.crucible', 'coding-bench-history.json')
const HISTORY_WINDOW = Number(process.env.CRUCIBLE_BENCH_HISTORY_WINDOW ?? 5)
const PER_TASK_TIMEOUT_MS = Number(process.env.CRUCIBLE_CODE_BENCH_TIMEOUT ?? 8 * 60 * 1000)

// ── env: pull JWT_SECRET (+ optional Groq key) from .env.local if not already set ──
function loadEnvLocal() {
  const f = path.join(CODE_DIR, '.env.local')
  if (!fs.existsSync(f)) return
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
}
loadEnvLocal()

// Mint a short-lived JWT the same way the server's auth guard expects (HS256/JWT_SECRET).
function mintToken(): string {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET not found (set it or put it in .env.local) — cannot authenticate to /api/chat')
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64({ id: 'coding-bench', email: 'bench@local', exp: Math.floor(Date.now() / 1000) + 3 * 3600 })
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

interface Task {
  id: string
  title: string
  modulePath: string     // file the agent MUST create (relative to project root)
  prompt: string         // exact spec handed to the agent (contract dictates API + path)
  /** Optional project scaffold — files written to the project dir BEFORE the agent fires. */
  scaffold?: Array<{ path: string; content: string }>
}

const CONTRACT_NOTE =
  'Build the COMPLETE, production-quality implementation — no placeholders, no TODOs, no stub bodies. ' +
  'You MUST create the exact file path and export the exact API named below (an automated audit imports it verbatim). ' +
  'Verify it actually runs before reporting done. Use a TypeScript project: tsconfig with "module":"commonjs" and ' +
  '"esModuleInterop":true; relative imports without .js extensions.'

const TASKS: Task[] = [
  {
    id: 'kvstore',
    title: 'Persistent LRU+TTL key-value store with WAL crash-recovery',
    modulePath: 'src/kvstore.ts',
    prompt:
`Implement a persistent key-value store in TypeScript at src/kvstore.ts. ${CONTRACT_NOTE}

Exact public API (src/kvstore.ts):
  export class KVStore {
    constructor(opts: { maxEntries: number; walPath: string })
    set(key: string, value: string, ttlMs?: number): void   // ttlMs optional per-key expiry
    get(key: string): string | undefined                    // undefined if missing or expired
    delete(key: string): boolean                             // true iff the key existed
    size(): number                                           // current live entry count
    close(): void
  }

Required behavior:
- LRU eviction: never exceed maxEntries; when full, evict the least-recently-used key. A get()
  counts as a use (refreshes recency).
- Per-key TTL: an entry with ttlMs expires that many ms after it was set; get() on an expired
  entry returns undefined.
- Durability via a write-ahead log at walPath: every mutation is appended to the WAL on disk.
- Crash recovery: constructing a new KVStore on an existing walPath replays the WAL to restore
  state. Deleted keys must stay deleted; entries whose TTL already lapsed must not be resurrected.

Write a self-test (src/index.ts, runnable with \`npx tsx src/index.ts\`) that exercises eviction,
TTL expiry, persistence across a fresh instance, and WAL replay — and confirm it passes.`,
  },
  {
    id: 'ratelimiter',
    title: 'Token-bucket + sliding-window rate limiter (injectable clock)',
    modulePath: 'src/ratelimiter.ts',
    prompt:
`Implement two rate limiters in TypeScript at src/ratelimiter.ts. ${CONTRACT_NOTE}

Exact public API (src/ratelimiter.ts):
  export class TokenBucket {
    // capacity tokens, refilled at refillPerSec tokens/second (fractional refill allowed),
    // never exceeding capacity. now() returns the current time in ms (default Date.now);
    // it is injectable so behavior is deterministically testable.
    constructor(capacity: number, refillPerSec: number, now?: () => number)
    tryRemove(tokens?: number): boolean   // default 1; true iff enough tokens were available
  }
  export class SlidingWindowLimiter {
    // at most \`limit\` allowed requests per rolling \`windowMs\`, tracked independently per key.
    constructor(limit: number, windowMs: number, now?: () => number)
    allow(key: string): boolean           // true iff this request is within the rolling limit
  }

Both must use the injected now() for all time math (so an advancing virtual clock drives them).
Write a self-test (src/index.ts, runnable with \`npx tsx src/index.ts\`) using a virtual clock that
proves capacity limiting, refill-over-time, the rolling window, and per-key isolation — confirm it passes.`,
  },
  {
    id: 'scheduler',
    title: 'Topological-sort task scheduler with cycle detection',
    modulePath: 'src/scheduler.ts',
    prompt:
`Implement a dependency scheduler in TypeScript at src/scheduler.ts. ${CONTRACT_NOTE}

Exact public API (src/scheduler.ts):
  // An edge [a, b] means "a must run before b".
  export function topoSort(nodes: string[], edges: [string, string][]): string[]
    // returns a valid topological order containing EVERY node exactly once
    // (including nodes with no edges); throws an Error if the graph has a cycle.
  export function findCycle(nodes: string[], edges: [string, string][]): string[] | null
    // returns the nodes forming a cycle (non-empty) if one exists, else null.
    // A self-loop [a, a] counts as a cycle.

Write a self-test (src/index.ts, runnable with \`npx tsx src/index.ts\`) covering a diamond DAG,
disconnected nodes, a multi-node cycle, and a self-loop — and confirm it passes.`,
  },
  {
    id: 'regex',
    title: 'Mini regex engine (full-match)',
    modulePath: 'src/regex.ts',
    prompt:
`Implement a small regular-expression engine in TypeScript at src/regex.ts. ${CONTRACT_NOTE}

Exact public API (src/regex.ts):
  export function regexMatch(pattern: string, text: string): boolean
    // returns true iff the ENTIRE text is matched by the pattern (full match, implicitly anchored).

Supported syntax:
  - literal characters
  - '.'  — any single character
  - '*'  — zero or more of the preceding element
  - '+'  — one or more of the preceding element
  - '?'  — zero or one of the preceding element
  - character classes: [abc] (members) and [a-z] (ranges)
  - '\\\\' escaping: \\\\. matches a literal '.', \\\\* a literal '*', etc.
Quantifiers must support backtracking so e.g. regexMatch('a.*z', 'a-middle-z') is true.

Write a self-test (src/index.ts, runnable with \`npx tsx src/index.ts\`) covering each operator,
class ranges, escaping, and a backtracking case — and confirm it passes.`,
  },
  // ── Phase C guard — edit an existing multi-file module ───────────────────────────
  {
    id: 'filterModule',
    title: 'Add filterUsers to an existing user-management module (repo-context task)',
    modulePath: 'src/filter.ts',
    scaffold: [
      {
        path: 'src/types.ts',
        content:
`// Existing type definitions — do not modify.
export interface User {
  id: number
  name: string
  email: string
  active: boolean
}
`,
      },
      {
        path: 'src/users.ts',
        content:
`// Existing user store — do not modify.
import type { User } from './types'

export function getAllUsers(): User[] {
  return [
    { id: 1, name: 'Alice',   email: 'alice@example.com',   active: true  },
    { id: 2, name: 'Bob',     email: 'bob@example.com',     active: false },
    { id: 3, name: 'Charlie', email: 'charlie@example.com', active: true  },
    { id: 4, name: 'Diana',   email: 'diana@corp.com',      active: true  },
    { id: 5, name: 'Eve',     email: 'eve@evil.net',        active: false },
  ]
}
`,
      },
    ],
    prompt:
`The project already has src/types.ts (defines User) and src/users.ts (defines getAllUsers).
Do NOT modify src/types.ts or src/users.ts — they are existing, correct code; only add new
files. Add src/filter.ts to this project. ${CONTRACT_NOTE}

Exact public API (src/filter.ts):
  import type { User } from './types'
  export interface FilterOpts {
    active?: boolean     // if provided, keep only users where user.active === active
    query?: string       // if provided, keep only users where name or email contains query (case-insensitive)
  }
  export function filterUsers(users: User[], opts: FilterOpts): User[]

Rules:
- Both filters compose: when both active and query are provided, both conditions must match.
- An empty opts object returns all users unchanged.
- The function must not mutate the input array.
- The import of User must come from './types' (NOT redeclared inline).

Write a self-test (src/index.ts, runnable with \`npx tsx src/index.ts\`) that calls getAllUsers()
from './users', passes the result to filterUsers with various opts, and confirms correctness.`,
  },
  {
    id: 'sortModule',
    title: 'Add sortProducts to an existing catalog module (repo-context, multi-key sort + tie-break)',
    modulePath: 'src/sort.ts',
    scaffold: [
      {
        path: 'src/types.ts',
        content:
`// Existing type definitions — do not modify.
export interface Product {
  id: number
  name: string
  category: string
  price: number
  inStock: boolean
}
`,
      },
      {
        path: 'src/catalog.ts',
        content:
`// Existing product catalog — do not modify.
import type { Product } from './types'

export function getAllProducts(): Product[] {
  return [
    { id: 1, name: 'Widget',      category: 'tools',   price: 19.99, inStock: true  },
    { id: 2, name: 'Gadget',      category: 'tools',   price: 9.99,  inStock: false },
    { id: 3, name: 'Sprocket',    category: 'tools',   price: 19.99, inStock: false },
    { id: 4, name: 'Doohickey',   category: 'novelty', price: 4.99,  inStock: true  },
    { id: 5, name: 'Contraption', category: 'novelty', price: 29.99, inStock: true  },
  ]
}
`,
      },
    ],
    prompt:
`The project already has src/types.ts (defines Product) and src/catalog.ts (defines getAllProducts).
Do NOT modify src/types.ts or src/catalog.ts — they are existing, correct code; only add new
files. Add src/sort.ts to this project. ${CONTRACT_NOTE}

Exact public API (src/sort.ts):
  import type { Product } from './types'
  export interface SortOpts {
    by: 'price' | 'name'          // primary sort key
    direction?: 'asc' | 'desc'    // default 'asc'
    inStockFirst?: boolean        // if true, ALL in-stock products sort before ALL out-of-stock ones
  }
  export function sortProducts(products: Product[], opts: SortOpts): Product[]

Rules:
- When inStockFirst is true: split into an in-stock group and an out-of-stock group, sort each
  group independently by by/direction, then return the in-stock group followed by the out-of-stock
  group.
- When inStockFirst is false or omitted: sort the whole list by by/direction with no grouping.
- direction defaults to 'asc' when omitted.
- Ties on the primary sort key break by id ascending, regardless of direction.
- The function must not mutate the input array.

Write a self-test (src/index.ts, runnable with \`npx tsx src/index.ts\`) that calls getAllProducts()
from './catalog', passes the result to sortProducts with various opts, and confirms correctness.`,
  },
  {
    id: 'summaryModule',
    title: 'Add summarizeByAccount to an existing transaction log (repo-context, group-by aggregation)',
    modulePath: 'src/summary.ts',
    scaffold: [
      {
        path: 'src/types.ts',
        content:
`// Existing type definitions — do not modify.
export interface Transaction {
  id: number
  accountId: string
  amount: number
  type: 'credit' | 'debit'
}
`,
      },
      {
        path: 'src/transactions.ts',
        content:
`// Existing transaction log — do not modify.
import type { Transaction } from './types'

export function getAllTransactions(): Transaction[] {
  return [
    { id: 1, accountId: 'acct-A', amount: 100, type: 'credit' },
    { id: 2, accountId: 'acct-A', amount: 30,  type: 'debit'  },
    { id: 3, accountId: 'acct-B', amount: 50,  type: 'credit' },
    { id: 4, accountId: 'acct-A', amount: 20,  type: 'debit'  },
    { id: 5, accountId: 'acct-B', amount: 50,  type: 'debit'  },
    { id: 6, accountId: 'acct-C', amount: 75,  type: 'credit' },
  ]
}
`,
      },
    ],
    prompt:
`The project already has src/types.ts (defines Transaction) and src/transactions.ts (defines
getAllTransactions). Do NOT modify src/types.ts or src/transactions.ts — they are existing,
correct code; only add new files. Add src/summary.ts to this project. ${CONTRACT_NOTE}

Exact public API (src/summary.ts):
  import type { Transaction } from './types'
  export interface AccountSummary {
    credits: number
    debits: number
    balance: number
  }
  export function summarizeByAccount(transactions: Transaction[]): Record<string, AccountSummary>

Rules:
- Group transactions by accountId.
- credits = sum of amount for that account's 'credit' transactions; debits = sum of amount for
  that account's 'debit' transactions.
- balance = credits - debits.
- Every account present in the input gets an entry with all three fields, even if one side (e.g.
  no debits) is 0 — never omit the credits or debits key.
- An account with no transactions at all must not appear in the result.
- The function must not mutate the input array.
- An empty input array returns an empty object.

Write a self-test (src/index.ts, runnable with \`npx tsx src/index.ts\`) that calls
getAllTransactions() from './transactions', passes the result to summarizeByAccount, and confirms
correctness.`,
  },
  // ── Fuzz-family-matched generation tasks (2026-07-05) — filterModule/sortModule/
  // summaryModule's real exported APIs never match localHardenFuzz.ts's name+arity
  // conventions (e.g. sortProducts(products, opts) is arity 2, not the arity-1 sort
  // family), so the fuzz layer has never been exercised by a live smoke sweep. These two
  // tasks are deliberately shaped so a correct — or subtly buggy — candidate lands
  // exactly inside a fuzz family's detection window.
  {
    id: 'clampModule',
    title: 'Add clampVolume to an existing audio-settings module (repo-context, number-transform-clamp family)',
    modulePath: 'src/clamp.ts',
    scaffold: [
      {
        path: 'src/types.ts',
        content:
`// Existing type definitions — do not modify.
export interface AudioSettings {
  volume: number
  minVolume: number
  maxVolume: number
}
`,
      },
    ],
    prompt:
`The project already has src/types.ts (defines AudioSettings). Do NOT modify src/types.ts — it is
existing, correct code; only add new files. Add src/clamp.ts to this project. ${CONTRACT_NOTE}

Exact public API (src/clamp.ts):
  export function clampVolume(value: number, min: number, max: number): number

Rules:
- Returns value unchanged if min <= value <= max.
- Returns min if value < min.
- Returns max if value > max.
- Behavior when min > max is unspecified (never tested with inverted bounds).

Write a self-test (src/index.ts, runnable with \`npx tsx src/index.ts\`) covering below-range,
in-range, above-range, and exact-boundary values — and confirm it passes.`,
  },
  {
    id: 'leaderboardModule',
    title: 'Add sortScoresAscending to an existing leaderboard module (repo-context, sort family)',
    modulePath: 'src/leaderboard.ts',
    scaffold: [
      {
        path: 'src/types.ts',
        content:
`// Existing type definitions — do not modify.
export interface ScoreEntry {
  player: string
  score: number
}
`,
      },
    ],
    prompt:
`The project already has src/types.ts (defines ScoreEntry). Do NOT modify src/types.ts — it is
existing, correct code; only add new files. Add src/leaderboard.ts to this project. ${CONTRACT_NOTE}

Exact public API (src/leaderboard.ts):
  export function sortScoresAscending(scores: number[]): number[]
    // returns a NEW array containing the same scores sorted ascending; does not mutate the input.

Rules:
- The output must contain exactly the same multiset of numbers as the input, in ascending order.
- The input array must not be mutated.

Write a self-test (src/index.ts, runnable with \`npx tsx src/index.ts\`) that sorts a mixed list of
scores and confirms both the ordering and that the input array is unchanged afterward.`,
  },
  {
    id: 'usernameModule',
    title: 'Add isValidUsername to a new module (standalone, validator family)',
    modulePath: 'src/username.ts',
    prompt:
`Add src/username.ts to this project. ${CONTRACT_NOTE}

Exact public API (src/username.ts):
  export function isValidUsername(name: string): boolean

Rules:
- Length must be between 3 and 20 characters inclusive.
- The first character must be a letter (a-z or A-Z).
- Every subsequent character must be a letter, digit, or underscore.
- Any other character (spaces, hyphens, punctuation, etc.) makes it invalid.

Write a self-test (src/index.ts, runnable with \`npx tsx src/index.ts\`) covering a valid username,
a leading-digit rejection, a too-short rejection, a too-long rejection, and an invalid-character
rejection — and confirm it passes.`,
  },
  {
    id: 'tagSetModule',
    title: 'Add unionTags/intersectTags to an existing article module (repo-context, set-op family)',
    modulePath: 'src/tags.ts',
    scaffold: [
      {
        path: 'src/types.ts',
        content:
`// Existing type definitions — do not modify.
export interface Article {
  id: string
  tags: string[]
}
`,
      },
    ],
    prompt:
`The project already has src/types.ts (defines Article). Do NOT modify src/types.ts — it is
existing, correct code; only add new files. Add src/tags.ts to this project. ${CONTRACT_NOTE}

Exact public API (src/tags.ts):
  export function unionTags(a: string[], b: string[]): string[]
    // returns a NEW array of every tag appearing in either a or b, with no duplicates.
  export function intersectTags(a: string[], b: string[]): string[]
    // returns a NEW array of tags appearing in BOTH a and b, with no duplicates.

Rules:
- Comparison is exact/case-sensitive string equality.
- The order of tags in the returned array is not significant.
- Neither function may mutate its input arrays.

Write a self-test (src/index.ts, runnable with \`npx tsx src/index.ts\`) exercising both functions
on overlapping tag lists and confirming neither input array is mutated afterward.`,
  },
  {
    // 2026-07-06: added specifically to live-fire-confirm the derive.ts `comparator`-family
    // fix from cont.32 (see NEXT_SESSION.md / crucible-coding-harness memory item 34) — that
    // fix stopped the family from unconditionally testing string-typed comparators with a
    // numeric pair (which fails tsc on the generated test file itself). This task's real
    // exported signature is explicitly `(a: string, b: string)`, landing squarely inside the
    // family this fix targets, with a domain (case-insensitive lexicographic order) chosen so
    // the oracle's own generic 'a'/'b' literal assertions are meaningful (unlike an
    // enum-restricted domain, where 'a'/'b' wouldn't be valid inputs).
    id: 'caseCompareModule',
    title: 'Add compareCaseInsensitive to a new module (standalone, string-typed comparator family)',
    modulePath: 'src/caseCompare.ts',
    prompt:
`Add src/caseCompare.ts to this project. ${CONTRACT_NOTE}

Exact public API (src/caseCompare.ts):
  export function compareCaseInsensitive(a: string, b: string): number

Rules:
- Case-insensitive lexicographic comparison: compare a.toLowerCase() to b.toLowerCase().
- Returns a negative number if a sorts before b, positive if a sorts after b, 0 if they are equal
  ignoring case.
- Two strings that differ only in case (e.g. "Hello" and "HELLO") must compare as equal (0).

Write a self-test (src/index.ts, runnable with \`npx tsx src/index.ts\`) covering an equal-ignoring-
case pair, an a-before-b pair, and a b-before-a pair — and confirm it passes.`,
  },

  // ── Frontier-SWE-adjacent tasks ─────────────────────────────────────────────
  // Unlike the greenfield single-module tasks above, these mirror real SWE work:
  // (1) FIX a bug in existing code without changing its signature, and (2) create
  // TWO interdependent files in an existing repo. Both stress locate-and-integrate,
  // not blank-page authoring.
  {
    id: 'bugfixCsv',
    title: 'Fix a quoted-field bug in an existing RFC-4180 CSV parser (bug-fix-in-repo task)',
    modulePath: 'src/csv.ts',
    scaffold: [
      {
        // The buggy implementation the agent must REPAIR (not rewrite from a blank file).
        path: 'src/csv.ts',
        content:
`// CSV parser. There is a bug: quoted fields are not handled — a comma or newline
// INSIDE a double-quoted field is wrongly treated as a delimiter, and escaped
// double-quotes ("") are not unescaped. Fix parseCsv so it is RFC-4180 correct.
// Do NOT change the exported signature.
export function parseCsv(input: string): string[][] {
  // BUG: naive split ignores quoting entirely.
  return input
    .split(/\\r?\\n/)
    .filter(line => line.length > 0)
    .map(line => line.split(','))
}
`,
      },
    ],
    prompt:
`The project has an existing, BUGGY CSV parser at src/csv.ts. ${CONTRACT_NOTE}

Fix the bug in place — keep the exact exported signature:
  export function parseCsv(input: string): string[][]

It must become RFC-4180 correct:
- A field may be wrapped in double quotes. A comma or newline INSIDE a quoted field is
  literal content, NOT a delimiter/row break.
- Inside a quoted field, a doubled double-quote ("") is an escaped single double-quote (").
- Unquoted fields are taken verbatim (trim nothing).
- Each output row is an array of field strings; the result is an array of rows.
- A trailing newline does not produce an extra empty row; but an empty quoted field ("")
  is a real empty-string field.

Examples (each must hold exactly):
- parseCsv('a,"b,c","d""e"\\nf,g,h') === [['a','b,c','d"e'],['f','g','h']]
- parseCsv('"a\\nb",c') === [['a\\nb','c']]
- parseCsv('x,"",y') === [['x','','y']]

Write a self-test (src/index.ts, runnable with \`npx tsx src/index.ts\`) that feeds inputs with
embedded commas, embedded newlines, and escaped quotes, and confirms correctness.`,
  },
  {
    id: 'multiFileLedger',
    title: 'Create two interdependent modules (ledger + report) in an existing repo (multi-file task)',
    modulePath: 'src/report.ts',
    scaffold: [
      {
        path: 'src/types.ts',
        content:
`// Existing type definitions — do not modify.
export interface Transaction {
  id: string
  amount: number      // positive = credit, negative = debit
  category: string
}
`,
      },
    ],
    prompt:
`The project has src/types.ts (defines Transaction). Do NOT modify it. ${CONTRACT_NOTE}

Create TWO new interdependent files:

1. src/ledger.ts:
     import type { Transaction } from './types'
     export class Ledger {
       add(tx: Transaction): void          // reject a duplicate id by throwing an Error
       all(): Transaction[]                // insertion order; must not expose internal mutability
       balance(): number                   // sum of all amounts
     }

2. src/report.ts (imports from BOTH ./ledger and ./types):
     import { Ledger } from './ledger'
     export function categoryTotals(ledger: Ledger): Record<string, number>
       // total amount per category, summed across the ledger's transactions

Rules:
- report.ts MUST import Ledger from './ledger' (the two files are genuinely coupled;
  do not inline a duplicate ledger).
- all() must not let a caller mutate the Ledger's internal array (return a copy).
- add() throws on a duplicate id.

Write a self-test (src/index.ts, runnable with \`npx tsx src/index.ts\`) that builds a Ledger,
adds several transactions across categories, and asserts balance() and categoryTotals().`,
  },
]

// ── SSE fire: send the task to the live agent, collect the outcome ─────────────────
interface FireResult {
  done: boolean; finalText: string; agentError: string | null
  iters: number; selfTestPassed: boolean | null; events: number; elapsedMs: number
  // 'catalog'   — server matched a stored, proven skill-catalog PRIMITIVE. Zero model inference
  //               AND zero search: a memorized answer. Doctrine calls this debt, not capability.
  // 'enumerative' — no primitive matched, so L1 ran a bottom-up ENUMERATIVE PROGRAM SEARCH from
  //               the spec's worked examples and the execution oracle certified the result. Zero
  //               model inference, but this is genuine reasoning about a task the system had no
  //               stored answer for — propose->verify->backtrack with a search-based proposer
  //               instead of a model-based one, which is the doctrine's own loop.
  // 'generated' — neither fast path certified; the task stressed the model generation path.
  //
  // WHY THREE AND NOT TWO (2026-07-26): the server has always sent `source: 'primitive' |
  // 'enumerative'` on the synth_match event, but this harness collapsed BOTH to 'catalog' and
  // printed "not a generative-capability signal" over the top. That mislabels the L1 search —
  // the one component that most directly embodies "correctness comes from the LOOP" — as a
  // memorized lookup, and it does so in the direction that UNDER-states capability. bugfixCsv's
  // two `path=catalog` rows in the rolling ledger are literally logged server-side as "pure-code
  // enumerative program search".
  //
  // The HEADLINE gen-path number deliberately still means 'generated' only, so it stays
  // comparable with every scorecard on record; 'enumerative' is broken out beside it rather
  // than folded in. Reporting a new, larger number under the old name would be the exact
  // silent-redefinition the doctrine forbids.
  synthPath: 'catalog' | 'enumerative' | 'generated' | null
  // TRUE iff PER_TASK_TIMEOUT_MS fired and we aborted the stream. Set from the timer itself, not
  // sniffed out of agentError. When this is true `elapsedMs` is RIGHT-CENSORED: it is the cap, a
  // LOWER BOUND on the real cost, not a measurement of it. Every wall-clock statistic below must
  // say so, otherwise a whole cohort of tasks reports the same saturated number and a latency
  // regression inside that cohort is structurally invisible.
  timedOut: boolean
}
async function fireTask(task: Task, dir: string, token: string): Promise<FireResult> {
  const t0 = Date.now()
  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, PER_TASK_TIMEOUT_MS)
  let done = false, finalText = '', agentError: string | null = null
  let iters = 0, events = 0, selfTestPassed: boolean | null = null
  let synthPath: 'catalog' | 'enumerative' | 'generated' | null = null
  try {
    const res = await fetch(`${API}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': `crucible_session=${token}` },
      body: JSON.stringify({ message: task.prompt, mode: 'agent', device: 'desktop', projectPath: dir, agentMode: true }),
      signal: ctrl.signal,
    })
    if (!res.ok) { agentError = `HTTP ${res.status}`; return { done, finalText, agentError, iters, selfTestPassed, events, elapsedMs: Date.now() - t0, synthPath, timedOut } }
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    outer: while (true) {
      const { done: rdone, value } = await reader.read()
      if (rdone) break
      buf += decoder.decode(value, { stream: true })
      const chunks = buf.split('\n\n'); buf = chunks.pop() ?? ''
      for (const chunk of chunks) {
        const line = chunk.split('\n').find(l => l.startsWith('data: '))
        if (!line) continue
        const payload = line.slice(6).trim()
        if (payload === '[DONE]') { done = true; break outer }
        try {
          const ev = JSON.parse(payload); events++
          if (ev.type === 'iter_progress' && typeof ev.iter === 'number') iters = Math.max(iters, ev.iter)
          if (ev.type === 'verify' && typeof ev.passed === 'boolean') selfTestPassed = ev.passed
          if (ev.type === 'agent_error') agentError = String(ev.error ?? 'agent_error').slice(0, 200)
          if (ev.type === 'final' && typeof ev.text === 'string') { finalText = ev.text; done = true }
          // The server distinguishes a stored primitive from an enumerative search win; keep it.
          if (ev.type === 'synth_match') synthPath = ev.source === 'enumerative' ? 'enumerative' : 'catalog'
          if (ev.type === 'synth_miss') synthPath = 'generated'
        } catch { /* keepalive / non-JSON */ }
      }
    }
  } catch (e: any) {
    if (e?.name !== 'AbortError') agentError = String(e?.message ?? e).slice(0, 200)
    else agentError = `timeout after ${(PER_TASK_TIMEOUT_MS / 1000).toFixed(0)}s`
  } finally { clearTimeout(timer) }
  return { done, finalText, agentError, iters, selfTestPassed, events, elapsedMs: Date.now() - t0, synthPath, timedOut }
}

// ── audit: checks the agent never saw ─────────────────────────────────────────────
function runCmd(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { cwd: CODE_DIR, encoding: 'utf8', timeout: opts.timeoutMs ?? 90_000, maxBuffer: 8 * 1024 * 1024 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  return { ok: r.status === 0, out }
}

// Freeze the produced src/ into a sibling dir the instant the agent run returns, so the
// audit reads a STABLE snapshot. Necessary because the server keeps the agent running for
// a 10-min grace period after the harness disconnects — without a snapshot it would still
// be rewriting files (momentarily empty) while we audit, corrupting the measurement.
function snapshotProject(dir: string, taskId: string): string {
  const frozen = path.join(BENCH_ROOT, `${taskId}__frozen`)
  fs.rmSync(frozen, { recursive: true, force: true })
  fs.mkdirSync(frozen, { recursive: true })
  const srcDir = path.join(dir, 'src')
  if (fs.existsSync(srcDir)) fs.cpSync(srcDir, path.join(frozen, 'src'), { recursive: true })
  return frozen
}

interface AuditResult {
  moduleExists: boolean
  compiled: boolean; compileDetail: string
  hiddenPassed: boolean; hiddenDetail: string
}
function auditTask(task: Task, dir: string): AuditResult {
  const moduleAbs = path.join(dir, task.modulePath)
  const moduleExists = fs.existsSync(moduleAbs) && fs.statSync(moduleAbs).size > 0
  if (!moduleExists) return { moduleExists: false, compiled: false, compileDetail: 'module file missing/empty', hiddenPassed: false, hiddenDetail: 'skipped — no module' }

  const auditDir = path.join(dir, '__audit__')
  fs.mkdirSync(auditDir, { recursive: true })

  // 1 — clean typecheck of the produced src/ (follows imports). Driven by our OWN lenient
  // audit-tsconfig via -p (NOT files-on-cmdline, which trips TS5112 when a tsconfig is in
  // scope) so we measure the module's type-soundness under reasonable settings — strict
  // off so we don't fail correct code on implicit-any pedantry; the hidden suite is the
  // real correctness bar. The tsconfig lives UNDER crucible-local so @types/node resolves;
  // it includes the scratch src by absolute path.
  const auditCfgDir = path.join(CODE_DIR, '.crucible', 'coding-bench-audit', task.id)
  fs.mkdirSync(auditCfgDir, { recursive: true })
  const auditTsconfig = path.join(auditCfgDir, 'tsconfig.json')
  fs.writeFileSync(auditTsconfig, JSON.stringify({
    compilerOptions: { noEmit: true, skipLibCheck: true, esModuleInterop: true, module: 'commonjs', target: 'es2020', moduleResolution: 'node10', ignoreDeprecations: '6.0', strict: false, noImplicitAny: false, typeRoots: [path.join(CODE_DIR, 'node_modules/@types')], types: ['node'] },
    include: [path.join(dir, 'src/**/*.ts')],
  }, null, 2))
  const tc = runCmd('npx', ['tsc', '--noEmit', '-p', auditTsconfig])
  const compiled = tc.ok
  const compileDetail = tc.ok ? 'tsc clean' : (tc.out.split('\n').find(l => /error TS/.test(l)) ?? tc.out.slice(0, 200))

  // 2 — HIDDEN adversarial suite: copy in and run via tsx (relative import → ../src/<module>)
  const hiddenSrc = path.join(HIDDEN_DIR, `${task.id}.hidden.ts`)
  const hiddenDst = path.join(auditDir, `${task.id}.hidden.ts`)
  fs.copyFileSync(hiddenSrc, hiddenDst)
  const hr = runCmd('npx', ['tsx', hiddenDst], { timeoutMs: 60_000 })
  const hiddenPassed = hr.ok
  // keep the PASS/FAIL lines for the report
  const hiddenDetail = hr.out.split('\n').filter(l => /PASS|FAIL|crashed|Error|ALL PASS|FAILURE/.test(l)).slice(-6).join(' | ') || hr.out.slice(0, 200)
  return { moduleExists, compiled, compileDetail, hiddenPassed, hiddenDetail }
}

// ── optional SOFT LLM rubric (free Groq model) — never blocks, never errors out ────
async function rubricScore(dir: string): Promise<number | null> {
  const key = process.env.VITE_GROQ_API_KEY
  if (!key) return null
  let src = ''
  try {
    const srcDir = path.join(dir, 'src')
    for (const f of fs.readdirSync(srcDir)) if (f.endsWith('.ts')) src += `\n// ===== ${f} =====\n` + fs.readFileSync(path.join(srcDir, f), 'utf8')
  } catch { return null }
  if (!src.trim()) return null
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile', temperature: 0,
        messages: [{
          role: 'user',
          content: `Score this TypeScript implementation 0-100 for senior-engineer quality: correctness, completeness (no stubs/TODOs), edge-case handling, and error paths. Reply with ONLY the integer.\n\n${src.slice(0, 12000)}`,
        }],
      }),
    })
    if (!res.ok) return null
    const data: any = await res.json()
    const m = String(data.choices?.[0]?.message?.content ?? '').match(/\d{1,3}/)
    if (!m) return null
    return Math.max(0, Math.min(100, parseInt(m[0], 10)))
  } catch { return null }
}

interface TaskScore extends AuditResult {
  id: string; title: string; fired: boolean; agentError: string | null
  selfTestPassed: boolean | null; rubric: number | null; iters: number; elapsedMs: number
  synthPath: 'catalog' | 'enumerative' | 'generated' | null
  /** See FireResult.timedOut — when true, elapsedMs is the cap (a lower bound), not a measurement. */
  timedOut: boolean
}

async function serverUp(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${API}/api/diag`, { signal: AbortSignal.timeout(4000), headers: { 'Cookie': `crucible_session=${token}` } })
    return res.ok
  } catch { return false }
}

// This benchmark is an HTTP client to an already-running, separately-launched server
// process. CRUCIBLE_OFFLINE set on THIS process (e.g. via `npm run smoke:code:offline`)
// has zero effect on that server's routing — the server reads its own env once, at its
// own startup. Silently firing tasks at a server in the wrong mode produced a whole
// session's worth of meaningless "rate-limit exhaustion" data before this check existed
// (the real bug turned out to be an offline-driver capability gap, not free-tier quota —
// see ROADMAP.md). Fetch what the live server is actually running and fail loud on mismatch.
async function liveServerConfig(token: string): Promise<{ offlineMode: string; noLearn: boolean }> {
  const res = await fetch(`${API}/api/config`, { signal: AbortSignal.timeout(4000), headers: { 'Cookie': `crucible_session=${token}` } })
  const cfg = await res.json() as { offlineMode?: string; noLearn?: boolean }
  return { offlineMode: cfg.offlineMode ?? '1', noLearn: !!cfg.noLearn }
}

function describeMode(mode: string): string {
  return mode === 'strict' ? 'offline-only, no external fallback'
    : mode === '0' ? 'external-only, offline brain opted out'
    : 'offline-first with external fallback (production default)'
}

function loadPrevious(): Record<string, TaskScore> {
  try {
    const j = JSON.parse(fs.readFileSync(SCORECARD, 'utf8'))
    const map: Record<string, TaskScore> = {}
    for (const t of j.tasks ?? []) map[t.id] = t
    return map
  } catch { return {} }
}

async function main() {
  const ids = process.argv.slice(2).filter(a => !a.startsWith('-'))
  const suite = ids.length ? TASKS.filter(t => ids.includes(t.id)) : TASKS
  if (!suite.length) { console.error(`No matching tasks. Known ids: ${TASKS.map(t => t.id).join(', ')}`); process.exit(2) }

  const token = mintToken()
  console.log('Crucible CODING stress-test & audit harness')
  console.log(`Target: ${API}   Tasks: ${suite.map(t => t.id).join(', ')}   Timeout/task: ${(PER_TASK_TIMEOUT_MS / 1000).toFixed(0)}s`)
  if (!(await serverUp(token))) {
    console.error(`\nFAIL — server not reachable/authorized at ${API}. Start it:\n  nohup npx tsx server.ts > /tmp/crucible-server.log 2>&1 < /dev/null & disown`)
    process.exit(2)
  }

  const requestedMode = process.env.CRUCIBLE_OFFLINE
  const { offlineMode: liveMode, noLearn: liveNoLearn } = await liveServerConfig(token)
  if (requestedMode && requestedMode !== liveMode) {
    console.error(
      `\nFAIL — this script was launched with CRUCIBLE_OFFLINE=${requestedMode}, but that only sets the env of ` +
      `THIS process. The live server at ${API} is a separate, already-running process and reads CRUCIBLE_OFFLINE ` +
      `from its OWN env at its own startup — it is actually running in mode "${liveMode}" (${describeMode(liveMode)}). ` +
      `Restart the server itself with CRUCIBLE_OFFLINE=${requestedMode} in its launch command, then re-run this.`
    )
    process.exit(2)
  }
  console.log(`Live server offline mode: ${liveMode} (${describeMode(liveMode)})`)

  // ── CATALOG-DRIFT GUARD ────────────────────────────────────────────────────────
  // A task solved via path=gen has its solution distilled into synth/skills/_learned/, so the
  // NEXT run of that task matches it and scores path=catalog (MEASURED: bugfixCsv, 99s gen ->
  // 3s catalog). Repeat-running to build confidence therefore measures the benchmark's own
  // memory. CRUCIBLE_NO_LEARN=1 closes both halves — but ONLY in the process that distils and
  // loads, which is the SERVER, not this script. Exporting it here would be a no-op that reads
  // like a guarantee, so ask the live server what it is actually doing and say so out loud.
  if (process.env.CRUCIBLE_NO_LEARN && !liveNoLearn) {
    console.error(
      `\nFAIL — CRUCIBLE_NO_LEARN is set on THIS process, but the live server at ${API} reports ` +
      `noLearn=false. Distillation and learned-catalog loading both happen inside the server, so ` +
      `this run would still promote its own answers into synth/skills/_learned/ and would still ` +
      `match previously-promoted ones — i.e. exactly the contaminated measurement the flag exists ` +
      `to prevent, but labelled clean. Restart the server with CRUCIBLE_NO_LEARN=1 in its OWN ` +
      `launch command, then re-run this.`,
    )
    process.exit(2)
  }
  console.log(
    liveNoLearn
      ? `Learned-catalog: SUPPRESSED (server noLearn=1) — no distillation, no _learned/ matches. Gen-path numbers are uncontaminated.`
      : `Learned-catalog: ACTIVE — this run may both match and create entries in synth/skills/_learned/. ` +
        `Repeat runs of the same task will drift gen -> catalog; treat per-task pass rates accordingly.`,
  )

  const prev = loadPrevious()
  const scores: TaskScore[] = []
  // Pace between tasks so a multi-task cert doesn't exhaust the free-tier rate limits
  // (running hard coding tasks back-to-back trips every circuit; the next task then sees
  // an empty pool). A gap lets the 60s cooldowns recover. Tunable / 0 to disable.
  // OFFLINE-STRICT has no external pool and no rate limits, so the gap is pure dead time
  // (~10 min across 14 tasks) AND its "free pool" log line is the exact phrase CLAUDE.md flags
  // as "you ran the WRONG command" — which would be a false alarm on a valid offline run. Default
  // it to 0 under strict so offline runs are faster and never print the misleading message.
  const strictOffline = (process.env.CRUCIBLE_OFFLINE ?? '') === 'strict'
  const GAP_MS = Number(process.env.CRUCIBLE_CODE_BENCH_GAP ?? (strictOffline ? 0 : 45_000))

  for (let ti = 0; ti < suite.length; ti++) {
    const task = suite[ti]
    if (ti > 0 && GAP_MS > 0) {
      console.log(`  …pausing ${(GAP_MS / 1000).toFixed(0)}s to let the free pool recover before the next task…`)
      await new Promise(r => setTimeout(r, GAP_MS))
    }
    const dir = path.join(BENCH_ROOT, task.id)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    // Write scaffold files BEFORE firing (Phase C: existing-project context).
    if (task.scaffold?.length) {
      for (const { path: rel, content } of task.scaffold) {
        const abs = path.join(dir, rel)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, content, 'utf-8')
      }
    }
    console.log(`\n=== ${task.id} — ${task.title} ===`)
    console.log(`  firing… (project: ${dir})`)
    const fire = await fireTask(task, dir, token)
    // Freeze the deliverable immediately (the agent may still be running post-disconnect).
    const frozen = snapshotProject(dir, task.id)
    console.log(`  agent: done=${fire.done} iters=${fire.iters} self-test=${fire.selfTestPassed} elapsed=${(fire.elapsedMs / 1000).toFixed(0)}s${fire.agentError ? ` error="${fire.agentError}"` : ''}`)
    const audit = auditTask(task, frozen)
    const rubric = await rubricScore(frozen)
    const score: TaskScore = {
      id: task.id, title: task.title, fired: fire.done || !!audit.moduleExists, agentError: fire.agentError,
      selfTestPassed: fire.selfTestPassed, rubric, iters: fire.iters, elapsedMs: fire.elapsedMs,
      synthPath: fire.synthPath, timedOut: fire.timedOut, ...audit,
    }
    scores.push(score)
    console.log(`  [HARD] module exists : ${audit.moduleExists ? 'PASS' : 'FAIL'}`)
    console.log(`  [HARD] compiles clean: ${audit.compiled ? 'PASS' : 'FAIL'}  :: ${audit.compileDetail}`)
    console.log(`  [HARD] hidden suite  : ${audit.hiddenPassed ? 'PASS' : 'FAIL'}  :: ${audit.hiddenDetail}`)
    console.log(`  [SOFT] self-test     : ${score.selfTestPassed === null ? 'n/a' : score.selfTestPassed ? 'PASS' : 'FAIL'}`)
    console.log(`  [SOFT] LLM rubric    : ${rubric === null ? 'n/a' : rubric + '/100'}`)
    const pathNote = fire.synthPath === 'catalog'
      ? ' — stored proven-skill primitive, zero model inference AND zero search; not a generative-capability signal'
      : fire.synthPath === 'enumerative'
      ? ' — L1 enumerative program search, zero model inference but no stored answer either; real reasoning, reported apart from the model-generation headline'
      : ''
    console.log(`  [INFO] synth path    : ${fire.synthPath ?? 'unknown'}${pathNote}`)
  }

  // ── scorecard + regression check ────────────────────────────────────────────────
  fs.mkdirSync(path.dirname(SCORECARD), { recursive: true })
  const passedHard = scores.filter(s => s.moduleExists && s.compiled && s.hiddenPassed).length
  // WALL CLOCK AS A SCORED AXIS (2026-07-26). `passedHard` deliberately keeps its exact old
  // meaning — it is the number the doctrine says to quote, and changing it silently would break
  // comparability with every scorecard on record and with the regression check below. What was
  // missing is that it says NOTHING about cost: a task cut off at PER_TASK_TIMEOUT_MS still scored
  // GREEN (measured: multiFileLedger, 480s, agentError="timeout after 480s", all three HARD checks
  // PASS — and 5 more greens in the same run). That GREEN is not a scoring bug: the audit reads a
  // real snapshot and the hidden adversarial suite really passed, so calling it RED would report
  // correct code as incorrect. But it is not a full pass either — the agent never terminated, so
  // the run was CENSORED, and a frontier-SWE bar that ignores whether work ever finishes is not a
  // bar. Hence a THIRD state (AMBER) and a second, stricter count reported alongside.
  const censored = scores.filter(s => s.moduleExists && s.compiled && s.hiddenPassed && s.timedOut)
  const passedHardInBudget = passedHard - censored.length
  const capS = (PER_TASK_TIMEOUT_MS / 1000).toFixed(0)
  fs.writeFileSync(SCORECARD, JSON.stringify({ ts: Date.now(), passedHard, passedHardInBudget, capMs: PER_TASK_TIMEOUT_MS, total: scores.length, tasks: scores }, null, 2))

  console.log('\n=== SCORECARD ===')
  for (const s of scores) {
    const hard = s.moduleExists && s.compiled && s.hiddenPassed
    const path = s.synthPath === 'catalog' ? 'catalog' : s.synthPath === 'enumerative' ? 'enum' : s.synthPath === 'generated' ? 'gen' : '?'
    // GREEN = correct AND converged in budget. AMBER = correct code on disk, but the harness cut
    // the agent off at the cap. RED = a HARD check failed. '+' marks a censored elapsed.
    const state = !hard ? ' RED ' : s.timedOut ? 'AMBER' : 'GREEN'
    const prevMs = prev[s.id]?.elapsedMs
    const delta = typeof prevMs === 'number' && prevMs > 0
      ? ` (${s.elapsedMs >= prevMs ? '+' : ''}${(((s.elapsedMs - prevMs) / prevMs) * 100).toFixed(0)}% vs prev)` : ''
    console.log(`  ${state}  ${s.id.padEnd(12)} compile=${s.compiled ? 'Y' : 'n'} hidden=${s.hiddenPassed ? 'Y' : 'n'} self=${s.selfTestPassed === null ? '-' : s.selfTestPassed ? 'Y' : 'n'} rubric=${s.rubric ?? '-'} path=${path.padEnd(7)} ${(s.elapsedMs / 1000).toFixed(0)}s${s.timedOut ? '+' : ' '}${delta}`)
  }
  console.log(`\n  Claude-level (all HARD green): ${passedHard}/${scores.length} tasks`)
  console.log(`    of which CONVERGED inside the ${capS}s box (GREEN)     : ${passedHardInBudget}/${scores.length}`)
  if (censored.length) {
    console.log(`    of which CENSORED at the ${capS}s cap (AMBER)         : ${censored.length}/${scores.length} — ${censored.map(s => s.id).join(', ')}`)
    console.log(`      AMBER = the audited code is correct, but the agent never terminated; the harness aborted and`)
    console.log(`      snapshotted mid-run. Their elapsed is the CAP, a lower bound — not a measurement of cost.`)
  }
  // A 'catalog' GREEN proves proven-skill coverage, NOT that the offline agent can generate
  // new code — it never touched the model. Only 'generated' tasks stress real capability;
  // conflating the two is exactly what produced last session's misleading 4/5 "Claude-level"
  // read on filterModule's rate-limit investigation. Report them separately, always.
  const genScores = scores.filter(s => s.synthPath === 'generated')
  const genPassed = genScores.filter(s => s.moduleExists && s.compiled && s.hiddenPassed).length
  const catScores = scores.filter(s => s.synthPath === 'catalog')
  const catPassed = catScores.filter(s => s.moduleExists && s.compiled && s.hiddenPassed).length
  // Broken out from 'catalog' (2026-07-26). An L1 enumerative win used the model zero times, like a
  // primitive — but unlike a primitive it had NO stored answer and had to SEARCH for a program,
  // certified by the execution oracle. That is the doctrine's loop with a search-based proposer,
  // so filing it under "memorized" understated capability. It is still reported apart from the
  // model-generation headline, because it measures a different faculty.
  const enumScores = scores.filter(s => s.synthPath === 'enumerative')
  const enumPassed = enumScores.filter(s => s.moduleExists && s.compiled && s.hiddenPassed).length
  const genPassedInBudget = genScores.filter(s => s.moduleExists && s.compiled && s.hiddenPassed && !s.timedOut).length
  console.log(`    of which via catalog-primitive match (memorized, zero search): ${catPassed}/${catScores.length} green`)
  if (enumScores.length) {
    console.log(`    of which via ENUMERATIVE program search (zero model, real)   : ${enumPassed}/${enumScores.length} green`)
    console.log(`      enum = no stored answer existed; L1 searched for a program and the execution oracle`)
    console.log(`      certified it. Genuine reasoning, but a DIFFERENT faculty from model generation —`)
    console.log(`      kept out of the gen headline so that number stays comparable with past scorecards.`)
  }
  console.log(`    of which via genuine model generation (real signal)  : ${genPassed}/${genScores.length} green  |  in-budget: ${genPassedInBudget}/${genScores.length}`)
  if (genScores.length === 0) console.log(`    ⚠ no task in this run exercised genuine MODEL generation — the summary above says nothing about the offline agent's ability to write new code${enumScores.length ? ` (${enumScores.length} task(s) were certified by enumerative search instead)` : ''}`)

  // ── WALL CLOCK — the scored axis the scorecard was missing ─────────────────────
  // Printed for the gen path only, for the same reason pass rates are: a catalog hit is a memory
  // lookup (measured: 3s) and folding it in would flatter the median into meaninglessness.
  const genTimed = scores.filter(s => s.synthPath === 'generated')
  if (genTimed.length) {
    const ms = genTimed.map(s => s.elapsedMs).sort((a, b) => a - b)
    const q = (p: number) => ms[Math.min(ms.length - 1, Math.floor(p * (ms.length - 1)))]
    const atCap = genTimed.filter(s => s.timedOut).length
    console.log(`\n=== WALL CLOCK (gen path, cap ${capS}s/task) ===`)
    console.log(`  median ${(q(0.5) / 1000).toFixed(0)}s   p90 ${(q(0.9) / 1000).toFixed(0)}s   max ${(ms[ms.length - 1] / 1000).toFixed(0)}s   at cap: ${atCap}/${genTimed.length}`)
    const slow = [...genTimed].sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 3)
    console.log(`  slowest: ${slow.map(s => `${s.id} ${(s.elapsedMs / 1000).toFixed(0)}s${s.timedOut ? '+' : ''}`).join(', ')}`)
    if (atCap) {
      console.log(`  ⚠ ${atCap}/${genTimed.length} gen tasks are pinned AT the cap. Inside that cohort every task reports the same`)
      console.log(`    ${capS}s regardless of how much slower it actually got — a latency regression there is INVISIBLE by`)
      console.log(`    construction. Raise CRUCIBLE_CODE_BENCH_TIMEOUT to un-saturate, or cut seconds/iteration.`)
    }
    const regressed: string[] = []
    for (const s of genTimed) {
      const p = prev[s.id]?.elapsedMs
      // Thresholds are deliberately loose: same-task wall time is documented to swing 137s→480s
      // purely on server contention (ROADMAP 2026-07-22h), so a tight bound would be a false-alarm
      // machine. This never changes the exit code — it reports, the human judges.
      if (typeof p === 'number' && p > 0 && s.elapsedMs > p * 1.25 && s.elapsedMs - p > 30_000) {
        regressed.push(`${s.id} ${(p / 1000).toFixed(0)}s→${(s.elapsedMs / 1000).toFixed(0)}s`)
      }
    }
    if (regressed.length) console.log(`  ⚠ SLOWER vs the previous scorecard (>25% and >30s): ${regressed.join(', ')}`)
  }

  // ── Per-task pass rates over the last N runs (n>1 signal) ──────────────────────
  // A single run cannot tell a real fix from variance. Append this run, then report each task's
  // rate across the window so a "GREEN" is qualified by how often it is actually green.
  // `ms`/`to` ride along with hard/gen so wall clock accumulates the SAME way pass rates do — one
  // run cannot tell a real slowdown from contention any more than it can tell a fix from variance.
  // Both are optional: entries written before 2026-07-26 have neither and must read as "unknown",
  // never as 0.
  type HistRun = { ts: number; tasks: Record<string, { hard: boolean; gen: boolean; ms?: number; to?: boolean }> }
  let history: HistRun[] = []
  try { history = JSON.parse(fs.readFileSync(HISTORY, 'utf-8')) } catch { history = [] }
  if (!Array.isArray(history)) history = []
  const thisRun: HistRun = { ts: Date.now(), tasks: {} }
  for (const s of scores) {
    // NOTE: `hard` intentionally stays the OLD predicate (AMBER counts as hard here). The ledger's
    // job is comparability across runs; `to` carries the censoring separately.
    thisRun.tasks[s.id] = { hard: !!(s.moduleExists && s.compiled && s.hiddenPassed), gen: s.synthPath === 'generated', ms: s.elapsedMs, to: s.timedOut }
  }
  history.push(thisRun)
  // Keep a bounded tail — enough to compute the window plus a little context.
  history = history.slice(-Math.max(HISTORY_WINDOW * 4, 20))
  try { fs.writeFileSync(HISTORY, JSON.stringify(history, null, 2)) } catch { /* non-fatal — the run's own result still stands */ }

  // Only runs that actually EXERCISED a task count toward its rate; a task-filtered invocation
  // (`smoke:code:offline tagSetModule`) must not be read as the other 13 tasks failing.
  const window = history.slice(-HISTORY_WINDOW)
  console.log(`\n=== PER-TASK PASS RATE (last ${window.length} run${window.length === 1 ? '' : 's'} that exercised each task) ===`)
  const variance: string[] = []
  const drifted: string[] = []
  let reliableGen = 0, genTracked = 0
  for (const s of scores) {
    // CONTAMINATION GUARD — rate ONLY over runs where this task actually went through generation.
    // Measured 2026-07-26: bugfixCsv ran path=gen (99s), its solution was promoted into
    // skills/_learned/, and the very next run scored it path=catalog (3s). A naive repeat-run
    // reliability number would therefore climb toward 100% simply because the catalog absorbs
    // run 1's answer — the benchmark would be grading its own memory, which the doctrine calls
    // debt, not capability. Catalog runs are excluded from the rate rather than counted as wins.
    const runs = window.filter(r => r.tasks[s.id])
    const genRuns = runs.filter(r => r.tasks[s.id].gen)
    const greens = genRuns.filter(r => r.tasks[s.id].hard).length
    const rate = genRuns.length ? greens / genRuns.length : 0
    const isGen = s.synthPath === 'generated'
    if (isGen) { genTracked++; if (genRuns.length > 1 && rate === 1) reliableGen++ }
    if (genRuns.length > 1 && rate > 0 && rate < 1) variance.push(s.id)
    // A task that has run BOTH ways in the window has drifted into the catalog — its future runs
    // stop measuring generation, so the gen sample silently stops growing.
    if (runs.length > genRuns.length && genRuns.length > 0) drifted.push(s.id)
    const tag = genRuns.length === 0 ? 'catalog-only (NO gen signal)'
      : genRuns.length < 2 ? 'n=1 (UNPROVEN)'
      : rate === 1 ? 'reliable' : rate === 0 ? 'reliably RED' : 'VARIANCE'
    // Median wall clock over the same gen runs, with the censored count, so "reliable" is always
    // read next to what it cost. A task can hold 3/3 green while tripling in wall time.
    const genMs = genRuns.map(r => r.tasks[s.id].ms).filter((m): m is number => typeof m === 'number').sort((a, b) => a - b)
    const capped = genRuns.filter(r => r.tasks[s.id].to).length
    const msCol = genMs.length ? `  med ${(genMs[Math.floor((genMs.length - 1) / 2)] / 1000).toFixed(0)}s${capped ? ` (${capped} at cap)` : ''}` : ''
    console.log(`  ${s.id.padEnd(18)} ${greens}/${genRuns.length} green over gen runs (${runs.length} total)  ${isGen ? 'gen    ' : 'catalog'}  ${tag}${msCol}`)
  }
  // Wall-clock drift against the ledger, the mirror of the pass-rate check above.
  const slower: string[] = []
  for (const s of scores) {
    if (s.synthPath !== 'generated') continue
    const priorMs = window.slice(0, -1).filter(r => r.tasks[s.id]?.gen)
      .map(r => r.tasks[s.id].ms).filter((m): m is number => typeof m === 'number').sort((a, b) => a - b)
    if (priorMs.length < 2) continue
    const med = priorMs[Math.floor((priorMs.length - 1) / 2)]
    if (med > 0 && s.elapsedMs > med * 1.5 && s.elapsedMs - med > 60_000) {
      slower.push(`${s.id} ${(med / 1000).toFixed(0)}s→${(s.elapsedMs / 1000).toFixed(0)}s`)
    }
  }
  if (slower.length) console.log(`\n  ⚠ WALL-CLOCK DRIFT vs the ledger median (>1.5× and >60s slower): ${slower.join(', ')}`)
  if (drifted.length) {
    console.log(`\n  ⚠ CATALOG DRIFT — these ran BOTH gen and catalog inside the window: ${drifted.join(', ')}`)
    console.log(`    Their solutions were promoted into skills/_learned/, so later runs are memorized lookups,`)
    console.log(`    not generation. Repeat-running to build confidence INFLATES the number unless gen runs are`)
    console.log(`    isolated (as above). To re-measure real capability, clear the learned entry for the task.`)
  }
  if (window.length < 2) {
    console.log(`\n  ⚠ Only ${window.length} run in the ledger — every rate above is n=1 and proves nothing about reliability.`)
    console.log(`    Re-run the suite to start separating real capability from variance.`)
  } else {
    // The "reliable floor" the ROADMAP has been estimating by hand, now computed: gen tasks green
    // in EVERY windowed run that exercised them. This is the number that should be quoted as
    // capability, because the headline passedHard can be inflated by a lucky run.
    console.log(`\n  Reliable gen-path floor (green in ALL ${window.length} windowed runs): ${reliableGen}/${genTracked}`)
    console.log(`  Headline gen-path this run: ${genPassed}/${genScores.length}${reliableGen < genPassed ? '  ← headline exceeds the reliable floor; the difference is variance, not capability' : ''}`)
    if (variance.length) console.log(`  VARIANCE tasks (green some runs, red others): ${variance.join(', ')}`)
  }

  // Regression = a task that previously passed a HARD check now fails it.
  const regressions: string[] = []
  for (const s of scores) {
    const p = prev[s.id]; if (!p) continue
    if (p.compiled && !s.compiled) regressions.push(`${s.id}: compile regressed`)
    if (p.hiddenPassed && !s.hiddenPassed) regressions.push(`${s.id}: hidden suite regressed`)
  }
  if (regressions.length) {
    console.error('\nREGRESSION DETECTED — a previously-green check went red:')
    for (const r of regressions) console.error(`  - ${r}`)
    process.exit(1)
  }
  if (Object.keys(prev).length === 0) console.log('\n(First run — baseline recorded. Re-run after each change to track the delta.)')
  else console.log('\nNo regressions vs the previous scorecard.')
  process.exit(0)
}

main().catch(e => { console.error('coding harness crashed:', e?.stack ?? e); process.exit(3) })
