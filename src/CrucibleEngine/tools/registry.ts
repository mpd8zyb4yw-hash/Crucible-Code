// Tool registry — single source of truth for every tool the agent can call.
// Sections 3+ register editing/shell tools here; section 1 ships read_file/list_dir.

import fs from 'fs'
import path from 'path'
import { spawn, execFile } from 'child_process'
import type { ToolCall, ToolCtx, ToolDef, ToolResult } from './protocol'
import { createCheckpoint, checkpointScopeFor } from '../checkpoint'
import { compileTool, saveDynamicTool, listDynamicTools, recordToolSuccess, type DynamicToolRecord } from './dynamicTools'
import { appendGlobalMemory } from '../state/session'
import { buildGraphDigest, findEntities, upsertEntity, touchEntities } from '../entityGraph'
import { gFetch, googleServicesStatus } from './googleApis'
import { getUITree, clickElement, typeText, navigateBrowser } from '../macTools'
import { runCapability, capabilityIntents } from '../agent/macCapabilities'
import { read_image, read_pdf } from './visionTools'
import { shimNodeAssert } from '../synth/assertShim'
// cont.118 — provider→entity adapters. These are the ONLY place provider shapes are known; every
// tool below returns `entities` alongside its prose so the UI and the model both get structure.
import {
  gmailMessages, calendarEvents, driveFiles, contacts as contactEntities, youtubeVideos,
  localFiles, webResults,
} from './adapters'
// The hardened fetcher (SSRF-guarded, redirect-capped, timeout-bounded) that `read_url` exposes.
import { fetch as retrievalFetch, stripBoilerplate } from '../retrieval/retrievalLayer'
import {
  findBrowser, readPage, pageToPdf, pageScreenshot, openSignInWindow,
  openWorkPage, actOnPage, closeWorkPage, listWorkPages, type PageAction,
} from './browser'
import { parkSignIn } from './signInSessions'
import { loadAutomations, saveAutomations, computeNextRun, describeTrigger, AUTOMATIONS_FILE } from '../automations/store'
import { parseTrigger } from '../automations/parseTrigger'
import { deriveView } from './viewDerivation'
import type { Entity } from './entities'

const tools = new Map<string, ToolDef>()

/**
 * The derived surface for a tool result, or undefined when the tool returned only prose.
 *
 * Kept to a single helper so there is exactly ONE answer to "when does a result get an interface",
 * and it is the same answer on every transport. A tool that emits no entities is untouched and
 * still renders as text, which is why this is safe to run on every call.
 */
function viewFor(result: ToolResult, args?: Record<string, unknown>) {
  if (!result.entities?.length) return undefined
  // `query` only ever feeds the empty-state copy, but it is threaded anyway so a future empty view
  // built here reads identically to one built at a call site that had the args in hand.
  const query = typeof args?.query === 'string' ? args.query : undefined
  return deriveView(result.entities as Entity[], query ? { query } : {})
}

// Checkpoint before file mutations, at most once per minute per project.
const FILE_MUTATORS = new Set(['write_file', 'edit_file', 'apply_patch'])
const lastCheckpoint = new Map<string, number>()
function checkpointBeforeMutation(toolName: string, ctx: ToolCtx, args?: Record<string, unknown>) {
  if (!FILE_MUTATORS.has(toolName)) return
  const now = Date.now()
  if (now - (lastCheckpoint.get(ctx.projectPath) ?? 0) < 60_000) return
  lastCheckpoint.set(ctx.projectPath, now)
  // Scope the snapshot to the file being mutated. Unscoped, the checkpoint's `git add -A`
  // commits every unrelated dirty file in the tree under a "pre-<tool>" message — which on
  // 2026-07-21 merged two concurrent agent sessions' work into single meaningless commits.
  const target = typeof args?.path === 'string' ? args.path
    : typeof args?.file_path === 'string' ? args.file_path
    : undefined
  // Only paths INSIDE the project can be staged; write_file legitimately targets Desktop and
  // other whitelisted roots, and `git add` on those would fail (or worse, hit another repo).
  // A known-but-external target passes [] — "snapshot nothing" — rather than undefined, which
  // would fall back to staging the whole tree for a write that does not touch this repo at all.
  // Containment is decided by checkpointScopeFor: the old test here treated every ABSOLUTE path
  // as external, so an in-project absolute write silently got no snapshot at all.
  const scope = checkpointScopeFor(ctx.projectPath, target)
  try {
    createCheckpoint(ctx.projectPath, `pre-${toolName}`, scope)
  } catch { /* non-fatal */ }
}

export const registry = {
  register(def: ToolDef) {
    tools.set(def.name, def)
  },
  list(): ToolDef[] {
    return [...tools.values()]
  },
  get(name: string): ToolDef | undefined {
    return tools.get(name)
  },
  async exec(call: ToolCall, ctx: ToolCtx): Promise<ToolResult> {
    // INVARIANT: exactly one `tool_call` and exactly one `tool_result` per exec(), on every path.
    // The three rejection paths below used to return BEFORE any emit, so a call the registry
    // refused (unknown tool, blocked mutation, already aborted) produced no UI event at all and
    // simply vanished from the agent panel — the run looked like it had stalled rather than
    // declined. Callers are entitled to assume the event stream accounts for every call they make,
    // so the `tool_call` is emitted first and each rejection reports itself through `refuse`.
    ctx.emit?.({ type: 'tool_call', id: call.id, tool: call.name, args: call.args })
    const refuse = (output: string): ToolResult => {
      ctx.emit?.({ type: 'tool_result', id: call.id, tool: call.name, ok: false, output })
      return { ok: false, output }
    }
    const def = tools.get(call.name)
    if (!def) return refuse(`Unknown tool: ${call.name}. Available: ${[...tools.keys()].join(', ')}`)
    if (def.mutates && ctx.allowMutation === false) {
      return refuse(`Tool ${call.name} mutates state and is not permitted in this context.`)
    }
    if (ctx.signal?.aborted) return refuse('Cancelled.')
    checkpointBeforeMutation(call.name, ctx, call.args as Record<string, unknown> | undefined)
    try {
      const result = await def.run(call.args, ctx)
      // cont.118 — the derived surface is attached HERE, at the one choke point every caller goes
      // through, rather than at any individual send() site. It was previously attached only in the
      // named-tool branch of /api/chat, which meant AGENT MODE — the mode whose whole UI is this
      // tool stream — could never receive a view at all: the agent loop's only tool_result is the
      // one emitted on this line. Deriving it here gives every current and future emit path the
      // surface for free, which is the same "universal, not per-integration" rule the entity
      // protocol itself is built on. `deriveView` is pure, so this costs no model call.
      ctx.emit?.({
        type: 'tool_result', id: call.id, tool: call.name, ok: result.ok,
        output: result.output.slice(0, 2000), truncated: result.truncated ?? false,
        view: viewFor(result, call.args),
      })
      return result
    } catch (e: any) {
      const result = { ok: false, output: `Tool ${call.name} threw: ${e?.message ?? e}` }
      ctx.emit?.({ type: 'tool_result', id: call.id, tool: call.name, ok: false, output: result.output })
      return result
    }
  },
}

// ── Path safety ───────────────────────────────────────────────────────────────

// Safe output locations outside the project root
const WHITELISTED_ROOTS = [
  path.join(process.env.HOME ?? '/tmp', 'Desktop'),
  path.join(process.env.HOME ?? '/tmp', 'Downloads'),
  path.join(process.env.HOME ?? '/tmp', 'Documents'),
]

/** Resolve p against projectPath; throw if it escapes the project root or whitelist. */
export function resolveSafe(p: string, ctx: ToolCtx, { allowOutside = false } = {}): string {
  if (!p || typeof p !== 'string' || !p.trim()) {
    throw new Error('A non-empty "path" argument is required.')
  }
  // Expand a leading ~ to the user's home dir so file tools agree with the shell.
  // The `run` tool executes via zsh, which expands ~; without this, "~/Desktop/x"
  // resolves to "<projectRoot>/~/Desktop/x" and write_file/run disagree on the
  // file's actual location (the "No such file or directory" cascade).
  let raw = p.trim()
  const home = process.env.HOME
  if (home && (raw === '~' || raw.startsWith('~/'))) raw = home + raw.slice(1)
  const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(ctx.projectPath, raw)
  if (!allowOutside) {
    const root = path.resolve(ctx.projectPath) + path.sep
    if (!(abs + path.sep).startsWith(root)) {
      throw new Error(`Path ${p} is outside the project root (${ctx.projectPath})`)
    }
  } else {
    // allowOutside: permit project root AND whitelisted user folders only
    const root = path.resolve(ctx.projectPath) + path.sep
    const inProject = (abs + path.sep).startsWith(root)
    const inWhitelist = WHITELISTED_ROOTS.some(w => (abs + path.sep).startsWith(w + path.sep))
    if (!inProject && !inWhitelist) {
      throw new Error(`Path ${p} is outside permitted locations. Allowed: project folder, Desktop, Downloads, Documents.`)
    }
  }
  return abs
}

// ── Destructive-command guard (Section 8 — destructive op confirmation) ───────
// In autonomous server-side mode there is no interactive confirm channel, so the safe
// default is to BLOCK clearly-destructive shell commands and tell the agent to surface
// them to the user. Set ctx.allowDestructive = true to opt in (e.g. an approved task).
const DESTRUCTIVE_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\b[^\n]*\s-\w*[rf]/i,                  why: 'recursive/forced delete (rm -rf)' },
  { re: /\bgit\s+push\b[^\n]*(?:--force|--force-with-lease|\s-f\b)/i, why: 'git force-push' },
  { re: /\bgit\s+reset\s+--hard\b/i,                why: 'git reset --hard (discards work)' },
  { re: /\bgit\s+clean\s+-\w*f/i,                   why: 'git clean -f (deletes untracked files)' },
  { re: /\bgit\s+checkout\s+(?:--\s|\.\s*$|-- \.)/i, why: 'git checkout -- (discards changes)' },
  { re: /\b(?:mkfs|fdisk|dd)\b/i,                   why: 'disk-level write' },
  { re: /\bchmod\s+-R\b|\bchown\s+-R\b/i,           why: 'recursive permission/ownership change' },
  { re: /\bsudo\b/i,                                why: 'privilege escalation (sudo)' },
  { re: /\b(?:shutdown|reboot|halt|poweroff)\b/i,   why: 'system power control' },
  { re: />\s*\/dev\/(?:sd|disk|null\/)/i,           why: 'write to a device node' },
  { re: /:\s*\(\s*\)\s*\{.*\|.*&\s*\}\s*;/,         why: 'fork bomb' },
  { re: /\bgit\s+branch\s+-D\b/i,                   why: 'force-delete a git branch' },
]

/** Returns the reason a command is destructive, or null if it's safe to run. */
export function destructiveReason(command: string): string | null {
  for (const { re, why } of DESTRUCTIVE_PATTERNS) if (re.test(command)) return why
  return null
}

