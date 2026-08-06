// Dynamic tool acquisition — Gap 2.
// The agent can write and register its own tools at runtime when the built-in
// set doesn't cover what it needs. Approved tools are persisted to
// .crucible/dynamic-tools/ and reloaded on every server start.
//
// Security model: same as the existing `run` tool — the agent already has shell
// access, so executing JS tool bodies is not a privilege escalation.

import fs from 'fs'
import path from 'path'
import vm from 'vm'
import { createRequire } from 'module'
import type { ToolDef, ToolCtx, ToolResult } from './protocol'

const _require = createRequire(import.meta.url)
import { crucibleDir } from '../state/session'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DynamicToolRecord {
  name: string
  description: string
  params: Record<string, unknown>
  body: string        // async JS function body string — receives (args, ctx)
  createdAt: number
  createdBy: string   // session id or 'agent'
  useCount: number
  successCount: number   // I6: successful invocations without error
  lastUsed: number | null
  tier: 'session' | 'specialist' | 'global'   // I6 graduation tier
  graduationPending?: boolean                  // flagged for triumvirate review
}

// ── Paths ─────────────────────────────────────────────────────────────────────

export function dynamicToolsDir(projectPath: string): string {
  return path.join(crucibleDir(projectPath), 'dynamic-tools')
}

function toolFile(projectPath: string, name: string): string {
  return path.join(dynamicToolsDir(projectPath), `${name}.json`)
}

// ── Compile a tool body into a run() function ─────────────────────────────────
// Uses vm.Script to catch syntax errors at compile time, then wraps the body
// in an AsyncFunction for execution. Security model: the agent already has shell
// access, so this is not a privilege escalation — we just validate syntax.

export function compileTool(body: string): (args: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolResult> {
  // Syntax check via vm.Script (throws SyntaxError immediately if body is invalid)
  try {
    new vm.Script(`(async function(args, ctx, require) { ${body} })`)
  } catch (e: any) {
    throw new Error(`Syntax error in tool body: ${e.message}`)
  }

  // Build the actual function with require injected from module scope
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const fn = new AsyncFunction('args', 'ctx', 'require', body)

  return async (args, ctx) => {
    try {
      const result = await fn(args, ctx, _require)
      if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean' || typeof result.output !== 'string') {
        return { ok: false, output: 'Dynamic tool must return { ok: boolean, output: string }' }
      }
      return result as ToolResult
    } catch (e: any) {
      return { ok: false, output: `Dynamic tool threw: ${e?.message ?? e}` }
    }
  }
}

// ── Persist / load ────────────────────────────────────────────────────────────

export function saveDynamicTool(projectPath: string, record: DynamicToolRecord): void {
  const dir = dynamicToolsDir(projectPath)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(toolFile(projectPath, record.name), JSON.stringify(record, null, 2), 'utf-8')
}

export function loadDynamicTool(projectPath: string, name: string): DynamicToolRecord | null {
  try {
    return JSON.parse(fs.readFileSync(toolFile(projectPath, name), 'utf-8'))
  } catch { return null }
}

export function listDynamicTools(projectPath: string): DynamicToolRecord[] {
  try {
    const dir = dynamicToolsDir(projectPath)
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => loadDynamicTool(projectPath, f.replace(/\.json$/, '')))
      .filter((r): r is DynamicToolRecord => r !== null)
      .sort((a, b) => b.createdAt - a.createdAt)
  } catch { return [] }
}

/** Load all persisted dynamic tools into the given registry.register() fn.
 *  Called at server startup so every agent session gets the full earned toolkit. */
export function loadDynamicToolsInto(
  projectPath: string,
  registerFn: (def: ToolDef) => void,
): number {
  const records = listDynamicTools(projectPath)
  let loaded = 0
  for (const record of records) {
    try {
      const run = compileTool(record.body)
      registerFn({
        name: record.name,
        description: record.description,
        params: record.params,
        mutates: false, // dynamic tools start non-mutating; agent can declare otherwise
        run,
      })
      loaded++
    } catch (e: any) {
      console.warn(`[DynamicTools] Failed to load '${record.name}': ${e.message}`)
    }
  }
  if (loaded) console.log(`[DynamicTools] Loaded ${loaded} dynamic tool(s) from ${projectPath}`)
  return loaded
}

// ── I6 — Tool graduation ──────────────────────────────────────────────────────
// Session → specialist: successCount ≥ 5 across sessions
// Specialist → global: successCount ≥ 20 across tasks; requires triumvirate approval

export function recordToolSuccess(projectPath: string, name: string): DynamicToolRecord | null {
  const record = loadDynamicTool(projectPath, name)
  if (!record) return null
  record.useCount += 1
  record.successCount = (record.successCount ?? 0) + 1
  record.lastUsed = Date.now()

  // Check graduation thresholds
  if (record.tier === 'session' && record.successCount >= 5) {
    record.tier = 'specialist'
    record.graduationPending = true
    try {
      const { debugBus } = require('../debug/bus')
      debugBus.emit('agent', 'tool_graduation_specialist', { name, successCount: record.successCount }, { severity: 'info' })
    } catch {}
  } else if (record.tier === 'specialist' && record.successCount >= 20 && !record.graduationPending) {
    record.graduationPending = true
    try {
      const { debugBus } = require('../debug/bus')
      debugBus.emit('agent', 'tool_graduation_global_pending', { name, successCount: record.successCount }, { severity: 'info' })
    } catch {}
  }

  saveDynamicTool(projectPath, record)
  return record
}

export function approveGlobalGraduation(projectPath: string, name: string): boolean {
  const record = loadDynamicTool(projectPath, name)
  if (!record || record.tier !== 'specialist' || !record.graduationPending) return false
  record.tier = 'global'
  record.graduationPending = false
  saveDynamicTool(projectPath, record)
  return true
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export function dynamicToolStats(projectPath: string) {
  const tools = listDynamicTools(projectPath)
  return {
    count: tools.length,
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      useCount: t.useCount,
      successCount: t.successCount ?? 0,
      tier: t.tier ?? 'session',
      graduationPending: t.graduationPending ?? false,
      createdAt: t.createdAt,
      lastUsed: t.lastUsed,
    })),
  }
}
