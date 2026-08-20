import { registerSource, type SourceContext } from './execute.js'
import { objectId, type ObjectDraft } from './objects.js'
import { DAY, HOUR, MINUTE, retrieved } from './provenance.js'

/**
 * Gmail and Calendar as plan sources.
 *
 * This file exists to answer one question, and it is the question the whole
 * phase turns on: does a second connector — one that is nothing like the first
 * — fit the pane, revision and plan layer without introducing a single concept
 * of its own into it?
 *
 * It does, and the evidence is what is NOT here. There is no pane code, no
 * revision code, no widget code and no addressing code below; there is nothing
 * added to `ir.ts`, `revisions.ts`, `protocol.ts` or `addressing.ts` for mail
 * or events to work. A connector is `registerSource` plus a function that
 * returns drafts. Everything else — citation, provenance, staleness, revision,
 * branching, pinning, refresh policy, undo, being referred to as "the Chase
 * emails" — arrives for free because none of it was ever about videos.
 *
 * The one thing that IS connector-specific is what goes stale and how fast,
 * and that is exactly right: an email's subject is permanent, whether it is
 * unread is minutes old, and an event's RSVP can change while you are looking
 * at it. A single decay function baked into the abstraction would have had to
 * pick one of those and be wrong about the rest.
 */