// A dynamically create_tool'd tool body is arbitrary JS, not a shell command string, so
// DESTRUCTIVE_PATTERNS (which matches shell syntax like `rm -rf`) never sees it — a real,
// documented gap in stakesRouter.ts's scope (create_tool bypasses IRREVERSIBLE_TOOLS/'run'
// entirely). Found + closed 2026-07-06: scan the body source for native destructive-fs and
// shell-out APIs. Deliberately coarse (flags "calls an fs delete/overwrite API" or "shells
// out to an opaque command" rather than trying to fully interpret the JS) — a tool body
// that shells out CAN construct any command from args at runtime, so no static string scan
// can fully vet it; flagging the capability itself, once, at creation time (a one-way door:
// this tool persists to disk and reloads on every future server start) is the honest
// deterministic signal available, not a false promise of full analysis.
const DESTRUCTIVE_TOOL_BODY_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\bfs(?:\.promises)?\.(?:rmSync|rmdirSync|unlinkSync|rm|rmdir|unlink)\b/, why: 'deletes files/folders via the fs API' },
  { re: /\b(?:child_process\b[^\n]*\.)?(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(/, why: 'shells out to an arbitrary command constructed at runtime' },
  { re: /\bfs(?:\.promises)?\.(?:writeFileSync|writeFile)\b/, why: 'overwrites files via the fs API' },
];

/** Returns the reason a dynamic tool BODY (arbitrary JS, from create_tool) is destructive,
 *  or null if none of the coarse native-API patterns match. */
export function destructiveToolBodyReason(body: string): string | null {
  for (const { re, why } of DESTRUCTIVE_TOOL_BODY_PATTERNS) if (re.test(body)) return why
  return null
}

// ── Protected-file guard ───────────────────────────────────────────────────────
// write_file blindly replaces a file's full content with no read-back check (unlike
// edit_file/apply_patch, which must match existing content first) — that makes it the one
// tool that can silently destroy an existing, correct file the agent only meant to leave
// alone. A "do not modify" / "read-only" marker on the file's first line is a convention
// already used for existing/scaffolded code; enforce it here at the tool layer instead of
// relying on the model to honor a natural-language instruction in the prompt or a comment.
const PROTECTED_MARKER_RE = /\b(?:do not modify|do not edit|don'?t modify|don'?t edit|read-?only)\b/i
function protectedFileReason(existingContent: string): string | null {
  const firstLine = existingContent.slice(0, 200).split('\n', 1)[0]
  return PROTECTED_MARKER_RE.test(firstLine) ? firstLine.trim() : null
}

const MAX_OUTPUT_CHARS = 24_000

/** Read a file for mutation tools, returning a clean error (never throwing EISDIR/ENOENT). */
function readFileChecked(abs: string): { ok: true; content: string } | { ok: false; output: string } {
  if (!fs.existsSync(abs)) return { ok: false, output: `File not found: ${abs}. Create it with write_file first.` }
  if (fs.statSync(abs).isDirectory()) return { ok: false, output: `${abs} is a directory, not a file. Pass a file path.` }
  return { ok: true, content: fs.readFileSync(abs, 'utf-8') }
}

export function capOutput(s: string, max = MAX_OUTPUT_CHARS): { output: string; truncated: boolean } {
  if (s.length <= max) return { output: s, truncated: false }
  return { output: s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`, truncated: true }
}

// ── Tiny inline unified-diff patcher (no deps) ───────────────────────────────
// Locates each hunk by its context+deletion lines (exact match scan from the
// hunk's declared position outward), so stale line numbers still apply.
export function applyUnifiedPatch(text: string, patch: string): { ok: boolean; text?: string; hunks?: number; error?: string } {
  const lines = text.split('\n')
  // Strip Codex-style envelope lines ("*** Begin Patch", "*** Update File: …",
  // "*** End Patch", "*** Add/Delete File: …") that codex-trained models such as
  // GPT-OSS wrap their hunks in. They aren't part of the diff body.
  const patchLines = patch.split('\n').filter(l => !/^\*\*\*\s/.test(l.trimStart()))
  let hunks = 0
  let i = 0
  // If a model emitted +/- lines with no @@ header at all, treat the whole body as
  // one implicit hunk located by its context lines.
  if (!patchLines.some(l => l.startsWith('@@'))) patchLines.unshift('@@ @@')
  while (i < patchLines.length) {
    // Accept BOTH unified headers ("@@ -a,b +c,d @@") and bare/context Codex headers
    // ("@@" or "@@ functionName"). Line numbers are used as a hint when present; the
    // hunk is always located by context scan (findBlock), so a bare @@ still applies.
    if (!patchLines[i].startsWith('@@')) { i++; continue }
    const header = patchLines[i].match(/^@@\s*-(\d+)/)
    const declaredStart = header ? parseInt(header[1], 10) - 1 : 0
    const oldBlock: string[] = []
    const newBlock: string[] = []
    i++
    while (i < patchLines.length && !patchLines[i].startsWith('@@')) {
      const l = patchLines[i]
      if (l.startsWith('-')) oldBlock.push(l.slice(1))
      else if (l.startsWith('+')) newBlock.push(l.slice(1))
      else if (l.startsWith(' ') || l === '') { oldBlock.push(l.slice(1)); newBlock.push(l.slice(1)) }
      else if (l.startsWith('\\')) { /* "\ No newline" — ignore */ }
      else break
      i++
    }
    if (oldBlock.length === 0 && newBlock.length === 0) continue
    const pos = findBlock(lines, oldBlock, declaredStart)
    if (pos === -1) return { ok: false, error: `Hunk ${hunks + 1} context not found:\n${oldBlock.slice(0, 5).join('\n')}` }
    lines.splice(pos, oldBlock.length, ...newBlock)
    hunks++
  }
  if (hunks === 0) return { ok: false, error: 'No @@ hunks found in patch.' }
  return { ok: true, text: lines.join('\n'), hunks }
}

/** Exact block match scanning outward from the declared position. */
function findBlock(lines: string[], block: string[], near: number): number {
  const matches = (at: number) => block.every((b, j) => lines[at + j] === b)
  const limit = lines.length - block.length
  if (near >= 0 && near <= limit && matches(near)) return near
  for (let d = 1; d <= Math.max(near, limit - near); d++) {
    if (near - d >= 0 && matches(near - d)) return near - d
    if (near + d <= limit && matches(near + d)) return near + d
  }
  return -1
}

// ── Search backends ───────────────────────────────────────────────────────────
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'release', 'server-dist', '.crucible', '.vite', 'app'])
const BINARY_EXT = /\.(png|jpe?g|gif|ico|woff2?|ttf|eot|mp4|mov|zip|gz|pdf|lock)$/i

function searchRipgrep(pattern: string, dir: string, max: number): Promise<string[] | null> {
  return new Promise(resolve => {
    const child = spawn('rg', ['-n', '--no-heading', '-m', String(max), '-e', pattern, '.'], { cwd: dir })
    let out = '', failed = false
    child.on('error', () => { failed = true; resolve(null) })  // rg not installed
    child.stdout.on('data', d => { if (out.length < 200_000) out += d.toString() })
    child.on('close', code => {
      if (failed) return
      if (code !== 0 && code !== 1) return resolve(null)       // 1 = no matches
      resolve(out.split('\n').filter(Boolean).slice(0, max))
    })
  })
}

function searchJSWalk(pattern: string, dir: string, max: number): string[] | null {
  let re: RegExp
  try { re = new RegExp(pattern) } catch { return null }
  const results: string[] = []
  const walk = (d: string) => {
    if (results.length >= max) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (results.length >= max) return
      const full = path.join(d, e.name)
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(full); continue }
      if (BINARY_EXT.test(e.name)) continue
      let content: string
      try { if (fs.statSync(full).size > 1_000_000) continue; content = fs.readFileSync(full, 'utf-8') } catch { continue }
      content.split('\n').forEach((line, idx) => {
        if (results.length < max && re.test(line)) results.push(`${path.relative(dir, full)}:${idx + 1}:${line.slice(0, 300)}`)
      })
    }
  }
  walk(dir)
  return results
}

// ── Built-in tools (section 1) ────────────────────────────────────────────────

registry.register({
  name: 'read_file',
  description: 'Read a file. Returns numbered lines. Supports offset/limit for large files.',
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (absolute, or relative to project root)' },
      offset: { type: 'number', description: '1-based line to start from' },
      limit: { type: 'number', description: 'Max lines to return' },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const abs = resolveSafe(String(args.path ?? ''), ctx, { allowOutside: true })
    if (!fs.existsSync(abs)) return { ok: false, output: `File not found: ${abs}` }
    const stat = fs.statSync(abs)
    if (stat.isDirectory()) return { ok: false, output: `${abs} is a directory — use list_dir.` }
    const lines = fs.readFileSync(abs, 'utf-8').split('\n')
    const offset = Math.max(1, Number(args.offset ?? 1))
    const limit = Math.min(Number(args.limit ?? 2000), 5000)
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join('\n')
    const { output, truncated } = capOutput(numbered)
    return { ok: true, output, truncated: truncated || offset - 1 + limit < lines.length, meta: { totalLines: lines.length } }
  },
})

registry.register({
  name: 'read_image',
  description:
    'Read an image (chart, screenshot, diagram, photo, scanned page) from a local file path OR ' +
    'a URL and get back a detailed description plus a verbatim transcription of any visible text. ' +
    'Use this instead of asking the user to describe or paste what an image contains.',
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Local image file path (absolute or relative to project root) OR an http(s) image URL' },
    },
    required: ['path'],
  },
  async run(args) {
    const target = String(args.path ?? '').trim()
    if (!target) return { ok: false, output: 'A non-empty "path" (file path or URL) is required.' }
    const output = await read_image(target)
    const ok = !output.startsWith('[read_image failed')
    const { output: capped, truncated } = capOutput(output)
    return { ok, output: capped, truncated }
  },
})

registry.register({
  name: 'read_pdf',
  description:
    'Read a PDF (paper, report, spec, scanned document) from a local file path OR a URL and get ' +
    'back its extracted text with structure preserved (headings, sections, lists, tables). ' +
    'Use this instead of asking the user to paste the contents of a PDF.',
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Local PDF file path (absolute or relative to project root) OR an http(s) PDF URL' },
    },
    required: ['path'],
  },
  async run(args) {
    const target = String(args.path ?? '').trim()
    if (!target) return { ok: false, output: 'A non-empty "path" (file path or URL) is required.' }
    const output = await read_pdf(target)
    const ok = !output.startsWith('[read_pdf failed')
    const { output: capped, truncated } = capOutput(output)
    return { ok, output: capped, truncated }
  },
})

registry.register({
  name: 'ask_user',
  description:
    'Ask the user ONE focused clarifying question — ONLY when you genuinely cannot proceed ' +
    'correctly without information that only the user has (a missing constraint, a real fork in ' +
    'intent, or confirmation before a destructive/irreversible action). Do NOT use this for ' +
    'things you can reasonably infer or decide yourself: prefer sensible defaults and proceed. ' +
    'Asking ends your turn; the user will reply and you continue with their answer.',
  params: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The single, specific question to ask the user.' },
    },
    required: ['question'],
  },
  // The agent loop intercepts ask_user to end the turn and surface the question. This
  // run() is only a fallback (e.g. if called outside the loop) — it echoes the question.
  async run(args, ctx) {
    const q = String(args.question ?? 'Could you clarify how you would like me to proceed?')
    try { ctx.emit?.({ type: 'clarification_request', question: q }) } catch {}
    return { ok: true, output: q }
  },
})

registry.register({
  name: 'write_file',
  description: 'Create or overwrite a file with the given content. Parent dirs are created.',
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (relative to project root or absolute within it)' },
      content: { type: 'string', description: 'Full file content' },
    },
    required: ['path', 'content'],
  },
  mutates: true,
  async run(args, ctx) {
    const abs = resolveSafe(String(args.path ?? ''), ctx, { allowOutside: true })
    if (fs.existsSync(abs) && !fs.statSync(abs).isDirectory()) {
      const reason = protectedFileReason(fs.readFileSync(abs, 'utf-8'))
      if (reason) return { ok: false, output: `Refusing to overwrite ${abs} — marked protected ("${reason}"). Write to a different path instead; this file must not change.` }
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    // Deterministic write-time repair: a generated TS/JS module that self-tests with node's
    // `assert` cannot compile in a project without @types/node — measured as the sole gen-path
    // RED (tagSetModule, 2026-07-26) on code whose logic was otherwise perfect. Swap the builtin
    // import for a behavior-preserving local shim. No-ops on every file that doesn't import it.
    let body = String(args.content ?? '')
    if (/\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(abs)) {
      try { body = shimNodeAssert(body) } catch { /* fail open — write the original content */ }
    }
    fs.writeFileSync(abs, body, 'utf-8')
    ctx.onFileMutated?.([abs])
    return { ok: true, output: `Wrote ${body.length} chars to ${abs}` }
  },
})

registry.register({
  name: 'edit_file',
  description: 'Surgical edit: replace an exact old string with a new string. The old string must appear exactly once in the file.',
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      old: { type: 'string', description: 'Exact text to replace (must be unique in the file)' },
      new: { type: 'string', description: 'Replacement text' },
    },
    required: ['path', 'old', 'new'],
  },
  mutates: true,
  async run(args, ctx) {
    const abs = resolveSafe(String(args.path ?? ''), ctx)
    const read = readFileChecked(abs)
    if (!read.ok) return read
    const protectedReason = protectedFileReason(read.content)
    if (protectedReason) return { ok: false, output: `Refusing to edit ${abs} — marked protected ("${protectedReason}"). This file must not change.` }
    const oldStr = String(args.old ?? ''), newStr = String(args.new ?? '')
    if (!oldStr) return { ok: false, output: 'old must be non-empty' }
    const content = read.content
    const first = content.indexOf(oldStr)
    if (first === -1) return { ok: false, output: `old string not found in ${abs}. Read the file and match exactly (including whitespace).` }
    if (content.indexOf(oldStr, first + 1) !== -1) return { ok: false, output: `old string appears more than once in ${abs} — include more surrounding context to make it unique.` }
    fs.writeFileSync(abs, content.slice(0, first) + newStr + content.slice(first + oldStr.length), 'utf-8')
    ctx.emit?.({ type: 'diff', path: abs, old: oldStr.slice(0, 1000), new: newStr.slice(0, 1000) })
    ctx.onFileMutated?.([abs])
    return { ok: true, output: `Edited ${abs} (replaced ${oldStr.length} chars with ${newStr.length}).` }
  },
})

registry.register({
  name: 'apply_patch',
  description: 'Apply a diff to a file (multi-hunk). Accepts both unified diffs (@@ -a,b +c,d @@) and the Codex apply_patch format (*** Begin Patch / @@ context / *** End Patch). Hunks are located by their context lines, so line numbers may be omitted or slightly off.',
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to patch' },
      patch: { type: 'string', description: 'Diff body: @@ hunk headers (line numbers optional) followed by context, -, and + lines. Codex *** Begin/End Patch envelopes are accepted and ignored.' },
    },
    required: ['path', 'patch'],
  },
  mutates: true,
  async run(args, ctx) {
    const abs = resolveSafe(String(args.path ?? ''), ctx)
    const read = readFileChecked(abs)
    if (!read.ok) return read
    const protectedReason = protectedFileReason(read.content)
    if (protectedReason) return { ok: false, output: `Refusing to patch ${abs} — marked protected ("${protectedReason}"). This file must not change.` }
    const patchBody = String(args.patch ?? '')
    if (!patchBody.trim()) return { ok: false, output: 'A non-empty "patch" argument (unified diff) is required.' }
    const result = applyUnifiedPatch(read.content, patchBody)
    if (!result.ok) return { ok: false, output: result.error! }
    fs.writeFileSync(abs, result.text!, 'utf-8')
    ctx.emit?.({ type: 'diff', path: abs, patch: String(args.patch).slice(0, 2000) })
    ctx.onFileMutated?.([abs])
    return { ok: true, output: `Patched ${abs}: ${result.hunks} hunk(s) applied.` }
  },
})

registry.register({
  name: 'search',
  description: 'Search file contents in the project for a pattern (regex). Returns file:line: matches.',
  params: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern' },
      dir: { type: 'string', description: 'Subdirectory to search (default: project root)' },
      maxResults: { type: 'number', description: 'Max matching lines (default 50)' },
    },
    required: ['pattern'],
  },
  async run(args, ctx) {
    const dir = resolveSafe(String(args.dir ?? '.'), ctx, { allowOutside: true })
    const maxResults = Math.min(Number(args.maxResults ?? 50), 200)
    const pattern = String(args.pattern ?? '')
    const viaRg = await searchRipgrep(pattern, dir, maxResults)
    const lines = viaRg ?? searchJSWalk(pattern, dir, maxResults)
    if (lines === null) return { ok: false, output: `Invalid regex: ${pattern}` }
    const { output, truncated } = capOutput(lines.join('\n') || '(no matches)')
    return { ok: true, output, truncated, meta: { count: lines.length } }
  },
})

registry.register({
  name: 'run',
  description: 'Run a shell command in the project root. Returns stdout/stderr and exit code. 30s timeout.',
  params: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      timeoutMs: { type: 'number', description: 'Timeout in ms (max 120000)' },
    },
    required: ['command'],
  },
  mutates: true,
  async run(args, ctx) {
    const command = String(args.command ?? '')
    const danger = destructiveReason(command)
    if (danger && ctx.allowDestructive !== true) {
      return {
        ok: false,
        output: `Blocked: this command looks destructive (${danger}). Destructive operations require explicit user approval. ` +
          `Do not retry — instead, stop and ask the user to confirm, or accomplish the goal a non-destructive way.`,
        meta: { blocked: 'destructive', reason: danger },
      }
    }
    const timeoutMs = Math.min(Number(args.timeoutMs ?? 30_000), 120_000)
    return new Promise<ToolResult>(resolve => {
      const child = spawn('/bin/zsh', ['-c', command], { cwd: ctx.projectPath, env: process.env })
      let out = ''
      const cap = (s: string) => { if (out.length < 100_000) out += s }
      child.stdout.on('data', d => cap(d.toString()))
      child.stderr.on('data', d => cap(d.toString()))
      const timer = setTimeout(() => { child.kill('SIGKILL'); out += `\n[killed: ${timeoutMs}ms timeout]` }, timeoutMs)
      const onAbort = () => { child.kill('SIGKILL'); out += '\n[killed: cancelled]' }
      ctx.signal?.addEventListener('abort', onAbort, { once: true })
      child.on('close', code => {
        clearTimeout(timer)
        ctx.signal?.removeEventListener('abort', onAbort)
        const { output, truncated } = capOutput(out)
        resolve({ ok: code === 0, output: `exit ${code}\n${output}`, truncated, meta: { exitCode: code } })
      })
      child.on('error', e => {
        clearTimeout(timer)
        resolve({ ok: false, output: `spawn failed: ${e.message}` })
      })
    })
  },
})

registry.register({
  name: 'list_dir',
  description: 'List a directory (shallow). Accepts any absolute path or a path relative to project root. Directories end with /.',
  params: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory path (default: project root)' } },
    required: [],
  },
  async run(args, ctx) {
    const abs = resolveSafe(String(args.path ?? '.'), ctx, { allowOutside: true })
    if (!fs.existsSync(abs)) return { ok: false, output: `Directory not found: ${abs}` }
    // Pointed at a FILE rather than a directory. "what's in /etc/hosts" and "what's in ./build"
    // are the same sentence, and nothing short of touching the disk can tell which target is
    // which — so the router guesses and this handles the miss (cont.118). Returning the file as
    // a one-entry listing means the surface renders it with its real "Read file" action instead
    // of the ENOTDIR that readdirSync would otherwise throw.
    if (!fs.statSync(abs).isDirectory()) {
      const st = fs.statSync(abs)
      return {
        ok: true,
        output: `${abs} is a file (${st.size} bytes, modified ${st.mtime.toISOString()}).`,
        entities: localFiles([{
          name: path.basename(abs), path: abs, isDir: false, size: st.size, mtime: st.mtime.toISOString(),
        }]),
      }
    }
    const dirents = fs.readdirSync(abs, { withFileTypes: true })
      .filter(e => e.name !== 'node_modules' && e.name !== '.git')
      .sort((a, b) => a.name.localeCompare(b.name))
    const entries = dirents.map(e => e.isDirectory() ? `${e.name}/` : e.name)
    const { output, truncated } = capOutput(entries.join('\n'))
    // cont.118 — the FIRST zero-auth entity source. Every other entity-emitting tool needs a
    // Google session, which meant that on a machine with no account connected there was no
    // possible way to see the agentic surface at all. Listing a directory needs nothing.
    // stat() is best-effort per entry: a broken symlink or a permission-denied file must degrade
    // to an entity without size/mtime, never take the whole listing down.
    const detailed = dirents.map(e => {
      const full = path.join(abs, e.name)
      let size: number | undefined, mtime: string | undefined
      try {
        const st = fs.statSync(full)
        size = st.size
        mtime = st.mtime.toISOString()
      } catch { /* unreadable entry — still worth listing */ }
      return { name: e.name, path: full, isDir: e.isDirectory(), size, mtime }
    })
    return { ok: true, output, truncated, entities: localFiles(detailed) }
  },
})

// ── OS-scope tools (Section 2 — Desktop workspace + navigation) ──────────────
// These are NOT sandboxed to projectPath — they operate on any path the user owns.
// The destructive guard in `run` already blocks rm -rf etc. These fill the gap
// for legitimate moves, deletes, and app launches the agent needs outside the project.

registry.register({
  name: 'move_file',
  description: 'Move or rename a file or directory. Works anywhere on the filesystem the user can access.',
  params: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Source path (absolute or relative to project root)' },
      to: { type: 'string', description: 'Destination path (absolute or relative to project root)' },
    },
    required: ['from', 'to'],
  },
  mutates: true,
  async run(args, ctx) {
    const from = resolveSafe(String(args.from ?? ''), ctx, { allowOutside: true })
    const to = resolveSafe(String(args.to ?? ''), ctx, { allowOutside: true })
    if (!fs.existsSync(from)) return { ok: false, output: `Source not found: ${from}` }
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.renameSync(from, to)
    return { ok: true, output: `Moved ${from} → ${to}` }
  },
})

registry.register({
  name: 'delete_file',
  description: 'Delete a file (not a directory). Refuses to delete directories — use the run tool with rm for that after user confirmation.',
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (absolute or relative to project root)' },
    },
    required: ['path'],
  },
  mutates: true,
  async run(args, ctx) {
    const abs = resolveSafe(String(args.path ?? ''), ctx, { allowOutside: true })
    if (!fs.existsSync(abs)) return { ok: false, output: `File not found: ${abs}` }
    const stat = fs.statSync(abs)
    if (stat.isDirectory()) {
      return { ok: false, output: `${abs} is a directory. Use the run tool with an explicit rm command (subject to destructive guard) after confirming with the user.` }
    }
    fs.unlinkSync(abs)
    return { ok: true, output: `Deleted ${abs}` }
  },
})

registry.register({
  name: 'open_app',
  description: 'Open a file, URL, or application on macOS using the system default handler (equivalent to double-clicking in Finder).',
  params: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'File path, directory path, URL (https://…), or app name (e.g. "Finder", "TextEdit")' },
    },
    required: ['target'],
  },
  async run(args) {
    const target = String(args.target ?? '').trim()
    if (!target) return { ok: false, output: 'A non-empty "target" is required.' }
    // URLs and absolute paths: open directly. Bundle ids ("com.apple.finder" — a shape
    // models often emit): open -b. App names: open -a.
    const isUrl = /^https?:\/\//.test(target)
    const isPath = target.startsWith('/') || target.startsWith('~')
    const isBundleId = !isPath && /^[a-z0-9-]+(\.[a-z0-9-]+){2,}$/i.test(target)
    const openArgs = (isUrl || isPath) ? [target] : isBundleId ? ['-b', target] : ['-a', target]
    return new Promise(resolve => {
      execFile('open', openArgs, (err, _stdout, stderr) => {
        if (err) {
          const msg = stderr || err.message
          if (msg.includes('Unable to find application') || msg.includes('does not exist') || msg.includes('No such file')) {
            resolve({ ok: false, output: `App not found: "${target}" does not appear to be installed on this Mac.` })
          } else {
            resolve({ ok: false, output: `open failed: ${msg}` })
          }
        } else {
          resolve({ ok: true, output: `Opened: ${target}` })
        }
      })
    })
  },
})

registry.register({
  name: 'web_search',
  description: 'Search the web using DuckDuckGo. Use for current events, weather, prices, news, facts, or anything requiring up-to-date information. For location-dependent queries like weather, infer the location from context or conversation history.',
  params: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
    },
    required: ['query'],
  },
  async run(args) {
    const query = String(args.query ?? '').trim()
    if (!query) return { ok: false, output: 'A non-empty "query" is required.' }
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
      })
      const html = await res.text()
      const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim()
      const titles: string[] = []
      const snippets: string[] = []
      // cont.118 — the href was parsed and thrown away. Without it a search result cannot become
      // a `webpage` entity (webResults drops anything with no url), so the second zero-auth
      // entity source did not exist. DDG wraps targets in /l/?uddg=<encoded>; unwrap it.
      const urls: string[] = []
      const unwrapDdg = (href: string): string => {
        try {
          const u = new URL(href, 'https://duckduckgo.com')
          const target = u.searchParams.get('uddg')
          return target ? decodeURIComponent(target) : (u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '')
        } catch { return '' }
      }

      // Strategy 1: standard DDG classes
      const titleRe1 = /<a class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>|<a[^>]+href="([^"]+)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/g
      const snippetRe1 = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
      let m
      while ((m = titleRe1.exec(html)) !== null && titles.length < 5) {
        titles.push(strip(m[2] ?? m[4] ?? ''))
        urls.push(unwrapDdg(m[1] ?? m[3] ?? ''))
      }
      while ((m = snippetRe1.exec(html)) !== null && snippets.length < 5) snippets.push(strip(m[1]))

      // Strategy 2: data-result blocks
      if (titles.length === 0) {
        const blockRe = /<h2[^>]*>([\s\S]*?)<\/h2>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/g
        while ((m = blockRe.exec(html)) !== null && titles.length < 5) {
          const t = strip(m[1]); if (t.length > 5) titles.push(t)
        }
      }

      // Strategy 3: any <h2> or <h3> near an <a> tag
      if (titles.length === 0) {
        const h2Re = /<h[23][^>]*>([\s\S]*?)<\/h[23]>/g
        while ((m = h2Re.exec(html)) !== null && titles.length < 5) {
          const t = strip(m[1]); if (t.length > 10) titles.push(t)
        }
      }

      if (titles.length === 0) return { ok: false, output: 'No results found. DDG may have changed their markup or blocked the request.' }
      const output = titles.map((t, i) => `${i + 1}. ${t}${snippets[i] ? '\n   ' + snippets[i] : ''}`).join('\n\n')
      // Only strategy 1 recovers hrefs; strategies 2 and 3 are markup-change fallbacks that
      // yield titles alone. Entities are emitted for whatever DID get a url, and the prose
      // output is unchanged either way — a partial surface beats no surface, and beats a
      // surface with dead links.
      const entities = webResults(
        titles.map((t, i) => ({ title: t, url: urls[i], snippet: snippets[i] })).filter(r => r.url),
      )
      return { ok: true, output, entities }
    } catch (e: any) {
      return { ok: false, output: `Search failed: ${e?.message ?? e}` }
    }
  },
})

// ── read_url — the primitive the agent was missing entirely (cont.118) ────────
//
// MEASURED LIVE: "make me a set of flash cards to study from https://en.wikipedia.org/wiki/…"
// returned "I'm sorry, but I don't have access to the Wikipedia page you provided." That refusal
// was, embarrassingly, ACCURATE — of 44 registered tools, `web_search` searches, `download_file`
// saves bytes to disk and `navigate_browser` opens a window, and NONE of them hands page text
// back to the agent. The single most basic operation on the web was not a capability.
//
// `retrieval/retrievalLayer.ts` has had a hardened fetcher the whole time — SSRF-guarded via
// `guardedLookup`, redirect-capped, timeout-bounded, with boilerplate stripping — and it was
// only ever reachable from the answer path, never from the tool loop. This exposes it.
//
// Emitting a `webpage` entity means a fetched page also becomes an object on the agentic surface
// with its real "Open" action, rather than a wall of text in a tool log.
registry.register({
  name: 'read_url',
  description: 'Read the readable text of a web page. Use this whenever the user gives a URL, or after web_search returns a link you need the CONTENTS of. Returns the article text with navigation and boilerplate stripped. This is how you study, summarize, extract from, or build anything out of a web page.',
  params: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The full URL to read (https://…)' },
      maxChars: { type: 'number', description: 'Max characters of text to return (default 20000)' },
    },
    required: ['url'],
  },
  async run(args) {
    const raw = String(args.url ?? '').trim()
    if (!raw) return { ok: false, output: 'A non-empty "url" is required.' }
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
    const cap = Math.min(60_000, Math.max(500, Number(args.maxChars ?? 20_000)))
    try {
      const html = await retrievalFetch(url)
      if (!html) return { ok: false, output: `Could not fetch ${url} — no content returned.` }
      const text = stripBoilerplate(html).replace(/\n{3,}/g, '\n\n').trim()
      if (!text) return { ok: false, output: `Fetched ${url} but found no readable text (it may be a JavaScript-rendered app).` }
      const truncated = text.length > cap
      // A title makes the entity legible on the surface; fall back to the host.
      const title = (html.match(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i)?.[1] ?? '')
        .replace(/\s+/g, ' ').trim() || url
      return {
        ok: true,
        output: truncated ? `${text.slice(0, cap)}\n\n…(truncated at ${cap} characters)` : text,
        truncated,
        entities: webResults([{ title, url, snippet: text.slice(0, 300) }], 'read_url'),
      }
    } catch (e: any) {
      return { ok: false, output: `Could not read ${url}: ${e?.message ?? e}` }
    }
  },
})

// ── screenshot — the capability that existed but was never a tool (cont.118) ──
//
// `macTools.takeScreenshot` has been in the codebase the whole time, driving the Remote Brain
// MJPEG stream, and its own comment says "optionally by the agent" — but it was never registered,
// so the agent could not take a screenshot. Asked to "screenshot it", the only thing it could do
// was talk about screenshotting.
//
// This writes a real FILE rather than returning bytes, because an artifact you cannot open is not
// an artifact, and emits a `file` entity so the result lands on the agentic surface with its real
// actions attached.
// ── Real browser tools (cont.118) ────────────────────────────────────────────
// Backed by `tools/browser.ts`. These are what make "log into my YouTube and find X, save it as a
// PDF" possible at all: a persistent profile the USER signs into once, reused headlessly
// thereafter. No password ever reaches Crucible.
//
// Every one degrades HONESTLY: with no Chromium installed they return the exact command to fix
// it rather than a stack trace or, worse, a confident answer about a page they never loaded.

/**
 * A string argument as the model meant it, not as it typed it.
 *
 * Models routinely wrap a value in its own quotes, and the quotes survive into the arg: live
 * (cont.119) `web_open` received `"\"https://example.com\""` and navigated to
 * `https://"https//example.com%22`, failing with ERR_NAME_NOT_RESOLVED. Stripping a MATCHED
 * surrounding pair is safe — no URL or path legitimately begins and ends with the same quote —
 * and it is done once, here, rather than at each call site that will otherwise forget.
 */
function argStr(v: unknown): string {
  const s = String(v ?? '').trim()
  const unquoted = /^(["'`])([\s\S]*)\1$/.exec(s)
  return (unquoted ? unquoted[2] : s).trim()
}

function artifactPath(ctx: ToolCtx, base: string, ext: string): string {
  const dir = path.join(ctx.projectPath, '.crucible', 'artifacts')
  fs.mkdirSync(dir, { recursive: true })
  const safe = base.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'artifact'
  return path.join(dir, `${safe}-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`)
}

registry.register({
  name: 'browse_page',
  description: 'Open a URL in the user\'s signed-in browser profile and return the page text. Use this INSTEAD of read_url whenever the page may require a login (YouTube, Instagram, any account page) or is rendered by JavaScript. Reuses sessions the user has already signed into.',
  params: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full URL to open' },
      maxChars: { type: 'number', description: 'Max characters of text (default 20000)' },
    },
    required: ['url'],
  },
  async run(args, ctx) {
    const avail = findBrowser()
    if (!avail.ok) return { ok: false, output: avail.reason!, meta: { blocked: 'no-browser' } }
    const url = argStr(args.url)
    if (!url) return { ok: false, output: 'A non-empty "url" is required.' }
    try {
      const r = await readPage(ctx.projectPath, /^https?:\/\//i.test(url) ? url : `https://${url}`,
        Math.min(60_000, Number(args.maxChars ?? 20_000)))
      if (typeof r.status === 'number' && r.status >= 400) {
        return {
          ok: false,
          output: `That page returned HTTP ${r.status}${r.title ? ` ("${r.title}")` : ''} — the site is failing or the URL is wrong. ` +
            `This is not a login or consent wall; signing in will not help.`,
          meta: { blocked: 'http-error', status: r.status, url: r.url },
        }
      }
      if (r.needsLogin) {
        // Reporting the wall is the honest move — summarising a sign-in form as though it were
        // the article is precisely the fabrication class this session has been closing.
        return {
          ok: false,
          output: `That page requires a sign-in and this browser profile is not logged in.\n` +
            `Run browser_sign_in with this URL, sign in yourself in the window that opens, close it, ` +
            `then retry. Crucible never handles your password — the session lives in the browser profile.`,
          meta: { blocked: 'needs-login', url: r.url },
        }
      }
      if (r.needsConsent) {
        // Same honesty rule as the login wall. The agent must NOT click "accept" — agreeing to a
        // site's terms is the user's call — so it says what it hit and hands them the window.
        return {
          ok: false,
          output: `That page returned a cookie/consent screen instead of its content, so nothing ` +
            `useful was read${r.title ? ` (page title: "${r.title}")` : ''}.\n` +
            `Run browser_sign_in with this URL and make the choice yourself in the window that opens, ` +
            `then close it and retry. Accepting terms on your behalf is not something Crucible will do.`,
          meta: { blocked: 'needs-consent', url: r.url },
        }
      }
      return {
        ok: true,
        output: `# ${r.title}\n${r.url}\n\n${r.text}`,
        truncated: r.text.length >= Math.min(60_000, Number(args.maxChars ?? 20_000)),
        entities: webResults([{ title: r.title, url: r.url, snippet: r.text.slice(0, 300) }], 'browse_page'),
      }
    } catch (e: any) {
      return { ok: false, output: `browse_page failed: ${String(e?.message ?? e).slice(0, 300)}` }
    }
  },
})

registry.register({
  name: 'save_pdf',
  description: 'Save a web page as a PDF file. Use whenever the user asks to save, export, archive or "get a PDF of" something on the web. Works on pages requiring a login if the profile is signed in. Returns the saved file path.',
  params: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The page to save' },
      name: { type: 'string', description: 'Optional base filename (no extension)' },
    },
    required: ['url'],
  },
  async run(args, ctx) {
    const avail = findBrowser()
    if (!avail.ok) return { ok: false, output: avail.reason!, meta: { blocked: 'no-browser' } }
    const url = argStr(args.url)
    if (!url) return { ok: false, output: 'A non-empty "url" is required.' }
    const out = artifactPath(ctx, String(args.name ?? 'page'), 'pdf')
    try {
      const { bytes } = await pageToPdf(ctx.projectPath, /^https?:\/\//i.test(url) ? url : `https://${url}`, out)
      if (bytes < 1000) return { ok: false, output: `Wrote ${out} but it is only ${bytes} bytes — the page probably did not render.` }
      return {
        ok: true,
        output: `Saved PDF: ${out} (${Math.round(bytes / 1024)} KB)`,
        entities: localFiles([{ name: path.basename(out), path: out, isDir: false, size: bytes, mtime: new Date().toISOString() }]),
      }
    } catch (e: any) {
      return { ok: false, output: `save_pdf failed: ${String(e?.message ?? e).slice(0, 300)}` }
    }
  },
})

registry.register({
  name: 'save_page_image',
  description: 'Screenshot a WEB PAGE to a PNG file (full page, not just the visible part). Use for capturing a website. For capturing the user\'s own screen instead, use the screenshot tool.',
  params: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The page to capture' },
      name: { type: 'string', description: 'Optional base filename (no extension)' },
      fullPage: { type: 'boolean', description: 'Capture the entire scrollable page (default true)' },
    },
    required: ['url'],
  },
  async run(args, ctx) {
    const avail = findBrowser()
    if (!avail.ok) return { ok: false, output: avail.reason!, meta: { blocked: 'no-browser' } }
    const url = argStr(args.url)
    if (!url) return { ok: false, output: 'A non-empty "url" is required.' }
    const out = artifactPath(ctx, String(args.name ?? 'page'), 'png')
    try {
      const { bytes } = await pageScreenshot(ctx.projectPath, /^https?:\/\//i.test(url) ? url : `https://${url}`, out, args.fullPage !== false)
      if (bytes < 1000) return { ok: false, output: `Wrote ${out} but it is only ${bytes} bytes — the page probably did not render.` }
      return {
        ok: true,
        output: `Saved page image: ${out} (${Math.round(bytes / 1024)} KB)`,
        entities: localFiles([{ name: path.basename(out), path: out, isDir: false, size: bytes, mtime: new Date().toISOString() }]),
      }
    } catch (e: any) {
      return { ok: false, output: `save_page_image failed: ${String(e?.message ?? e).slice(0, 300)}` }
    }
  },
})

registry.register({
  name: 'browser_sign_in',
  description: 'Open a visible browser window so the USER can sign in to a site themselves, then STOP and report. Returns immediately — it does not wait for them. The work that needed the login is resumed automatically in the background once the session appears, so do not retry or poll. Use when browse_page reports that a page needs a login. Never ask the user for their password — this tool is how signing in happens.',
  // Opens a window and parks a deferred continuation; both are state changes worth gating.
  mutates: true,
  params: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The site\'s login or home URL' },
      site: { type: 'string', description: 'Optional host whose session matters, when it differs from the login URL (e.g. url=accounts.google.com, site=youtube.com)' },
    },
    required: ['url'],
  },
  async run(args, ctx) {
    const avail = findBrowser()
    if (!avail.ok) return { ok: false, output: avail.reason!, meta: { blocked: 'no-browser' } }
    const url = argStr(args.url)
    if (!url) return { ok: false, output: 'A non-empty "url" is required.' }
    try {
      const r = await openSignInWindow(ctx.projectPath, url, args.site ? argStr(args.site) : undefined)
      // Already signed in — say so and let the caller carry straight on. Opening a window to
      // ask for a login the profile already holds is the kind of busywork that reads as broken.
      if (r.alreadySignedIn) {
        return {
          ok: true,
          output: `Already signed in to ${r.host} — that session is live in the Crucible browser profile, so just retry the page you wanted.`,
          meta: { signIn: 'already', host: r.host },
        }
      }
      // Park the continuation BEFORE reporting, so a user who signs in instantly is never
      // racing an unwritten record.
      const goal = (ctx.goal ?? '').trim()
      let parked: { id: string } | null = null
      if (goal && ctx.userId) {
        parked = parkSignIn({
          userId: ctx.userId,
          host: r.host,
          url,
          goal,
          projectPath: ctx.projectPath,
          sessionId: ctx.sessionId ?? '',
        }, Date.now())
      }
      return {
        ok: true,
        // This text is what the model sees, so it says plainly that the turn is over: the
        // failure mode otherwise is a loop that keeps calling browse_page hoping the human
        // hurried up.
        output:
          `A sign-in window for ${r.host} is now open on the user's screen. Do not wait, retry or poll — ` +
          `this turn is finished.\n` +
          (parked
            ? `Their original request has been saved and will run automatically in the background the ` +
              `moment the session appears, with the result delivered to them. `
            : `Ask them to retry once they are signed in. `) +
          `Tell the user: the window is open, they can sign in whenever suits them${parked ? ` and carry on with something else — you will pick it up and finish the job on your own` : ''}. ` +
          `Crucible never sees their password.`,
        meta: { signIn: 'window-open', host: r.host, parked: parked?.id ?? null },
      }
    } catch (e: any) {
      return { ok: false, output: `browser_sign_in failed: ${String(e?.message ?? e).slice(0, 300)}` }
    }
  },
})

