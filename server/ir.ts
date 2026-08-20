import type { FieldValue } from './objects.js'

/**
 * What a pane IS, as opposed to what it currently shows.
 *
 * A pane whose query is natural language has to be re-planned by a model every
 * time it refreshes: a token per refresh, a different answer each time, and no
 * way to say "same thing, last quarter" without asking the model what the same
 * thing was. A pane whose query is a rigid schema can only ever express what
 * the schema anticipated, and the first request that does not fit becomes a
 * feature request.
 *
 * So: the model COMPILES his instruction into a plan over typed objects, the
 * plan is stored, and his original words are stored beside it. Most refreshes
 * then cost nothing — the server re-executes the plan itself. The plan is
 * versioned and open: a node whose `op` this build does not know is preserved
 * rather than dropped and marks the plan as needing a model, so a plan written
 * by a newer brain survives an older server without being silently truncated
 * into something that looks valid and means something else.
 *
 * Nothing here names a connector, a widget or a subject. A plan says "retrieve
 * from this source by this route, filter, join to that kind, rank, take five,
 * show as media" — which is as true of restaurants and calendars as of videos.
 * The example that governs the shape is deliberately not a YouTube one:
 *
 *   find emails about France → extract the restaurants named in them →
 *   join to calendar events for the dates we are there → check which are
 *   open → rank → present
 *
 * That is `source`, `extract` (model-required), `join`, `enrich`, `rank`,
 * `present`. Six nodes, no France, no restaurants, nothing added to this file.
 */

export const IR_VERSION = 1

// ── Nodes ────────────────────────────────────────────────────────────────────

/** Retrieve from a connector by one of its routes. The only node that fetches. */
export interface SourceNode {
  op: 'source'
  /** Connector id: 'youtube', 'gmail', 'calendar'. */
  source: string
  /** The route within it: 'subscriptions', 'search', 'likes', 'inbox'. */
  via: string
  /** Route parameters. Opaque here; meaningful to the adapter for `source`. */
  params?: Record<string, FieldValue>
  /** What kind of object it yields, when the route is not fixed to one. */
  kind?: string
}

/** Read what is already known, without going to the network. */
export interface ObjectsNode {
  op: 'objects'
  sources?: string[]
  kinds?: string[]
  text?: string
  where?: Record<string, FieldValue>
  via?: string
  seenWithinMs?: number
}

/** Keep what matches. Every predicate is mechanical — no judgement. */
export interface FilterNode {
  op: 'filter'
  where?: Record<string, FieldValue>
  /** Substring over title, sub and body. */
  text?: string
  /** Numeric or date bounds on a named field. Dates as ISO strings. */
  range?: { field: string; min?: number | string; max?: number | string }
  /** Drop anything whose provenance has decayed past retrieved. */
  freshOnly?: boolean
  /** Invert the whole node. "Not from this channel", "not already seen". */
  not?: boolean
}

/** Order by a field. Ordering by a JUDGEMENT is `rank`, which needs a model. */
export interface SortNode {
  op: 'sort'
  by: string
  dir?: 'asc' | 'desc'
}

export interface LimitNode {
  op: 'limit'
  n: number
}

/** Distinct by a field — one video per channel, one email per thread. */
export interface DedupeNode {
  op: 'dedupe'
  by: string
}

/**
 * Relate one set of objects to another.
 *
 * The node that makes this a plan over typed objects rather than a filter over
 * one source. `on` names the field on each side that has to agree; `into`
 * decides whether the right-hand objects become fields on the left or a second
 * stream. Nothing about it knows which kinds can relate to which.
 */
export interface JoinNode {
  op: 'join'
  /** The plan producing the objects to join TO. */
  right: PlanNode[]
  on: { left: string; right: string }
  /** 'inner' drops unmatched; 'left' keeps them unattached. */
  how?: 'inner' | 'left'
  /** Field name the matched object is attached under. */
  as?: string
}

