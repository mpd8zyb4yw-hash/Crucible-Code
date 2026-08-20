/**
 * DURABLE HOME STATE — the decisions only he can make.
 *
 * "Persist" is not one bucket. What he arranged, hid, saved or archived is a
 * fact about HIM and belongs on the server, so his phone and his Mac agree
 * about which apps he hid and which task results he kept. Which card of a deck
 * is currently in front, how far a rail is scrolled and whether the chat panel
 * is expanded are facts about a DEVICE, and syncing them would mean his phone
 * quietly repaging his laptop — the exact class of viewport theft the product
 * forbids. Those stay in the browser; see `src/home/homeState.ts`.
 *
 * Everything here is small, additive and hand-readable on purpose. If Home ever
 * refuses to draw, this is the document to look at, and deleting it is a
 * supported way back to the factory arrangement — it destroys no content,
 * because none of it is content.
 */

export interface HomeState {
  /** System app order, as ids. Anything unlisted keeps its factory position. */
  systemOrder: string[]
  hiddenApps: string[]
  pinnedPanes: string[]
  /** Task results and insights he saved. These become User Panes. */
  saved: string[]
  archived: string[]
  dismissed: string[]
  /**
   * When each ephemeral object was first put in front of him.
   *
   * Durable rather than device-local, and this is deliberate: the retention
   * clock for a completed task starts when it was SEEN, and a result he read on
   * his phone must not get a fresh six hours on the laptop.
   */
  seenAt: Record<string, string>
  updatedAt: string
}

export const blankHome = (): HomeState => ({
  systemOrder: [], hiddenApps: [], pinnedPanes: [], saved: [], archived: [], dismissed: [], seenAt: {},
  updatedAt: new Date().toISOString(),
})

export interface HomeStore {
  read(): Promise<HomeState | null>
  write(s: HomeState): Promise<void>
}

let store: HomeStore | null = null

export function setHomeStore(s: HomeStore): void {
  store = s
}

export function kvHomeStore(kv: KVNamespace, key = 'home'): HomeStore {
  return {
    async read() {
      const raw = await kv.get(key)
      return raw ? (JSON.parse(raw) as HomeState) : null
    },
    async write(s) {
      await kv.put(key, JSON.stringify(s))
    },
  }
}

export async function readHome(): Promise<HomeState> {
  if (!store) return blankHome()
  try {
    return (await store.read()) ?? blankHome()
  } catch {
    // A durable read that throws must cost the sync, not the screen: the client
    // already painted from its local mirror and reconciles against this.
    return blankHome()
  }
}

const list = (v: unknown, fallback: string[]): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : fallback

/**
 * A partial write, merged.
 *
 * PATCH rather than PUT because two devices legitimately change different parts
 * of this at once — hiding an app on the phone must not roll back a pane
 * archived on the Mac thirty seconds earlier. `seenAt` merges per key and keeps
 * the EARLIEST timestamp, since the retention clock starts when a thing was
 * first seen anywhere.
 */
export async function writeHome(patch: Partial<HomeState>): Promise<HomeState> {
  const cur = await readHome()
  const seenAt = { ...cur.seenAt }
  for (const [id, at] of Object.entries(patch.seenAt ?? {})) {
    if (typeof at !== 'string') continue
    const have = Date.parse(seenAt[id] ?? '')
    const next = Date.parse(at)
    if (!Number.isFinite(have) || (Number.isFinite(next) && next < have)) seenAt[id] = at
  }
  const next: HomeState = {
    systemOrder: list(patch.systemOrder, cur.systemOrder),
    hiddenApps: list(patch.hiddenApps, cur.hiddenApps),
    pinnedPanes: list(patch.pinnedPanes, cur.pinnedPanes),
    saved: list(patch.saved, cur.saved),
    archived: list(patch.archived, cur.archived),
    dismissed: list(patch.dismissed, cur.dismissed),
    seenAt,
    updatedAt: new Date().toISOString(),
  }
  if (store) await store.write(next)
  return next
}
