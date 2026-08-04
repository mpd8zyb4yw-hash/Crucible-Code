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
import { lastLookupAnswer } from '../tools/registry'

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
  if (typeof p !== 'string' || !p.startsWith('/')) return p
  // A glob is not a path. Collapse "<dir>/**/*.js" to "<dir>" so the call reaches the directory
  // the user meant rather than failing on a pattern no file tool accepts.
  if (/[*?]/.test(p)) {
    const dir = p.split('/').filter(seg => !/[*?]/.test(seg)).join('/')
    if (dir && fs.existsSync(dir)) return dir
  }
  if (fs.existsSync(p)) return p
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


/**
 * Narrow the tool menu to what this goal could plausibly need.
 *
 * MEASURED 2026-08-03: with all 47 registered tools in the enum, the head selecting the next
 * step of "read prices.csv, total it, write total.txt" wandered into `read_image` and
 * `read_pdf`. The grammar guarantees a VALID name; it cannot make a 47-way choice easy for a
 * 1.5B model. Scoring by literal overlap between the goal and each tool's name/description and
 * keeping the best handful turns a 47-way decision into a ~10-way one, which is the difference
 * between selection and guessing. Purely lexical, no model call.
 *
 * `keep` are tools that must never be pruned: the ones a multi-step task needs at the END,
 * after the goal words have all been consumed by earlier steps.
 */
export function relevantTools(tools: ToolDef[], goal: string, limit = 10): ToolDef[] {
  const KEEP = new Set(['write_file', 'read_file', 'list_dir', 'compute', 'ask_user'])
  const words = new Set(
    goal.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3),
  )
  const score = (t: ToolDef) => {
    const hay = `${t.name} ${typeof t.description === 'string' ? t.description : ''}`.toLowerCase()
    let n = 0
    for (const w of words) if (hay.includes(w)) n++
    // The tool's own name appearing in the goal is a much stronger signal than a description hit.
    if (words.has(t.name.replace(/_/g, ''))) n += 3
    return n
  }
  const scored = tools.map(t => ({ t, s: score(t) })).sort((a, b) => b.s - a.s)
  const out: ToolDef[] = []
  for (const { t } of scored) { if (out.length >= limit) break; out.push(t) }
  for (const t of tools) if (KEEP.has(t.name) && !out.includes(t)) out.push(t)
  return out
}


/**
 * The ordered CATEGORY PLAN a goal implies, derived from its verbs — no model call.
 *
 * MEASURED 2026-08-03: with all 47 tools in one enum the head, trying to total a CSV column,
 * reached for `read_image`, `read_pdf` and once `gmail_search`, and never found `compute`.
 * Narrowing the flat list by lexical overlap made it WORSE (2/5 -> 1/5) — the words in a goal
 * do not name the tools it needs; "add up the amount column" contains no token like `compute`.
 * Asking the head to pick a CATEGORY first was no better: it chose OTHER, the 27-tool bucket.
 *
 * But the goal already states the order. "Read prices.csv, add up the amount column, and write
 * the total into total.txt" is READ, then CALCULATE, then WRITE, in the order the verbs appear.
 * That is string work a machine does exactly, so it does it, and the model is left with the one
 * question it can answer: WHICH file, WHICH expression.
 *
 * DELETE is deliberately absent. Scoping the menu to destructive tools on the strength of the
 * word "delete" removes every non-destructive alternative from the sampler, and measured, that
 * walked the agent straight into deleting two files. Destructive intent must widen the choice,
 * never narrow it — the stakes gate is what handles it, and it needs the agent to still be able
 * to choose something else.
 */