const g = async (token: string, url: string): Promise<any> => {
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`)
  return r.json()
}

const token = (ctx: SourceContext): string => {
  const t = ctx.params.googleToken
  if (typeof t !== 'string' || !t) throw new Error('Google is not connected.')
  return t
}

const str = (ctx: SourceContext, k: string): string | undefined =>
  typeof ctx.params[k] === 'string' ? (ctx.params[k] as string) : undefined
const int = (ctx: SourceContext, k: string, d: number): number =>
  typeof ctx.params[k] === 'number' ? (ctx.params[k] as number) : d

/**
 * What a mail message is made of, by how long each part stays true.
 *
 * The subject and sender of a message that has been sent are facts about a
 * thing that already happened and cannot change. Whether it is still unread,
 * or still in the inbox, is true for as long as he leaves it alone — which is
 * often about a minute.
 */
const MAIL_FIELDS = {
  subject: 365 * DAY,
  title: 365 * DAY,
  from: 365 * DAY,
  sub: 365 * DAY,
  at: 365 * DAY,
  threadId: 365 * DAY,
  unread: 5 * MINUTE,
  labels: 5 * MINUTE,
}

/**
 * An event's identity and time are settled; his answer to it is not, and
 * neither is who else has answered. A pane showing "3 going" an hour old is
 * making a claim the source would no longer support.
 */
const EVENT_FIELDS = {
  title: 30 * DAY,
  summary: 30 * DAY,
  at: 30 * DAY,
  start: HOUR,
  end: HOUR,
  location: DAY,
  response: 10 * MINUTE,
  attendees: 10 * MINUTE,
}

export function installGoogleSources(): void {
  registerSource('gmail', {
    routes: ['inbox', 'search', 'thread'],
    describe: {
      what: 'his mail',
      kinds: ['email'],
      routes: {
        inbox: 'recent mail. params: q (a Gmail query, default recent non-promotional), limit',
        search: 'mail matching a Gmail query. params: q (required), limit',
        thread: 'the messages of one thread. params: threadId, limit',
      },
    },
    /**
     * "My inbox" needs no model, and mail is the clearest case for saying so:
     * it is the thing asked for most often and the thing with the least room
     * for interpretation. `unless` keeps it away from sentences that mention
     * mail while being about something else.
     */
    shortcuts: [{
      when: ['inbox', 'my mail', 'my email', 'unread'],
      unless: ['calendar', 'event', 'video', 'watch'],
      nodes: (words) => [
        { op: 'source', source: 'gmail', via: 'inbox', params: { limit: 15 } },
        ...(/\bunread\b/i.test(words) ? [{ op: 'filter' as const, where: { unread: true } }] : []),
        { op: 'sort', by: 'at', dir: 'desc' },
        { op: 'present', widget: 'list', title: 'Mail', empty: 'Nothing new.' },
      ],
      refresh: { mode: 'on-open' },
    }],
    async fetch(route, ctx) {
      const t = token(ctx)
      const limit = Math.min(40, int(ctx, 'limit', 15))
      const q =
        route === 'search'
          ? (str(ctx, 'q') ?? '')
          : (str(ctx, 'q') ?? 'newer_than:7d -category:promotions')
      if (route === 'search' && !q) throw new Error('A search needs something to search for.')

      const listUrl =
        route === 'thread'
          ? `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${limit}&q=${encodeURIComponent(`rfc822msgid:${str(ctx, 'threadId') ?? ''}`)}`
          : `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${limit}&q=${encodeURIComponent(q)}`

      const list = await g(t, listUrl)
      const out: ObjectDraft[] = []
      for (const m of (list.messages ?? []).slice(0, limit)) {
        const msg = await g(
          t,
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`
        )
        const h = Object.fromEntries((msg.payload?.headers ?? []).map((x: any) => [x.name, x.value]))
        const from = String(h.From ?? 'unknown')
        /**
         * Subject, sender and snippet come off ONE message record — the same
         * rule the video connector is built around, for the same reason. A
         * subject paired with the wrong sender is the mail-shaped version of a
         * title paired with the wrong thumbnail.
         */
        out.push({
          id: objectId('gmail', 'email', String(m.id)),
          source: 'gmail',
          kind: 'email',
          nativeId: String(m.id),
          title: String(h.Subject ?? '(no subject)'),
          sub: displayName(from),
          body: msg.snippet ? String(msg.snippet).slice(0, 400) : undefined,
          at: h.Date ? new Date(h.Date).toISOString() : undefined,
          fields: {
            from,
            to: h.To ? String(h.To) : null,
            threadId: msg.threadId ? String(msg.threadId) : null,
            unread: Array.isArray(msg.labelIds) && msg.labelIds.includes('UNREAD'),
            labels: Array.isArray(msg.labelIds) ? msg.labelIds.slice(0, 12).join(',') : null,
          },
          prov: retrieved('gmail', route, 10 * MINUTE, MAIL_FIELDS),
        })
      }
      return out
    },
  })

  registerSource('calendar', {
    routes: ['upcoming', 'range'],
    describe: {
      what: 'his calendar',
      kinds: ['event'],
      routes: {
        upcoming: 'events from now forward. params: days (default 7), limit',
        range: 'events between two instants. params: from, to (ISO strings), limit',
      },
    },
    /**
     * The window is a PARAMETER, not a pair of dates.
     *
     * "This week" compiles to `days: 7`, which is still true next Tuesday. A
     * literal timeMin/timeMax computed today would be a plan that quietly
     * describes a week in the past for as long as the pane lives, and nothing
     * about the pane would look wrong.
     */
    shortcuts: [{
      when: ['calendar', 'my week', 'my day', 'agenda', 'schedule', "what's on", 'whats on'],
      unless: ['mail', 'email', 'inbox', 'video', 'watch'],
      nodes: (words) => {
        const t = words.toLowerCase()
        const days = /\b(today|tonight|my day)\b/.test(t) ? 1 : /\bmonth\b/.test(t) ? 31 : 7
        return [
          { op: 'source', source: 'calendar', via: 'upcoming', params: { days, limit: 50 } },
          { op: 'sort', by: 'at', dir: 'asc' },
          { op: 'present', widget: 'agenda', title: days === 1 ? 'Today' : 'Ahead', empty: 'Nothing on.' },
        ]
      },
      refresh: { mode: 'on-open' },
    }],
    async fetch(route, ctx) {
      const t = token(ctx)
      const now = new Date()
      const from = str(ctx, 'from') ?? now.toISOString()
      const to =
        str(ctx, 'to') ??
        new Date(now.getTime() + int(ctx, 'days', 7) * 86_400_000).toISOString()
      const url =
        `https://www.googleapis.com/calendar/v3/calendars/primary/events` +
        `?timeMin=${encodeURIComponent(from)}&timeMax=${encodeURIComponent(to)}` +
        `&singleEvents=true&orderBy=startTime&maxResults=${Math.min(100, int(ctx, 'limit', 50))}`

      const b = await g(t, url)
      return (b.items ?? []).flatMap((e: any): ObjectDraft[] => {
        const start = e.start?.dateTime ?? e.start?.date
        if (!start || !e.id) return []
        const me = (e.attendees ?? []).find((a: any) => a.self)
        const going = (e.attendees ?? []).filter((a: any) => a.responseStatus === 'accepted').length
        return [{
          id: objectId('calendar', 'event', String(e.id)),
          source: 'calendar',
          kind: 'event',
          nativeId: String(e.id),
          title: String(e.summary ?? 'Untitled'),
          sub: e.location ? String(e.location) : undefined,
          body: e.description ? String(e.description).slice(0, 2000) : undefined,
          at: String(start),
          fields: {
            start: String(start),
            end: e.end?.dateTime ?? e.end?.date ?? null,
            allDay: !e.start?.dateTime,
            location: e.location ? String(e.location) : null,
            response: me?.responseStatus ? String(me.responseStatus) : null,
            attendees: (e.attendees ?? []).length,
            going,
            organizer: e.organizer?.email ? String(e.organizer.email) : null,
          },
          prov: retrieved('calendar', route, 10 * MINUTE, EVENT_FIELDS),
        }]
      })
    },
  })
}

/** "Justin <j@x.com>" → "Justin". Falls back to the address. */
function displayName(from: string): string {
  const m = /^\s*"?([^"<]+?)"?\s*</.exec(from)
  return (m?.[1] ?? from.replace(/[<>]/g, '')).trim()
}
