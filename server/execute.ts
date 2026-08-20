import {
  classify,
  unknownOps,
  type EnrichNode,
  type ExtractNode,
  type FilterNode,
  type JoinNode,
  type LimitNode,
  type ObjectsNode,
  type Plan,
  type PlanNode,
  type PresentNode,
  type RankNode,
  type SortNode,
  type SourceNode,
  type DedupeNode,
  type RefreshPolicy,
} from './ir.js'
import { observe, objectId, query, type FieldValue, type ObjectDraft, type RetrievedObject } from './objects.js'
import { derive, provenanceLabel, type Provenance } from './provenance.js'
import type { Widget, WidgetItem, WidgetPane } from './widgets.js'

/**
 * Running a plan.
 *
 * The executor is the boundary the whole design rests on: retrieval and
 * reasoning READ. Nothing in this file sends, books, buys, archives or deletes,
 * and there is no node in the IR that could ask it to. A pane can offer
 * actions — they ride out as named intents on the rendered widget — but they
 * are performed later, by him, through the action path, where each one is
 * authorised and written down. observe → plan → present is this file; authorise
 * → execute → record is not, and the two must not be reachable from each other.
 *
 * A source adapter registers a `source` id and the routes it can serve. That is
 * the only way a connector enters the general layer, and it is why the pane and
 * revision code contains no connector names: adding Gmail is registering an
 * adapter, not editing the executor.
 */

// ── Adapters ─────────────────────────────────────────────────────────────────

export interface SourceContext {
  /** Route parameters from the plan node. */
  params: Record<string, FieldValue>
  /** For `enrich`: the objects being enriched. Empty for a plain fetch. */
  input: RetrievedObject[]
  /** Which field of each input identifies it to this source. */
  by?: string
}

export interface SourceAdapter {
  /**
   * Fetch, and return drafts in the shape the object store takes.
   *
   * An adapter is responsible for the invariant its own data needs — the
   * YouTube one funnels every id through `videos.list` so a title and a
   * thumbnail can never come from different records. The executor does not
   * enforce that because it cannot: only the connector knows what "the same
   * record" means for its API.
   */
  fetch(route: string, ctx: SourceContext): Promise<ObjectDraft[]>
  /** Routes this adapter serves. A plan naming any other is refused. */
  routes: string[]
  /** What a route costs, if the source meters it. Surfaced, never enforced. */
  cost?: (route: string) => number | undefined
  /**
   * How to describe this source to whatever has to write a plan against it.
   *
   * Optional, and the shape of the option is the point: a connector that says
   * nothing is still fully usable — the catalogue falls back to its id and its
   * route names, which is exactly what the executor itself knows. What it buys
   * is that the compiler's prompt is GENERATED from the registry rather than
   * hand-written beside it. A hand-written list of what YouTube can do would be
   * a second place every connector has to be registered, and the one that goes
   * stale silently: the adapter grows a route, nothing tells the prompt, and
   * the model keeps compiling plans naming the four routes someone typed out
   * months ago.
   */
  describe?: SourceDescription
  /**
   * Instructions this connector can compile for itself, with no model at all.
   *
   * "What's on this week" has exactly one correct compilation and it is the
   * calendar's to know. Declaring it here rather than in the compiler is not
   * tidiness: a table of phrases in the general layer would be a list of
   * connector names sitting in the file that is supposed to have never heard of
   * one, and it is the same mistake as a decay window baked into the
   * abstraction — it has to pick a connector's vocabulary and be wrong about
   * every other.
   *
   * On a free tier this is worth real money. The two things most often asked
   * are the two with no ambiguity in them, and spending a rate-limited call to
   * rediscover a fixed answer is how the app comes to say "no model available"
   * at the moment he needed one for something that actually was hard.
   */
  shortcuts?: SourceShortcut[]
}

export interface SourceDescription {
  /** "his YouTube account", "his mail". One noun phrase, no salesmanship. */
  what: string
  /** Object kinds this source yields: 'video', 'email', 'event'. */
  kinds: string[]
  /** Route → one line, naming the params it takes. Keys must be in `routes`. */
  routes: Record<string, string>
}

