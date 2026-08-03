// ═══════════════════════════════════════════════════════════════════════════════
// GENERAL-PURPOSE TOOL-CALLING DRIVER (grammar-constrained, on-device)
// ═══════════════════════════════════════════════════════════════════════════════
//
// MEASURED 2026-08-03 (`npm run agent:workflow`): the agentic path scored **0/5** on ordinary
// multi-step assistant tasks — write a file, read a CSV and total it, rename a symbol across
// two files, research-then-write, and confirm-before-destroying. Three of the five ended with
// ZERO tool calls; one reported "The file prices.csv has been successfully read and added. No
// problems were flagged" with nothing on disk.
//
// The cause is not that the head is small. It is that on the offline path there was no
// general tool-calling driver at all. `makeOfflineDriveTurn` is a CODE-SYNTHESIS state machine
// (S0–S6: parse goal paths → write file → run self-test → done), built for the coding-agent
// scope this product abandoned at 2/9. Point it at "sum the amount column and write total.txt"
// and it misparses the goal, emits no usable call, and the loop's refusal bounce fires.
//
// So this file supplies the missing piece, built the way DOCTRINE §1 says to build it: the
// SYSTEM does the thinking, the model only PROPOSES, and the shape is never left to chance.
// One turn is two small constrained generations:
//
//   1. SELECT — which tool (or FINISH). Constrained by `enumGrammar` to the literal tool
//      names, so "I cannot do that" is not in the sampler's output space. This alone kills
//      the three zero-tool-call refusals: prose is unsamplable.
//   2. FILL   — the arguments for the tool it chose, constrained by `jsonObjectGrammar` built
//      from that tool's OWN schema, so the closing brace and every required key are
//      guaranteed. Malformed JSON stops being a failure mode rather than being repaired
//      after the fact.
//
// Neither call asks the model to invent structure, and neither trusts what it says about what
// it did — that is `postconditions.ts`'s job. This driver only makes a well-formed proposal
// reachable. It is deliberately provider-agnostic: it takes a completion function, so the same
// driver works against the local head, the Apple FM, or any escalated model.
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs'
import path from 'node:path'
import { enumGrammar, jsonObjectGrammar } from './grammars'
import type { ToolDef, ToolCall } from '../tools/protocol'

/** Minimal completion contract — (messages, opts) → text. Matches fmComplete. */
export type Complete = (
  messages: Array<{ role: string; content: string }>,
  opts?: { gbnf?: string; maxTokens?: number; temperature?: number; signal?: AbortSignal },
) => Promise<string>

export interface DriveTurnResult { text: string; toolCalls: ToolCall[] }

/** The literal the model emits when it believes the goal is met. Never a tool name. */
export const FINISH = 'FINISH'

/** JSON Schema primitive → the grammar's field type. Everything else is carried as a string. */
function fieldType(schema: unknown): 'string' | 'number' | 'boolean' {
  const t = (schema as { type?: unknown } | null)?.type
  if (t === 'number' || t === 'integer') return 'number'
  if (t === 'boolean') return 'boolean'
  return 'string'
}

/**
 * The argument keys this tool actually needs, in schema order.
 *
 * Only REQUIRED keys are put in the grammar. A grammar with every optional key forces the head
 * to invent values for parameters the task does not use — measured on `write_file`, which has
 * optional flags the model happily filled with plausible nonsense once they were samplable.
 * Optional arguments are therefore unreachable in one turn by design; a tool that genuinely
 * needs one exposes it as required or gets a second call.
 */
export function requiredFields(tool: ToolDef): Array<{ key: string; type: 'string' | 'number' | 'boolean' }> {
  const params = (tool.params ?? {}) as { properties?: Record<string, unknown>; required?: unknown }
  const props = params.properties ?? {}
  const required = Array.isArray(params.required) ? params.required.filter(k => typeof k === 'string') as string[] : []
  const keys = required.length ? required : Object.keys(props).slice(0, 3)
  return keys
    // The grammar builder rejects unsafe keys; drop them here rather than throw mid-turn.
    .filter(k => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && k in props)
    .map(k => ({ key: k, type: fieldType((props as Record<string, unknown>)[k]) }))
}


/** Levenshtein distance, bounded — only used to compare short filenames. */
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

