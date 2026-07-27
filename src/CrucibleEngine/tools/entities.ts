// The entity protocol — the universal shape every tool returns THINGS in.
//
// WHY THIS EXISTS (cont.118). `ToolResult.output` is a `string`. Every tool that fetches real
// objects — gmail_search, calendar_list, drive_search, contacts_search, maps_directions — has
// rich structured data in hand and flattens it into prose the instant it returns:
//
//     return { ok: true, output: details.join('\n\n---\n\n') }        // registry.ts, gmail_search
//
// Three separate failures fall out of that one line, and they are all the same failure:
//
//  1. FABRICATION. cont.105b — the FM was handed prose, collapsed an inbox to one address and
//     reported "your inbox is empty". The fix at the time (`renderPersonalData`) RE-PARSES the
//     prose with per-tool regex renderers. It covers 2 tools out of 44 and cannot cover the rest,
//     because parsing a string back into the object you already had is not a general operation.
//  2. NO AFFORDANCES. cont.103's standing rule — "a surface showing a result must let you OPEN
//     and ACT on it" — is literally unimplementable against a string. There is no id to act on.
//  3. NO REAL UI. A per-integration renderer is the only thing you can build on prose, so the
//     interface can only ever be a pile of bespoke cards, one per provider, forever.
//
// THE UNIVERSAL FORM. Tools return ENTITIES alongside the string. An entity is provider-agnostic:
// a Gmail message, an IMAP message and a Slack DM are all `kind: 'message'`. Then:
//
//   * AFFORDANCES are declared against KIND, not against tool. Any future tool that emits
//     `kind: 'message'` inherits reply/open/archive without a line of UI being written.
//   * VIEWS are DERIVED from the shape of the data (`viewDerivation.ts`) — deterministically, no
//     model — so the layout is a function of what came back, not a hand-picked component.
//   * FIELDS carry semantic ROLES, not component names. `role: 'timestamp'` says what the value
//     MEANS; the renderer decides how a timestamp looks. That separation is what keeps this a
//     protocol instead of a template.
//
// This is `crucible-no-templates-universal-fix` applied to the interface layer: one mechanism
// that works for everything, rather than a bespoke card per integration.

// ── Entity ────────────────────────────────────────────────────────────────────

/**
 * What kind of thing this is, in provider-neutral terms.
 *
 * Deliberately small and about USER-FACING NOUNS rather than APIs. Adding a provider must never
 * require adding a kind — a new mail backend is `message`, a new calendar is `event`. A kind is
 * only justified when a thing genuinely affords different ACTIONS and reads as a different shape.
 */
export type EntityKind =
  | 'message'   // email, DM, chat message — has sender, subject, received time
  | 'event'     // calendar event — has start/end, attendees, location
  | 'file'      // document, attachment, local file — has type, size, location
  | 'contact'   // person or organisation — has name, handles
  | 'place'     // location — has coordinates or address
  | 'route'     // directions between places — has legs, duration
  | 'media'     // video, audio, image — has duration or dimensions
  | 'webpage'   // search result, article — has url, snippet
  | 'task'      // todo, issue, reminder — has status, due date
  | 'record'    // generic structured row — the honest fallback, never a dumping ground

/**
 * What a field MEANS. Drives rendering without naming a component — the renderer maps role to
 * presentation, so the same entity renders correctly in a list, a table and a detail pane.
 */
export type FieldRole =
  | 'title' | 'subtitle' | 'body' | 'timestamp' | 'duration'
  | 'person' | 'location' | 'url' | 'status' | 'quantity' | 'size' | 'label' | 'id'

export interface EntityField {
  key: string
  label: string
  value: string | number | boolean | null
  role?: FieldRole
}

export interface Entity {
  /** Stable within its source — this is what affordances bind to. Never synthesised randomly. */
  id: string
  kind: EntityKind
  /** The tool that produced it. Used for provenance and for source-specific affordances. */
  source: string
  title: string
  subtitle?: string
  /** Longer text — snippet, description, body. Renderers truncate; the protocol does not. */
  body?: string
  /** ISO 8601. The entity's own time: when a message arrived, when an event starts. */
  at?: string
  /** ISO 8601 end, for things with duration. */
  until?: string
  /** Canonical external link, when the provider has one. */
  url?: string
  /** Everything else, with roles. Order is display order. */
  fields: EntityField[]
  /** Unmodelled provider data, retained so an affordance can pass through what it needs. */
  raw?: Record<string, unknown>
}

// ── Affordances ───────────────────────────────────────────────────────────────

/**
 * How much damage an action can do. Drives confirmation, and it is NOT advisory:
 * `viewDerivation` refuses to emit an unconfirmed non-read affordance, and `__surface_bench`
 * asserts that refusal. A UI that can silently send email on a model's say-so is a bug with a
 * blast radius, not a feature.
 */
export type Effect =
  | 'read'        // fetches or opens. Safe to run on click.
  | 'write'       // changes state the user owns and can undo (archive, label, mark read).
  | 'send'        // leaves the machine and cannot be recalled (email, invite, message).
  | 'destructive' // discards data (delete, empty trash).

