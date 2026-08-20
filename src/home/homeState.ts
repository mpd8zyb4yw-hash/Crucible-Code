import { useEffect, useState } from 'react'
import { noteEngaged } from '../api'
import { blankDurable, type Durable, type Lane } from './lanes'

/**
 * PERSISTENCE, SPLIT IN TWO.
 *
 * Treating "persist" as one bucket is what let a background sync silently move
 * the card the user was reading. There are two kinds of state here and they get
 * opposite treatment.
 *
 *   DURABLE — his arrangement, hidden apps, saved results, archived panes, and
 *   when each ephemeral object was first seen. Server-backed, synced across
 *   devices, and mirrored locally so Home paints instantly on reopen.
 *
 *   DEVICE-LOCAL — which card each lane is showing, the chat panel's snap
 *   state, scroll offsets, transient focus. Never synced. Syncing it would mean
 *   his laptop repages his phone, which from where he is sitting is
 *   indistinguishable from the agent doing it.
 *
 * The reconcile order is fixed and matters: paint from the local mirror →
 * reconcile with the server → revalidate live data. A server answer replaces
 * durable state only; it cannot touch `visibleItemId`, so a sync landing while
 * he reads card three leaves him on card three.
 */

const DURABLE_KEY = 'cru:home:durable'
const LOCAL_KEY = 'cru:home:local'

/** Device-local spatial state. Deliberately not part of `Durable`. */
export interface LocalState {
  /** Which card each lane is showing, BY ID — never by index. A ranking change
   *  reorders the deck, and an index would silently point at a different card. */
  visible: Partial<Record<Lane, string>>
  /** Collapsed / expanded / max. See ChatOverlay. */
  chat: 'collapsed' | 'expanded' | 'max'
  /**
   * Which domain the deck is showing, BY ID, for exactly the reason `visible`
   * is by id: the deck's order is a ranking, and a stored index would quietly
   * come back pointing at a different application.
   *
   * Device-local like the rest of this object. Which card is in front is a fact
   * about a screen, and syncing it would mean his phone repaging his laptop.
   */
  deck: string | null
}

const blankLocal = (): LocalState => ({ visible: {}, chat: 'collapsed', deck: null })

function read<T>(key: string, fallback: () => T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...fallback(), ...(JSON.parse(raw) as T) } : fallback()
  } catch {
    return fallback()
  }
}

function write(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* private mode */ }
}

// ── the store ────────────────────────────────────────────────────────────────

let durable: Durable = read(DURABLE_KEY, blankDurable)
/**
 * DEVICE-LOCAL, AND ONE FIELD OF IT DELIBERATELY NOT RESTORED.
 *
 * `visible` and `deck` are a preference — he reads card three, he comes back to
 * card three — and they persist. `chat` is not a preference, it is where a
 * conversation had got to, and restoring it means a cold launch opens onto a
 * maximised chat panel showing yesterday's exchange instead of onto his day.
 *
 * A launch begins collapsed. The workspace is the product; the composer is how
 * you talk to it, not the thing you arrive in.
 */
let local: LocalState = { ...read(LOCAL_KEY, blankLocal), chat: 'collapsed' }
const listeners = new Set<() => void>()

const emit = () => { for (const l of listeners) l() }

/**
 * One step back.
 *
 * Only lifecycle moves are undoable — saving, archiving, dismissing, hiding.
 * They are the operations that make something disappear from where he last saw
 * it, which is the only class of change where "wait, put that back" is a real
 * sentence. One step, because a stack of them is a history feature nobody asked
 * for and this is a safety net.
 */
let undoStack: { label: string; before: Durable } | null = null

export const canUndoHome = (): boolean => undoStack !== null
export const lastHomeAction = (): string | null => undoStack?.label ?? null

/**
 * Changes made here that the server has not acknowledged.
 *
 * Load-bearing, and its absence was a real way to lose his arrangement: a
 * reconcile replaces durable state with the server's copy, so a hide made while
 * offline — written locally, pushed, failed — would be silently rolled back by
 * the next load. While this is set the local mirror is the authority and the
 * reconcile re-pushes instead of overwriting.
 */
let dirty = false