/**
 * Snap a path argument to a file that actually exists.
 *
 * MEASURED 2026-08-03: asked to read `prices.csv`, the head emitted `price.csv` — one character
 * short — and then repeated that exact failing call until the loop stopped it. The grammar can
 * force a well-formed string; it cannot force a TRUE one. But the filesystem knows the answer,
 * so the system checks rather than trusting: if the proposed file does not exist and exactly one
 * sibling in the same directory is within a couple of edits, use the sibling. Ambiguity (two
 * equally close candidates) is left alone — a wrong confident correction is worse than the
 * original error, and the failed-repeat exclusion below will move the agent on regardless.
 *
 * Only applies to READS. A near-miss filename on a WRITE is a new file the user asked for, and
 * silently redirecting a write onto an existing file would destroy data.
 */
export function snapPathToReality(p: string): string {
  if (typeof p !== 'string' || !p.startsWith('/') || fs.existsSync(p)) return p
  const dir = path.dirname(p), base = path.basename(p)
  let siblings: string[]
  try { siblings = fs.readdirSync(dir) } catch { return p }
  const scored = siblings
    .map(s => ({ s, d: editDistance(base.toLowerCase(), s.toLowerCase()) }))
    .filter(x => x.d <= 2)
    .sort((a, b) => a.d - b.d)
  if (!scored.length) return p
  if (scored.length > 1 && scored[0].d === scored[1].d) return p
  return path.join(dir, scored[0].s)
}

/** Render the tool menu compactly. A 1.5B head reads a short list far better than a schema dump. */
export function toolMenu(tools: ToolDef[]): string {
  return tools.map(t => {
    const args = requiredFields(t).map(f => f.key).join(', ')
    // A tool registered without a description is not a reason to take down the turn.
    const desc = typeof t.description === 'string' ? t.description : ''
    return `- ${t.name}(${args}) — ${desc.split('\n')[0].slice(0, 110)}`
  }).join('\n')
}

/**
 * Signatures of calls that ALREADY SUCCEEDED, as `name(argsJson)`.
 *
 * The ledger alone did not stop the repeat — measured, the head still re-picked `read_file` on
 * a file it had just read. Telling a 1.5B model not to repeat itself is advice; removing the
 * option is a constraint, and DOCTRINE §1 says to prefer the constraint. A tool whose identical
 * call has already succeeded is dropped from the SELECT enum, so re-picking it is unsamplable
 * and the head must choose the next step. Only exact (name, args) pairs are excluded — reading
 * a DIFFERENT file, or writing a second file, stays available.
 */
export function attemptedSignatures(messages: Array<Record<string, unknown>>): Map<string, boolean> {
  const out = new Map<string, boolean>()
  let pending: string[] = []
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      pending = (m.tool_calls as Array<Record<string, unknown>>).map(tc => {
        const fn = (tc.function ?? {}) as { name?: string; arguments?: string }
        return `${fn.name ?? ''}(${fn.arguments ?? ''})`
      })
    } else if (m.role === 'tool') {
      const sig = pending.shift()
      if (sig) out.set(sig, String(m.content ?? '').startsWith('(ok)'))
    }
  }
  return out
}

export function succeededSignatures(messages: Array<Record<string, unknown>>): Set<string> {
  const out = new Set<string>()
  let pending: string[] = []
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      pending = (m.tool_calls as Array<Record<string, unknown>>).map(tc => {
        const fn = (tc.function ?? {}) as { name?: string; arguments?: string }
        return `${fn.name ?? ''}(${fn.arguments ?? ''})`
      })
    } else if (m.role === 'tool') {
      const c = String(m.content ?? '')
      const sig = pending.shift()
      if (sig && c.startsWith('(ok)')) out.add(sig)
    }
  }
  return out
}

/**
 * An explicit ledger of the tool calls already made and how they went.
 *
 * MEASURED 2026-08-03: on "read prices.csv, total the amount column, write total.txt" the
 * driver called `read_file`, got the CSV back, and then called `read_file` again, and again,
 * until the loop's stall detector stopped it. A raw transcript buries "what has been done" in
 * amongst assistant chatter and tool payloads, and a 1.5B head reading 8 mixed messages cannot
 * reliably infer which step it is on. State it, rather than hoping the model derives it.
 */
function ledger(messages: Array<Record<string, unknown>>): string {
  const lines: string[] = []
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls as Array<Record<string, unknown>>) {
        const fn = (tc.function ?? {}) as { name?: string; arguments?: string }
        if (fn.name) lines.push(`  called ${fn.name}(${String(fn.arguments ?? '').slice(0, 120)})`)
      }
    } else if (m.role === 'tool') {
      const c = String(m.content ?? '')
      lines.push(`    -> ${c.slice(0, 200).replace(/\s+/g, ' ')}`)
    }
  }
  return lines.length ? lines.join('\n') : '  (no tool has been called yet)'
}