export interface SourceShortcut {
  /** Lowercased substrings; any one of them matching is enough. */
  when: string[]
  /**
   * Lowercased substrings that mean he meant something else.
   *
   * Load-bearing rather than a nicety: "is there mail about my calendar
   * invite" contains both connectors' words, and a shortcut that fired on the
   * first match would confidently answer the wrong question for free. When
   * `unless` rules a shortcut out the instruction falls through to the model,
   * which is the correct outcome — an ambiguous sentence is exactly what a
   * model is for.
   */
  unless?: string[]
  /** The plan, given his words. Return nothing to decline after all. */
  nodes(words: string): PlanNode[]
  refresh?: RefreshPolicy
}

const adapters = new Map<string, SourceAdapter>()

export function registerSource(source: string, adapter: SourceAdapter): void {
  adapters.set(source, adapter)
}

export function registeredSources(): string[] {
  return [...adapters.keys()]
}

export interface CatalogueEntry {
  source: string
  routes: string[]
  kinds: string[]
  what?: string
  /** Per-route notes, for the routes whose adapter bothered to write one. */
  notes: Record<string, string>
  /** Metered units per route, where the adapter reports them. */
  cost: Record<string, number>
  /** Instructions this connector compiles for itself. Usually empty. */
  shortcuts: SourceShortcut[]
}

/**
 * Everything a plan is allowed to name, as the registry currently stands.
 *
 * Read by the compiler to build its prompt and by `/api/sources` to say what is
 * actually reachable. It is derived, never declared: connect an account and the
 * catalogue grows; disconnect one and the compiler stops being told it exists,
 * which is what keeps it from writing plans against a source that will only
 * fail at execution.
 */
export function sourceCatalogue(): CatalogueEntry[] {
  return [...adapters.entries()].map(([source, a]) => {
    const notes: Record<string, string> = {}
    const cost: Record<string, number> = {}
    for (const r of a.routes) {
      const note = a.describe?.routes[r]
      if (note) notes[r] = note
      const c = a.cost?.(r)
      if (c !== undefined) cost[r] = c
    }
    return {
      source,
      routes: [...a.routes],
      kinds: a.describe?.kinds ?? [],
      what: a.describe?.what,
      notes,
      cost,
      shortcuts: a.shortcuts ?? [],
    }
  })
}

/**
 * The model, when a plan needs one.
 *
 * Injected rather than imported so the executor can be run, tested and reasoned
 * about without a provider key — and so the deterministic half of a hybrid plan
 * is demonstrably deterministic: with no model installed, everything up to the
 * first model node still runs and the result says exactly where it stopped.
 */
export interface Reasoner {
  /** Return the given ids in a new order. Adding or inventing ids is ignored. */
  rank(ids: string[], by: string, objects: RetrievedObject[]): Promise<string[]>
  /** Read new objects out of the content of existing ones. */
  extract(what: string, kind: string, objects: RetrievedObject[]): Promise<ExtractedDraft[]>
}

/**
 * What a model is allowed to hand back from `extract`.
 *
 * Deliberately narrower than `ObjectDraft`, and the missing fields are the
 * point rather than an omission. `id`, `source` and `prov` are minted here from
 * the objects the extraction ran over — a model that could choose its own
 * identity could claim one that already exists and merge invented fields into a
 * retrieved record, and one that could choose its own provenance could present
 * something it made up as something Gmail said. `image` is absent for the same
 * reason it is absent from the IR: there is no path by which a URL a model
 * wrote reaches the renderer.
 */
export type ExtractedDraft = {
  title: string
  nativeId?: string
  sub?: string
  body?: string
  at?: string
  fields?: Record<string, FieldValue>
}

let reasoner: Reasoner | null = null

export function setReasoner(r: Reasoner | null): void {
  reasoner = r
}

// ── Result ───────────────────────────────────────────────────────────────────

export interface ExecutionResult {
  objects: RetrievedObject[]
  refs: string[]
  presentation: WidgetPane[]
  /** Provenance label per ref, as observed now. Stored into the revision. */
  observed: Record<string, string>
  /** 'deterministic' | 'parameterized' | 'model-required' | 'hybrid'. */
  planClass: ReturnType<typeof classify>
  /** True if any model node actually ran. A hybrid plan can finish without one. */
  usedModel: boolean
  /** Nodes that could not run, and why. Never silent. */
  skipped: { op: string; why: string }[]
  /** Metered cost, where the adapter reports it. */
  cost?: number
}

/**
 * Did this run answer the question, or fail to run?
 *
 * ONE expression, used by everything that has to tell those apart, because two
 * readers of `objects` and `skipped` would eventually disagree about which
 * empty result was a real one.
 *
 * Emptiness alone is not failure — "no flights under £200 today" is a correct
 * answer and a pane worth keeping. A skip is what says a step of the plan never
 * ran, and an empty result underneath a skip is not an answer to anything.
 */