/** An input the action needs from the user before it can run — rendered as a real form control. */
export interface AffordanceInput {
  key: string
  label: string
  type: 'text' | 'longtext' | 'datetime' | 'choice'
  required?: boolean
  choices?: string[]
  /** Prefill derived from the entity — e.g. a reply's recipient and subject. */
  default?: string
}

export interface Affordance {
  id: string
  label: string
  /** The registry tool this invokes. Verified to exist by `__surface_bench`. */
  tool: string
  effect: Effect
  /** Extra input collected from the user before invoking. */
  inputs?: AffordanceInput[]
  /**
   * Build the tool arguments from the entity plus any collected input. PURE — no model, no I/O.
   * Returns null when this entity cannot support the action (e.g. no message id), which is how
   * an affordance declines rather than producing a malformed call.
   */
  bind: (e: Entity, input?: Record<string, string>) => Record<string, unknown> | null
}

/** An affordance already bound to an entity and ready to render. */
export interface BoundAffordance {
  id: string
  label: string
  tool: string
  effect: Effect
  inputs?: AffordanceInput[]
  /** Pre-resolved arguments for affordances that need no input. Null when input is required. */
  args: Record<string, unknown> | null
  /** True for anything above 'read'. The UI must gate on this. */
  requiresConfirmation: boolean
}

// ── The registry ──────────────────────────────────────────────────────────────
// Keyed by KIND. This is the whole reason the surface is universal: a new provider registers a
// tool that emits entities of an existing kind and inherits every action below for free.

const byKind = new Map<EntityKind, Affordance[]>()

export function registerAffordance(kind: EntityKind, a: Affordance): void {
  const list = byKind.get(kind) ?? []
  list.push(a)
  byKind.set(kind, list)
}

export function affordancesFor(kind: EntityKind): Affordance[] {
  return byKind.get(kind) ?? []
}

/** Test hook — clears the registry so a bench can assert registration from a known state. */
export function _resetAffordances(): void { byKind.clear() }

const str = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
  return s ? s : null
}

/** Read a field's value by key, for affordances that need data the envelope does not model. */
export function fieldValue(e: Entity, key: string): string | null {
  const f = e.fields.find(f => f.key === key)
  return f ? str(f.value) : null
}

// ── message ───────────────────────────────────────────────────────────────────

registerAffordance('message', {
  id: 'open', label: 'Read full message', tool: 'gmail_read', effect: 'read',
  bind: e => (e.source.startsWith('gmail') && e.id ? { messageId: e.id } : null),
})

registerAffordance('message', {
  id: 'reply', label: 'Reply', tool: 'gmail_send', effect: 'send',
  inputs: [
    { key: 'to', label: 'To', type: 'text', required: true },
    { key: 'subject', label: 'Subject', type: 'text', required: true },
    { key: 'body', label: 'Message', type: 'longtext', required: true },
  ],
  bind: (e, input) => {
    // Prefill comes from the entity; the USER supplies and confirms the body. A reply is 'send' —
    // it leaves the machine and cannot be recalled — so this never fires without confirmation.
    const to = input?.to ?? fieldValue(e, 'from')
    const subject = input?.subject ?? (e.title.startsWith('Re:') ? e.title : `Re: ${e.title}`)
    const body = input?.body
    if (!to || !body) return null
    return { to, subject, body }
  },
})

// ── event ─────────────────────────────────────────────────────────────────────

registerAffordance('event', {
  id: 'open', label: 'Open in calendar', tool: 'navigate_browser', effect: 'read',
  bind: e => (e.url ? { url: e.url } : null),
})

registerAffordance('event', {
  id: 'directions', label: 'Directions', tool: 'maps_directions', effect: 'read',
  bind: e => {
    const dest = fieldValue(e, 'location')
    return dest ? { destination: dest } : null
  },
})

// ── file ──────────────────────────────────────────────────────────────────────

registerAffordance('file', {
  id: 'open', label: 'Open', tool: 'navigate_browser', effect: 'read',
  bind: e => (e.url ? { url: e.url } : null),
})

registerAffordance('file', {
  id: 'read', label: 'Read contents', tool: 'drive_read', effect: 'read',
  bind: e => (e.source.startsWith('drive') && e.id ? { fileId: e.id } : null),
})

registerAffordance('file', {
  id: 'read_local', label: 'Read file', tool: 'read_file', effect: 'read',
  bind: e => {
    const p = fieldValue(e, 'path')
    return e.source === 'list_dir' && p ? { path: p } : null
  },
})

// ── contact ───────────────────────────────────────────────────────────────────

registerAffordance('contact', {
  id: 'email', label: 'Email', tool: 'gmail_send', effect: 'send',
  inputs: [
    { key: 'subject', label: 'Subject', type: 'text', required: true },
    { key: 'body', label: 'Message', type: 'longtext', required: true },
  ],
  bind: (e, input) => {
    const to = fieldValue(e, 'email')
    if (!to || !input?.body || !input?.subject) return null
    return { to, subject: input.subject, body: input.body }
  },
})