/** Last N messages flattened to a short transcript the head can actually hold. */
function recentContext(messages: Array<Record<string, unknown>>, n = 8): string {
  return messages.slice(-n).map(m => {
    const role = String(m.role ?? '')
    let content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
    if (content.length > 600) content = content.slice(0, 600) + ' …[truncated]'
    return `${role}: ${content}`
  }).join('\n')
}

let seq = 0
const nextId = () => `tc_${Date.now().toString(36)}_${(seq++).toString(36)}`

/**
 * Build a DriveTurn that proposes ONE tool call per turn, with both stages grammar-constrained.
 *
 * Returns `{text, toolCalls: []}` when the model selects FINISH — the loop treats a turn with
 * no tool calls as a final answer, which is exactly the intended handoff.
 */
export function makeToolCallDriveTurn(complete: Complete, goal: string) {
  return async function toolCallDriveTurn(
    messages: Array<Record<string, unknown>>,
    tools: ToolDef[],
    signal?: AbortSignal,
  ): Promise<DriveTurnResult> {
    if (signal?.aborted) throw new Error('Aborted')
    if (!tools.length) return { text: 'No tools are available for this task.', toolCalls: [] }

    const byName = new Map(tools.map(t => [t.name, t]))
    const ctx = recentContext(messages)
    const done = ledger(messages)

    // ── Stage 1: SELECT ───────────────────────────────────────────────────────────
    // The choice set is the grammar. Refusal prose is not in it.
    // A tool that has already succeeded TWICE is dropped from the choice set. The measured
    // loop was `read_file` on the same path over and over until the stall detector fired; the
    // loop's own guard stops at three identical turns, so two successes is the point where
    // continuing cannot be progress. Reading a different file the first two times still works,
    // and FINISH is never removed.
    const attempted = attemptedSignatures(messages)
    const succeeded = succeededSignatures(messages)
    const successCount = new Map<string, number>()
    for (const sig of succeeded) {
      const name = sig.slice(0, sig.indexOf('('))
      successCount.set(name, (successCount.get(name) ?? 0) + 1)
    }
    // Tools ruled out THIS turn: two prior successes, or a repeat blocked below. A blocked
    // repeat must not end the turn — MEASURED, returning zero tool calls made the loop treat
    // "you already read that file" as a FINAL ANSWER, so the run ended having done half the
    // goal. Re-select instead, with the dead option removed.
    const excluded = new Set<string>()
    for (const [name, n] of successCount) if (n >= 2) excluded.add(name)
    let picked = '', tool: ToolDef | undefined, args: Record<string, unknown> = {}
    for (let attempt = 0; attempt < 3; attempt++) {
    const usable = tools.filter(t => !excluded.has(t.name))
    const choices = [...(usable.length ? usable : tools).map(t => t.name), FINISH]
    const selectSystem = [
      'You are the executor of a task. You act by choosing ONE tool to call next.',
      '',
      'TOOLS:',
      toolMenu(usable.length ? usable : tools),
      '',
      `Reply with EXACTLY ONE of these words and nothing else: ${choices.join(', ')}`,
      `Choose ${FINISH} only when the goal is already fully achieved by the work shown below.`,
      'Never explain. Never apologise. Never say you cannot — choose the closest useful tool.',
      'Do NOT repeat a call that already succeeded. Look at STEPS ALREADY DONE and choose the NEXT',
      'step of the goal. A goal with several verbs ("read X … write Y") needs one call per verb.',
    ].join('\n')
    const selectUser = [
      `GOAL: ${goal}`, '',
      'STEPS ALREADY DONE:', done, '',
      'RECENT CONTEXT:', ctx || '(nothing yet)', '',
      'Which single tool next?',
    ].join('\n')

    picked = (await complete(
      [{ role: 'system', content: selectSystem }, { role: 'user', content: selectUser }],
      { gbnf: enumGrammar(choices), maxTokens: 16, temperature: 0, signal },
    )).trim()

    if (!picked || picked === FINISH) {
      return { text: picked === FINISH ? 'Goal complete.' : 'No action selected.', toolCalls: [] }
    }
    tool = byName.get(picked)
    if (!tool) {
      // The grammar makes this unreachable on a grammar-aware backend; on one that ignores
      // GBNF it is the honest fallthrough rather than a silently mangled call.
      return { text: `Selected an unknown tool (${picked.slice(0, 40)}).`, toolCalls: [] }
    }

    // ── Stage 2: FILL ─────────────────────────────────────────────────────────────
    const fields = requiredFields(tool)
    if (!fields.length) {
      return { text: `Calling ${tool.name}.`, toolCalls: [{ id: nextId(), name: tool.name, args: {} }] }
    }
    const fillSystem = [
      `Fill in the arguments for the tool ${tool.name}.`,
      (typeof tool.description === 'string' ? tool.description : '').slice(0, 400),
      '',
      `Output ONLY a JSON object with exactly these keys, in this order: ${fields.map(f => f.key).join(', ')}`,
      'Use absolute paths exactly as they appear in the goal. Copy values from the goal verbatim where possible.',
    ].join('\n')
    const fillUser = [
      `GOAL: ${goal}`, '',
      'STEPS ALREADY DONE:', done, '',
      'RECENT CONTEXT:', ctx || '(nothing yet)', '',
      `Arguments for ${tool.name}:`,
    ].join('\n')

    const raw = await complete(
      [{ role: 'system', content: fillSystem }, { role: 'user', content: fillUser }],
      { gbnf: jsonObjectGrammar(fields), maxTokens: 900, temperature: 0, signal },
    )

    // A backend that ignored the grammar can still emit junk. Anything short of a parsed object
    // carrying every required key is a FAILED TURN, never a call with the gaps left empty:
    // `write_file` with no path is not a degraded write, it is a different action. The bench
    // caught exactly this — refusal prose contains no "{", which silently became `args: {}`.
    const s = raw.indexOf('{'); const e = raw.lastIndexOf('}')
    if (s < 0 || e <= s) return { text: `No arguments returned for ${tool.name}.`, toolCalls: [] }
    try {
      const parsed = JSON.parse(raw.slice(s, e + 1))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      args = parsed as Record<string, unknown>
    } catch {
      return { text: `Could not read arguments for ${tool.name}.`, toolCalls: [] }
    }
    const missing = fields.filter(f => args[f.key] === undefined || args[f.key] === null || args[f.key] === '')
    if (missing.length) {
      return { text: `Incomplete arguments for ${tool.name} (missing ${missing.map(f => f.key).join(', ')}).`, toolCalls: [] }
    }

    // Snap read-side path arguments onto a file that actually exists (see snapPathToReality).
    // Writes are never redirected: a near-miss filename on a write is a NEW file.
    if (!tool.mutates) {
      for (const f of fields) {
        if (f.type === 'string' && /path|file|dir/i.test(f.key) && typeof args[f.key] === 'string') {
          const snapped = snapPathToReality(args[f.key] as string)
          if (snapped !== args[f.key]) args[f.key] = snapped
        }
      }
    }

    // An identical call that ALREADY FAILED will fail again. Measured: read_file on a
    // mistyped path repeated until the loop's stall guard fired, burning the whole run on one
    // typo. Report it as a failed turn so the loop's error hint pushes the head somewhere new,
    // rather than re-issuing a call whose outcome is already known.
    const sig = `${tool.name}(${JSON.stringify(args)})`
    if (attempted.has(sig)) {
      // Do not end the turn — rule this tool out and pick again. Falls through to the loop's
      // next attempt; only if three attempts all land on already-done work do we report it.
      excluded.add(tool.name)
      if (attempt < 2) continue
      // Succeeded OR failed, an identical call cannot advance the goal: a re-read returns the
      // same bytes, a re-failure returns the same error. Measured both ways -- read_file on a
      // mistyped path, then read_file on the CORRECT path six times running. The count-based
      // exclusion at SELECT does not catch this because the tool is legitimately still needed
      // for other paths; the exact signature is what must be unreachable.
      const how = attempted.get(sig) ? 'already succeeded' : 'already failed'
      return { text: `${tool.name} ${how} with exactly these arguments — that result is already in hand; the next step of the goal is what remains.`, toolCalls: [] }
    }

    return {
      text: `Calling ${tool.name}.`,
      toolCalls: [{ id: nextId(), name: tool.name, args }],
    }
    }
    return { text: 'Every available next action has already been carried out.', toolCalls: [] }
  }
}