/**
 * Attach facts from a second source to objects that already exist.
 *
 * Separate from `join` because it FETCHES: hydrating ids into full records,
 * looking up whether a place is open, asking a price. Its results are recorded
 * as their own reading against the same identity, so an enrichment never
 * overwrites what the first source said.
 */
export interface EnrichNode {
  op: 'enrich'
  source: string
  via: string
  /** Which field of each object identifies it to the enriching source. */
  by?: string
  params?: Record<string, FieldValue>
}

/**
 * Ordering by judgement. Model-required, always.
 *
 * "Best", "most interesting", "cheapest given what he said he wanted" are not
 * sorts. The model returns an order over ids it was given; it cannot add,
 * invent, or rewrite the objects, so the order is an opinion and the items
 * underneath it are still retrieved facts. That boundary is what lets the
 * result be presented with `ranked` provenance instead of laundering a
 * judgement into the source's voice.
 */
export interface RankNode {
  op: 'rank'
  /** The criterion, in his words or the model's compilation of them. */
  by: string
  /** Ranking is worthless below a handful and expensive above a hundred. */
  max?: number
}

/**
 * Derive new objects from the CONTENT of existing ones. Model-required.
 *
 * "Extract the restaurants named in these emails" — the emails are retrieved
 * facts, the restaurants are things the model read out of them, and they are
 * therefore `transformed` and must never be presented as retrieved. The node
 * declares what kind it produces so the plan stays typed across the boundary.
 */
export interface ExtractNode {
  op: 'extract'
  /** What to pull out, in plain language. */
  what: string
  /** The kind of object produced: 'place', 'person', 'task'. */
  kind: string
  /** Which source the derived objects are filed under. Defaults to 'crucible'. */
  as?: string
}

/**
 * How it should look. A hint, not a command — the renderer owns every pixel.
 */
export interface PresentNode {
  op: 'present'
  /** One of the widget kinds. Anything else falls back to a list. */
  widget: string
  title?: string
  columns?: 1 | 2
  empty?: string
}

/**
 * A node this build does not understand.
 *
 * Never dropped. A plan written by a newer brain keeps its unknown steps, is
 * classified as needing a model, and can still be shown, stored, diffed and
 * re-planned — which is the difference between forward compatibility and
 * silently executing three quarters of someone's instruction.
 */
export interface UnknownNode {
  op: string
  [k: string]: unknown
}

export type PlanNode =
  | SourceNode
  | ObjectsNode
  | FilterNode
  | SortNode
  | LimitNode
  | DedupeNode
  | JoinNode
  | EnrichNode
  | RankNode
  | ExtractNode
  | PresentNode
  | UnknownNode

/** Ops this build executes without a model. */
export const DETERMINISTIC_OPS = ['source', 'objects', 'filter', 'sort', 'limit', 'dedupe', 'join', 'enrich', 'present'] as const

/** Ops that require a model every time they run. */
export const MODEL_OPS = ['rank', 'extract'] as const

const KNOWN = new Set<string>([...DETERMINISTIC_OPS, ...MODEL_OPS])

// ── The plan ─────────────────────────────────────────────────────────────────

/**
 * When re-running is worth doing.
 *
 * Kept on the plan rather than on the pane because it is a property of the
 * QUERY: "what is on my calendar" wants re-running on open, "the five videos I
 * chose in March" does not want re-running at all. A pinned pane overrides it,
 * and refreshing never destroys what it replaces regardless.
 */
export type RefreshPolicy =
  | { mode: 'manual' }
  | { mode: 'on-open' }
  | { mode: 'interval'; everyMs: number }
  /** Re-run when an object matching this appears or changes. */
  | { mode: 'on-change'; watch: ObjectsNode }

