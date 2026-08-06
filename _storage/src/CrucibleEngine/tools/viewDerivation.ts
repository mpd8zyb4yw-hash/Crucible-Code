// View derivation — turning entities into an interface, deterministically.
//
// THE POINT (cont.118). The interface is a FUNCTION OF THE DATA, not a component someone picked.
// Nothing in this file knows what Gmail is. It knows that four-or-more homogeneous things sharing
// three-or-more fields read best as a table, that things with start times read best as an agenda
// grouped by day, and that one thing reads best as a detail pane. Any tool emitting entities gets
// a real interface out of these rules without a line of bespoke UI — which is the difference
// between a universal surface and a pile of per-integration cards.
//
// ZERO MODEL. This is a pure function: same entities in, same view out. That matters for three
// reasons — it is instant, it is testable (`__surface_bench.ts` asserts every branch), and a weak
// model cannot make the interface wrong. `DOCTRINE.md`: the SYSTEM builds structure from sound
// primitives; the model is not consulted about control flow.
//
// THE EMPTY CASE IS LOAD-BEARING. cont.105b's "your inbox is empty" fabrication happened because
// emptiness was PROSE the model wrote. Here it is a rendered fact with the query that produced it
// attached, so the difference between "no results" and "the model did not look" is visible on
// screen rather than being something the user has to take on trust.

import { type Entity, type EntityKind, type BoundAffordance, bindAffordances } from './entities'

export type Layout =
  | 'empty'    // nothing came back — stated as a fact, with what was asked
  | 'detail'   // exactly one thing, shown in full
  | 'list'     // things that read as a stack of cards (messages, mixed results)
  | 'agenda'   // things with start times, grouped by day
  | 'table'    // homogeneous things sharing enough fields for columns to be meaningful
  | 'grid'     // things whose identity is visual (media)
  | 'map'      // things with a location

export interface ViewColumn {
  key: string
  label: string
  /** Numeric/size columns right-align; timestamps get their own formatting. */
  role?: string
}

export interface ViewGroup {
  /** Human label — a day for an agenda, a kind for mixed results. */
  label: string
  entityIds: string[]
}

export interface ViewSpec {
  layout: Layout
  title: string
  /** Present for `table`. Derived from which fields the entities actually share. */
  columns?: ViewColumn[]
  /** Present for `agenda` and mixed-kind lists. */
  groups?: ViewGroup[]
  entities: Entity[]
  /** entityId → the actions genuinely available on it. Never contains an action that cannot run. */
  actions: Record<string, BoundAffordance[]>
  /** Honest context: what was asked, what came back, what was NOT available. */
  notice?: string
  /** Tools that produced this view — provenance, shown in the UI footer. */
  sources: string[]
}

// Which roles make the best columns, in order. A table of messages should lead with who and when,
// not with an opaque id, and this ordering is what makes a derived table read like a designed one.
const COLUMN_ROLE_RANK: Record<string, number> = {
  title: 0, person: 1, timestamp: 2, status: 3, label: 4, location: 5,
  quantity: 6, size: 7, duration: 8, subtitle: 9, url: 10, body: 20, id: 30,
}

const MAX_COLUMNS = 5
/** A field must appear on at least this share of entities to earn a column. */
const COLUMN_COVERAGE = 0.7
/** Below this count a table reads worse than a list, however uniform the data. */
const MIN_TABLE_ROWS = 4
/** Below this many shared fields a table is a list with extra lines. */
const MIN_TABLE_COLUMNS = 3

function allSameKind(entities: Entity[]): EntityKind | null {
  if (!entities.length) return null
  const k = entities[0].kind
  return entities.every(e => e.kind === k) ? k : null
}

/**
 * The identity column every table needs.
 *
 * `title` lives on the entity envelope, not in `fields`, so a purely field-derived table came out
 * with Type/Modified/Size columns and NO FILENAME — caught by `__surface_bench`. The title is
 * always the first column and is never subject to the coverage threshold, because a table whose
 * rows cannot be told apart is not a table.
 */