// ── Acting on live pages (cont.119) ──────────────────────────────────────────
// browse_page reads a page and throws it away, which is why "log in, find the thing, save it"
// was impossible: every step of that is an ACTION against a page whose state must survive to the
// next step. web_open keeps a tab, web_act drives it and reports what actually changed.

/** Render a page's controls compactly. This is the model's entire view of what it can do, so it
 *  leads with the ref it must quote back and stays terse enough to survive observation
 *  compression in the agent loop. */
function renderPageState(s: { url: string; title: string; text: string; elements: Array<{ ref: string; role: string; name: string; value?: string; disabled?: boolean }> }, maxChars: number): string {
  const controls = s.elements
    .filter(e => e.name || e.role.startsWith('input'))
    .slice(0, 60)
    .map(e => `  ${e.ref}  [${e.role}]${e.disabled ? ' (disabled)' : ''} ${e.name}${e.value ? ` = "${e.value}"` : ''}`)
    .join('\n')
  return `# ${s.title}\n${s.url}\n\n` +
    `CONTROLS (quote the ref, e.g. web_act target:"e12"):\n${controls || '  (no interactive controls found)'}\n\n` +
    `PAGE TEXT:\n${s.text.slice(0, maxChars)}`
}

registry.register({
  name: 'web_open',
  description: 'Open a web page in a tab that STAYS OPEN so you can interact with it. Returns the page text plus every clickable/typeable control with a ref id. Use this instead of browse_page whenever the task needs more than one step on a site (logging in, searching, filling a form, navigating to a result). Reuses the user\'s signed-in browser profile.',
  mutates: true,
  params: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full URL to open' },
      maxChars: { type: 'number', description: 'Max characters of page text (default 6000)' },
    },
    required: ['url'],
  },
  async run(args, ctx) {
    const avail = findBrowser()
    if (!avail.ok) return { ok: false, output: avail.reason!, meta: { blocked: 'no-browser' } }
    const url = argStr(args.url)
    if (!url) return { ok: false, output: 'A non-empty "url" is required.' }
    try {
      const s = await openWorkPage(ctx.projectPath, url)
      if (typeof s.status === 'number' && s.status >= 400) {
        await closeWorkPage(s.pageId)
        return {
          ok: false,
          output: `That page returned HTTP ${s.status}${s.title ? ` ("${s.title}")` : ''} — the site is failing or the URL is wrong. ` +
            `This is not a login or consent wall; signing in will not help. Check the URL, or try again later.`,
          meta: { blocked: 'http-error', status: s.status, url: s.url },
        }
      }
      if (s.needsLogin) {
        await closeWorkPage(s.pageId)
        return {
          ok: false,
          output: `That page requires a sign-in and this browser profile is not logged in.\n` +
            `Call browser_sign_in with this URL — it opens a window, returns immediately, and the ` +
            `task resumes on its own once the user signs in. Crucible never handles their password.`,
          meta: { blocked: 'needs-login', url: s.url },
        }
      }
      if (s.needsConsent) {
        await closeWorkPage(s.pageId)
        return {
          ok: false,
          output: `That page returned a cookie/consent screen instead of its content${s.title ? ` (title: "${s.title}")` : ''}.\n` +
            `Call browser_sign_in with this URL so the user can make that choice themselves. ` +
            `Accepting terms on their behalf is not something Crucible will do.`,
          meta: { blocked: 'needs-consent', url: s.url },
        }
      }
      if (s.needsChallenge) {
        await closeWorkPage(s.pageId)
        return {
          ok: false,
          output: `That site is showing an anti-bot challenge (CAPTCHA) rather than its content, so ` +
            `nothing on it can be read or acted on${s.title ? ` (title: "${s.title}")` : ''}.\n` +
            `Crucible does not solve CAPTCHAs. Either use a different source, or call ` +
            `browser_sign_in with this URL so the user can complete the check themselves in a ` +
            `visible window — the task then resumes automatically.`,
          meta: { blocked: 'needs-challenge', url: s.url },
        }
      }
      return {
        ok: true,
        output: `Opened as page "${s.pageId}" — it stays open; drive it with web_act, and close it with web_close when done.\n\n` +
          renderPageState(s, Math.min(20_000, Number(args.maxChars ?? 6000))),
        entities: webResults([{ title: s.title, url: s.url, snippet: s.text.slice(0, 300) }], 'web_open'),
        meta: { pageId: s.pageId, controls: s.elements.length },
      }
    } catch (e: any) {
      return { ok: false, output: `web_open failed: ${String(e?.message ?? e).slice(0, 300)}` }
    }
  },
})

