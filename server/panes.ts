import type { Need } from './think.js'
import type { Observation, World } from './world.js'
import type { Widget, WidgetAction, WidgetItem, WidgetPane } from './widgets.js'

/**
 * The panes that do not need a model.
 *
 * The home feed was built entirely out of synthesis, which meant that the whole
 * screen — every pane, the whole reason to open the app — was downstream of one
 * LLM call. Sign in with Google, connect four sources, and still get a blank
 * page, because the free tier was spent or the selected model could not chat.
 * That is the wrong dependency: what is on his calendar this week is a FACT the
 * app already holds. It should be on screen whether or not anything is thinking.
 *
 * So: connected sources render themselves, deterministically, from the
 * observations already in the world model. Synthesis then adds what only a
 * model can add — the hero and ember cards that connect facts across sources —
 * and sits ABOVE these rather than replacing them.
 *
 * These are quiet-tier rows by design. They are the standing state of his life,
 * not something demanding attention; the design reserves hero and ember for
 * things that actually need him, and a calendar pane that shouts every day
 * would burn out the one signal that means "look at this".
 */

/** How each known source presents itself. Order is the order on screen. */
const SOURCES: {
  key: string
  title: string
  accent: string
  glyph: 'dots' | 'lines' | 'bars'
  /** The one line under the title, from the source's own observations. */
  line: (obs: Observation[]) => string
  /** Up to two numbers worth showing beside it. */
  stats?: (obs: Observation[]) => { l: string; v: string }[]
}[] = [
  {
    key: 'calendar',
    title: 'Calendar',
    accent: 'teal',
    glyph: 'lines',
    // Sorted by the date the event happens, not the order the API returned:
    // "next" has to mean next, or the pane is worse than no pane.
    line: (o) => {
      const next = [...o].sort((a, b) => a.at.localeCompare(b.at))[0]
      return next ? next.text : 'Nothing on the next seven days.'
    },
    stats: (o) => [{ l: 'Next 7 days', v: String(o.length) }],
  },
  {
    key: 'email',
    title: 'Mail',
    accent: 'amber',
    glyph: 'dots',
    line: (o) => {
      const from = new Set(o.map((x) => senderOf(x.text)).filter(Boolean))
      const newest = [...o].sort((a, b) => b.at.localeCompare(a.at))[0]
      return newest
        ? `${o.length} in the last week from ${from.size} ${from.size === 1 ? 'sender' : 'senders'}. Newest: ${subjectOf(newest.text)}`
        : 'Nothing in the last week.'
    },
    stats: (o) => [{ l: 'This week', v: String(o.length) }],
  },
  {
    key: 'health',
    title: 'Activity',
    accent: 'lime',
    glyph: 'bars',
    line: (o) => o[0]?.text ?? 'No step data yet.',
    stats: (o) => {
      const avg = firstNumber(o[0]?.text ?? '', /average\s+([\d,]+)/i)
      return avg ? [{ l: 'Steps/day', v: avg }] : []
    },
  },
  {
    key: 'youtube',
    title: 'YouTube',
    accent: 'violet',
    glyph: 'bars',
    line: (o) => o[0]?.text ?? 'Nothing watched recently.',
  },
]

/**
 * Anything else that turns up gets a pane too.
 *
 * A source is not a fixed list of four. When a new connector lands, or a track
 * starts filing observations under a name of its own, the app must be able to
 * show it without a code change and without anything hardcoded about what it
 * means — a title from the source name, the newest line it has, and the count.
 * The known four above are only there because they can say something better
 * than the generic version, not because they are the only ones allowed.
 */
function genericPane(key: string, obs: Observation[]): Need | null {
  const newest = [...obs].sort((a, b) => b.at.localeCompare(a.at))[0]
  if (!newest) return null
  return row({
    key,
    title: titleCase(key),
    accent: 'teal',
    glyph: 'dots',
    line: newest.text,
    stats: [{ l: 'Known', v: String(obs.length) }],
    count: obs.length,
    panes: widgetFor(key, obs),
  })
}

// ── What each source opens into ──────────────────────────────────────────────

/**
 * The widget a source's own observations make.
 *
 * Built from `data`, the structured payload the connectors now keep, and from
 * nothing else — no model, no network. That is the point: this is the standing
 * state of his life, it is already known, and it must be on screen whether or
 * not anything is thinking. A source whose observations predate structured
 * payloads produces a plain list of their text, which is worse than a real mail
 * list and far better than the chat thread that used to be there.
 */
