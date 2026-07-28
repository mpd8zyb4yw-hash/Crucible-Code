// The agent run, as ONE derived surface (cont.118).
//
// WHY THIS EXISTS. The first cut of the agentic surface rendered only inside a tool-log row, and
// only when a tool happened to return entities. That made it PROMPT-DEPENDENT: run an agent that
// did not touch mail, calendar, Drive or the filesystem and the page looked exactly as it always
// had. A decoration on one log line is not an overhaul of the agent page, and the correct
// criticism was made immediately.
//
// The fix is to stop treating "things the agent FOUND" and "things the agent DID" as different
// species. Both are objects with identity, provenance and actions:
//
//     a message it read      → kind 'message', action: reply
//     a file it listed       → kind 'file',    action: read
//     a file it CHANGED      → kind 'file',    action: read      ← the run's own work
//     a check it ran         → kind 'task',    status: passed/failed
//     a command it executed  → kind 'record',  status: exit code
//
// Once the run's own work is entities too, EVERY run has a surface — files it touched, checks it
// ran, commands it executed — and the same list/table/detail derivation and the same affordance
// binding apply to all of it. Nothing here is per-provider and nothing is per-prompt.
//
// `viewDerivation.ts` and `entities.ts` are imported as VALUES, not just types: `entities.ts`
// imports nothing at all and `viewDerivation.ts` imports only `entities.ts`, so the whole
// closure is browser-safe. That is stated at the top of `entities.ts` and is load-bearing here.

import { entity, type Entity } from '../CrucibleEngine/tools/entities'
import { deriveView, type ViewSpec } from '../CrucibleEngine/tools/viewDerivation'
import type { AgentState, AgentTool, AgentDiff, AgentVerify } from '../chat/core'

/** Count changed lines in a unified diff — the only summary a patch needs at a glance. */
function diffStat(d: AgentDiff): { added: number; removed: number } {
  const patch = d.patch ?? ''
  if (patch) {
    const lines = patch.split('\n')
    return {
      added: lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length,
      removed: lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length,
    }
  }
  // No patch — fall back to comparing the two sides we were given.
  const before = (d.old ?? '').split('\n').length
  const after = (d.new ?? '').split('\n').length
  return { added: Math.max(0, after - before), removed: Math.max(0, before - after) }
}

function baseName(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/** Files the agent CHANGED, as file entities — so they inherit the real "Read file" action. */
function changedFiles(diffs: AgentDiff[]): Entity[] {
  // A path can be written more than once in a run; the surface should show the FILE, not each
  // write. Keep the last touch and sum the churn.
  const byPath = new Map<string, { d: AgentDiff; added: number; removed: number; writes: number }>()
  for (const d of diffs) {
    if (!d?.path) continue
    const { added, removed } = diffStat(d)
    const prev = byPath.get(d.path)
    byPath.set(d.path, {
      d,
      added: (prev?.added ?? 0) + added,
      removed: (prev?.removed ?? 0) + removed,
      writes: (prev?.writes ?? 0) + 1,
    })
  }
  return [...byPath.entries()].map(([path, v]) => entity({
    id: `changed:${path}`,
    kind: 'file',
    source: 'agent',
    title: baseName(path),
    subtitle: path,
    at: new Date(v.d.ts).toISOString(),
    fields: [
      { key: 'path', label: 'Path', value: path, role: 'label' },
      { key: 'change', label: 'Change', value: `+${v.added} −${v.removed}`, role: 'quantity' },
      { key: 'status', label: 'Status', value: v.writes > 1 ? `Edited ${v.writes}×` : 'Edited', role: 'status' },
      { key: 'modified', label: 'Changed', value: new Date(v.d.ts).toISOString(), role: 'timestamp' },
    ],
    raw: { isDir: false, patch: v.d.patch },
  }))
}

/** Checks the agent ran. A failed check is the single most important thing on the page. */
function checks(verifies: AgentVerify[]): Entity[] {
  return verifies.filter(Boolean).map((v, i) => entity({
    id: `check:${i}`,
    kind: 'task',
    source: 'agent',
    title: v.signal || (v.passed ? 'Check passed' : 'Check failed'),
    subtitle: v.passed ? 'Passed' : 'Failed',
    body: v.report,
    at: new Date(v.ts).toISOString(),
    fields: [
      { key: 'status', label: 'Result', value: v.passed ? 'Passed' : 'Failed', role: 'status' },
      { key: 'signal', label: 'Check', value: v.signal, role: 'label' },
      { key: 'ran', label: 'Ran', value: new Date(v.ts).toISOString(), role: 'timestamp' },
    ],
  }))
}

/**
 * Tool calls that produced no entities of their own — shown so the run is legible rather than
 * silently partial. A tool that DID return entities is represented by those entities instead;
 * listing it twice would be noise.
 */
function toolRecords(tools: AgentTool[]): Entity[] {
  return tools
    .filter(t => t.done && !(t.view && t.view.entities.length))
    // Writes are already represented as changed files.
    .filter(t => !['write_file', 'edit_file', 'apply_patch'].includes(t.tool))
    .map((t, i) => {
      const arg = t.args?.command ?? t.args?.path ?? t.args?.query ?? t.args?.pattern ?? ''
      return entity({
        id: `tool:${t.id}:${i}`,
        kind: 'record',
        source: 'agent',
        title: t.tool,
        subtitle: typeof arg === 'string' ? arg.slice(0, 120) : '',
        body: t.output,
        fields: [
          { key: 'status', label: 'Result', value: t.ok === false ? 'Failed' : 'OK', role: 'status' },
          { key: 'tool', label: 'Tool', value: t.tool, role: 'label' },
          { key: 'target', label: 'Target', value: typeof arg === 'string' ? arg.slice(0, 120) : '', role: 'label' },
        ],
      })
    })
}

export interface RunSurface {
  /** Real-world objects the run retrieved — mail, events, files, pages. May be empty. */
  found: ViewSpec | null
  /** What the run DID — files changed, checks run, tools called. Empty only before it acts. */
  work: ViewSpec | null
}

/**
 * Derive the whole agent run as surfaces.
 *
 * Split into FOUND and WORK deliberately rather than merged into one grouped list: they answer
 * different questions ("what is out there" vs "what did you change"), and a failed check must not
 * be buried among sixty search results. Both use the same derivation and the same affordances —
 * the split is presentational, not a second mechanism.
 *
 * Returns nulls rather than empty views so the caller can omit a section entirely; an empty
 * "Found" panel on a pure refactor would be noise, not honesty.
 */
export function deriveRunSurface(state: AgentState | null | undefined): RunSurface {
  if (!state) return { found: null, work: null }

  const found: Entity[] = []
  for (const t of state.tools ?? []) {
    if (t.view?.entities?.length) found.push(...(t.view.entities as Entity[]))
  }

  const work: Entity[] = [
    ...changedFiles(state.diffs ?? []),
    ...checks(state.verifies ?? []),
    ...toolRecords(state.tools ?? []),
  ]

  return {
    found: found.length ? deriveView(dedupe(found)) : null,
    work: work.length ? deriveView(work) : null,
  }
}

/** The same message can be returned by two searches in one run; show it once. */
function dedupe(entities: Entity[]): Entity[] {
  const seen = new Set<string>()
  return entities.filter(e => {
    const k = `${e.kind}:${e.id}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