registry.register({
  name: 'web_act',
  description: 'Do something on a page opened with web_open: click a button or link, type into a field, select an option, press a key, scroll, or go back. Then re-reads the page and tells you what changed. Target a control by the ref id from the last read (like "e12") or by its visible name.',
  mutates: true,
  params: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'The page id returned by web_open' },
      action: { type: 'string', description: 'click | type | fill | select | press | scroll | hover | back | wait' },
      target: { type: 'string', description: 'Ref id from the last read ("e12"), or a substring of the control\'s visible name' },
      value: { type: 'string', description: 'Text to type/fill, option to select, key to press, or pixels to scroll' },
      maxChars: { type: 'number', description: 'Max characters of page text to return (default 6000)' },
    },
    required: ['pageId', 'action'],
  },
  async run(args, ctx) {
    const pageId = argStr(args.pageId)
    const action = argStr(args.action).toLowerCase() as PageAction
    const VALID: PageAction[] = ['click', 'type', 'fill', 'select', 'press', 'scroll', 'hover', 'back', 'wait']
    if (!VALID.includes(action)) return { ok: false, output: `Unknown action "${action}". Use one of: ${VALID.join(', ')}.` }
    try {
      const r = await actOnPage(pageId, action, args.target ? argStr(args.target) : undefined, args.value != null ? argStr(args.value) : undefined)
      // Report the DELTA first. "I clicked it" is not evidence anything happened, and a model
      // that cannot tell a no-op from a success will happily march on through a broken flow.
      const delta = r.changed.url ? `navigated to a new URL`
        : r.changed.title ? `the page title changed`
        : r.changed.elementCount !== 0 ? `${r.changed.elementCount > 0 ? '+' : ''}${r.changed.elementCount} controls appeared/disappeared`
        : `NOTHING measurably changed — the action may not have taken effect; try a different target`
      if (r.needsLogin) {
        return {
          ok: false,
          output: `That action landed on a sign-in wall. Call browser_sign_in for ${r.url} — it returns immediately and the task resumes once the user signs in.`,
          meta: { blocked: 'needs-login', pageId, url: r.url },
        }
      }
      return {
        ok: true,
        output: `${action}${args.target ? ` on "${args.target}"` : ''} — ${delta}.\n\n` + renderPageState(r, Math.min(20_000, Number(args.maxChars ?? 6000))),
        meta: { pageId, navigated: r.navigated, changed: r.changed },
      }
    } catch (e: any) {
      return { ok: false, output: `web_act failed: ${String(e?.message ?? e).slice(0, 400)}` }
    }
  },
})