export const answeredBy = (r: Pick<ExecutionResult, 'objects' | 'skipped'>): boolean =>
  r.objects.length > 0 || r.skipped.length === 0

export interface ExecuteOptions {
  /** Passed to adapters that need credentials. Opaque to the executor. */
  auth?: Record<string, string>
  now?: number
  /** Refuse anything that would go to the network. For a cheap re-render. */
  offline?: boolean
}

/**
 * Run a plan and return what to show.
 *
 * Nodes run in order over one stream of objects. A node that cannot run is
 * SKIPPED AND REPORTED rather than silently dropped — a plan that quietly lost
 * "and none of the ones from yesterday" returns a result that looks right and
 * is not, and nobody ever finds out.
 */
export async function execute(plan: Plan, opts: ExecuteOptions = {}): Promise<ExecutionResult> {
  const now = opts.now ?? Date.now()
  const skipped: { op: string; why: string }[] = []
  let objects: RetrievedObject[] = []
  let usedModel = false
  let cost = 0
  let present: PresentNode | undefined

  for (const op of unknownOps(plan)) {
    skipped.push({ op, why: 'This build does not know that step. Kept in the plan; a model has to run it.' })
  }

  for (const node of plan.nodes) {
    switch (node.op) {
      case 'source': {
        const n = node as SourceNode
        const got = await fetchFrom(n.source, n.via, { params: n.params ?? {}, input: [] }, opts, skipped)
        cost += got.cost
        objects = merge(objects, got.objects)
        break
      }
      case 'objects': {
        const n = node as ObjectsNode
        const found = await query(
          { sources: n.sources, kinds: n.kinds, text: n.text, where: n.where, via: n.via, seenWithinMs: n.seenWithinMs, limit: 200 },
          now
        )
        objects = merge(objects, found)
        break
      }
      case 'filter':
        objects = applyFilter(objects, node as FilterNode, now)
        break
      case 'sort': {
        const n = node as SortNode
        objects = [...objects].sort(byField(n.by, n.dir ?? 'desc'))
        break
      }
      case 'dedupe': {
        const n = node as DedupeNode
        const seen = new Set<unknown>()
        objects = objects.filter((o) => {
          const k = fieldOf(o, n.by)
          if (seen.has(k)) return false
          seen.add(k)
          return true
        })
        break
      }
      case 'limit':
        objects = objects.slice(0, (node as LimitNode).n)
        break
      case 'join': {
        const n = node as JoinNode
        const right = await execute({ ...plan, nodes: n.right }, opts)
        const index = new Map<unknown, RetrievedObject>()
        for (const r of right.objects) index.set(fieldOf(r, n.on.right), r)
        objects = objects.flatMap((o) => {
          const match = index.get(fieldOf(o, n.on.left))
          if (!match) return n.how === 'left' ? [o] : []
          /**
           * The joined object is attached as a FIELD, and the provenance of the
           * result composes both sides. A pane built from a mail thread and a
           * calendar event is neither of those things on its own, and saying
           * so is the point of the chain.
           */
          return [{
            ...o,
            fields: { ...(o.fields ?? {}), [n.as ?? 'joined']: match.id },
            prov: derive('enriched', [o.prov, match.prov], { note: `joined on ${n.on.left}` }),
          }]
        })
        break
      }
      case 'enrich': {
        const n = node as EnrichNode
        const got = await fetchFrom(n.source, n.via, { params: n.params ?? {}, input: objects, by: n.by }, opts, skipped)
        cost += got.cost
        /**
         * An enrichment is a SECOND reading of things we already know, filed
         * as its own observation. It does not replace the first reading and it
         * cannot erase a field it did not return — which is exactly the bug
         * that flat objects had, arriving here as a structural guarantee.
         */
        const byId = new Map(got.objects.map((o) => [o.id, o]))
        objects = objects.map((o) => {
          const extra = byId.get(o.id)
          return extra ? { ...extra, prov: derive('enriched', [o.prov, extra.prov]) } : o
        })
        break
      }
      case 'rank': {
        const n = node as RankNode
        if (!reasoner) {
          skipped.push({ op: 'rank', why: 'No model available, so the order is the retrieval order.' })
          break
        }
        const ids = objects.slice(0, n.max ?? 50).map((o) => o.id)
        const ordered = await reasoner.rank(ids, n.by, objects)
        // Only a REORDERING is accepted. Ids the model added are dropped and
        // ids it forgot keep their place at the end, so a ranking can never
        // introduce an object that was not retrieved.
        const allowed = new Set(ids)
        const rank = new Map(ordered.filter((id) => allowed.has(id)).map((id, i) => [id, i]))
        objects = [...objects].sort((a, b) => (rank.get(a.id) ?? 1e6) - (rank.get(b.id) ?? 1e6))
        objects = objects.map((o) => ({
          ...o,
          prov: derive('ranked', [o.prov], { note: `ordered by: ${n.by}`.slice(0, 200) }),
        }))
        usedModel = true
        break
      }
      case 'extract': {
        const n = node as ExtractNode
        if (!reasoner) {
          skipped.push({ op: 'extract', why: 'No model available, so nothing was read out of these.' })
          break
        }
        const drafts = await reasoner.extract(n.what, n.kind, objects)
        /**
         * Derived objects are `transformed`, always, and carry the objects they
         * were read out of. A restaurant the model found in an email is not a
         * fact Gmail asserted, and it must be impossible for it to render as
         * though it were.
         */
        const parents = objects.map((o) => o.prov)
        const source = n.as ?? 'crucible'
        const made: RetrievedObject[] = drafts.flatMap((d, i): RetrievedObject[] => {
          /**
           * Built FIELD BY FIELD, never spread.
           *
           * A spread would take whatever the reasoner put on the draft, and the
           * type is a compile-time promise from an implementation that is
           * injected at runtime — `setReasoner` accepts any object with the
           * right two methods, so the type guarantees nothing here. Spreading
           * let an `image` through, which is the one thing this file says
           * cannot happen: a URL a model wrote reaching the renderer. It is
           * the same argument as accepting only a reordering from `rank`.
           */
          const title = typeof d.title === 'string' ? d.title.trim().slice(0, 300) : ''
          if (!title) return []
          const nativeId = (typeof d.nativeId === 'string' && d.nativeId.trim()) || `x${i}`
          const text = (v: unknown, max: number) =>
            typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined
          const prov = derive('transformed', parents, {
            source,
            via: 'extract',
            note: n.what.slice(0, 200),
            basis: objects.map((o) => o.id).slice(0, 50),
          })
          return [{
            id: objectId(source, n.kind, nativeId),
            source,
            kind: n.kind,
            nativeId,
            title,
            sub: text(d.sub, 300),
            body: text(d.body, 2000),
            at: text(d.at, 40),
            // Deliberately no `image`. Pictures come off records a connector
            // fetched; nothing a model produced has one, and there is now no
            // expression here that could give it one.
            fields: scalarFields(d.fields),
            prov,
            fieldProv: {},
            readings: 1,
          }]
        })
        await observe(
          made.map((m) => ({
            identity: { id: m.id, source: m.source, kind: m.kind, nativeId: m.nativeId },
            fields: { title: m.title, sub: m.sub, body: m.body, at: m.at, ...(m.fields ?? {}) },
            prov: m.prov,
          }))
        )
        objects = made
        usedModel = true
        break
      }
      case 'present':
        present = node as PresentNode
        break
      default:
        // Already reported through unknownOps. Nothing runs.
        break
    }
  }

  const observed: Record<string, string> = {}
  for (const o of objects) observed[o.id] = provenanceLabel(o.prov, now)

  return {
    objects,
    refs: objects.map((o) => o.id),
    presentation: render(objects, present, now, plan.intent),
    observed,
    planClass: classify(plan),
    usedModel,
    skipped,
    cost: cost || undefined,
  }
}

