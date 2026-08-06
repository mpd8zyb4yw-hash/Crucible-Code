// External integrations registry — the drawer of locally-executed open-source
// agentic tools (GitHub CLI first) the agent can call alongside its built-ins.
//
// EXTERNAL-TOOL INVARIANT (ROADMAP, 2026-07-04): a locally-executed open-source
// tool (npm package, binary, WASM, subprocess) is in-bounds; anything that is
// itself a hosted API dependency — including "free tier" hosted services — is
// out-of-bounds, because metered/rate-limited dependencies violate
// model-cost-independence. `gh` is in-bounds under this rule: the binary is
// local open-source tooling and its network calls are the USER's authenticated
// GitHub traffic (their own account, their own rate budget), not model-inference
// quota the pipeline depends on.
//
// Two ways an integration reaches the agent:
//   1. The user enables it in the Integrations drawer (manual add for custom CLIs).
//   2. The recommender (deterministic keyword match, optionally sharpened by the
//      LOCAL Apple FM — zero external calls) surfaces detected-but-disabled tools
//      that look relevant to the current request; the user approves from the drawer.
// Enablement is always a HUMAN decision — the model recommends, it never self-enables.

import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'

export interface IntegrationEntry {
  id: string
  name: string
  description: string
  /** Only 'cli' for now — locally-executed binaries, per the external-tool invariant. */
  kind: 'cli'
  /** Bare binary name (no args, no shell metachars) resolved via PATH. */
  command: string
  homepage?: string
  builtin: boolean
  enabled: boolean
  /** Keywords the recommender matches against a request (word-boundary, case-insensitive). */
  keywords: string[]
  addedAt: number
  addedBy: 'builtin' | 'user' | 'model'
}

/** IntegrationEntry + runtime detection state (never persisted). */
export interface IntegrationStatus extends IntegrationEntry {
  detected: boolean
  version: string | null
}

export interface IntegrationRecommendation {
  id: string
  name: string
  detected: boolean
  enabled: boolean
  /** Why this tool looks relevant to the request — shown verbatim in the drawer. */
  reason: string
  /** 'fm' when the local Apple FM confirmed/added it, 'heuristic' otherwise. */
  source: 'heuristic' | 'fm'
}

// ── Builtin catalog ───────────────────────────────────────────────────────────
// Hand-picked, all free open-source locally-executed CLIs. Deliberately small:
// the ROADMAP defers any auto-discovery registry until hand-picked tools prove
// the wrapper pattern. GitHub (gh) is the flagship; the rest are common
// agentic-coding force multipliers the recommender can suggest per request.

const BUILTINS: Omit<IntegrationEntry, 'enabled' | 'addedAt'>[] = [
  {
    id: 'github', name: 'GitHub CLI', kind: 'cli', command: 'gh', builtin: true, addedBy: 'builtin',
    homepage: 'https://cli.github.com',
    description: 'Work with GitHub from the agent: PRs, issues, repos, releases, Actions runs. Read-only queries run freely; anything that writes to GitHub requires your explicit approval per action.',
    keywords: ['github', 'pr', 'pull request', 'issue', 'repo', 'repository', 'release', 'fork', 'clone', 'merge', 'branch', 'ci', 'actions', 'workflow', 'review'],
  },
  {
    id: 'ripgrep', name: 'ripgrep', kind: 'cli', command: 'rg', builtin: true, addedBy: 'builtin',
    homepage: 'https://github.com/BurntSushi/ripgrep',
    description: 'Very fast recursive code search. Lets the agent locate symbols, usages, and patterns across large repos far faster than shell grep.',
    keywords: ['search', 'find', 'grep', 'usages', 'references', 'where is', 'locate', 'occurrences'],
  },
  {
    id: 'jq', name: 'jq', kind: 'cli', command: 'jq', builtin: true, addedBy: 'builtin',
    homepage: 'https://jqlang.github.io/jq',
    description: 'Command-line JSON processor. Lets the agent slice, filter, and transform JSON files and command output deterministically instead of parsing by eye.',
    keywords: ['json', 'parse', 'jq', 'transform', 'filter json', 'api response'],
  },
  {
    id: 'semgrep', name: 'Semgrep', kind: 'cli', command: 'semgrep', builtin: true, addedBy: 'builtin',
    homepage: 'https://semgrep.dev',
    description: 'Open-source static analysis (runs fully locally with --config auto disabled; use local rule packs). Lets the agent scan for bug patterns and security issues as a verification critic.',
    keywords: ['security', 'vulnerability', 'static analysis', 'lint', 'audit', 'scan', 'cwe', 'injection'],
  },
]