registry.register({
  name: 'web_close',
  description: 'Close a page opened with web_open. Do this when finished with a site so the browser is not left holding tabs open.',
  mutates: true,
  params: { type: 'object', properties: { pageId: { type: 'string' } }, required: ['pageId'] },
  async run(args) {
    const closed = await closeWorkPage(String(args.pageId ?? ''))
    return { ok: true, output: closed ? `Closed page ${args.pageId}.` : `Page ${args.pageId} was not open (open pages: ${listWorkPages().join(', ') || 'none'}).` }
  },
})

// ── Scheduling (cont.119) ────────────────────────────────────────────────────
// The automations subsystem was complete and unreachable: no tool touched it, so "every morning
// summarise my inbox" got a promise and no schedule. These three close that. Execution is
// unchanged — the existing 30s tick and runner own it; these only read and write the store.

registry.register({
  name: 'schedule_task',
  description: 'Schedule a task to run automatically on a recurring or future basis ("every weekday at 8am", "every 2 hours", "tomorrow at 9am", "in 30 minutes"). Use whenever the user asks for something to happen repeatedly, later, on a schedule, or as a reminder/digest. The scheduled run executes autonomously with full tool access and the result is delivered to them.',
  mutates: true,
  params: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short name, e.g. "Morning inbox digest"' },
      brief: { type: 'string', description: 'What to do on each run, written as a standalone instruction (the run has no conversation context)' },
      schedule: { type: 'string', description: 'When, in the user\'s own words: "every weekday at 8am", "every 2 hours", "tomorrow at 9am"' },
      notify: { type: 'boolean', description: 'true to push a notification on completion; otherwise it lands in the digest' },
    },
    required: ['name', 'brief', 'schedule'],
  },
  async run(args, ctx) {
    if (!ctx.userId) return { ok: false, output: 'Scheduling needs a signed-in user, and this run has none.' }
    const name = String(args.name ?? '').trim().slice(0, 80)
    const brief = String(args.brief ?? '').trim()
    const schedule = String(args.schedule ?? '').trim()
    if (!name) return { ok: false, output: 'A "name" is required.' }
    if (brief.length < 8) return { ok: false, output: 'A "brief" of at least 8 characters is required — it is the whole instruction the unattended run receives.' }

    const parsed = parseTrigger(schedule, Date.now())
    if (!parsed) {
      // Never invent a cadence. A schedule the user did not intend runs forever without being
      // noticed, which is worse than asking one question now.
      return {
        ok: false,
        output: `Could not read "${schedule}" as a schedule, and guessing one would be worse than asking. ` +
          `Ask the user for it in a form like: "every weekday at 8am", "every 2 hours", "every Monday at 9", ` +
          `"daily at 18:30", "tomorrow at 9am", or "in 30 minutes".`,
      }
    }

    const now = Date.now()
    const list = loadAutomations()
    // Same brief + same cadence = the user restating, not asking for a second copy. Two identical
    // automations both firing is a bug the user experiences as duplicate notifications forever.
    const dupe = list.find(a => a.userId === ctx.userId && a.brief.trim().toLowerCase() === brief.toLowerCase()
      && JSON.stringify(a.trigger) === JSON.stringify(parsed.trigger))
    if (dupe) {
      return {
        ok: true,
        output: `That is already scheduled — "${dupe.name}", ${describeTrigger(dupe.trigger)}, next run ${dupe.nextRun ? new Date(dupe.nextRun).toLocaleString() : 'never'}. Nothing new was created.`,
        meta: { automationId: dupe.id, duplicate: true },
      }
    }

    const automation = {
      id: `auto-${now}-${Math.abs(hashString(name + brief))}`,
      userId: ctx.userId,
      name,
      brief,
      trigger: parsed.trigger,
      delivery: (args.notify ? 'push' : 'digest') as 'push' | 'digest',
      enabled: true,
      createdAt: now,
      lastRuns: [],
      consecutiveFailures: 0,
      nextRun: computeNextRun(parsed.trigger, now),
    }
    list.push(automation)
    // Verify the WRITE, then verify the READ. A scheduling tool that reports success for a
    // schedule that does not exist is worse than one that fails: the user stops thinking about
    // it, and nothing ever runs. Caught live — the first version said "first run 8:00 AM" for a
    // record that never reached disk.
    const wrote = saveAutomations(list)
    const readBack = wrote && loadAutomations().some(a => a.id === automation.id)
    if (!readBack) {
      return {
        ok: false,
        output: `Could not save the schedule — nothing was created, so do NOT tell the user it was.\n` +
          `The automations store at ${AUTOMATIONS_FILE} could not be written (check the server's ` +
          `working directory and permissions, or set CRUCIBLE_DIR).`,
        meta: { blocked: 'store-unwritable', file: AUTOMATIONS_FILE },
      }
    }
    return {
      ok: true,
      output: `Scheduled "${name}" — ${parsed.description}. First run ${automation.nextRun ? new Date(automation.nextRun).toLocaleString() : 'never'}.\n` +
        `It will run on its own with full tool access and ${args.notify ? 'notify the user' : 'appear in their digest'} when done. ` +
        `Tell the user what was scheduled and when it first runs, so they can correct it now if it is not what they meant.`,
      meta: { automationId: automation.id, trigger: parsed.trigger, nextRun: automation.nextRun },
    }
  },
})

registry.register({
  name: 'list_scheduled_tasks',
  description: 'List the user\'s scheduled/recurring tasks, when each next runs, and how the last run went. Use when they ask what is scheduled, what is running automatically, or to check on a reminder.',
  params: { type: 'object', properties: {} },
  async run(_args, ctx) {
    if (!ctx.userId) return { ok: false, output: 'Listing scheduled tasks needs a signed-in user, and this run has none.' }
    const mine = loadAutomations().filter(a => a.userId === ctx.userId)
    if (mine.length === 0) return { ok: true, output: 'Nothing is scheduled right now.' }
    const rows = mine.map(a => {
      const last = a.lastRuns[0]
      return `- ${a.name} [${a.id}] — ${describeTrigger(a.trigger)}${a.enabled ? '' : ' (PAUSED)'}\n` +
        `  next: ${a.nextRun ? new Date(a.nextRun).toLocaleString() : 'never'}\n` +
        `  brief: ${a.brief.slice(0, 160)}\n` +
        (last ? `  last run: ${new Date(last.ts).toLocaleString()} — ${last.status}${last.status === 'failed' ? ` (${last.summary.slice(0, 120)})` : ''}\n` : '  last run: never\n')
    })
    return { ok: true, output: `${mine.length} scheduled task${mine.length === 1 ? '' : 's'}:\n\n${rows.join('\n')}` }
  },
})

registry.register({
  name: 'cancel_scheduled_task',
  description: 'Cancel or pause a scheduled task. Identify it by its id from list_scheduled_tasks, or by its name. Use when the user asks to stop, cancel, pause or delete a recurring task or reminder.',
  mutates: true,
  params: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Automation id, or the task\'s name' },
      pause: { type: 'boolean', description: 'true to pause (keeps it, stops running); omit to delete outright' },
    },
    required: ['id'],
  },
  async run(args, ctx) {
    if (!ctx.userId) return { ok: false, output: 'Cancelling a scheduled task needs a signed-in user, and this run has none.' }
    const key = String(args.id ?? '').trim().toLowerCase()
    const list = loadAutomations()
    const idx = list.findIndex(a => a.userId === ctx.userId && (a.id.toLowerCase() === key || a.name.toLowerCase() === key))
    if (idx === -1) {
      const names = list.filter(a => a.userId === ctx.userId).map(a => `"${a.name}"`).join(', ')
      return { ok: false, output: `No scheduled task matches "${args.id}".${names ? ` Existing tasks: ${names}.` : ' Nothing is scheduled.'}` }
    }
    const a = list[idx]
    if (args.pause) {
      a.enabled = false
      a.nextRun = null
      saveAutomations(list)
      return { ok: true, output: `Paused "${a.name}". It keeps its history and can be re-enabled.`, meta: { automationId: a.id } }
    }
    list.splice(idx, 1)
    saveAutomations(list)
    return { ok: true, output: `Deleted the scheduled task "${a.name}".`, meta: { automationId: a.id } }
  },
})

/** Deterministic id suffix — Math.random would make automation ids untestable. */
function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