function widgetFor(source: string, obs: Observation[]): WidgetPane[] {
  const newestFirst = [...obs].sort((a, b) => b.at.localeCompare(a.at))

  if (source === 'email') {
    const items: WidgetItem[] = newestFirst.flatMap((o) => {
      const d = o.data
      if (d?.kind !== 'email') return []
      return [{
        id: d.messageId,
        title: d.subject,
        sub: d.fromName ?? d.from,
        body: d.body ?? d.snippet,
        meta: shortWhen(o.at),
        at: o.at,
        unread: d.unread,
        tags: d.fromName ? [d.fromName] : undefined,
        // Read and reply are safe to offer up front; archiving is a change to
        // his mailbox, so it is confirmed at the moment it is tapped.
        actions: [
          { kind: 'mail.reply', label: 'Reply', params: { messageId: d.messageId, threadId: d.threadId ?? null, to: d.from, subject: d.subject }, primary: true },
          { kind: 'mail.archive', label: 'Archive', params: { messageId: d.messageId }, busy: 'Archiving…' },
          ...(d.unread ? [{ kind: 'mail.read', label: 'Mark read', params: { messageId: d.messageId } }] : []),
        ] as WidgetAction[],
      }]
    })
    if (!items.length) return fallbackList(newestFirst, 'Nothing in the last week.')
    return [{
      widget: {
        kind: 'list',
        items,
        expandable: true,
        // The senders present, so the filter chips are the people who actually
        // wrote to him rather than a fixed set of categories.
        filters: [...new Set(items.flatMap((i) => i.tags ?? []))].slice(0, 6),
        empty: 'Nothing in the last week.',
      },
    }]
  }

  if (source === 'calendar') {
    const items: WidgetItem[] = obs.flatMap((o) => {
      const d = o.data
      if (d?.kind !== 'event') return []
      const going = d.response === 'accepted'
      return [{
        id: d.eventId,
        title: d.summary,
        sub: [d.location, d.attendees?.length ? `${d.attendees.length} people` : null].filter(Boolean).join(' · ') || undefined,
        body: d.description,
        meta: d.allDay ? 'all day' : clockOf(d.start),
        at: d.start,
        tags: d.response ? [d.response] : undefined,
        actions: d.response && d.response !== 'accepted'
          ? ([{ kind: 'calendar.rsvp', label: going ? 'Going' : 'Accept', params: { eventId: d.eventId, response: 'accepted' }, primary: true },
              { kind: 'calendar.rsvp', label: 'Decline', params: { eventId: d.eventId, response: 'declined' } }] as WidgetAction[])
          : undefined,
      }]
    })
    if (!items.length) return fallbackList(obs, 'Nothing on the next seven days.')
    return [{
      widget: { kind: 'agenda', items, days: 7, empty: 'Nothing on the next seven days.' },
      actions: [{ kind: 'calendar.create', label: 'New event' }],
    }]
  }

  if (source === 'health') {
    const d = newestFirst.find((o) => o.data?.kind === 'steps')?.data
    if (d?.kind !== 'steps' || !d.days.length) return fallbackList(newestFirst, 'No step data yet.')
    return [{
      widget: {
        kind: 'chart',
        points: d.days.map((x) => ({ label: dayLabel(x.date), value: x.steps })),
        unit: 'steps',
        // The average as a line across the bars, so a day reads as above or
        // below his own normal rather than against a number from a magazine.
        target: d.average,
        compareLabel: 'average',
        accent: 'lime',
      },
    }]
  }

  if (source === 'youtube') {
    const items: WidgetItem[] = newestFirst.flatMap((o) => {
      const d = o.data
      if (d?.kind !== 'video') return []
      return [{
        id: d.videoId,
        title: d.title,
        sub: d.channel,
        body: d.description,
        meta: shortWhen(o.at),
        at: o.at,
        image: d.thumbnail,
        actions: [{ kind: 'media.open', label: 'Watch', params: { videoId: d.videoId }, primary: true }],
      }]
    })
    if (!items.length) return fallbackList(newestFirst, 'Nothing watched recently.')
    return [{ widget: { kind: 'media', items, columns: 2, empty: 'Nothing watched recently.' } }]
  }

  return fallbackList(newestFirst, 'Nothing here yet.')
}

/**
 * The generic pane: whatever the observations say, as a list.
 *
 * Reached by any source without a hand-written widget and by old observations
 * with no structured payload. It is the reason a brand-new connector is useful
 * the day it lands — it gets a real, scrollable, expandable pane without a line
 * of code being written about it.
 */