// ── Persistence ───────────────────────────────────────────────────────────────
// Machine-level (a CLI is installed once per machine, not per project) →
// ~/.crucible/integrations.json, next to world.md (see state/session.ts).

function storeFile(): string {
  return path.join(process.env.HOME ?? '~', '.crucible', 'integrations.json')
}

interface Store { entries: IntegrationEntry[] }

function loadStore(): Store {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf-8')) as Store
    if (Array.isArray(raw.entries)) return raw
  } catch { /* first run / corrupt → reseed below */ }
  return { entries: [] }
}

function saveStore(store: Store): void {
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true })
  fs.writeFileSync(storeFile(), JSON.stringify(store, null, 2), 'utf-8')
}

/** Merge builtins into the persisted store (idempotent — user edits/toggles win). */
function withBuiltins(store: Store): Store {
  const have = new Set(store.entries.map(e => e.id))
  for (const b of BUILTINS) {
    if (!have.has(b.id)) store.entries.push({ ...b, enabled: false, addedAt: Date.now() })
  }
  return store
}

// ── Detection ─────────────────────────────────────────────────────────────────
// `which` + a best-effort --version, cached briefly so drawer polls stay cheap.

const detectCache = new Map<string, { at: number; detected: boolean; version: string | null }>()
const DETECT_TTL_MS = 60_000

function execOut(cmd: string, args: string[], timeoutMs = 4000): Promise<string | null> {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => resolve(err ? null : stdout.toString()))
  })
}