const CATEGORY_VERBS: Array<{ cat: string; rx: RegExp }> = [
  { cat: 'READ', rx: /\b(read|open|inspect|examine|load)\b/gi },
  // "total" is only a verb with an object after it. MEASURED 2026-08-03: "write the TOTAL into
  // total.txt" contributed a phantom fourth CALCULATE step, so after read -> sum -> compute the
  // plan pointed at CALCULATE again and the agent never reached the write. A noun is not an
  // instruction.
  { cat: 'CALCULATE', rx: /\b(add up|sum|calculate|compute|work out|average)\b|\btotal(?:s|ling|ing)?\s+(?:up\s+)?the\b/gi },
  { cat: 'SEARCH', rx: /\b(search|find out|look up|research)\b/gi },
  // Edit-in-place verbs are WRITE verbs — renaming a symbol changes the file. They also trigger
  // the READ prepend below, because edit_file's contract needs the exact existing string.
  { cat: 'WRITE', rx: /\b(write|create|save|record|output|store|rename|replace|edit|update|modify)\b/gi },
]

/** Tools per plan category. Deliberately small and non-destructive. */
const PLAN_TOOLS: Record<string, string[]> = {
  READ: ['read_file', 'list_dir'],
  CALCULATE: ['sum_column', 'compute'],
  // lookup_fact first: web_search is the dead DDG scraper, lookup_fact is the answer engine.
  SEARCH: ['lookup_fact', 'web_search'],
  WRITE: ['write_file', 'edit_file', 'rename_symbol'],
}

export function categoryPlan(goal: string): string[] {
  // Strip filesystem paths FIRST. MEASURED 2026-08-03: the scratch directory for the
  // read-then-write task is literally named ".../read-then-write", so the path contributed a
  // spurious WRITE and the plan came out READ, WRITE, CALCULATE — putting the write step before
  // the total had been computed. A path is a NAME, not an instruction; only the prose the user
  // wrote states the order.
  const prose = (goal ?? '').replace(/(?:\/[\w.@+-]+)+/g, ' ')
  const hits: Array<{ at: number; cat: string }> = []
  for (const { cat, rx } of CATEGORY_VERBS) {
    for (const m of prose.matchAll(rx)) hits.push({ at: m.index ?? 0, cat })
  }
  hits.sort((a, b) => a.at - b.at)
  const out: string[] = []
  for (const h of hits) if (out[out.length - 1] !== h.cat) out.push(h.cat)
  // An EDIT-IN-PLACE verb implies a read first: you cannot rename a symbol in a file you have
  // not looked at, and edit_file's contract needs the exact existing string. MEASURED: the
  // rename task planned WRITE as step one, so the agent was offered only write tools and
  // returned empty. Prepending READ is not a guess — it is the precondition of the edit.
  if (/\b(rename|replace|update|edit|change|modify|fix)\b/i.test(prose) && out[0] !== 'READ') out.unshift('READ')
  return out
}

/**
 * The tools to offer for step N of the plan, or null when the plan does not cover this step.
 * Null means "offer everything" — the plan is a hint, never a cage.
 */