registry.register({
  name: 'screenshot',
  description: 'Capture the screen (or a region of it) to a PNG file. Use whenever the user asks to screenshot, capture, or grab an image of what is on screen. Returns the saved file path.',
  params: {
    type: 'object',
    properties: {
      region: { type: 'string', description: 'Optional region as "x,y,width,height". Omit for the whole screen.' },
      name: { type: 'string', description: 'Optional base filename (no extension).' },
    },
  },
  async run(args, ctx) {
    const dir = path.join(ctx.projectPath, '.crucible', 'artifacts')
    try { fs.mkdirSync(dir, { recursive: true }) } catch { /* exists */ }
    const safeName = String(args.name ?? 'screenshot').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'screenshot'
    const out = path.join(dir, `${safeName}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
    const region = String(args.region ?? '').trim()
    const regionArgs = /^\d+,\d+,\d+,\d+$/.test(region) ? ['-R', region] : []
    try {
      await new Promise<void>((resolve, reject) => {
        execFile('screencapture', ['-x', '-t', 'png', ...regionArgs, out], err => err ? reject(err) : resolve())
      })
      if (!fs.existsSync(out)) return { ok: false, output: 'screencapture produced no file.' }
      const size = fs.statSync(out).size
      // A capture without macOS Screen Recording permission yields a tiny, empty PNG. Checking
      // the artifact rather than the exit code is the difference between "saved" and "saved
      // something you can actually look at".
      if (size < 5_000) {
        return {
          ok: false,
          output: `Captured to ${out} but the image is only ${size} bytes — almost certainly blank. ` +
            `macOS Screen Recording permission is probably not granted to this app ` +
            `(System Settings → Privacy & Security → Screen Recording).`,
        }
      }
      return {
        ok: true,
        output: `Saved screenshot: ${out} (${Math.round(size / 1024)} KB)`,
        entities: localFiles([{ name: path.basename(out), path: out, isDir: false, size, mtime: new Date().toISOString() }]),
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      // The TCC gate. `screencapture` exits non-zero with "could not create image from display"
      // when Screen Recording permission is missing, which is a PERMISSION problem the user can
      // fix in ten seconds — surfacing the raw shell error instead would read as a broken tool.
      if (/could not create image|not authorized|permission/i.test(msg)) {
        return {
          ok: false,
          output: 'Screen Recording permission is not granted, so macOS refused the capture. ' +
            'Grant it in System Settings → Privacy & Security → Screen Recording (add Crucible, ' +
            'or your terminal if running in dev), then try again. Nothing else is wrong.',
          meta: { blocked: 'tcc-screen-recording' },
        }
      }
      return { ok: false, output: `screencapture failed: ${msg.slice(0, 200)}` }
    }
  },
})

registry.register({
  name: 'image_search',
  description: 'Search for images on the web and return direct image URLs. Use this when you need to find and download images.',
  params: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for' },
      count: { type: 'number', description: 'Number of image URLs to return (default 5, max 20)' },
    },
    required: ['query'],
  },
  async run(args) {
    const query = String(args.query ?? '').trim()
    const count = Math.min(Number(args.count ?? 5), 20)
    if (!query) return { ok: false, output: 'A non-empty "query" is required.' }
    // ── Source order: Wikipedia lead image → Wikimedia Commons → DDG scrape ──────
    // Rewritten 2026-07-21 (cont.95) after a live check showed this tool returned
    // "No image URLs found." for EVERY query: the third-party ddg proxy below is dead, and
    // the DDG HTML fallback does not serve image results at that endpoint, so both tiers
    // failed silently and any agent asking for a picture got nothing. Wikimedia is the right
    // primary anyway — no API key, stable, and the images carry explicit CC/public-domain
    // licensing rather than being arbitrary hotlinked web results.
    const UA = 'crucible-local/1.0 (on-device agent; contact: local user)'
    const wikiTitle = query.replace(/\b(photo|photos|image|images|picture|pictures|pic|pics)\b/gi, '').trim()
    try {
      // Tier 1: the Wikipedia article's lead image — for a named entity this is almost always
      // the single most representative picture, already editorially chosen.
      if (wikiTitle) {
        const res = await fetch(
          `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wikiTitle.replace(/\s+/g, '_'))}`,
          { headers: { 'User-Agent': UA } },
        )
        if (res.ok) {
          const d = await res.json() as any
          const lead = d?.originalimage?.source ?? d?.thumbnail?.source
          if (typeof lead === 'string' && lead) return { ok: true, output: lead }
        }
      }
    } catch { /* fall through to Commons */ }
    try {
      // Tier 2: Wikimedia Commons file search — works for subjects with no article of their own.
      if (wikiTitle) {
        const res = await fetch(
          `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(wikiTitle)}` +
          `&gsrnamespace=6&gsrlimit=${count}&prop=imageinfo&iiprop=url&format=json`,
          { headers: { 'User-Agent': UA } },
        )
        if (res.ok) {
          const d = await res.json() as any
          const urls = Object.values(d?.query?.pages ?? {})
            .map((p: any) => p?.imageinfo?.[0]?.url)
            .filter((u: any) => typeof u === 'string' && /\.(jpg|jpeg|png|webp)$/i.test(u))
            .slice(0, count)
          if (urls.length > 0) return { ok: true, output: urls.join('\n') }
        }
      }
    } catch { /* fall through to DDG */ }
    try {
      // Tier 3 (legacy): scrape DDG images HTML
      const fallback = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query + ' filetype:jpg')}&iax=images&ia=images`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
      })
      const html = await fallback.text()
      const imgRe = /https?:\/\/[^"'\s]+\.(?:jpg|jpeg|png|webp)/gi
      const matches = [...new Set(html.match(imgRe) ?? [])].slice(0, count)
      if (matches.length === 0) return { ok: false, output: 'No image URLs found.' }
      return { ok: true, output: matches.join('\n') }
    } catch (e: any) {
      return { ok: false, output: `Image search failed: ${e?.message ?? e}` }
    }
  },
})

registry.register({
  name: 'download_file',
  description: 'Download a file from a URL and save it to a local path. Validates the file is a real image. Only saves to Desktop, Downloads, Documents, or the project folder.',
  params: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to download from' },
      dest: { type: 'string', description: 'Destination file path (e.g. ~/Desktop/dogs/dog1.jpg)' },
    },
    required: ['url', 'dest'],
  },
  mutates: true,
  async run(args, ctx) {
    const rawDest = String(args.dest ?? '').replace(/^~/, process.env.HOME ?? '')
    if (!rawDest) return { ok: false, output: 'A non-empty "dest" is required.' }
    try { resolveSafe(rawDest, ctx, { allowOutside: true }) } catch (e: any) { return { ok: false, output: e.message } }
    const url = argStr(args.url)
    if (!url) return { ok: false, output: 'A non-empty "url" is required.' }
    return new Promise(resolve => {
      const dir = path.dirname(rawDest)
      fs.mkdirSync(dir, { recursive: true })
      const tmpPath = rawDest + '.tmp'
      const child = spawn('curl', ['-L', '--max-time', '15', '--max-filesize', '20000000', '-o', tmpPath, url], { env: process.env })
      let stderr = ''
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
      child.on('close', code => {
        if (code !== 0) { try { fs.unlinkSync(tmpPath) } catch {} ; return resolve({ ok: false, output: `curl failed: ${stderr.slice(0, 200)}` }) }
        try {
          const buf = fs.readFileSync(tmpPath)
          const size = buf.length
          // Validate magic bytes for common image formats
          const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8
          const isPng = buf[0] === 0x89 && buf[1] === 0x50
          const isWebp = buf.slice(8, 12).toString() === 'WEBP'
          const isGif = buf.slice(0, 3).toString() === 'GIF'
          if (!isJpeg && !isPng && !isWebp && !isGif) {
            fs.unlinkSync(tmpPath)
            return resolve({ ok: false, output: `URL did not return a valid image (got ${size} bytes, wrong format). Try a different URL.` })
          }
          if (size < 5000) {
            fs.unlinkSync(tmpPath)
            return resolve({ ok: false, output: `Downloaded file too small (${size} bytes) — likely a placeholder or error image.` })
          }
          fs.renameSync(tmpPath, rawDest)
          resolve({ ok: true, output: `Downloaded valid image to ${rawDest} (${Math.round(size/1024)}KB)` })
        } catch (e: any) {
          resolve({ ok: false, output: `Validation failed: ${e.message}` })
        }
      })
    })
  },
})

registry.register({
  name: 'delete_folder',
  description: 'Recursively delete a folder and all its contents. Only works on Desktop, Downloads, Documents, or project folder. Use this instead of rm -rf.',
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Folder path to delete (absolute or relative to project root)' },
    },
    required: ['path'],
  },
  mutates: true,
  async run(args, ctx) {
    const abs = resolveSafe(String(args.path ?? ''), ctx, { allowOutside: true })
    if (!fs.existsSync(abs)) return { ok: false, output: `Folder not found: ${abs}` }
    const stat = fs.statSync(abs)
    if (!stat.isDirectory()) return { ok: false, output: `${abs} is a file, not a folder. Use delete_file instead.` }
    fs.rmSync(abs, { recursive: true, force: true })
    return { ok: true, output: `Deleted folder: ${abs}` }
  },
})

registry.register({
  name: 'empty_trash',
  description: 'Empty the macOS Trash/Recycling bin.',
  params: { type: 'object', properties: {} },
  mutates: true,
  async run() {
    return new Promise(resolve => {
      execFile('osascript', ['-e', 'tell application "Finder" to empty trash'], (err, _, stderr) => {
        if (err) resolve({ ok: false, output: `Failed to empty trash: ${stderr || err.message}` })
        else resolve({ ok: true, output: 'Trash emptied.' })
      })
    })
  },
})

// ── Dynamic tool acquisition (Gap 2) ─────────────────────────────────────────

registry.register({
  name: 'create_tool',
  description: [
    'Write and register a NEW tool at runtime when no existing tool covers the need.',
    'The body is a JS async function body (receives `args` and `ctx`). It must return',
    '{ ok: boolean, output: string }. The tool is live immediately in this session',
    'AND persisted to .crucible/dynamic-tools/ so it reloads on future runs.',
    'Only create a tool when the built-in set genuinely cannot do the job.',
    'EXAMPLE body: "const { execFile } = require(\'child_process\');\n',
    'return new Promise(res => execFile(\'say\', [args.text], e => res({ ok: !e, output: e?.message || \'spoken\' })))"',
  ].join(' '),
  params: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Snake_case tool name (no spaces). Must not clash with an existing tool.' },
      description: { type: 'string', description: 'One sentence describing what this tool does and when to use it.' },
      params: {
        type: 'object',
        description: 'JSON Schema object for the args this tool accepts. Example: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }',
      },
      body: { type: 'string', description: 'Async JS function body. Receives (args, ctx). Must return { ok: boolean, output: string }.' },
    },
    required: ['name', 'description', 'params', 'body'],
  },
  mutates: false,
  async run(args, ctx) {
    const name = String(args.name ?? '').replace(/[^a-z0-9_]/gi, '_').toLowerCase()
    if (!name) return { ok: false, output: 'name is required' }
    if (registry.get(name)) return { ok: false, output: `Tool '${name}' already exists. Choose a different name or use the existing tool.` }

    const description = String(args.description ?? '').trim()
    const body = String(args.body ?? '').trim()
    if (!body) return { ok: false, output: 'body is required' }

    // Parse params schema
    let params: Record<string, unknown>
    try {
      params = typeof args.params === 'object' && args.params !== null
        ? args.params as Record<string, unknown>
        : JSON.parse(String(args.params))
    } catch {
      return { ok: false, output: 'params must be a valid JSON Schema object' }
    }

    // Compile and smoke-test the body
    let runFn: (a: Record<string, unknown>, c: ToolCtx) => Promise<import('./protocol').ToolResult>
    try {
      runFn = compileTool(body)
    } catch (e: any) {
      return { ok: false, output: `Tool body failed to compile: ${e.message}` }
    }

    // Smoke-test: call with empty args — should not throw (may return ok:false, that's fine)
    try {
      await runFn({}, ctx)
    } catch (e: any) {
      return { ok: false, output: `Tool body threw on smoke-test: ${e.message}. Fix the body and try again.` }
    }

    // Register live in this session
    registry.register({ name, description, params, mutates: false, run: runFn })

    // Persist to .crucible/dynamic-tools/
    const record: DynamicToolRecord = {
      name, description, params, body,
      createdAt: Date.now(),
      createdBy: 'agent',
      useCount: 0,
      successCount: 0,
      lastUsed: null,
      tier: 'session',
    }
    try {
      saveDynamicTool(ctx.projectPath, record)
    } catch (e: any) {
      // Registered in-session but persist failed — non-fatal
      return { ok: true, output: `Tool '${name}' registered for this session (persist failed: ${e.message}).` }
    }

    ctx.emit?.({ type: 'tool_created', name, description })
    return { ok: true, output: `Tool '${name}' created and registered. It is now available in this session and all future sessions. Use it like any other tool.` }
  },
})

registry.register({
  name: 'write_global_memory',
  description: 'Write a durable fact to global memory (~/.crucible/world.md). Use this to remember things about the USER (preferences, tools they use, patterns you notice) that should persist across ALL future sessions and projects — not just this one. One fact per call. Keep it short and specific.',
  params: {
    type: 'object',
    properties: { fact: { type: 'string', description: 'A concise fact to remember globally, e.g. "User prefers TypeScript over JavaScript" or "User timezone is Europe/Rome, in Italy"' } },
    required: ['fact'],
  },
  mutates: true,   // writes to disk — gated by allowMutation + denied to read-only archetypes
  async run(args) {
    const fact = String(args.fact ?? '').trim()
    if (!fact) return { ok: false, output: 'fact must not be empty' }
    appendGlobalMemory(fact, Date.now())
    return { ok: true, output: `Remembered: "${fact}"` }
  },
})

registry.register({
  name: 'list_dynamic_tools',
  description: 'List all custom tools the agent has created for this project. Shows name, description, use count, and creation date.',
  params: { type: 'object', properties: {} },
  async run(_args, ctx) {
    const tools = listDynamicTools(ctx.projectPath)
    if (!tools.length) return { ok: true, output: 'No dynamic tools created yet for this project.' }
    const lines = tools.map(t =>
      `- ${t.name} (used ${t.useCount}x): ${t.description}`
    )
    return { ok: true, output: `Dynamic tools (${tools.length}):\n${lines.join('\n')}` }
  },
})

// J1 — World model as a callable tool
registry.register({
  name: 'query_world_model',
  description: 'Semantic search over the entity graph + knowledge base. Use when you need to know something about the project, user preferences, prior decisions, or any entity Crucible has learned about. Pulls exactly the context needed at the moment rather than loading all context upfront.',
  params: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'The topic, entity name, or question to look up in the world model' },
      depth: { type: 'number', description: 'How many related entities to include (1-3, default 1)' },
    },
    required: ['topic'],
  },
  async run(args, ctx) {
    const topic = String(args.topic ?? '').trim()
    if (!topic) return { ok: false, output: 'topic required' }
    const depth = Math.min(3, Math.max(1, Number(args.depth ?? 1)))
    const digest = buildGraphDigest(topic, depth * 600)
    // Also touch these entities to track query frequency (H3 re-evaluation)
    const entities = findEntities(topic, undefined, 5)
    if (entities.length) touchEntities(entities.map(e => e.label))
    if (!digest) return { ok: true, output: 'No relevant entries found in world model for this topic.' }
    return { ok: true, output: digest }
  },
})