async function fetchFrom(
  source: string,
  via: string,
  ctx: SourceContext,
  opts: ExecuteOptions,
  skipped: { op: string; why: string }[]
): Promise<{ objects: RetrievedObject[]; cost: number }> {
  const adapter = adapters.get(source)
  if (!adapter) {
    skipped.push({ op: 'source', why: `Nothing is connected that can answer "${source}".` })
    return { objects: [], cost: 0 }
  }
  if (!adapter.routes.includes(via)) {
    skipped.push({ op: 'source', why: `${source} has no "${via}" to read.` })
    return { objects: [], cost: 0 }
  }
  if (opts.offline) {
    skipped.push({ op: 'source', why: 'Offline, so this used what was already known.' })
    return { objects: [], cost: 0 }
  }

  try {
    const drafts = await adapter.fetch(via, { ...ctx, params: { ...ctx.params, ...(opts.auth ?? {}) } })
    // Everything fetched is filed, so the next revision of this pane can be
    // built without going back to the network and a pinned pane keeps
    // resolving its refs long after the account is disconnected.
    await observe(
      drafts.map((d) => ({
        identity: { id: d.id, source: d.source, kind: d.kind, nativeId: d.nativeId },
        fields: { title: d.title, sub: d.sub, body: d.body, image: d.image, at: d.at, ...(d.fields ?? {}) },
        prov: d.prov,
      }))
    )
    return {
      objects: drafts.map((d) => ({ ...d, fieldProv: {}, readings: 1 })),
      cost: adapter.cost?.(via) ?? 0,
    }
  } catch (e) {
    skipped.push({ op: 'source', why: `${source}/${via}: ${(e as Error).message}`.slice(0, 200) })
    return { objects: [], cost: 0 }
  }
}