function fallbackList(obs: Observation[], empty: string): WidgetPane[] {
  const items: WidgetItem[] = obs.slice(0, 40).map((o) => ({
    id: o.id,
    title: clip(o.text, 90),
    body: o.text.length > 90 ? o.text : undefined,
    meta: shortWhen(o.at),
    at: o.at,
  }))
  return [{ widget: { kind: 'list', items, expandable: true, empty } }]
}

const clockOf = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(11, 16)
}

const dayLabel = (date: string) => {
  const d = new Date(date)
  return Number.isNaN(d.getTime()) ? date : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]!
}

function shortWhen(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return at
  const days = Math.round((Date.now() - d.getTime()) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  return at.slice(5, 10)
}

/** Sources that are not connectors and must never become panes of their own. */
const NOT_A_SOURCE = new Set(['user', 'seed', 'research', 'note'])

export function sourcePanes(world: World): Need[] {
  const on = (s: string) => world.sources?.[s] !== false
  const by = new Map<string, Observation[]>()
  for (const o of world.observations ?? []) {
    if (!by.has(o.source)) by.set(o.source, [])
    by.get(o.source)!.push(o)
  }

  const out: Need[] = []
  for (const s of SOURCES) {
    const obs = by.get(s.key) ?? []
    // A source he switched off is not a source. A source that is on but has
    // nothing yet still gets its pane, saying so — "connected and quiet" and
    // "not connected" are different states and the screen has to tell them
    // apart, which a missing pane cannot do.
    if (!on(s.key) || !by.has(s.key)) continue
    out.push(row({
      key: s.key,
      title: s.title,
      accent: s.accent,
      glyph: s.glyph,
      line: s.line(obs),
      stats: s.stats?.(obs) ?? [],
      count: obs.length,
      panes: widgetFor(s.key, obs),
    }))
  }

  for (const [key, obs] of by) {
    if (SOURCES.some((s) => s.key === key) || NOT_A_SOURCE.has(key)) continue
    if (!on(key)) continue
    const pane = genericPane(key, obs)
    if (pane) out.push(pane)
  }
  return out
}

/**
 * The one pane the app shows when it cannot think.
 *
 * Previously this was the readLine — 19px of raw error text where the day's
 * summary goes, with nothing to do about it. It is a card like everything else
 * now, and tapping it goes to the place where the problem is actually fixable.
 */
export function noticePane(message: string): Need {
  return {
    id: 'notice-brain',
    tier: 'quiet',
    heat: 'hot',
    heatLabel: 'needs you · now',
    title: 'I can’t think right now',
    sub: message,
    status: '',
    opening: message,
    stats: null,
    chips: [],
    gauges: null,
    meter: null,
    glyph: { kind: 'dots', values: [0.9, 0.35, 0.15] },
    accent: 'amber',
    action: { label: 'Open settings', done: 'Opening…' },
    proposes: null,
    basis: [],
    asks: false,
  }
}

/** Is this the card that opens settings rather than a thread? */
export const isNotice = (n: Need) => n.id === 'notice-brain'

function row(x: {
  key: string
  title: string
  accent: string
  glyph: 'dots' | 'lines' | 'bars'
  line: string
  stats: { l: string; v: string }[]
  count: number
  panes: WidgetPane[]
}): Need {
  return {
    id: `src-${x.key}`,
    tier: 'quiet',
    heat: 'quiet',
    heatLabel: 'quiet · standing',
    title: x.title,
    sub: clip(x.line, 150),
    status: '',
    opening: clip(x.line, 400),
    stats: x.stats.length ? x.stats : null,
    chips: [],
    gauges: null,
    meter: null,
    // The tile is a shape, not a chart: three bars scaled against the busiest
    // source on screen would need cross-pane state, so it reads its own count.
    glyph: { kind: x.glyph, values: spark(x.count) },
    accent: x.accent,
    action: null,
    proposes: null,
    basis: [`source:${x.key}`],
    asks: false,
    panes: x.panes,
  }
}

/** Three values that rise with how much is there, without pretending to be data. */
function spark(n: number): number[] {
  const f = Math.min(1, n / 12)
  return [0.35 + f * 0.5, 0.2 + f * 0.7, 0.5 + f * 0.4].map((v) => Math.round(v * 100) / 100)
}

const senderOf = (t: string) => t.match(/^Email from ([^—]+)—/)?.[1]?.trim() ?? ''
const subjectOf = (t: string) => t.match(/"([^"]+)"/)?.[1] ?? clip(t, 60)
const firstNumber = (t: string, re: RegExp) => t.match(re)?.[1] ?? ''
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