export interface Plan {
  /** Bumped when a node's meaning changes, never when one is added. */
  irVersion: number
  /**
   * HIS WORDS. Preserved verbatim, always, even when the plan is fully
   * deterministic — a plan is a compilation of an instruction and the
   * instruction is the thing that can be re-compiled when the plan turns out
   * to have missed the point. It is never re-interpreted from scratch while a
   * plan exists; it is the fallback, and the record of what was asked.
   */
  intent: string
  nodes: PlanNode[]
  refresh: RefreshPolicy
  /**
   * Parts of the instruction the compiler could not express.
   *
   * Written down rather than dropped. A plan that quietly ignored "and none of
   * the ones you showed me yesterday" produces a result that looks right and is
   * not, and nobody finds out.
   */
  unresolved?: string[]
}

/**
 * How this plan can be run.
 *
 *   A. deterministic  — server executes it; no model, no tokens, same answer.
 *   B. parameterized  — deterministic, and its parameters can be edited in
 *                       place: "same thing, last quarter" is an edit to a
 *                       range, not a new conversation.
 *   C. model-required — contains judgement or extraction; a model runs.
 *   D. hybrid         — deterministic retrieval, model in the middle,
 *                       deterministic render. The common shape for anything
 *                       interesting, and the reason the classification exists:
 *                       the retrieval half of a hybrid still costs nothing and
 *                       still returns the same objects.
 */
export type PlanClass = 'deterministic' | 'parameterized' | 'model-required' | 'hybrid'

export function classify(plan: Plan): PlanClass {
  const ops = plan.nodes.map((n) => n.op)
  const unknown = ops.filter((o) => !KNOWN.has(o))
  const needsModel = ops.some((o) => (MODEL_OPS as readonly string[]).includes(o)) || unknown.length > 0

  if (!needsModel) return parameters(plan).length ? 'parameterized' : 'deterministic'
  const fetches = ops.some((o) => o === 'source' || o === 'objects')
  return fetches ? 'hybrid' : 'model-required'
}

/** Nodes this build cannot execute, so a caller can say what it is falling back for. */
export function unknownOps(plan: Plan): string[] {
  return [...new Set(plan.nodes.map((n) => n.op).filter((o) => !KNOWN.has(o)))]
}

/**
 * The knobs a revision can turn without a model.
 *
 * This is what makes "same thing, but ten" or "same thing, last quarter" free.
 * Addressed by path — `2.n`, `0.params.q` — so nothing has to enumerate which
 * fields of which node kinds are adjustable.
 */
export function parameters(plan: Plan): { path: string; value: unknown }[] {
  const out: { path: string; value: unknown }[] = []
  plan.nodes.forEach((node, i) => {
    const n = node as Record<string, unknown>
    if (node.op === 'limit') out.push({ path: `${i}.n`, value: n.n })
    if (node.op === 'sort') out.push({ path: `${i}.by`, value: n.by }, { path: `${i}.dir`, value: n.dir ?? 'desc' })
    if (node.op === 'filter') {
      if (n.text !== undefined) out.push({ path: `${i}.text`, value: n.text })
      if (n.range) out.push({ path: `${i}.range`, value: n.range })
    }
    if (node.op === 'source' && n.params) {
      for (const [k, v] of Object.entries(n.params as Record<string, unknown>)) {
        out.push({ path: `${i}.params.${k}`, value: v })
      }
    }
  })
  return out
}

/**
 * Turn one knob, returning a NEW plan.
 *
 * Never mutates: a revision's plan is part of an immutable snapshot, and a
 * refinement that edited it in place would silently rewrite history that has
 * already been shown and stored.
 */
export function withParameter(plan: Plan, path: string, value: unknown): Plan {
  const [head, ...rest] = path.split('.')
  const index = Number(head)
  if (!Number.isInteger(index) || index < 0 || index >= plan.nodes.length) return plan
  const nodes = plan.nodes.map((n, i) => (i === index ? setIn(n as Record<string, unknown>, rest, value) : n))
  return { ...plan, nodes: nodes as PlanNode[] }
}