export async function detectIntegration(command: string): Promise<{ detected: boolean; version: string | null }> {
  const hit = detectCache.get(command)
  if (hit && Date.now() - hit.at < DETECT_TTL_MS) return hit
  const found = await execOut('which', [command])
  let version: string | null = null
  if (found) {
    const v = await execOut(command, ['--version'])
    version = v ? (v.split('\n')[0] ?? '').trim().slice(0, 80) || null : null
  }
  const result = { at: Date.now(), detected: !!found, version }
  detectCache.set(command, result)
  return result
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function listIntegrations(): Promise<IntegrationStatus[]> {
  const store = withBuiltins(loadStore())
  saveStore(store)
  return Promise.all(store.entries.map(async e => {
    const d = await detectIntegration(e.command)
    return { ...e, detected: d.detected, version: d.version }
  }))
}

export function isIntegrationEnabled(id: string): boolean {
  return withBuiltins(loadStore()).entries.some(e => e.id === id && e.enabled)
}

export function setIntegrationEnabled(id: string, enabled: boolean): IntegrationEntry | null {
  const store = withBuiltins(loadStore())
  const entry = store.entries.find(e => e.id === id)
  if (!entry) return null
  entry.enabled = enabled
  saveStore(store)
  return entry
}

// Bare binary names only — a custom integration is a PATH-resolved executable,
// never a shell string, so there is no quoting/injection surface here. (Executing
// it at all is the same trust level as the existing `run` tool: the agent already
// has shell access; see dynamicTools.ts for the identical rationale.)
const VALID_COMMAND = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const VALID_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export async function addCustomIntegration(input: {
  name: string; command: string; description?: string; keywords?: string[]; addedBy?: 'user' | 'model'
}): Promise<{ ok: true; entry: IntegrationStatus } | { ok: false; error: string }> {
  const name = (input.name ?? '').trim()
  const command = (input.command ?? '').trim()
  if (!name) return { ok: false, error: 'Name is required.' }
  if (!VALID_COMMAND.test(command)) {
    return { ok: false, error: 'Command must be a bare binary name (letters, digits, . _ -), no arguments or shell syntax.' }
  }
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  if (!VALID_ID.test(id)) return { ok: false, error: 'Name must contain at least one letter or digit.' }
  const store = withBuiltins(loadStore())
  if (store.entries.some(e => e.id === id || e.command === command)) {
    return { ok: false, error: `An integration with that ${store.entries.some(e => e.id === id) ? 'name' : 'command'} already exists.` }
  }
  const entry: IntegrationEntry = {
    id, name, command, kind: 'cli', builtin: false,
    description: (input.description ?? '').trim() || `Custom CLI tool (${command}).`,
    keywords: (input.keywords ?? []).map(k => k.trim().toLowerCase()).filter(Boolean),
    enabled: false,   // added ≠ enabled — enabling stays an explicit human step
    addedAt: Date.now(),
    addedBy: input.addedBy ?? 'user',
  }
  store.entries.push(entry)
  saveStore(store)
  const d = await detectIntegration(command)
  return { ok: true, entry: { ...entry, detected: d.detected, version: d.version } }
}

export function removeIntegration(id: string): boolean {
  const store = withBuiltins(loadStore())
  const idx = store.entries.findIndex(e => e.id === id && !e.builtin)  // builtins can be disabled, not removed
  if (idx === -1) return false
  store.entries.splice(idx, 1)
  saveStore(store)
  return true
}

// ── Recommender ───────────────────────────────────────────────────────────────
// Deterministic keyword scoring first (offline, zero inference — the philosophy
// is to never spend model budget on what plain code can do), then an OPTIONAL
// local-FM refinement pass that can add catalog picks the keywords missed. The
// FM is advisory only: its output is validated against the catalog, and on any
// failure (daemon down, unparseable reply) the heuristic result stands alone.

function wordHit(text: string, kw: string): boolean {
  const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(text)
}

export async function recommendIntegrations(
  goal: string,
  complete?: (messages: Array<{ role: string; content: string }>) => Promise<string>,
): Promise<IntegrationRecommendation[]> {
  const text = (goal ?? '').slice(0, 4000)
  if (!text.trim()) return []
  const all = await listIntegrations()
  const recs = new Map<string, IntegrationRecommendation>()

  for (const e of all) {
    const hits = e.keywords.filter(k => wordHit(text, k))
    if (hits.length === 0) continue
    recs.set(e.id, {
      id: e.id, name: e.name, detected: e.detected, enabled: e.enabled,
      reason: `Request mentions ${hits.slice(0, 3).map(h => `"${h}"`).join(', ')} — ${e.name} handles this directly.`,
      source: 'heuristic',
    })
  }

  if (complete) {
    try {
      const catalog = all.map(e => `${e.id}: ${e.description.split('.')[0]}`).join('\n')
      const raw = await complete([
        { role: 'system', content: 'You match a coding request to helper tools. Reply with ONLY a JSON array of tool ids from the catalog that would genuinely help this request, best first, max 3. Reply [] if none apply. No prose.' },
        { role: 'user', content: `Catalog:\n${catalog}\n\nRequest: ${text.slice(0, 800)}` },
      ])
      const match = raw.match(/\[[\s\S]*?\]/)
      if (match) {
        const ids = JSON.parse(match[0]) as unknown[]
        for (const id of ids) {
          if (typeof id !== 'string') continue
          const e = all.find(x => x.id === id)
          if (!e) continue   // FM invented an id — ignore
          const existing = recs.get(id)
          if (existing) existing.source = 'fm'   // keyword + FM agreement → keep richer reason
          else recs.set(id, {
            id: e.id, name: e.name, detected: e.detected, enabled: e.enabled,
            reason: `The local model judged ${e.name} relevant to this request.`,
            source: 'fm',
          })
        }
      }
    } catch { /* FM is advisory — heuristic result stands */ }
  }

  // Already-enabled tools are working, not news — surface them last.
  return [...recs.values()].sort((a, b) => Number(a.enabled) - Number(b.enabled))
}