export const TITLE_COLUMN: ViewColumn = { key: '__title', label: 'Name', role: 'title' }

/** Fields present (non-empty) on at least COLUMN_COVERAGE of the entities, best roles first. */
function deriveColumns(entities: Entity[]): ViewColumn[] {
  const counts = new Map<string, { label: string; role?: string; n: number }>()
  for (const e of entities) {
    for (const f of e.fields) {
      const cur = counts.get(f.key) ?? { label: f.label, role: f.role, n: 0 }
      cur.n++
      counts.set(f.key, cur)
    }
  }
  const threshold = entities.length * COLUMN_COVERAGE
  const derived = [...counts.entries()]
    .filter(([, v]) => v.n >= threshold)
    .filter(([, v]) => v.role !== 'body' && v.role !== 'id')   // never a useful column
    .sort((a, b) => (COLUMN_ROLE_RANK[a[1].role ?? 'zz'] ?? 15) - (COLUMN_ROLE_RANK[b[1].role ?? 'zz'] ?? 15))
    .slice(0, MAX_COLUMNS - 1)
    .map(([key, v]) => ({ key, label: v.label, role: v.role }))
  return [TITLE_COLUMN, ...derived]
}

/** Local calendar day for an ISO timestamp; null when unparseable. */
function dayKey(iso?: string): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

function dayLabel(key: string): string {
  const d = new Date(`${key}T00:00:00`)
  const today = new Date()
  const tomorrow = new Date(Date.now() + 86400000)
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (same(d, today)) return 'Today'
  if (same(d, tomorrow)) return 'Tomorrow'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

function groupByDay(entities: Entity[]): ViewGroup[] {
  const groups = new Map<string, string[]>()
  const undated: string[] = []
  for (const e of entities) {
    const k = dayKey(e.at)
    if (!k) { undated.push(e.id); continue }
    groups.set(k, [...(groups.get(k) ?? []), e.id])
  }
  const out: ViewGroup[] = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, ids]) => ({ label: dayLabel(k), entityIds: ids }))
  if (undated.length) out.push({ label: 'No date', entityIds: undated })
  return out
}

function groupByKind(entities: Entity[]): ViewGroup[] {
  const groups = new Map<EntityKind, string[]>()
  for (const e of entities) groups.set(e.kind, [...(groups.get(e.kind) ?? []), e.id])
  return [...groups.entries()].map(([kind, ids]) => ({ label: KIND_LABEL[kind] ?? kind, entityIds: ids }))
}

const KIND_LABEL: Record<EntityKind, string> = {
  message: 'Messages', event: 'Events', file: 'Files', contact: 'Contacts',
  place: 'Places', route: 'Routes', media: 'Media', webpage: 'Pages',
  task: 'Tasks', record: 'Records',
}

const KIND_TITLE: Record<EntityKind, (n: number) => string> = {
  message: n => `${n} message${n === 1 ? '' : 's'}`,
  event: n => `${n} event${n === 1 ? '' : 's'}`,
  file: n => `${n} file${n === 1 ? '' : 's'}`,
  contact: n => `${n} contact${n === 1 ? '' : 's'}`,
  place: n => `${n} place${n === 1 ? '' : 's'}`,
  route: n => (n === 1 ? 'Route' : `${n} routes`),
  media: n => `${n} item${n === 1 ? '' : 's'}`,
  webpage: n => `${n} result${n === 1 ? '' : 's'}`,
  task: n => `${n} task${n === 1 ? '' : 's'}`,
  record: n => `${n} record${n === 1 ? '' : 's'}`,
}

export interface DeriveOpts {
  /** What the user asked, so the empty case can say what was searched for. */
  query?: string
  /** Attached to the empty view — the honest difference between "none" and "could not look". */
  emptyReason?: string
}