/**
 * Scalars only, from an object an injected reasoner handed over.
 *
 * Anything nested is dropped rather than carried: a field is a value a renderer
 * might show, and a structure arriving here is either a mistake or an attempt
 * to smuggle something past the field-by-field construction above.
 */
function scalarFields(raw: unknown): Record<string, FieldValue> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, FieldValue> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= 24) break
    if (v === null || typeof v === 'number' || typeof v === 'boolean') out[k.slice(0, 60)] = v
    else if (typeof v === 'string') out[k.slice(0, 60)] = v.slice(0, 500)
  }
  return Object.keys(out).length ? out : undefined
}

/** Union by id, keeping the first occurrence's position. */
function merge(a: RetrievedObject[], b: RetrievedObject[]): RetrievedObject[] {
  const seen = new Set(a.map((o) => o.id))
  return [...a, ...b.filter((o) => !seen.has(o.id) && (seen.add(o.id), true))]
}

function fieldOf(o: RetrievedObject, name: string): FieldValue | undefined {
  if (name === 'id') return o.id
  if (name === 'title') return o.title
  if (name === 'sub') return o.sub
  if (name === 'at') return o.at
  if (name === 'kind') return o.kind
  if (name === 'source') return o.source
  return o.fields?.[name]
}

function applyFilter(objects: RetrievedObject[], n: FilterNode, now: number): RetrievedObject[] {
  const needle = n.text?.toLowerCase()
  const keep = (o: RetrievedObject): boolean => {
    if (n.where) for (const [k, v] of Object.entries(n.where)) if (fieldOf(o, k) !== v) return false
    if (needle) {
      const hay = `${o.title} ${o.sub ?? ''} ${o.body ?? ''}`.toLowerCase()
      if (!hay.includes(needle)) return false
    }
    if (n.range) {
      const raw = fieldOf(o, n.range.field)
      const v = typeof raw === 'number' ? raw : Date.parse(String(raw ?? ''))
      if (!Number.isFinite(v)) return false
      const min = n.range.min === undefined ? -Infinity : bound(n.range.min)
      const max = n.range.max === undefined ? Infinity : bound(n.range.max)
      if (v < min || v > max) return false
    }
    if (n.freshOnly && provenanceLabel(o.prov, now).includes('may have changed')) return false
    return true
  }
  return objects.filter((o) => (n.not ? !keep(o) : keep(o)))
}

const bound = (v: number | string): number => (typeof v === 'number' ? v : Date.parse(v))

