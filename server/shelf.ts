/**
 * What is on the splash, in what order, and whether it shows at all.
 *
 * The feed populates itself: connect an account and its card appears, open a
 * pane and it takes a place. That is the behaviour worth having by default and
 * it is also the behaviour that, unchecked, makes the screen someone else's.
 * So there is a second rule beside it, and the whole of this file is that rule:
 *
 *   WHAT HE DECIDED OUTRANKS WHAT ANYTHING ELSE DECIDED, INCLUDING LATER.
 *
 * Every entry records who last placed it. Auto-registration and any future
 * agent-side arrangement may only move and hide entries still marked `agent`;
 * the moment he drags one or switches one off it becomes `user` and nothing but
 * him touches it again. Without that, "the assistant can rearrange your feed"
 * and "you can rearrange your feed" are the same switch fighting over one
 * value, and the one that ran most recently wins — which from where he is
 * sitting is indistinguishable from the app ignoring him.
 *
 * Entry ids are STABLE and that constrains what can be an entry. A source card
 * is `src-mail` for as long as mail is connected; a pane is its pane id for as
 * long as it exists. Model-authored synthesis cards are not: they are minted
 * fresh every pass, so they appear as one entry — `synthesis` — for the block
 * as a whole. An entry per ephemeral card would be a settings screen that grew
 * a new dead row every time it thought.
 */

export type ShelfKind = 'synthesis' | 'source' | 'pane'

export interface ShelfItem {
  /** Stable across passes. 'synthesis' | 'src-<key>' | a pane id. */
  id: string
  kind: ShelfKind
  /** What to call it in settings. Refreshed from the live feed, never edited. */
  label: string
  on: boolean
  /**
   * Who last decided this entry's position and visibility.
   *
   * The load-bearing field. `agent` means "nobody has expressed a preference,
   * so arrange it sensibly"; `user` means "hands off".
   */
  by: 'user' | 'agent'
  /** First seen. Only used to keep a burst of new entries in a stable order. */
  addedAt: string
}

export interface Shelf {
  items: ShelfItem[]
  updatedAt: string
}

export interface ShelfStore {
  read(): Promise<Shelf | null>
  write(s: Shelf): Promise<void>
}

let store: ShelfStore | null = null

export function setShelfStore(s: ShelfStore): void {
  store = s
}

export function kvShelfStore(kv: KVNamespace, key = 'shelf'): ShelfStore {
  return {
    async read() {
      const raw = await kv.get(key)
      return raw ? (JSON.parse(raw) as Shelf) : null
    },
    async write(s) {
      await kv.put(key, JSON.stringify(s))
    },
  }
}

const EMPTY: Shelf = { items: [], updatedAt: new Date(0).toISOString() }

/**
 * A missing shelf is an empty one, not an error.
 *
 * Unlike panes, nothing here is irreplaceable: losing the shelf costs him his
 * arrangement, and the next feed rebuilds every entry from what is actually
 * connected. So it degrades to the default layout rather than refusing to
 * render the splash — a home screen that will not draw because a preferences
 * file is missing is the worse failure by a distance.
 */
export async function readShelf(): Promise<Shelf> {
  if (!store) return EMPTY
  try {
    const s = await store.read()
    return s && Array.isArray(s.items) ? s : EMPTY
  } catch {
    return EMPTY
  }
}

async function save(items: ShelfItem[]): Promise<Shelf> {
  const shelf: Shelf = { items, updatedAt: new Date().toISOString() }
  if (store) await store.write(shelf)
  return shelf
}

/** One entry the live feed says exists. */
export interface Seen {
  id: string
  kind: ShelfKind
  label: string
}

/**
 * Reconcile the shelf against what the feed actually produced.
 *
 * Additive, and never destructive in the direction that would lose a decision.
 * A newly connected source appears, switched on, at the end. A source that has
 * gone away KEEPS its entry — disconnecting an account for an afternoon and
 * finding your arrangement rebuilt from scratch afterwards is the behaviour
 * this avoids — it simply has nothing to render until it comes back.
 *
 * Labels are refreshed from the feed on every pass, because a label is a
 * description of a live thing rather than a preference: the pane he called "the
 * scary videos" should say so in settings after he renames it.
 */
export async function reconcile(seen: Seen[]): Promise<Shelf> {
  const shelf = await readShelf()
  const byId = new Map(shelf.items.map((i) => [i.id, i]))
  let changed = false

  for (const s of seen) {
    const existing = byId.get(s.id)
    if (!existing) {
      byId.set(s.id, { id: s.id, kind: s.kind, label: s.label, on: true, by: 'agent', addedAt: new Date().toISOString() })
      changed = true
    } else if (existing.label !== s.label || existing.kind !== s.kind) {
      byId.set(s.id, { ...existing, label: s.label, kind: s.kind })
      changed = true
    }
  }

  if (!changed) return shelf
  // Existing order first, in the order it already had; genuinely new entries
  // appended in the order the feed offered them. Nothing he placed moves.
  const order = new Map(shelf.items.map((i, n) => [i.id, n]))
  const items = [...byId.values()].sort(
    (a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity) || a.addedAt.localeCompare(b.addedAt)
  )
  return save(items)
}

/**
 * His arrangement. Everything named becomes his, in the order given.
 *
 * Ids he did not mention keep their entries and follow, so a client working
 * from a stale list cannot delete a card by forgetting to send it.
 */
export async function arrange(order: string[]): Promise<Shelf> {
  const shelf = await readShelf()
  const wanted = order.filter((id, i) => order.indexOf(id) === i)
  const rank = new Map(wanted.map((id, i) => [id, i]))
  const items = [...shelf.items]
    .sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
    .map((i) => (rank.has(i.id) ? { ...i, by: 'user' as const } : i))
  return save(items)
}

/** On or off, by him. Unknown ids are ignored rather than invented. */
export async function toggle(id: string, on: boolean): Promise<Shelf> {
  const shelf = await readShelf()
  if (!shelf.items.some((i) => i.id === id)) return shelf
  return save(shelf.items.map((i) => (i.id === id ? { ...i, on, by: 'user' } : i)))
}

/**
 * Drop an entry entirely. For a pane he closed — not for hiding something.
 *
 * Deliberately not reachable from the toggle: "off" and "gone" are different
 * answers, and collapsing them means switching a card off silently forgets that
 * he ever placed it, so switching it back on puts it somewhere else.
 */
export async function forget(id: string): Promise<Shelf> {
  const shelf = await readShelf()
  return save(shelf.items.filter((i) => i.id !== id))
}

/**
 * Order a live feed by the shelf, dropping what is switched off.
 *
 * Anything the shelf has never heard of sorts to the end rather than
 * disappearing. The shelf is a preference over the feed, not a whitelist for
 * it: a card that appeared between the last reconcile and this render must
 * still be shown, or a race decides whether he sees something.
 */
export function applyShelf<T>(shelf: Shelf, entries: { id: string; value: T }[]): T[] {
  const rank = new Map(shelf.items.map((i, n) => [i.id, n]))
  const off = new Set(shelf.items.filter((i) => !i.on).map((i) => i.id))
  return entries
    .filter((e) => !off.has(e.id))
    .map((e, n) => ({ e, at: rank.get(e.id) ?? shelf.items.length + n }))
    .sort((a, b) => a.at - b.at)
    .map((x) => x.e.value)
}