/**
 * Derive an interface from entities.
 *
 * TOTAL: every input produces a valid ViewSpec, including the empty array and mixed kinds. The
 * renderer therefore never needs a fallback branch, which is what stops a novel result shape
 * from rendering as nothing at all.
 */
export function deriveView(entities: Entity[], opts: DeriveOpts = {}): ViewSpec {
  const sources = [...new Set(entities.map(e => e.source))]
  const actions: Record<string, BoundAffordance[]> = {}
  for (const e of entities) actions[e.id] = bindAffordances(e)

  // ── Empty. A rendered fact, not prose the model wrote. ──
  if (!entities.length) {
    return {
      layout: 'empty',
      title: 'No results',
      entities: [],
      actions: {},
      notice: opts.emptyReason
        ?? (opts.query ? `Nothing matched “${opts.query}”.` : 'The search returned nothing.'),
      sources: [],
    }
  }

  const kind = allSameKind(entities)

  // ── One thing → show it properly, not as a one-row list. ──
  if (entities.length === 1) {
    return {
      layout: 'detail',
      title: entities[0].title,
      entities,
      actions,
      sources,
    }
  }

  const title = kind ? KIND_TITLE[kind](entities.length) : `${entities.length} results`

  // ── Things with start times read as an agenda, whatever provider they came from. ──
  if (kind === 'event' && entities.some(e => e.at)) {
    return { layout: 'agenda', title, groups: groupByDay(entities), entities: sortByTime(entities), actions, sources }
  }

  // ── Things whose identity is visual. ──
  if (kind === 'media') {
    return { layout: 'grid', title, entities, actions, sources }
  }

  // ── Things with a location. ──
  if (kind === 'place' || kind === 'route') {
    return { layout: 'map', title, entities, actions, sources }
  }

  // ── Homogeneous and uniform enough for columns to mean something. ──
  // Messages are excluded deliberately: a subject line is prose and needs room to breathe, so a
  // stack of cards reads better than a truncated column no matter how uniform the fields are.
  if (kind && kind !== 'message' && entities.length >= MIN_TABLE_ROWS) {
    const columns = deriveColumns(entities)
    if (columns.length >= MIN_TABLE_COLUMNS) {
      return { layout: 'table', title, columns, entities, actions, sources }
    }
  }

  // ── Default: a stack of cards. Mixed kinds get grouped so the result stays legible. ──
  return {
    layout: 'list',
    title,
    groups: kind ? undefined : groupByKind(entities),
    entities: kind === 'message' ? sortByTime(entities, 'desc') : entities,
    actions,
    sources,
  }
}

/** Newest-last for agendas (chronological), newest-first for messages. Undated entries keep order. */
function sortByTime(entities: Entity[], dir: 'asc' | 'desc' = 'asc'): Entity[] {
  return [...entities].sort((a, b) => {
    const ta = a.at ? Date.parse(a.at) : NaN
    const tb = b.at ? Date.parse(b.at) : NaN
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0
    if (Number.isNaN(ta)) return 1
    if (Number.isNaN(tb)) return -1
    return dir === 'asc' ? ta - tb : tb - ta
  })
}

/**
 * A compact text rendering of the view, for the model's own context and for non-visual clients.
 *
 * This is what the FM sees INSTEAD of raw provider prose, and it is lossless in the way that
 * matters: every entity keeps its id and title, so the model can refer to a specific thing rather
 * than paraphrasing a blob. cont.105b's inbox collapse was exactly a paraphrase of a blob.
 */
export function viewToText(v: ViewSpec): string {
  if (v.layout === 'empty') return v.notice ?? 'No results.'
  const lines: string[] = [`${v.title}:`]
  for (const e of v.entities) {
    const when = e.at ? ` — ${e.at}` : ''
    const who = e.subtitle ? ` (${e.subtitle})` : ''
    lines.push(`- [${e.id}] ${e.title}${who}${when}`)
    if (e.body) lines.push(`    ${e.body.slice(0, 200).replace(/\s+/g, ' ')}`)
  }
  return lines.join('\n')
}