function byField(name: string, dir: 'asc' | 'desc') {
  const sign = dir === 'asc' ? 1 : -1
  return (a: RetrievedObject, b: RetrievedObject) => {
    const x = fieldOf(a, name)
    const y = fieldOf(b, name)
    const nx = typeof x === 'number' ? x : Date.parse(String(x ?? '')) || 0
    const ny = typeof y === 'number' ? y : Date.parse(String(y ?? '')) || 0
    if (nx || ny) return sign * (nx - ny)
    return sign * String(x ?? '').localeCompare(String(y ?? ''))
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * Objects to a widget spec.
 *
 * The images come off the objects, which came off the store, which was written
 * by the adapter that fetched them. There is no path by which a URL from a plan
 * or a model reaches this function — the IR has no field for one.
 */
/**
 * DOMAIN SEMANTICS OUTRANK GENERIC PRESENTATION.
 *
 * `present.widget` is whatever the compiler emitted, and its default is
 * `'list'` — so "show me the route to Avano" came back as a bulleted list
 * containing the sentence "No route found", filling a workspace with a generic
 * empty card where a map belongs. The list was not wrong about the DATA; it was
 * wrong about what kind of thing had been asked for.
 *
 * A generic renderer is a fallback for output nothing better fits. Where a
 * richer trusted renderer exists for what this actually IS, that renderer wins,
 * and the two facts that decide it are the request and the objects — never a
 * keyword in a title.
 *
 * Deliberately: an explicit non-list choice from the compiler is respected.
 * Overriding `media` with `map` because the objects have coordinates would be
 * this rule making the same mistake in the opposite direction.
 */
export function presentationFor(
  intent: string,
  objects: Pick<RetrievedObject, 'kind'>[],
  present?: Pick<PresentNode, 'widget'>,
): string {
  const chosen = present?.widget
  if (chosen && chosen !== 'list') return chosen

  // What he asked for. A route is a route even when it resolved to nothing —
  // especially then, because an unresolved route is a state a map can show and
  // a list can only describe.
  if (/\b(route|directions|drive|driving|walk|walking|cycle|navigate|get to|take me|how far|how long to get)\b/i.test(intent)) {
    return 'map'
  }

  // What came back. One clear kind across the objects means the domain
  // application for that kind is the right frame for them.
  const kinds = new Set(objects.map((o) => o.kind).filter(Boolean))
  if (kinds.size === 1) {
    switch ([...kinds][0]) {
      case 'place': return 'map'
      case 'event': return 'agenda'
      case 'video': return 'media'
      default: break
    }
  }

  return chosen ?? 'list'
}

function render(
  objects: RetrievedObject[],
  present: PresentNode | undefined,
  now: number,
  intent = '',
): WidgetPane[] {
  const items: WidgetItem[] = objects.map((o) => ({
    id: o.id,
    title: o.title,
    sub: o.sub,
    body: o.body,
    meta: typeof o.fields?.durationLabel === 'string' ? o.fields.durationLabel : undefined,
    at: o.at,
    image: o.image,
    ref: o.id,
    provenance: provenanceLabel(o.prov, now),
    origin: undefined,
  }))

  const kind = presentationFor(intent, objects, present)
  const empty = present?.empty ?? 'Nothing matched.'

  /*
    A MAP THAT RESOLVED NOTHING IS STILL A MAP.

    It shows the places it has — none, here — and the surface says the route is
    unresolved. That is a state of the trip, and it is what the missing-slot
    flow in the client then asks about. The alternative, and what it did before,
    was a full-height generic card saying "No route found" and nothing to do
    about it.
  */
  const widget: Widget =
    kind === 'map'
      ? {
          kind: 'map',
          places: objects.flatMap((o) =>
            typeof o.fields?.lat === 'number' && typeof o.fields?.lon === 'number'
              ? [{ id: o.id, label: o.title, sub: o.sub, lat: o.fields.lat, lon: o.fields.lon }]
              : []),
          route: 'drive',
          searchable: true,
        }
      : kind === 'media'
        ? { kind: 'media', items, columns: present?.columns ?? 2, empty }
        : kind === 'agenda'
          ? { kind: 'agenda', items, days: 7, empty }
          : { kind: 'list', items, expandable: true, empty }

  return [{ title: present?.title, widget }]
}

/**
 * What a plan will cost before it runs.
 *
 * Asked by the refresh path so an interval policy over an expensive route can
 * be declined rather than discovered on the bill. Adapters report their own
 * units; anything unmetered contributes nothing and says nothing.
 */
export function estimateCost(plan: Plan): number | undefined {
  let total = 0
  let known = false
  for (const node of plan.nodes) {
    if (node.op !== 'source' && node.op !== 'enrich') continue
    const n = node as SourceNode | EnrichNode
    const c = adapters.get(n.source)?.cost?.(n.via)
    if (c !== undefined) {
      total += c
      known = true
    }
  }
  return known ? total : undefined
}

/** Provenance for a whole pane: what the set of it rests on. */
export function paneProvenance(objects: RetrievedObject[]): Provenance | undefined {
  const provs = objects.map((o) => o.prov)
  if (!provs.length) return undefined
  return provs.length === 1 ? provs[0] : derive('enriched', provs, { note: `${provs.length} records` })
}
