import { registerAction } from './actions.js'
import { goalPhrase } from './activity.js'
import { gmailModify, gmailReply, gmailDraft, gmailDeleteDraft, calendarCreate, calendarRsvp, calendarUpdate } from './google.js'
import { addObservations } from './world.js'
import { addTrack, listTracks, removeTrack, runTrack, updateTrack } from './tracks.js'
import { pauseGoal, setGoal } from './personRoutes.js'

/**
 * EVERYTHING THE APP CAN DO TO THE WORLD. ONE TABLE, TWO HOSTS.
 *
 * This existed twice — once in `server/index.ts` for the Mac and once in
 * `worker/index.ts` for the edge — as two byte-identical blocks that differed
 * only in how they reached a Google token. Nobody intended a fork; it is just
 * what happens when the same list is typed in two places.
 *
 * The cost was not theoretical. `calendar.update` — the verb behind "that's
 * the wrong name, call it Cinzia's" — was missing from BOTH, and the shape of
 * the duplication is why: adding a capability meant remembering a second file
 * with no compiler, test or type to say you had forgotten. The phone talks to
 * the edge, so a capability added only to the Mac copy would have been an
 * assistant that could rename an event on a laptop nobody uses.
 *
 * Anything the assistant can DO now goes here, once. The two hosts supply the
 * two things that genuinely differ between them — how to get a Google token,
 * and where the search keys live — and get an identical action table.
 *
 * A NOTE ON REVERSIBILITY. Every action but one returns an `undo` describing
 * the exact inverse, and `mail.send` is the single irreversible one; `perform`
 * refuses it without a user confirmation and there is no flag that waives that.
 * An action that cannot say how to undo itself does not belong in this file.
 */
export interface Host {
  /** A Google access token, or a throw explaining that Google is not connected. */
  google: () => Promise<string>
  /** Whatever search keys this host has, for running a watch on demand. */
  searchKeys: () => Promise<{ brave?: string; tavily?: string }>
}

const str = (p: Record<string, unknown>, k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '')

