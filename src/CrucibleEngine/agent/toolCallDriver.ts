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
    const choices = [...tools.map(t => t.name), FINISH]
    const selectSystem = [
      'You are the executor of a task. You act by choosing ONE tool to call next.',
      '',
      'TOOLS:',
      toolMenu(tools),
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

    const picked = (await complete(
      [{ role: 'system', content: selectSystem }, { role: 'user', content: selectUser }],
      { gbnf: enumGrammar(choices), maxTokens: 16, temperature: 0, signal },
    )).trim()

    if (!picked || picked === FINISH) {
      return { text: picked === FINISH ? 'Goal complete.' : 'No action selected.', toolCalls: [] }
    }
    const tool = byName.get(picked)
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
    let args: Record<string, unknown>
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

    return {
      text: `Calling ${tool.name}.`,
      toolCalls: [{ id: nextId(), name: tool.name, args }],
    }
  }
}