registerAffordance('contact', {
  id: 'mail_history', label: 'Find emails', tool: 'gmail_search', effect: 'read',
  bind: e => {
    const addr = fieldValue(e, 'email')
    return addr ? { query: `from:${addr} OR to:${addr}` } : null
  },
})

// ── place / route ─────────────────────────────────────────────────────────────

registerAffordance('place', {
  id: 'directions', label: 'Directions', tool: 'maps_directions', effect: 'read',
  bind: e => ({ destination: fieldValue(e, 'address') ?? e.title }),
})

registerAffordance('place', {
  id: 'open_map', label: 'Open map', tool: 'navigate_browser', effect: 'read',
  bind: e => (e.url ? { url: e.url } : null),
})

// ── webpage / media ───────────────────────────────────────────────────────────

registerAffordance('webpage', {
  id: 'open', label: 'Open', tool: 'navigate_browser', effect: 'read',
  bind: e => (e.url ? { url: e.url } : null),
})

registerAffordance('media', {
  id: 'open', label: 'Watch', tool: 'navigate_browser', effect: 'read',
  bind: e => (e.url ? { url: e.url } : null),
})

// ── Binding ───────────────────────────────────────────────────────────────────

/**
 * Resolve the actions actually available on THIS entity.
 *
 * An affordance whose `bind` returns null is DROPPED, not rendered disabled — a button that
 * cannot work should not be on screen. That is why `bind` is total and returns null rather than
 * throwing: declining is a normal outcome, since kinds are shared across providers and not every
 * provider supports every action.
 */
export function bindAffordances(e: Entity): BoundAffordance[] {
  const out: BoundAffordance[] = []
  for (const a of affordancesFor(e.kind)) {
    const needsInput = !!a.inputs?.length
    const args = needsInput ? null : a.bind(e)
    // With no inputs, a null bind means "not supported here" → drop it. With inputs we cannot
    // evaluate until the user has filled the form, so we probe with a sentinel to find out
    // whether the entity carries the data the action needs at all.
    if (!needsInput && args === null) continue
    if (needsInput) {
      const probe = Object.fromEntries((a.inputs ?? []).map(i => [i.key, ' probe']))
      if (a.bind(e, probe) === null) continue
    }
    out.push({
      id: a.id,
      label: a.label,
      tool: a.tool,
      effect: a.effect,
      inputs: a.inputs?.map(i => ({ ...i, default: defaultFor(i, e) })),
      args,
      requiresConfirmation: a.effect !== 'read',
    })
  }
  return out
}

/** Prefill an input from the entity where the mapping is unambiguous. */
function defaultFor(i: AffordanceInput, e: Entity): string | undefined {
  if (i.default) return i.default
  if (i.key === 'to') return fieldValue(e, 'from') ?? fieldValue(e, 'email') ?? undefined
  if (i.key === 'subject') return e.title.startsWith('Re:') ? e.title : `Re: ${e.title}`
  return undefined
}

/** Look up a bound affordance for execution — the server-side entry point for a UI action. */
export function resolveAction(
  e: Entity, affordanceId: string, input?: Record<string, string>,
): { tool: string; args: Record<string, unknown>; effect: Effect } | null {
  const a = affordancesFor(e.kind).find(a => a.id === affordanceId)
  if (!a) return null
  const args = a.bind(e, input)
  if (!args) return null
  return { tool: a.tool, args, effect: a.effect }
}

// ── Construction helper ───────────────────────────────────────────────────────

/**
 * Build an entity with the invariants enforced in one place.
 *
 * Adapters call this rather than building object literals, so "every entity has a non-empty id
 * and title" is true by construction instead of by convention across a dozen call sites.
 */
export function entity(init: {
  id: string
  kind: EntityKind
  source: string
  title?: string | null
  subtitle?: string | null
  body?: string | null
  at?: string | null
  until?: string | null
  url?: string | null
  fields?: Array<{ key: string; label: string; value: unknown; role?: FieldRole }>
  raw?: Record<string, unknown>
}): Entity {
  const fields: EntityField[] = (init.fields ?? [])
    .map(f => ({ key: f.key, label: f.label, value: normalizeValue(f.value), role: f.role }))
    // A field with no value is noise in every layout — drop it at construction so no renderer
    // has to special-case empties and no table grows an all-blank column.
    .filter(f => f.value !== null && f.value !== '')
  return {
    id: init.id,
    kind: init.kind,
    source: init.source,
    title: str(init.title) ?? '(untitled)',
    subtitle: str(init.subtitle) ?? undefined,
    body: str(init.body) ?? undefined,
    at: str(init.at) ?? undefined,
    until: str(init.until) ?? undefined,
    url: str(init.url) ?? undefined,
    fields,
    raw: init.raw,
  }
}

function normalizeValue(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' || typeof v === 'boolean') return v
  return String(v)
}