export function plannedTools(tools: ToolDef[], goal: string, stepsDone: number): ToolDef[] | null {
  const plan = categoryPlan(goal)
  // Clamp to the LAST planned step rather than falling back to the full 47-tool menu once the
  // plan is exhausted. MEASURED 2026-08-03: after rename_symbol succeeded, the next turn got the
  // unrestricted menu, chose write_file, and overwrote a.js with the 7 characters "newName".
  // A plan that has run out is a signal the goal is done, not a licence to try anything.
  const cat = plan[stepsDone] ?? plan[plan.length - 1]
  if (!cat) return null
  let list = PLAN_TOOLS[cat] ?? []
  // A goal that names a COLUMN is a column sum, and `sum_column` reads every row itself.
  // MEASURED 2026-08-03: offered both, the head chose `compute` and hand-built the expression
  // "229.50 + 12.75", silently dropping the first row — total.txt got 242.25 instead of 292.24.
  // Handing the model a calculator only moves the guess from the arithmetic to the
  // TRANSCRIPTION, so where an exact tool exists the approximate one is removed.
  if (cat === 'CALCULATE' && /\bcolumn\b/i.test(goal)) list = ['sum_column']
  // A goal about FILES (plural) or a wildcard cannot start with read_file: there is no single
  // file to read. MEASURED 2026-08-03 on multi-file-edit — the head answered the READ step with
  // read_file("<dir>/**/*.js"), a glob no file tool accepts, and the run ended there. Which
  // files exist is a question the filesystem answers, so the step is list_dir and the head is
  // never asked to guess a filename it has not been shown.
  if (cat === 'READ' && /\b\w+ files\b|\bfiles\b.*\b(in|under|inside)\b|\*\.[a-z]+/i.test(goal)) list = ['list_dir']
  // A RENAME gets exactly one tool. MEASURED 2026-08-03: edit_file refused (its contract needs
  // the old string exactly once, and a rename hits every occurrence), and the head then fell
  // back to write_file and OVERWROTE the file with invented content. Leaving write_file on the
  // menu for a rename is leaving a loaded data-loss path in reach of a model that has not read
  // the file. rename_symbol does the whole operation exactly, so it is the only offer.
  if (cat === 'WRITE' && /\brename\b/i.test(goal)) list = ['rename_symbol']
  const names = new Set(list)
  const picked = tools.filter(t => names.has(t.name))
  return picked.length ? picked : null
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
    // NOTE: relevantTools() below is deliberately NOT applied. Measured 2026-08-03, narrowing
    // the menu to 13 goal-relevant tools took the probe from 2/5 to 1/5 — write-file, which had
    // been passing, started returning an empty reply. Kept as a tested function for a future
    // attempt with a better relevance signal; wiring it in without moving the number is exactly
    // the 'this should help' change the standing rule bans.
    // Step N of the goal's own verb plan narrows the menu to a handful; anything the plan does
    // not cover, or any retry after a blocked repeat, falls back to the full set.
    // The plan is finished — stop. MEASURED 2026-08-03: on write-file the agent wrote
    // "Crucible agent test" CORRECTLY, then took another turn and called edit_file to change it
    // to "crucible-agent-test", corrupting work that was already right. A model with a tool and
    // no remaining instruction will keep using the tool. The plan knows when the verbs are
    // spent, and postconditions.ts is what decides whether the result is actually good — the
    // driver's job is only to stop proposing.
    const plan = categoryPlan(goal)
    if (plan.length > 0) {
      // A step counts as done only when a tool BELONGING TO IT succeeded. Counting raw successes
      // let an off-plan call consume a step: on read-then-write the agent did read_file,
      // sum_column and then an incidental compute, hit three successes against a three-step
      // plan, and stopped before ever writing total.txt — reporting "every step has been
      // carried out" over an empty output file.
      const doneNames = new Set([...succeeded].map(sig => sig.slice(0, sig.indexOf('('))))
      const allStepsDone = plan.every(cat => (PLAN_TOOLS[cat] ?? []).some(n => doneNames.has(n)))
      if (allStepsDone) return { text: 'Every step of the request has been carried out.', toolCalls: [] }
    }

    // Which plan step we are on = how many leading categories have a successful call of their
    // own. Raw success count drifts as soon as the agent makes any off-plan call.
    const doneNames2 = new Set([...succeeded].map(sig => sig.slice(0, sig.indexOf('('))))
    let stepIdx = 0
    while (stepIdx < plan.length && (PLAN_TOOLS[plan[stepIdx]] ?? []).some(n => doneNames2.has(n))) stepIdx++
    const planned = attempt === 0 ? plannedTools(tools, goal, stepIdx) : null
    const usable = (planned ?? tools).filter(t => !excluded.has(t.name))
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
    // A rename asked for "in the .js files" of a FOLDER must be applied to the folder. MEASURED:
    // the head passed a.js, rename_symbol correctly renamed a.js only, and b.js was left
    // untouched — a half-done rename, which is worse than none. The goal states the scope, so
    // the machine widens the path back to the directory the user named.
    // When the goal DICTATES the file's content verbatim, use it. MEASURED 2026-08-03: asked for
    // a file "containing exactly the line: Crucible agent test", the head wrote
    // "crucible-agent-test" — it had reached for the scratch directory's name instead of the
    // literal three words in front of it. "Exactly" is a promise the machine can keep and the
    // model cannot; copying a quoted literal is transcription, not reasoning.
    if (tool.name === 'write_file' && typeof args.content === 'string') {
      const lit = /\bcontain(?:ing|s)?\s+(?:exactly\s+)?(?:the\s+)?(?:line|text|string)\s*:?\s*["“']?([^"”'\n]{3,200}?)\.?\s*$/i.exec(goal)
      if (lit) args.content = lit[1].trim()
    }

    // A verified answer already in hand is not re-authored from memory. MEASURED 2026-08-03 on
    // research-to-file: lookup_fact returned "the current Node.js LTS line is 24" with its
    // source, and the head then wrote a node.md saying "Node.js is v14.1.0" — a hallucinated
    // version, written to disk, in a file whose entire purpose was to record the looked-up fact.
    // The retrieval was right and the transcription invented a different answer, which is the
    // single most dangerous shape this product has: a confident artifact contradicting its own
    // evidence. When a lookup succeeded and the model's content does not carry the numbers the
    // lookup returned, the lookup's text is used instead.
    if (tool.name === 'write_file' && typeof args.content === 'string') {
      // Accept ANY lookup_fact result, not just a [verified] one — measured, the same question
      // asked in a slightly different phrasing came back [unverified] from the research DAG, the
      // filter skipped it, and the head wrote v14.1.0 "sourced from Wikipedia" regardless. An
      // unverified retrieved answer is still evidence; an invented one is not. A verified result
      // wins when both are present.
      const all = messages
        .filter(m => m.role === 'tool' && typeof m.content === 'string' && /^\(ok\)\s*\[(verified|unverified|abstained)\]/.test(m.content as string))
        .map(m => (m.content as string).replace(/^\(ok\)\s*\[(verified|unverified|abstained)\]\s*/, (x) => x))
      const verified = all.filter(t => /\[verified\]/.test(t))
      const pool = verified.length ? verified : all
      let last = pool[pool.length - 1]?.replace(/^\(ok\)\s*\[(verified|unverified|abstained)\]\s*/, '')
      // Nothing in THIS subtask's history? Fall back to the shared scratchpad — the meta-router
      // splits a goal across subtasks that cannot see each other's messages, and the answer may
      // have been retrieved by a sibling.
      if (!last) last = lastLookupAnswer()?.output.replace(/^\[(verified|unverified|abstained)\]\s*/, '')
      if (last) {
        const nums = (n: string) => new Set((n.match(/\d+(?:\.\d+)*/g) ?? []))
        const want = nums(last.split(/Sources?:/i)[0])
        const got = nums(args.content)
        const carried = [...want].some(v => got.has(v))
        if (!carried) args.content = last.trim()
      }
    }

    // A goal that asks for the SOURCE gets the source. MEASURED 2026-08-03 on research-to-file:
    // lookup_fact returned the answer WITH "Source: https://endoflife.date/nodejs" in the tool
    // result, and the head then wrote a node.md carrying the version but not the URL — dropping
    // the one thing that makes the claim checkable. The URL is already in hand; keeping it is
    // copying, not reasoning, so the machine appends it rather than hoping.
    if (tool.name === 'write_file' && typeof args.content === 'string'
        && /\bsource|\bcite|\breference/i.test(goal) && !/https?:\/\//.test(args.content)) {
      // Scan the RAW messages: ledger() truncates each tool result to 200 chars and the URL
      // sits past that cut, so searching the ledger found nothing.
      const hay = messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')).join(' ')
      const urls = Array.from(new Set(
        (hay.match(/https?:\/\/[^\s)\]",]+/g) ?? []).map(u => u.replace(/[.,;]+$/, '')),
      ))
      if (urls.length) args.content = `${args.content.replace(/\s+$/, '')}\n\nSource: ${urls[0]}\n`
    }

    if (tool.name === 'rename_symbol' && /\bfolder\b|\bfiles\b|\beverywhere\b|\ball\b/i.test(goal)) {
      const p0 = args.path
      if (typeof p0 === 'string' && p0) {
        try { if (fs.statSync(p0).isFile()) args.path = path.dirname(p0) } catch { /* leave as-is */ }
      }
    }

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
