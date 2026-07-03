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
]

// ── SSE fire: send the task to the live agent, collect the outcome ─────────────────
interface FireResult {
  done: boolean; finalText: string; agentError: string | null
  iters: number; selfTestPassed: boolean | null; events: number; elapsedMs: number
  // 'catalog'  — server matched a proven skill-catalog primitive, zero model inference.
  // 'generated' — no catalog match; the task actually stressed the FM/model generation path.
  // A task can only ever be a valid signal on generative capability when this is 'generated' —
  // 'catalog' GREENs prove catalog coverage, not the offline agent's ability to write new code.
  synthPath: 'catalog' | 'generated' | null
}
async function fireTask(task: Task, dir: string, token: string): Promise<FireResult> {
  const t0 = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PER_TASK_TIMEOUT_MS)
  let done = false, finalText = '', agentError: string | null = null
  let iters = 0, events = 0, selfTestPassed: boolean | null = null
  let synthPath: 'catalog' | 'generated' | null = null
  try {
    const res = await fetch(`${API}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': `crucible_session=${token}` },
      body: JSON.stringify({ message: task.prompt, mode: 'agent', device: 'desktop', projectPath: dir, agentMode: true }),
      signal: ctrl.signal,
    })
    if (!res.ok) { agentError = `HTTP ${res.status}`; return { done, finalText, agentError, iters, selfTestPassed, events, elapsedMs: Date.now() - t0 } }
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
          if (ev.type === 'synth_match') synthPath = 'catalog'
          if (ev.type === 'synth_miss') synthPath = 'generated'
        } catch { /* keepalive / non-JSON */ }
      }
    }
  } catch (e: any) {
    if (e?.name !== 'AbortError') agentError = String(e?.message ?? e).slice(0, 200)
    else agentError = `timeout after ${(PER_TASK_TIMEOUT_MS / 1000).toFixed(0)}s`
  } finally { clearTimeout(timer) }
  return { done, finalText, agentError, iters, selfTestPassed, events, elapsedMs: Date.now() - t0, synthPath }
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
  synthPath: 'catalog' | 'generated' | null
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
async function liveOfflineMode(token: string): Promise<string> {
  const res = await fetch(`${API}/api/config`, { signal: AbortSignal.timeout(4000), headers: { 'Cookie': `crucible_session=${token}` } })
  const cfg = await res.json() as { offlineMode?: string }
  return cfg.offlineMode ?? '1'
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
  const liveMode = await liveOfflineMode(token)
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

  const prev = loadPrevious()
  const scores: TaskScore[] = []
  // Pace between tasks so a multi-task cert doesn't exhaust the free-tier rate limits
  // (running hard coding tasks back-to-back trips every circuit; the next task then sees
  // an empty pool). A gap lets the 60s cooldowns recover. Tunable / 0 to disable.
  const GAP_MS = Number(process.env.CRUCIBLE_CODE_BENCH_GAP ?? 45_000)

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
      synthPath: fire.synthPath, ...audit,
    }
    scores.push(score)
    console.log(`  [HARD] module exists : ${audit.moduleExists ? 'PASS' : 'FAIL'}`)
    console.log(`  [HARD] compiles clean: ${audit.compiled ? 'PASS' : 'FAIL'}  :: ${audit.compileDetail}`)
    console.log(`  [HARD] hidden suite  : ${audit.hiddenPassed ? 'PASS' : 'FAIL'}  :: ${audit.hiddenDetail}`)
    console.log(`  [SOFT] self-test     : ${score.selfTestPassed === null ? 'n/a' : score.selfTestPassed ? 'PASS' : 'FAIL'}`)
    console.log(`  [SOFT] LLM rubric    : ${rubric === null ? 'n/a' : rubric + '/100'}`)
    console.log(`  [INFO] synth path    : ${fire.synthPath ?? 'unknown'}${fire.synthPath === 'catalog' ? ' — proven-skill match, zero model inference; not a generative-capability signal' : ''}`)
  }

  // ── scorecard + regression check ────────────────────────────────────────────────
  fs.mkdirSync(path.dirname(SCORECARD), { recursive: true })
  const passedHard = scores.filter(s => s.moduleExists && s.compiled && s.hiddenPassed).length
  fs.writeFileSync(SCORECARD, JSON.stringify({ ts: Date.now(), passedHard, total: scores.length, tasks: scores }, null, 2))

  console.log('\n=== SCORECARD ===')
  for (const s of scores) {
    const hard = s.moduleExists && s.compiled && s.hiddenPassed
    const path = s.synthPath === 'catalog' ? 'catalog' : s.synthPath === 'generated' ? 'gen' : '?'
    console.log(`  ${hard ? 'GREEN' : ' RED '}  ${s.id.padEnd(12)} compile=${s.compiled ? 'Y' : 'n'} hidden=${s.hiddenPassed ? 'Y' : 'n'} self=${s.selfTestPassed === null ? '-' : s.selfTestPassed ? 'Y' : 'n'} rubric=${s.rubric ?? '-'} path=${path.padEnd(7)} ${(s.elapsedMs / 1000).toFixed(0)}s`)
  }
  console.log(`\n  Claude-level (all HARD green): ${passedHard}/${scores.length} tasks`)
  // A 'catalog' GREEN proves proven-skill coverage, NOT that the offline agent can generate
  // new code — it never touched the model. Only 'generated' tasks stress real capability;
  // conflating the two is exactly what produced last session's misleading 4/5 "Claude-level"
  // read on filterModule's rate-limit investigation. Report them separately, always.
  const genScores = scores.filter(s => s.synthPath === 'generated')
  const genPassed = genScores.filter(s => s.moduleExists && s.compiled && s.hiddenPassed).length
  const catScores = scores.filter(s => s.synthPath === 'catalog')
  const catPassed = catScores.filter(s => s.moduleExists && s.compiled && s.hiddenPassed).length
  console.log(`    of which via catalog-primitive match (zero inference): ${catPassed}/${catScores.length} green`)
  console.log(`    of which via genuine model generation (real signal)  : ${genPassed}/${genScores.length} green`)
  if (genScores.length === 0) console.log(`    ⚠ no task in this run exercised genuine generation — the summary above says nothing about offline-agent coding capability`)

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
