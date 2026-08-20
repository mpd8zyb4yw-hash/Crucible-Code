/**
 * WHAT HE IS LOOKING AT — one derivation, read by both consumers.
 *
 * There are exactly two things that need to know what is on screen, and they had
 * completely separate answers:
 *
 *   · the MODEL, through `snapshot()` in `surface/store.ts`, which serialises
 *     every mounted surface with its state, its capabilities and its objects;
 *   · the LADDER, through `KnownWorld` in `task/resolve.ts`, which was rebuilt
 *     by hand inside `App.tsx` from the feed's panes.
 *
 * Two derivations of one fact drift, and this pair drifted in a specific and
 * damaging direction: `snapshot()` returns `[]` when no surface is mounted, and
 * no surface is mounted on Home. So on the screen where most conversations
 * actually start, the model was told nothing whatsoever about what he could see.
 * "When should I leave?" asked from Home, with the event legible on a card two
 * inches above the composer, reached a model that had been handed no event.
 *
 * This file is the single derivation. It does not introduce a new context type —
 * it EXTENDS the existing `snapshot()` contract with the one location that was
 * excluded from it, and projects the same objects into the shape the ladder
 * reads. Home is not pretended to be a surface: it declares no operations, which
 * is what stops the model trying to `filter` a home screen.
 */

import type { Feed, Need } from './api'
import { snapshot } from './surface/store'
import { watchesOf } from './home/lanes'
import type { Attention, KnownObject, KnownWorld } from './task/resolve'

/** A read-only context row, shaped like a surface brief so `say` needs no branch. */
export interface ContextBrief {
  key: string
  title: string
  kind: string
  state: Record<string, unknown>
  can: string[]
  showing: { id: string; label: string; sub?: string; at?: string; unread?: boolean }[]
  total: number
}

/**
 * Every canonical object the feed is currently showing him, with WHY it is
 * reachable.
 *
 * `attentionId` is the object the card in the `now` band is about — the closest
 * thing Home has to a focus, and the referent of "this" and "that" when nothing
 * is open. It ranks above the rest of what is merely visible, and below anything
 * he has actually touched inside a surface.
 */
function homeObjects(feed: Feed | null, attentionId: string | null): KnownObject[] {
  if (!feed) return []
  const out: KnownObject[] = []
  const push = (o: KnownObject) => {
    if (!out.some((x) => x.id === o.id)) out.push(o)
  }

  for (const n of feed.needs ?? []) {
    for (const p of n.panes ?? []) {
      const w = p.widget
      if (w.kind === 'calendar') {
        for (const e of w.events) {
          push({ id: e.id, label: e.title, sub: e.location, at: e.start, end: e.end, allDay: e.allDay, kind: 'event' })
        }
      }
      if (w.kind === 'mail') {
        for (const m of w.messages) push({ id: m.id, label: m.subject, sub: m.fromName ?? m.from, at: m.at, kind: 'message' })
      }
      if (w.kind === 'map') for (const pl of w.places) push({ id: pl.id, label: pl.label, sub: pl.sub, kind: 'place' })
      if (w.kind === 'video') for (const v of w.videos) push({ id: v.id, label: v.title, sub: v.channel, kind: 'video' })
    }
  }
  for (const w of watchesOf(feed.items ?? [])) push({ id: w.id, label: w.what, sub: w.why, kind: 'watch' })

  return out.map((o) => ({ ...o, rank: (o.id === attentionId ? 'focused' : 'visible') as Attention }))
}

/**
 * The one object Home is currently ABOUT, if it is about one.
 *
 * Read off the highest-ranked card rather than guessed: the server has already
 * decided which item leads the `now` band, and its `focus` names the object its
 * line is about. That is the same field an opened card uses to land on the right
 * row, so the referent is identical whether he opens it or asks about it.
 */
export function attentionObject(feed: Feed | null): { id: string; card: string; kind: string } | null {
  const lead = (feed?.needs ?? []).find((n) => n.band === 'now' && n.focus) ?? (feed?.needs ?? []).find((n) => n.focus)
  return lead?.focus ? { id: lead.focus, card: lead.title, kind: lead.id } : null
}

/**
 * THE CONTEXT, for both readers, from one traversal.
 *
 * `briefs` goes to the model verbatim. `world` goes to the resolution ladder.
 * Neither is allowed to be built anywhere else — that is the whole point.
 */
export function contextFor(input: {
  /** The surface the workspace has open, when one is open. */
  open: Need | null
  feed: Feed | null
  /** Live location, only when he has permitted it. */
  location?: KnownWorld['location']
  /** Typed facts the ladder may read — his usual transport, where home is. */
  stated?: Record<string, string>
}): { briefs: ContextBrief[]; world: KnownWorld } {
  const mounted = snapshot() as unknown as ContextBrief[]
  const attention = attentionObject(input.feed)

  /*
    A MOUNTED SURFACE'S OWN ATTENTION ORDER.

    `focus`, `expanded` and `selected` are already in the state the snapshot
    carries; the ladder needs them as ranks on the objects rather than as ids
    beside them, because the whole ordering rule is expressed over objects.
  */
  const fromSurfaces: KnownObject[] = mounted.flatMap((s) => {
    const st = s.state as { focus?: string | null; expanded?: string | null; selected?: string[] }
    const selected = new Set(st.selected ?? [])
    return s.showing.map((o): KnownObject => ({
      id: o.id,
      label: o.label,
      sub: o.sub,
      at: o.at,
      kind: s.kind === 'calendar' ? 'event' : s.kind === 'mail' ? 'message' : s.kind,
      // An all-day calendar object publishes no clock time in `at`; the surface
      // marks it and the ladder must not read a bare date as a start time.
      allDay: s.kind === 'calendar' ? !/T\d\d:/.test(o.at ?? '') : undefined,
      rank:
        st.focus === o.id ? 'focused'
        : st.expanded === o.id ? 'expanded'
        : selected.has(o.id) ? 'selected'
        : 'visible',
    }))
  })

  /*
    HOME AS A CONTEXT ROW, not as a surface.

    `can: []` is a statement, not an omission: Home accepts no interface
    operations, so the model is told what is on it and given no vocabulary for
    operating it. A row with an empty `can` renders in the prompt as read-only.
  */
  const homeRow: ContextBrief[] = mounted.length || !input.feed
    ? []
    : [{
        key: 'home',
        title: 'Home',
        kind: 'home',
        state: {
          location: 'home',
          attentionId: attention?.id ?? null,
          attentionCard: attention?.card ?? null,
          bands: (input.feed.needs ?? []).slice(0, 6).map((n) => ({ title: n.title, band: n.band ?? 'background', asks: n.asks })),
        },
        can: [],
        showing: homeObjects(input.feed, attention?.id ?? null)
          .slice(0, 30)
          .map((o) => ({ id: o.id, label: o.label, sub: o.sub, at: o.at })),
        total: homeObjects(input.feed, attention?.id ?? null).length,
      }]

  const objects = mounted.length
    ? fromSurfaces
    : homeObjects(input.feed, attention?.id ?? null)

  return {
    briefs: [...mounted, ...homeRow],
    world: {
      objects,
      stated: input.stated ?? {},
      location: input.location ?? null,
      // The opened card's own focus still wins where a surface has not
      // published one — a card opened ON an object is a statement about what he
      // is looking at, made before the renderer has drawn anything.
      focus: input.open?.focus ?? attention?.id ?? null,
    },
  }
}