export function installCapabilities({ google, searchKeys }: Host): void {
  // ── mail ──────────────────────────────────────────────────────────────────
  // Reading and organising. Reversible in Gmail, and reversible here: the undo
  // is the opposite label change, recorded with the action that made it.
  registerAction('mail.archive', {
    async run(p) {
      await gmailModify(await google(), str(p, 'messageId'), { removeLabelIds: ['INBOX'] })
      return { undo: { kind: 'mail.unarchive', params: { messageId: str(p, 'messageId') } } }
    },
  })
  registerAction('mail.unarchive', {
    async run(p) {
      await gmailModify(await google(), str(p, 'messageId'), { addLabelIds: ['INBOX'] })
      return { undo: { kind: 'mail.archive', params: { messageId: str(p, 'messageId') } } }
    },
  })
  registerAction('mail.read', {
    async run(p) {
      await gmailModify(await google(), str(p, 'messageId'), { removeLabelIds: ['UNREAD'] })
      return { undo: { kind: 'mail.unread', params: { messageId: str(p, 'messageId') } } }
    },
  })
  registerAction('mail.unread', {
    async run(p) {
      await gmailModify(await google(), str(p, 'messageId'), { addLabelIds: ['UNREAD'] })
      return { undo: { kind: 'mail.read', params: { messageId: str(p, 'messageId') } } }
    },
  })

  /**
   * Sending. The only outbound action in the app, and the only irreversible one.
   *
   * `irreversible` is not advisory: `perform` refuses it unless the
   * authorisation is a user who confirmed. No model-authored widget can name
   * this intent either — `mail.send` is not in the model-safe grammar — so it
   * is reachable exactly one way.
   */
  registerAction('mail.send', {
    irreversible: true,
    async run(p) {
      await gmailReply(await google(), str(p, 'messageId'), str(p, 'text'))
      return {}
    },
  })

  /**
   * DRAFTING, WHICH IS NOT SENDING, AND THE DIFFERENCE IS THE FEATURE.
   *
   * The people-aware journey ends in a message to a third party — "are you
   * driving tomorrow?" — and there is no version of this app that sends that on
   * his behalf. `mail.send` above exists for a reply he typed and confirmed; it
   * is irreversible and `perform` refuses it without his confirmation.
   *
   * A draft is a different object. It lands in HIS mailbox, he opens it, changes
   * the wording that only he can get right, and sends it himself — or deletes it
   * and nothing ever happened. That makes it fully reversible, which is why it
   * can be offered from a card with no dialog, and why the undo below is exact
   * rather than approximate.
   *
   * The card that offers this says, in the app's own words, that nothing has
   * been sent. See `draft.ts`'s `disclosure`.
   */
  registerAction('mail.draft', {
    async run(p) {
      const made = await gmailDraft(await google(), {
        to: str(p, 'to'),
        subject: str(p, 'subject'),
        body: str(p, 'text') || str(p, 'body'),
      })
      return { id: made.id, undo: { kind: 'mail.draft.discard', params: { draftId: made.id } } }
    },
  })
  registerAction('mail.draft.discard', {
    async run(p) {
      await gmailDeleteDraft(await google(), str(p, 'draftId'))
      return {}
    },
  })

  // ── calendar ──────────────────────────────────────────────────────────────
  registerAction('calendar.create', {
    async run(p) {
      const made = await calendarCreate(await google(), {
        summary: str(p, 'summary') || str(p, 'text'),
        start: str(p, 'start') || new Date().toISOString(),
        end: str(p, 'end') || undefined,
        location: str(p, 'location') || undefined,
      })
      return { id: made.id }
    },
  })

  /**
   * CHANGE AN EVENT THAT IS ALREADY THERE.
   *
   * The verb the app was missing. He told it "Comic concert in avano" was the
   * wrong name and asked for "Cinzia's"; it could create events and it could
   * RSVP to them, and that was the whole of its calendar vocabulary — so the
   * only calendar-shaped thing available to a model asked to rename something
   * was a refresh, which it then narrated as though it had been the rename.
   *
   * The undo carries the PREVIOUS values, read back from Google inside the
   * same call rather than guessed from a cache, and only for the fields this
   * call actually touched — so undoing a rename cannot also revert a time he
   * changed separately in between.
   */
  registerAction('calendar.update', {
    async run(p) {
      const eventId = str(p, 'eventId')
      const change = {
        summary: str(p, 'summary') || undefined,
        start: str(p, 'start') || undefined,
        end: str(p, 'end') || undefined,
        location: str(p, 'location') || undefined,
        description: str(p, 'description') || undefined,
      }
      const { before } = await calendarUpdate(await google(), eventId, change)
      const undo: Record<string, string> = { eventId }
      for (const k of Object.keys(change) as (keyof typeof change)[]) {
        if (change[k] !== undefined && before[k] !== undefined) undo[k] = String(before[k])
      }
      return { undo: { kind: 'calendar.update', params: undo } }
    },
  })

  registerAction('calendar.rsvp', {
    async run(p) {
      await calendarRsvp(await google(), str(p, 'eventId'), str(p, 'response'))
      return { undo: { kind: 'calendar.rsvp', params: { eventId: str(p, 'eventId'), response: 'needsAction' } } }
    },
  })

  // ── the world model ───────────────────────────────────────────────────────
  /**
   * Something happened that the assistant should know about. The one action a
   * model-authored widget can take, and it only ever adds to the world model.
   */
  registerAction('world.tell', {
    async run(p) {
      await addObservations([
        {
          id: `act-${Date.now()}`,
          source: 'user',
          at: new Date().toISOString().slice(0, 10),
          text: str(p, 'text') || 'acted on a card',
        },
      ])
      return {}
    },
  })

  // ── watches ───────────────────────────────────────────────────────────────
  /**
   * All reversible and all invisible to anyone but him, so none is marked
   * irreversible — pausing a watch, re-timing it and checking it now are the
   * same class of thing as opening a card. Removing one is different: it
   * destroys the interest itself, so it carries the way back.
   */
  registerAction('track.toggle', {
    async run(p) {
      const active = p.active === true || p.active === 'true'
      const t = await updateTrack(str(p, 'id'), { active })
      if (!t) throw new Error('That watch is gone.')
      return { id: t.id, undo: { kind: 'track.toggle', params: { id: t.id, active: !active } } }
    },
  })
  registerAction('track.interval', {
    async run(p) {
      const before = (await listTracks()).find((x) => x.id === str(p, 'id'))
      const t = await updateTrack(str(p, 'id'), { everyHours: Number(p.everyHours) || 24 })
      if (!t) throw new Error('That watch is gone.')
      return { id: t.id, undo: before ? { kind: 'track.interval', params: { id: t.id, everyHours: before.everyHours } } : null }
    },
  })
  registerAction('track.remove', {
    async run(p) {
      const before = (await listTracks()).find((x) => x.id === str(p, 'id'))
      if (!(await removeTrack(str(p, 'id')))) throw new Error('That watch is gone.')
      return { undo: before ? { kind: 'track.add', params: { ...before } } : null }
    },
  })
  registerAction('track.add', {
    async run(p) {
      const t = await addTrack(p as Record<string, never>, 'user')
      return { id: t?.id }
    },
  })
  registerAction('track.check', {
    async run(p) {
      const r = await runTrack(str(p, 'id'), await searchKeys())
      if (!r.ok) throw new Error('That watch has no question to ask.')
      return {}
    },
  })

  // ── goals ─────────────────────────────────────────────────────────────────
  /**
   * "MAKE THAT THE GOAL" — the one genuinely new verb the Phase 1 design needs.
   *
   * The Activity widget draws seven days and a figure, and the design's move is
   * to let him turn the figure he is already hitting into the line every future
   * day is read against. Until now that interaction ended in a sentence: the
   * surface's `set-goal` branch said "tell me in chat and I will measure against
   * it", which is the app asking him to describe something it is standing right
   * next to. The endpoint existed (`/api/person/goal`) and nothing but prose
   * could reach it.
   *
   * WRITTEN AS HIS. `statedGoal` records `by: 'user'`, and that is not a detail:
   * a goal the assistant set for him is a goal it may quietly revise, and one he
   * set is not. Direction travels with it rather than defaulting to 'up' — a
   * step target can be a ceiling as easily as a floor.
   *
   * REVERSIBLE, like everything else in this file. The undo pauses the goal
   * rather than deleting it, which is the same reasoning `retire` gives: absence
   * is indistinguishable from "never said", and would be re-inferred.
   */
  registerAction('activity.goal', {
    async run(p) {
      const metric = str(p, 'metric')
      const target = Number(p.target)
      if (!metric || !Number.isFinite(target)) throw new Error('I need a metric and a number to aim at.')
      const unit = str(p, 'unit')
      // ONE expression for this phrase, in `activity.ts`. See `goalPhrase`.
      const description = str(p, 'description') || goalPhrase(target, metric, unit)
      const r = await setGoal({
        description,
        metric,
        target,
        unit: unit || undefined,
        direction: str(p, 'direction') || 'up',
        source: str(p, 'source') || undefined,
      })
      if (!r.ok || !r.id) throw new Error('That goal did not save.')
      return { id: r.id, undo: { kind: 'activity.goal.clear', params: { id: r.id } } }
    },
  })
  registerAction('activity.goal.clear', {
    async run(p) {
      const r = await pauseGoal(str(p, 'id'))
      if (!r.ok) throw new Error('I could not find that goal.')
      return {}
    },
  })

  // ── client-side intents ───────────────────────────────────────────────────
  // Registered so that reaching the server is a no-op rather than an error, and
  // so they appear in the log like everything else — "he opened this" is worth
  // knowing and costs nothing to keep.
  for (const kind of ['mail.open', 'calendar.open', 'media.open', 'map.route', 'map.search']) {
    registerAction(kind, { async run() { return {} } })
  }
}

/**
 * What the assistant may be told it can do.
 *
 * Exported so the grammar the model is given and the table that executes it
 * cannot disagree — a model offered a verb the host cannot perform produces
 * exactly the failure this file was written for.
 */
export const CAPABILITIES = [
  'mail.archive', 'mail.unarchive', 'mail.read', 'mail.unread', 'mail.send',
  'calendar.create', 'calendar.update', 'calendar.rsvp',
  'world.tell',
  'track.toggle', 'track.interval', 'track.remove', 'track.add', 'track.check',
  'mail.open', 'calendar.open', 'media.open', 'map.route', 'map.search',
] as const