function setIn(obj: Record<string, unknown>, path: string[], value: unknown): Record<string, unknown> {
  if (!path.length) return obj
  const [head, ...rest] = path
  return {
    ...obj,
    [head!]: rest.length ? setIn((obj[head!] ?? {}) as Record<string, unknown>, rest, value) : value,
  }
}

// ── Accepting a plan from a model ────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

const str = (v: unknown, max = 400): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined

const scalars = (v: unknown, max = 20): Record<string, FieldValue> | undefined => {
  if (!isRecord(v)) return undefined
  const out: Record<string, FieldValue> = {}
  for (const [k, val] of Object.entries(v)) {
    if (Object.keys(out).length >= max) break
    if (val === null || typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      out[k.slice(0, 60)] = typeof val === 'string' ? val.slice(0, 500) : val
    }
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * Take whatever a model emitted and return a plan, or null.
 *
 * A plan is untrusted input in exactly the way a widget spec is: it arrives as
 * JSON claiming to be executable. Every field is rebuilt rather than passed
 * through, and the two dangerous freedoms are removed here — a plan cannot name
 * an arbitrary URL, and it cannot describe an ACTION. Retrieval and reasoning
 * do not have side effects in this system; a plan can only ever read. Anything
 * that sends, books, buys or deletes goes through the action path, where it is
 * named, authorised and recorded.
 *
 * Unknown ops survive, deliberately, with their fields reduced to scalars.
 */
export function sanitisePlan(raw: unknown, fallbackIntent = ''): Plan | null {
  if (!isRecord(raw)) return null
  const intent = str(raw.intent, 2000) ?? str(fallbackIntent, 2000)
  if (!intent) return null

  const nodes = Array.isArray(raw.nodes) ? raw.nodes.slice(0, 24).flatMap((n) => sanitiseNode(n) ?? []) : []
  if (!nodes.length) return null

  return {
    irVersion: typeof raw.irVersion === 'number' ? raw.irVersion : IR_VERSION,
    intent,
    nodes,
    refresh: sanitiseRefresh(raw.refresh),
    unresolved: Array.isArray(raw.unresolved)
      ? raw.unresolved.flatMap((u) => str(u, 300) ?? []).slice(0, 8)
      : undefined,
  }
}

function sanitiseNode(raw: unknown, depth = 0): PlanNode | null {
  if (!isRecord(raw)) return null
  const op = str(raw.op, 40)
  if (!op) return null

  switch (op) {
    case 'source': {
      const source = str(raw.source, 40)
      const via = str(raw.via, 40)
      if (!source || !via) return null
      return { op, source, via, params: scalars(raw.params), kind: str(raw.kind, 40) }
    }
    case 'objects':
      return {
        op,
        sources: Array.isArray(raw.sources) ? raw.sources.flatMap((s) => str(s, 40) ?? []).slice(0, 8) : undefined,
        kinds: Array.isArray(raw.kinds) ? raw.kinds.flatMap((s) => str(s, 40) ?? []).slice(0, 8) : undefined,
        text: str(raw.text, 300),
        where: scalars(raw.where),
        via: str(raw.via, 40),
        seenWithinMs: typeof raw.seenWithinMs === 'number' ? Math.max(0, raw.seenWithinMs) : undefined,
      }
    case 'filter': {
      const r = isRecord(raw.range) ? raw.range : undefined
      const field = r ? str(r.field, 60) : undefined
      return {
        op,
        where: scalars(raw.where),
        text: str(raw.text, 300),
        range: field
          ? {
              field,
              min: typeof r!.min === 'number' || typeof r!.min === 'string' ? (r!.min as number | string) : undefined,
              max: typeof r!.max === 'number' || typeof r!.max === 'string' ? (r!.max as number | string) : undefined,
            }
          : undefined,
        freshOnly: raw.freshOnly === true,
        not: raw.not === true,
      }
    }
    case 'sort': {
      const by = str(raw.by, 60)
      return by ? { op, by, dir: raw.dir === 'asc' ? 'asc' : 'desc' } : null
    }
    case 'limit':
      return { op, n: Math.max(1, Math.min(200, typeof raw.n === 'number' ? Math.floor(raw.n) : 10)) }
    case 'dedupe': {
      const by = str(raw.by, 60)
      return by ? { op, by } : null
    }
    case 'join': {
      const on = isRecord(raw.on) ? raw.on : null
      const left = on ? str(on.left, 60) : undefined
      const right = on ? str(on.right, 60) : undefined
      // One level of nesting. A plan that joins to a plan that joins is a
      // plan nobody can read, and every case seen so far is one deep.
      const rightNodes =
        depth === 0 && Array.isArray(raw.right)
          ? raw.right.slice(0, 12).flatMap((n) => sanitiseNode(n, depth + 1) ?? [])
          : []
      if (!left || !right || !rightNodes.length) return null
      return { op, right: rightNodes, on: { left, right }, how: raw.how === 'left' ? 'left' : 'inner', as: str(raw.as, 60) }
    }
    case 'enrich': {
      const source = str(raw.source, 40)
      const via = str(raw.via, 40)
      if (!source || !via) return null
      return { op, source, via, by: str(raw.by, 60), params: scalars(raw.params) }
    }
    case 'rank': {
      const by = str(raw.by, 500)
      return by ? { op, by, max: Math.max(1, Math.min(100, typeof raw.max === 'number' ? raw.max : 50)) } : null
    }
    case 'extract': {
      const what = str(raw.what, 500)
      const kind = str(raw.kind, 40)
      return what && kind ? { op, what, kind, as: str(raw.as, 40) } : null
    }
    case 'present': {
      const widget = str(raw.widget, 20) ?? 'list'
      return {
        op,
        widget,
        title: str(raw.title, 80),
        columns: raw.columns === 1 ? 1 : raw.columns === 2 ? 2 : undefined,
        empty: str(raw.empty, 200),
      }
    }
    default:
      // Preserved, scalar-only, and it will make the plan model-required.
      return { op, ...(scalars(raw, 24) ?? {}) }
  }
}

function sanitiseRefresh(raw: unknown): RefreshPolicy {
  if (!isRecord(raw)) return { mode: 'manual' }
  if (raw.mode === 'on-open') return { mode: 'on-open' }
  if (raw.mode === 'interval') {
    const everyMs = typeof raw.everyMs === 'number' ? raw.everyMs : 0
    // Under a minute is a poll, not a refresh policy.
    return everyMs >= 60_000 ? { mode: 'interval', everyMs } : { mode: 'manual' }
  }
  if (raw.mode === 'on-change') {
    const watch = sanitiseNode(isRecord(raw.watch) ? { op: 'objects', ...raw.watch } : null)
    return watch && watch.op === 'objects' ? { mode: 'on-change', watch: watch as ObjectsNode } : { mode: 'manual' }
  }
  return { mode: 'manual' }
}

/** A stable, readable summary of what a plan does. Used for diffing revisions. */
export function describePlan(plan: Plan): string {
  return plan.nodes
    .map((n) => {
      switch (n.op) {
        case 'source':
          return `${(n as SourceNode).source}/${(n as SourceNode).via}`
        case 'objects':
          return `known(${(n as ObjectsNode).kinds?.join('|') ?? 'any'})`
        case 'filter':
          return (n as FilterNode).not ? 'filter!' : 'filter'
        case 'sort':
          return `sort:${(n as SortNode).by}`
        case 'limit':
          return `take ${(n as LimitNode).n}`
        case 'rank':
          return `rank:${(n as RankNode).by.slice(0, 40)}`
        case 'extract':
          return `extract:${(n as ExtractNode).kind}`
        case 'present':
          return `as ${(n as PresentNode).widget}`
        default:
          return n.op
      }
    })
    .join(' → ')
}