/** Best-effort durable sync. A failed write costs the sync, never the screen. */
async function push(patch: Partial<Durable>): Promise<void> {
  try {
    const res = await fetch('/api/home', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (res.ok) dirty = false
  } catch { /* offline; the local mirror stands and re-syncs on the next load */ }
}

function commit(label: string | null, next: Durable): void {
  if (label) undoStack = { label, before: durable }
  durable = next
  dirty = true
  write(DURABLE_KEY, durable)
  emit()
  void push(durable)
}

export function undoHome(): void {
  if (!undoStack) return
  const { before } = undoStack
  undoStack = null
  commit(null, before)
}

const without = (list: string[], id: string) => list.filter((x) => x !== id)
const with_ = (list: string[], id: string) => (list.includes(id) ? list : [...list, id])

// ── lifecycle operations ─────────────────────────────────────────────────────

/**
 * PROMOTION. A task result or an insight becomes a User Pane.
 *
 * It is removed from `dismissed` as well as added to `saved`, so saving
 * something previously dismissed genuinely brings it back. It is deliberately
 * NOT pinned: pinning is a separate, stronger statement, and quietly making
 * every saved thing permanent is how a curated lane becomes an accumulated one.
 */
export function saveObject(id: string, about?: string): void {
  /**
   * Keeping something is the clearest possible statement that it was worth
   * showing. `about` is the card's subject, so what is learned is "travel cards
   * are worth his time" rather than an opinion about cards in general. It only
   * moves a ranking — his stated preferences are untouched. See `noteEngaged`.
   */
  noteEngaged(about, 'accepted')
  commit('Saved', { ...durable, saved: with_(durable.saved, id), dismissed: without(durable.dismissed, id) })
  /**
   * Show it where it landed.
   *
   * Moving his viewport is normally forbidden — but this move IS his: he tapped
   * save, and a promotion he cannot see is indistinguishable from one that did
   * not happen. The transition is the deck's ordinary fade rather than anything
   * theatrical, and the seam offers the undo.
   *
   * `background` because that is where a saved thing lands now: saving does not
   * make something urgent, it makes it PERMANENT, and those are different axes.
   * It used to be the "panes" lane, which was the same statement back when the
   * screen was filed by where things came from.
   */
  setVisible('background', id)
}

/**
 * SWIPING SOMETHING AWAY IS EVIDENCE, NOT AN INSTRUCTION.
 *
 * The dismissal itself is local and immediate — it is his screen. What goes to
 * the server is the weaker claim: a card about this subject was not worth his
 * time this once. It nudges the ranking within bounds and can never suppress a
 * subject on its own; that is what "don't use this" is for, which is him saying
 * it, in words, visibly and reversibly. See `person.ts`'s `engagement`.
 */
export const dismissObject = (id: string, about?: string): void => {
  noteEngaged(about, 'dismissed')
  commit('Dismissed', { ...durable, dismissed: with_(durable.dismissed, id) })
}

/**
 * Archive a User Pane.
 *
 * Removes its Home placement and its pane state. It does not mint a new
 * indefinite retention policy for the content: whatever the global action and
 * task log already keeps, it keeps, and that record is a separate artefact from
 * the pane itself.
 */
export const archivePane = (id: string): void =>
  commit('Archived', { ...durable, archived: with_(durable.archived, id), pinnedPanes: without(durable.pinnedPanes, id) })

export const restorePane = (id: string): void =>
  commit('Restored', { ...durable, archived: without(durable.archived, id) })

export const pinPane = (id: string, on: boolean): void =>
  commit(on ? 'Pinned' : 'Unpinned', {
    ...durable,
    pinnedPanes: on ? with_(durable.pinnedPanes, id) : without(durable.pinnedPanes, id),
  })

export const hideApp = (id: string, hidden: boolean): void =>
  commit(hidden ? 'Hidden' : 'Shown', {
    ...durable,
    hiddenApps: hidden ? with_(durable.hiddenApps, id) : without(durable.hiddenApps, id),
  })

/** His order, explicitly. Nothing else ever writes this list. */
export const reorderApps = (order: string[]): void =>
  commit('Reordered', { ...durable, systemOrder: order })

/**
 * Start an ephemeral object's retention clock.
 *
 * Written when it is actually rendered, not when it was produced, so a result
 * that arrived while the phone was in a pocket still gets its full window in
 * front of him. Idempotent — the first stamp wins, here and on the server.
 */
export function markSeen(ids: string[]): void {
  const now = new Date().toISOString()
  const add: Record<string, string> = {}
  for (const id of ids) if (!durable.seenAt[id]) add[id] = now
  if (!Object.keys(add).length) return
  durable = { ...durable, seenAt: { ...durable.seenAt, ...add } }
  write(DURABLE_KEY, durable)
  emit()
  void push({ seenAt: add })
}

// ── device-local ─────────────────────────────────────────────────────────────

export function setVisible(lane: Lane, id: string): void {
  if (local.visible[lane] === id) return
  local = { ...local, visible: { ...local.visible, [lane]: id } }
  write(LOCAL_KEY, local)
  emit()
}

export function setDeck(id: string): void {
  if (local.deck === id) return
  local = { ...local, deck: id }
  write(LOCAL_KEY, local)
  emit()
}

export function setChatSnap(chat: LocalState['chat']): void {
  if (local.chat === chat) return
  local = { ...local, chat }
  write(LOCAL_KEY, local)
  emit()
}

// ── reconciliation ───────────────────────────────────────────────────────────

/**
 * Bring the local mirror up to date with the server.
 *
 * Runs AFTER the first paint, deliberately. The mirror is what makes reopening
 * the app instant, and waiting for this before drawing would trade a correct
 * screen now for the same screen a round-trip later. The server's copy wins for
 * durable fields; device-local state is not in the payload at all, so there is
 * nothing here that could move his viewport.
 */
export async function reconcileHome(): Promise<void> {
  // Something local has not landed yet. Pushing it is the reconciliation; taking
  // the server's older copy would be undoing a decision he already made.
  if (dirty) { await push(durable); return }
  try {
    const res = await fetch('/api/home')
    if (!res.ok) return
    const server = (await res.json()) as Partial<Durable>
    const merged: Durable = {
      ...blankDurable(),
      ...server,
      // The earliest stamp wins on both sides; a result read on the phone must
      // not get a fresh retention window on the laptop.
      seenAt: { ...server.seenAt, ...durable.seenAt },
    }
    durable = merged
    write(DURABLE_KEY, durable)
    emit()
  } catch { /* offline; the mirror stands */ }
}

// ── React ────────────────────────────────────────────────────────────────────

export function useHomeState(): { durable: Durable; local: LocalState } {
  const [, bump] = useState(0)
  useEffect(() => {
    const l = () => bump((n) => n + 1)
    listeners.add(l)
    return () => { listeners.delete(l) }
  }, [])
  return { durable, local }
}