// I4 — agent-to-agent consultation: ask another specialist a focused question.
registry.register({
  name: 'consult_specialist',
  description:
    'Ask another specialist agent (researcher | coder | critic | strategist) ONE focused ' +
    'question and get its answer back. Use to get a second opinion or domain expertise mid-task ' +
    '(e.g. a coder asks the critic to review an approach, or the strategist asks the researcher ' +
    'for facts). Consultation depth is limited to 1 — the consulted specialist cannot itself consult.',
  params: {
    type: 'object',
    properties: {
      archetype: { type: 'string', enum: ['researcher', 'coder', 'critic', 'strategist'], description: 'Which specialist to consult' },
      question: { type: 'string', description: 'The single focused question to ask the specialist' },
    },
    required: ['archetype', 'question'],
  },
  mutates: false,
  async run(args, ctx) {
    const archetype = String(args.archetype ?? '') as 'researcher' | 'coder' | 'critic' | 'strategist'
    const question = String(args.question ?? '').trim()
    if (!['researcher', 'coder', 'critic', 'strategist'].includes(archetype)) {
      return { ok: false, output: 'archetype must be one of: researcher, coder, critic, strategist' }
    }
    if (!question) return { ok: false, output: 'question is required' }
    if (!ctx.consultSpecialist) {
      return { ok: false, output: 'consult_specialist is unavailable in this context (no orchestrator wiring).' }
    }
    const answer = await ctx.consultSpecialist(archetype, question)
    return { ok: true, output: answer }
  },
})

registry.register({
  name: 'search_youtube',
  description: [
    'Search YouTube and return REAL video URLs with verified video IDs.',
    'ALWAYS use this tool when the user asks to play, open, queue, or put on a YouTube video.',
    'NEVER construct youtube.com/watch?v= URLs from model knowledge — video IDs hallucinated',
    'from training data will be dead links. This tool fetches live search results and returns',
    'only URLs with real video IDs extracted from YouTube\'s own response.',
    'Returns up to 5 results: title, channel, duration, and a verified watch URL.',
    'Pass the best result URL to open_app to actually play it.',
  ].join(' '),
  params: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search terms — be specific (e.g. "relaxing rain sleep music 1 hour")' },
      count: { type: 'number', description: 'Number of results to return (default 3, max 5)' },
    },
    required: ['query'],
  },
  async run(args) {
    const query = String(args.query ?? '').trim()
    if (!query) return { ok: false, output: '"query" is required.' }
    const count = Math.min(5, Math.max(1, Number(args.count ?? 3)))

    try {
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
      const res = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      })
      if (!res.ok) return { ok: false, output: `YouTube returned HTTP ${res.status}` }
      const html = await res.text()

      // YouTube embeds all search result data as JSON in ytInitialData
      const match = html.match(/var ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/)
        ?? html.match(/ytInitialData\s*=\s*(\{[\s\S]*?\});\s*(?:\/\/|<)/)
      if (!match) return { ok: false, output: 'Could not parse YouTube search results (page structure changed).' }

      let data: any
      try { data = JSON.parse(match[1]) } catch { return { ok: false, output: 'Failed to parse YouTube response JSON.' } }

      // Navigate the ytInitialData structure to reach video renderers
      const contents: any[] =
        data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
          ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents
        ?? data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
          ?.sectionListRenderer?.contents?.[1]?.itemSectionRenderer?.contents
        ?? []

      interface VideoResult { videoId: string; title: string; channel: string; duration: string }
      const videos: VideoResult[] = []
      for (const item of contents) {
        if (videos.length >= count) break
        const vr = item?.videoRenderer
        if (!vr?.videoId) continue
        const videoId: string = vr.videoId
        // Validate ID format — YouTube IDs are exactly 11 alphanumeric/-/_ chars
        if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) continue
        const title: string = vr.title?.runs?.[0]?.text ?? vr.title?.simpleText ?? 'Unknown'
        const channel: string = vr.ownerText?.runs?.[0]?.text ?? vr.shortBylineText?.runs?.[0]?.text ?? 'Unknown'
        const duration: string = vr.lengthText?.simpleText ?? ''
        videos.push({ videoId, title, channel, duration })
      }

      if (videos.length === 0) return { ok: false, output: 'No video results found. Try a different query.' }

      const lines = videos.map((v, i) =>
        `${i + 1}. ${v.title}\n   Channel: ${v.channel}${v.duration ? `  |  Duration: ${v.duration}` : ''}\n   URL: https://www.youtube.com/watch?v=${v.videoId}`
      )
      return {
        ok: true,
        output: `YouTube search results for "${query}":\n\n${lines.join('\n\n')}\n\nPick the best match and call open_app with its URL.`,
      }
    } catch (e: any) {
      return { ok: false, output: `search_youtube failed: ${e?.message ?? e}` }
    }
  },
})

// ── Google API tools — require Google sign-in with appropriate scopes ─────────

registry.register({
  name: 'gmail_search',
  description: 'Search the user\'s Gmail inbox. Returns subject, sender, date, and snippet for each match. Use for finding emails, checking messages, reading correspondence.',
  params: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Gmail search query (same syntax as Gmail search box, e.g. "from:boss subject:meeting after:2024/1/1")' },
      maxResults: { type: 'number', description: 'Max emails to return (default 10, max 20)' },
    },
    required: ['query'],
  },
  async run(args, ctx) {
    const uid = ctx.userId
    if (!uid) return { ok: false, output: 'gmail_search requires an authenticated user session.' }
    const q = String(args.query ?? '').trim()
    const max = Math.min(20, Math.max(1, Number(args.maxResults ?? 10)))
    try {
      const list = await gFetch(uid, `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${max}`)
      const messages: any[] = list.messages ?? []
      if (!messages.length) return { ok: true, output: 'No emails found matching that query.' }
      // Keep the RAW provider objects — cont.118. Mapping straight to strings here is what
      // destroyed the structure the UI and the entity protocol need; the prose is now derived
      // FROM the objects rather than replacing them.
      const raw = await Promise.all(messages.slice(0, max).map((m: any) =>
        gFetch(uid, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`)))
      const details = raw.map((msg: any) => {
        const headers: any[] = msg.payload?.headers ?? []
        const h = (name: string) => headers.find((h: any) => h.name === name)?.value ?? ''
        return `[${msg.id}] From: ${h('From')}\nDate: ${h('Date')}\nSubject: ${h('Subject')}\nSnippet: ${msg.snippet ?? ''}`
      })
      // `output` is byte-identical to before so every existing reader (including cont.105b's
      // renderPersonalData parsers) is unaffected; `entities` is purely additive.
      return { ok: true, output: details.join('\n\n---\n\n'), entities: gmailMessages(raw) }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'gmail_read',
  description: 'Read the full body of a specific Gmail message by ID. Get the message ID from gmail_search first.',
  params: {
    type: 'object',
    properties: {
      messageId: { type: 'string', description: 'Gmail message ID from gmail_search results' },
    },
    required: ['messageId'],
  },
  async run(args, ctx) {
    const uid = ctx.userId
    if (!uid) return { ok: false, output: 'gmail_read requires an authenticated user session.' }
    try {
      const msg = await gFetch(uid, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${args.messageId}?format=full`)
      const headers: any[] = msg.payload?.headers ?? []
      const h = (name: string) => headers.find((x: any) => x.name === name)?.value ?? ''
      const extractBody = (part: any): string => {
        if (part?.body?.data) return Buffer.from(part.body.data, 'base64').toString('utf8')
        if (part?.parts) return part.parts.map(extractBody).join('\n')
        return ''
      }
      const body = extractBody(msg.payload)
      return {
        ok: true,
        output: `From: ${h('From')}\nTo: ${h('To')}\nDate: ${h('Date')}\nSubject: ${h('Subject')}\n\n${body.slice(0, 4000)}`,
      }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'gmail_send',
  description: 'Send an email via Gmail. Use only when explicitly asked by the user to send an email.',
  mutates: true,
  params: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email address' },
      subject: { type: 'string', description: 'Email subject' },
      body: { type: 'string', description: 'Plain text email body' },
      cc: { type: 'string', description: 'CC email address (optional)' },
    },
    required: ['to', 'subject', 'body'],
  },
  async run(args, ctx) {
    const uid = ctx.userId
    if (!uid) return { ok: false, output: 'gmail_send requires an authenticated user session.' }
    const to = String(args.to ?? '')
    const subject = String(args.subject ?? '')
    const body = String(args.body ?? '')
    const cc = String(args.cc ?? '')
    const raw = [
      `To: ${to}`,
      cc ? `Cc: ${cc}` : '',
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ].filter(Boolean).join('\r\n')
    const encoded = Buffer.from(raw).toString('base64url')
    try {
      const res = await gFetch(uid, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        body: JSON.stringify({ raw: encoded }),
      })
      return { ok: true, output: `Email sent. Message ID: ${res.id}` }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'calendar_list',
  description: 'List upcoming Google Calendar events. Returns title, time, location, and description.',
  params: {
    type: 'object',
    properties: {
      maxResults: { type: 'number', description: 'Max events to return (default 10)' },
      days: { type: 'number', description: 'How many days ahead to look (default 7)' },
      calendarId: { type: 'string', description: 'Calendar ID (default: primary)' },
    },
  },
  async run(args, ctx) {
    const uid = ctx.userId
    if (!uid) return { ok: false, output: 'calendar_list requires an authenticated user session.' }
    const max = Math.min(50, Number(args.maxResults ?? 10))
    const days = Number(args.days ?? 7)
    const calId = encodeURIComponent(String(args.calendarId ?? 'primary'))
    const timeMin = new Date().toISOString()
    const timeMax = new Date(Date.now() + days * 86400000).toISOString()
    try {
      const data = await gFetch(uid, `https://www.googleapis.com/calendar/v3/calendars/${calId}/events?maxResults=${max}&timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime`)
      const items: any[] = data.items ?? []
      if (!items.length) return { ok: true, output: 'No upcoming events found.' }
      const lines = items.map(e => {
        const start = e.start?.dateTime ?? e.start?.date ?? ''
        return `• ${e.summary ?? '(no title)'}\n  When: ${start}\n  Location: ${e.location ?? 'none'}\n  ${e.description?.slice(0, 200) ?? ''}`
      })
      return { ok: true, output: lines.join('\n\n'), entities: calendarEvents(items) }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'calendar_create',
  description: 'Create a Google Calendar event. Use when the user asks to schedule, book, or add something to their calendar.',
  mutates: true,
  params: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Event title' },
      start: { type: 'string', description: 'Start time in ISO 8601 format (e.g. 2025-06-15T14:00:00+01:00)' },
      end: { type: 'string', description: 'End time in ISO 8601 format' },
      description: { type: 'string', description: 'Event description (optional)' },
      location: { type: 'string', description: 'Location (optional)' },
      attendees: { type: 'string', description: 'Comma-separated email addresses of attendees (optional)' },
    },
    required: ['title', 'start', 'end'],
  },
  async run(args, ctx) {
    const uid = ctx.userId
    if (!uid) return { ok: false, output: 'calendar_create requires an authenticated user session.' }
    const attendeeList = String(args.attendees ?? '').split(',').map(e => e.trim()).filter(Boolean).map(e => ({ email: e }))
    try {
      const event = await gFetch(uid, 'https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        body: JSON.stringify({
          summary: args.title,
          start: { dateTime: args.start },
          end: { dateTime: args.end },
          description: args.description ?? '',
          location: args.location ?? '',
          attendees: attendeeList,
        }),
      })
      return { ok: true, output: `Event created: "${event.summary}" on ${event.start?.dateTime}\nLink: ${event.htmlLink}` }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'drive_search',
  description: 'Search Google Drive for files. Returns file names, types, and links.',
  params: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query — supports Drive query syntax (e.g. "name contains \'report\'" or "type:document modified>2024-01-01")' },
      maxResults: { type: 'number', description: 'Max files (default 10)' },
    },
    required: ['query'],
  },
  async run(args, ctx) {
    const uid = ctx.userId
    if (!uid) return { ok: false, output: 'drive_search requires an authenticated user session.' }
    const q = String(args.query ?? '')
    const max = Math.min(20, Number(args.maxResults ?? 10))
    try {
      const data = await gFetch(uid, `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=${max}&fields=files(id,name,mimeType,modifiedTime,webViewLink,size)`)
      const files: any[] = data.files ?? []
      if (!files.length) return { ok: true, output: 'No files found.' }
      const lines = files.map(f => `[${f.id}] ${f.name}\n  Type: ${f.mimeType}\n  Modified: ${f.modifiedTime ?? ''}\n  Link: ${f.webViewLink ?? 'n/a'}`)
      return { ok: true, output: lines.join('\n\n'), entities: driveFiles(files) }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'drive_read',
  description: 'Read the text content of a Google Drive file. Works for Google Docs, Sheets (as CSV), and plain text files. Get the file ID from drive_search.',
  params: {
    type: 'object',
    properties: {
      fileId: { type: 'string', description: 'Google Drive file ID from drive_search' },
      mimeType: { type: 'string', description: 'File MIME type (e.g. application/vnd.google-apps.document). Used to choose export format.' },
    },
    required: ['fileId'],
  },
  async run(args, ctx) {
    const uid = ctx.userId
    if (!uid) return { ok: false, output: 'drive_read requires an authenticated user session.' }
    const id = String(args.fileId)
    const mime = String(args.mimeType ?? '')
    try {
      let content: string
      if (mime.includes('google-apps.document')) {
        content = await gFetch(uid, `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=text/plain`)
      } else if (mime.includes('google-apps.spreadsheet')) {
        content = await gFetch(uid, `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=text/csv`)
      } else {
        content = await gFetch(uid, `https://www.googleapis.com/drive/v3/files/${id}?alt=media`)
      }
      return { ok: true, output: String(content).slice(0, 6000) }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'contacts_search',
  description: 'Search the user\'s Google Contacts. Returns names, emails, and phone numbers.',
  params: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Name or email to search for' },
    },
    required: ['query'],
  },
  async run(args, ctx) {
    const uid = ctx.userId
    if (!uid) return { ok: false, output: 'contacts_search requires an authenticated user session.' }
    const q = encodeURIComponent(String(args.query ?? ''))
    try {
      const data = await gFetch(uid, `https://people.googleapis.com/v1/people:searchContacts?query=${q}&readMask=names,emailAddresses,phoneNumbers`)
      const results: any[] = data.results ?? []
      if (!results.length) return { ok: true, output: 'No contacts found.' }
      const lines = results.map(r => {
        const p = r.person
        const name = p?.names?.[0]?.displayName ?? 'Unknown'
        const email = p?.emailAddresses?.map((e: any) => e.value).join(', ') ?? ''
        const phone = p?.phoneNumbers?.map((e: any) => e.value).join(', ') ?? ''
        return `${name}${email ? `\n  Email: ${email}` : ''}${phone ? `\n  Phone: ${phone}` : ''}`
      })
      return { ok: true, output: lines.join('\n\n'), entities: contactEntities(results) }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'youtube_search_api',
  description: 'Search YouTube using the official API — more reliable than scraping. Returns video titles, channels, and URLs. Use in preference to search_youtube when the user has signed in with Google.',
  params: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search terms' },
      maxResults: { type: 'number', description: 'Number of results (default 5, max 10)' },
    },
    required: ['query'],
  },
  async run(args, ctx) {
    const uid = ctx.userId
    if (!uid) return { ok: false, output: 'youtube_search_api requires Google sign-in.' }
    const q = String(args.query ?? '')
    const max = Math.min(10, Number(args.maxResults ?? 5))
    try {
      const data = await gFetch(uid, `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=${encodeURIComponent(q)}&maxResults=${max}`)
      const items: any[] = data.items ?? []
      if (!items.length) return { ok: true, output: 'No results found.' }
      const lines = items.map((item: any) => {
        const s = item.snippet
        return `${s.title}\n  Channel: ${s.channelTitle}\n  URL: https://www.youtube.com/watch?v=${item.id.videoId}`
      })
      return { ok: true, output: lines.join('\n\n'), entities: youtubeVideos(items) }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'fitness_activity',
  description: 'Get the user\'s Google Fit activity data — steps, calories, distance, active minutes.',
  params: {
    type: 'object',
    properties: {
      days: { type: 'number', description: 'How many days back to fetch (default 7, max 30)' },
    },
  },
  async run(args, ctx) {
    const uid = ctx.userId
    if (!uid) return { ok: false, output: 'fitness_activity requires Google sign-in.' }
    const days = Math.min(30, Number(args.days ?? 7))
    const endMs = Date.now()
    const startMs = endMs - days * 86400000
    const body = {
      aggregateBy: [
        { dataTypeName: 'com.google.step_count.delta' },
        { dataTypeName: 'com.google.calories.expended' },
        { dataTypeName: 'com.google.distance.delta' },
        { dataTypeName: 'com.google.active_minutes' },
      ],
      bucketByTime: { durationMillis: 86400000 },
      startTimeMillis: startMs,
      endTimeMillis: endMs,
    }
    try {
      const data = await gFetch(uid, 'https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate', {
        method: 'POST', body: JSON.stringify(body),
      })
      const buckets: any[] = data.bucket ?? []
      const lines = buckets.map(b => {
        const date = new Date(Number(b.startTimeMillis)).toLocaleDateString()
        const vals = (typeName: string) => {
          const ds = b.dataset?.find((d: any) => d.dataSourceId?.includes(typeName))
          return ds?.point?.[0]?.value?.[0]?.intVal ?? ds?.point?.[0]?.value?.[0]?.fpVal ?? 0
        }
        const steps = vals('step_count')
        const cals = Math.round(Number(vals('calories')))
        const dist = (Number(vals('distance')) / 1000).toFixed(2)
        const active = vals('active_minutes')
        return `${date}: ${steps} steps, ${cals} kcal, ${dist} km, ${active} active min`
      })
      return { ok: true, output: lines.join('\n') }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'analytics_report',
  description: 'Run a Google Analytics 4 report. Returns page views, sessions, and user metrics for a given date range.',
  params: {
    type: 'object',
    properties: {
      propertyId: { type: 'string', description: 'GA4 property ID (numeric, e.g. "123456789"). Find it in Google Analytics → Admin → Property Settings.' },
      days: { type: 'number', description: 'Date range in days (default 28)' },
      metric: { type: 'string', description: 'Metric to report: sessions | activeUsers | screenPageViews | bounceRate (default: sessions)' },
    },
    required: ['propertyId'],
  },
  async run(args, ctx) {
    const uid = ctx.userId
    if (!uid) return { ok: false, output: 'analytics_report requires Google sign-in.' }
    const propId = String(args.propertyId ?? '').replace(/^properties\//, '')
    const days = Number(args.days ?? 28)
    const metric = String(args.metric ?? 'sessions')
    const body = {
      dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: metric }],
    }
    try {
      const data = await gFetch(uid, `https://analyticsdata.googleapis.com/v1beta/properties/${propId}:runReport`, {
        method: 'POST', body: JSON.stringify(body),
      })
      const rows: any[] = data.rows ?? []
      if (!rows.length) return { ok: true, output: 'No data returned. Check the property ID and date range.' }
      const lines = rows.map(r => `${r.dimensionValues?.[0]?.value}: ${r.metricValues?.[0]?.value}`)
      const total = rows.reduce((s, r) => s + Number(r.metricValues?.[0]?.value ?? 0), 0)
      return { ok: true, output: `${metric} for last ${days} days (property ${propId}):\n${lines.join('\n')}\n\nTotal: ${total}` }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'maps_directions',
  description: 'Get driving, walking, or transit directions between two places using Google Maps.',
  params: {
    type: 'object',
    properties: {
      origin: { type: 'string', description: 'Starting address or place name' },
      destination: { type: 'string', description: 'Destination address or place name' },
      mode: { type: 'string', description: 'Travel mode: driving | walking | transit | bicycling (default: driving)' },
    },
    required: ['origin', 'destination'],
  },
  async run(args) {
    const key = process.env.GOOGLE_MAPS_API_KEY
    if (!key) return { ok: false, output: 'GOOGLE_MAPS_API_KEY not set in .env.local' }
    const origin = encodeURIComponent(String(args.origin))
    const dest   = encodeURIComponent(String(args.destination))
    const mode   = String(args.mode ?? 'driving')
    try {
      const r = await fetch(`https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${dest}&mode=${mode}&key=${key}`)
      const data = await r.json() as any
      if (data.status !== 'OK') return { ok: false, output: `Google Maps: ${data.status} — ${data.error_message ?? ''}` }
      const leg = data.routes?.[0]?.legs?.[0]
      const steps = (leg?.steps ?? []).map((s: any) => `  • ${(s.html_instructions ?? '').replace(/<[^>]+>/g, '')} (${s.duration?.text})`)
      return {
        ok: true,
        output: `Directions from "${args.origin}" to "${args.destination}" by ${mode}:\nDistance: ${leg?.distance?.text}  |  ETA: ${leg?.duration?.text}\n\n${steps.join('\n')}`,
      }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'knowledge_graph_search',
  description: 'Search Google\'s Knowledge Graph for facts about people, places, organisations, and concepts. Returns structured entity data.',
  params: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Entity name or concept to look up' },
      limit: { type: 'number', description: 'Max results (default 3)' },
    },
    required: ['query'],
  },
  async run(args) {
    const key = process.env.GOOGLE_KG_API_KEY ?? process.env.VITE_GEMINI_API_KEY  // fallback to same project key
    if (!key) return { ok: false, output: 'GOOGLE_KG_API_KEY not set in .env.local' }
    const q = encodeURIComponent(String(args.query))
    const limit = Math.min(5, Number(args.limit ?? 3))
    try {
      const r = await fetch(`https://kgsearch.googleapis.com/v1/entities:search?query=${q}&limit=${limit}&indent=True&key=${key}`)
      const data = await r.json() as any
      const items: any[] = data.itemListElement ?? []
      if (!items.length) return { ok: true, output: 'No Knowledge Graph results found.' }
      const lines = items.map(item => {
        const e = item.result
        return `${e.name} (${e['@type']?.join(', ') ?? 'entity'})\n  ${e.description ?? ''}\n  ${e.detailedDescription?.body?.slice(0, 300) ?? ''}`
      })
      return { ok: true, output: lines.join('\n\n') }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'custom_search',
  description: 'Run a Google Custom Search. More accurate than DuckDuckGo scraping. Use when web_search returns poor results.',
  params: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      num: { type: 'number', description: 'Number of results (default 5, max 10)' },
    },
    required: ['query'],
  },
  async run(args) {
    const key = process.env.GOOGLE_CSE_API_KEY
    const cx  = process.env.GOOGLE_CSE_CX
    if (!key || !cx) return { ok: false, output: 'GOOGLE_CSE_API_KEY and GOOGLE_CSE_CX must be set in .env.local' }
    const q   = encodeURIComponent(String(args.query))
    const num = Math.min(10, Number(args.num ?? 5))
    try {
      const r = await fetch(`https://www.googleapis.com/customsearch/v1?q=${q}&num=${num}&key=${key}&cx=${cx}`)
      const data = await r.json() as any
      const items: any[] = data.items ?? []
      if (!items.length) return { ok: true, output: 'No results found.' }
      const lines = items.map((item: any) => `${item.title}\n  ${item.link}\n  ${item.snippet ?? ''}`)
      return { ok: true, output: lines.join('\n\n') }
    } catch (e: any) { return { ok: false, output: e.message } }
  },
})

registry.register({
  name: 'google_services_status',
  description: 'Check which Google services are connected and available for this session. Call this before using any google_* tool if unsure.',
  params: { type: 'object', properties: {} },
  async run(_args, ctx) {
    if (!ctx.userId) return { ok: true, output: 'Not authenticated — no Google services available.' }
    const status = googleServicesStatus(ctx.userId)
    const lines = Object.entries(status).map(([k, v]) => `${v ? '[x]' : '[ ]'} ${k}`)
    return { ok: true, output: `Google services for this session:\n${lines.join('\n')}` }
  },
})

// ── Step 9: Remote Brain — Mac accessibility tools ───────────────────────────

registry.register({
  name: 'get_ui_tree',
  description:
    'Dump the macOS Accessibility tree of the currently focused window as structured text. ' +
    'Returns a list of UI elements (buttons, text fields, menus, links) with their roles and titles. ' +
    'Use this to understand what is on screen before clicking or typing. ' +
    'Call before click_element or type_text to identify the correct target.',
  params: { type: 'object', properties: {} },
  async run() {
    const result = await getUITree()
    return { ok: true, output: result }
  },
})

registry.register({
  name: 'click_element',
  description:
    'Click a UI element on the Mac by its visible title or partial title. ' +
    'Call get_ui_tree first to see what elements are available. ' +
    'Pass the element title as shown in the tree — partial matches are tried automatically.',
  params: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'The visible title or label of the element to click' },
      app: { type: 'string', description: 'Optional: name of the target app (defaults to frontmost app)' },
    },
    required: ['title'],
  },
  mutates: true,
  async run(args) {
    const result = await clickElement(String(args.title), args.app ? String(args.app) : undefined)
    return { ok: !result.startsWith('Click failed') && !result.startsWith('Element not found'), output: result }
  },
})

registry.register({
  name: 'type_text',
  description:
    'Type text into the currently focused field on the Mac. ' +
    'Use click_element first to focus the correct input field, then call type_text to enter text. ' +
    'For pressing Enter/Return after typing, include \\n in the text or call type_text with just "\\n".',
  params: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to type into the focused field' },
    },
    required: ['text'],
  },
  mutates: true,
  async run(args) {
    const result = await typeText(String(args.text ?? ''))
    return { ok: !result.startsWith('Type failed'), output: result }
  },
})

registry.register({
  name: 'control_mac',
  description:
    'Control macOS system settings and actions via reliable native commands — NEVER UI automation. ' +
    'This is ONE tool with many capabilities; always prefer it over get_ui_tree/click_element for ' +
    'system settings (clicking the System Settings sliders is slow, fragile, and fails with -10006). ' +
    'Most actions read the state back to confirm they took effect. ' +
    `Supported intents: ${capabilityIntents().join(', ')}. ` +
    'Examples: {intent:"brightness", percent:50}; {intent:"volume", percent:30}; {intent:"mute", on:true}; ' +
    '{intent:"dark_mode", on:true}; {intent:"wifi", on:false}; {intent:"wifi_connect", ssid:"Home", password:"…"}; ' +
    '{intent:"battery"}; {intent:"sleep"}; {intent:"lock_screen"}. ' +
    'If the action you need is NOT in the supported list, do NOT force it here — use the run tool ' +
    '(shell/osascript), verify it worked, then create_tool to persist a new recipe for next time.',
  params: {
    type: 'object',
    properties: {
      intent: { type: 'string', enum: capabilityIntents(), description: 'Which capability to invoke' },
      percent: { type: 'number', description: 'Target level 0–100 (brightness, volume)' },
      on: { type: 'boolean', description: 'On/off or true/false (mute, dark_mode, wifi)' },
      ssid: { type: 'string', description: 'Wi-Fi network name (wifi_connect)' },
      password: { type: 'string', description: 'Wi-Fi password (wifi_connect)' },
    },
    required: ['intent'],
  },
  mutates: true,
  async run(args) {
    const { intent, ...rest } = args as Record<string, unknown>
    const res = await runCapability(String(intent ?? ''), rest)
    return { ok: res.ok, output: res.output }
  },
})

registry.register({
  name: 'navigate_browser',
  description:
    'Open a URL in the default browser, or bring a named app to the foreground (and launch it if not running). ' +
    'For URLs: pass the full https:// URL. For apps: pass the app name exactly as it appears in Applications (e.g. "Safari", "YouTube", "Settings"). ' +
    'Use this before get_ui_tree when the target app may not be in the foreground. ' +
    'For YouTube searches: use search_youtube to get the real URL first, then pass that URL here.',
  params: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'A URL (https://...) or an app name to bring to focus' },
    },
    required: ['target'],
  },
  mutates: true,
  async run(args) {
    const result = await navigateBrowser(String(args.target ?? ''))
    return { ok: !result.startsWith('navigate_browser failed') && !result.startsWith('App not found'), output: result }
  },
})
