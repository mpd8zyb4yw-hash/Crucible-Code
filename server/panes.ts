import { domainContexts, type DomainContext, type DomainContextOptions, type DomainFacts } from './domain.js'
import type { MemoryStore } from './memory/types.js'
import { isVideoId } from './youtube.js'
import type { Heat, Need } from './think.js'
import { daysBetween, type Observation, type Track, type World } from './world.js'
import { activityReport, goalPhrase, type ActivityReport } from './activity.js'
import { dayIn, daysBetweenDays, relativeDay, timeLabel, weekdayName } from './clock.js'
import { getFact, readPerson } from './person.js'
import { positionOf } from './plan.js'
import { cleanSnippet, normaliseEvent, synopsis } from './widgets.js'
import { dedupeEvents, isOver, nextUp, upcoming } from './calendar.js'
import type {
  ActivityBrief, CalEvent, MailMessage, VideoObject, WatchObject,
  Widget, WidgetAction, WidgetItem, WidgetPane,
} from './widgets.js'

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

/**
 * ONE REAL-WORLD OBJECT → ONE CANONICAL TYPED OBJECT → MANY PROJECTIONS.
 *
 * Home and the full application used to be two independent readers of the same
 * `Observation[]`. The Home calendar line, finding no `data.kind === 'event'`,
 * fell back to the observation's PROSE (`oldest.text`); the Calendar widget, in
 * the same situation, correctly rendered an empty week. So Home announced lunch
 * with Odelia — read out of a sentence — while Calendar, asked about the same
 * day, truthfully said it had no events. Both were reading the same rows. Only
 * the readers disagreed.
 *
 * That prose fallback is also where "at 11 AM … (all day)" came from: a time
 * recovered from a display string rather than carried as data. Time is
 * structured or it is absent; it is never re-derived from a sentence.
 *
 * `canonical` is now the single typed reading. Every projection — Home line,
 * Home stats, the full surface, and anything downstream — is derived from it.
 * A projection cannot know about an object the canonical set does not contain.
 */
export type Canonical = {
  source: string
  events: CalEvent[]
  messages: MailMessage[]
  videos: VideoObject[]
  steps: { date: string; value: number }[]
  /**
   * What the activity numbers mean, for the health source only.
   *
   * Part of the canonical read rather than computed separately by the row and by
   * the widget, which is the same rule the rest of this type exists to enforce:
   * ONE reading, MANY projections. The Home line, the Home stat, the row's heat
   * and the surface header are four projections of this one object, so it is
   * structurally impossible for the row to claim an average the surface does not
   * have.
   */
  activity?: ActivityReport
  /**
   * The instant this read is AS OF, and the zone to render it in.
   *
   * Carried on the read rather than taken from `Date.now()` inside each renderer,
   * for the reason `nextEvent` spells out at length: a projection that reads the
   * ambient clock cannot be re-derived for a stated time, so a cached feed's
   * re-projection could neither be tested nor trusted to answer as of anything but
   * the moment it happened to run.
   */
  at: string
  tz?: string
  /** Kept only for sources with no typed reading at all (unknown connectors). */
  obs: Observation[]
}

/**
 * The object a source's Home line is about.
 *
 * Shared by `line` and `focus` so the sentence and the id are two readings of
 * ONE expression rather than two expressions that happen to agree today. This
 * is the same rule `canonical` exists for, applied one level down.
 */
/**
 * `now` and `tz` are PARAMETERS, not ambient state, and both had to become so.
 *
 * This read `Date.now()` internally and compared an all-day event against
 * `${start}T23:59:59` — a string with no zone, which the runtime parses in its
 * OWN zone. Two consequences, both observed against his real calendar:
 *
 *   The Mac (Europe/Rome) and the Worker (UTC) gave DIFFERENT answers for the
 *   same stored world. At 22:56Z on 8 August the Mac had already retired the
 *   8 August all-day event and named the 10th's concert as next; the edge still
 *   advertised the 8th, and went on doing so until 02:00 his time.
 *
 *   Nothing could re-derive this for a stated instant, so the re-projection of
 *   a cached feed could not be tested — or trusted — to answer as of anything
 *   but the moment it happened to run.
 *
 * An all-day event stays current through the end of ITS OWN DAY IN HIS ZONE,
 * which is what `daysAway >= 0` says without any string parsing at all.
 */
const nextEvent = (c: Canonical, now: Date, tz?: string) => nextUp(c.events, now, tz)

const newestMessage = (c: Canonical) =>
  [...c.messages].sort((a, b) => b.at.localeCompare(a.at))[0] ?? null

/**
 * HOW WARM A ROW IS, ANSWERED FROM ITS OWN CONTENTS.
 *
 * `heat` and `heatLabel` were literals in `row()` — every source, forever,
 * "quiet · standing". Not a default: there was no expression anywhere that
 * could produce any other value for a source row, so the field was structurally
 * incapable of meaning anything. A morning with an event in forty minutes and
 * eight unread threads rendered identically to an empty Tuesday, and the
 * ordering that Home's whole layout rests on had nothing to sort by.
 *
 * TIER STAYS QUIET, deliberately, and that part was never the bug: hero and
 * ember are reserved for synthesis, and a calendar that claims the top of the
 * screen every day would burn out the one signal meaning "look at this" (see
 * this file's opening comment). Heat is the finer instrument — it says how
 * live a standing row is WITHOUT letting it seize the layout.
 *
 * `hot` is rationed on purpose. It means the thing is happening now or within
 * the hour and he would want to be interrupted; anything that merely awaits him
 * is `warm`. A row that shouted at eight unread messages would be shouting most
 * days, which is the same failure one level down.
 */
type HeatRead = { heat: Heat; label: string }

const QUIET: HeatRead = { heat: 'quiet', label: 'quiet · standing' }

/**
 * Does the event's own TITLE already state a clock time?
 *
 * His calendar is mostly all-day entries with the hour written into the name —
 * "Restaurant with Odelia at 11 AM", "Comic concert in avano 9PM" — five of the
 * seven events on it. Against that, appending the structured qualifier produced
 * a line that contradicts itself inside eleven words:
 *
 *     Restaurant with Odelia at 11 AM — all day.
 *
 * THIS DOES NOT RECOVER THE TIME, and the distinction is the whole point. The
 * event genuinely has no clock time — Google holds it as a date — and parsing
 * "11 AM" out of the name to sort, alarm or route on would be exactly the
 * prose-derived time that `normaliseEvent` exists to forbid, arriving through
 * a side door. All this decides is whether the app should ADD a time-shaped
 * phrase to a sentence that already contains one. It answers no, and says the
 * day instead — which is the part it actually knows.
 */
const TITLE_STATES_TIME = /\b(\d{1,2})(:\d{2})?\s?(am|pm)\b|\b([01]?\d|2[0-3]):[0-5]\d\b/i
const titleStatesTime = (title: string) => TITLE_STATES_TIME.test(title)

/**
 * Whole calendar days from now, counted in HIS zone. Negative is in the past.
 *
 * An all-day event is anchored at midday rather than midnight so that reading
 * it in any zone still lands it on the date Google wrote down — a date-only
 * value parsed as UTC midnight is the previous evening for anyone west of the
 * line, which is how an event silently becomes "yesterday".
 */
function daysAway(iso: string, allDay: boolean | undefined, now: Date, tz?: string): number {
  const t = new Date(allDay ? `${iso}T12:00:00Z` : iso)
  return daysBetween(now, t, tz)
}

/** How each known source presents itself. Order is the order on screen. */
const SOURCES: {
  key: string
  title: string
  accent: string
  glyph: 'dots' | 'lines' | 'bars'
  /**
   * The one line under the title.
   *
   * Takes the CANONICAL objects the full surface renders — not the raw
   * observations — because Home and the application must never be able to
   * disagree about what exists. See `canonical` below for why that mattered.
   */
  line: (c: Canonical, now: Date, tz?: string) => string
  /**
   * The id of the object `line` is ABOUT, from the same canonical read.
   *
   * Derived here rather than in the client, and by the same expression that
   * chooses the line, so the card and the surface cannot point at two
   * different things. Returns null when the line names nothing in particular.
   */
  focus?: (c: Canonical, now: Date, tz?: string) => string | null
  /** Up to two numbers worth showing beside it. */
  stats?: (c: Canonical) => { l: string; v: string }[]
  /** How live this row is right now. Omitted means permanently quiet. */
  heat?: (c: Canonical, now: Date, tz?: string) => HeatRead
}[] = [
  {
    key: 'calendar',
    title: 'Calendar',
    accent: 'teal',
    glyph: 'lines',
    /**
     * The next event that has not happened yet.
     *
     * Sorting on the observation's own date and taking the first was picking
     * whatever was earliest in the window, which after a sync that includes
     * yesterday means the summary line advertises something already over.
     * "Next" has to mean next, and now that events carry a real start time it
     * can be answered properly rather than by the order the API returned.
     */
    /**
     * The next event that has not happened yet — chosen from the SAME
     * `CalEvent[]` the Calendar surface draws. If Home names an event, tapping
     * through must find it, because there is only one list.
     */
    /**
     * Both branches now go through `clock.ts` rather than through
     * `toLocaleString(undefined, …)`.
     *
     * The old version had two distinct faults in three lines. It used the RUNTIME's
     * locale, so the Mac and the edge could format the same stored event
     * differently. And the all-day branch built `new Date('…T12:00:00Z')` and then
     * asked for a weekday IN HIS ZONE — which is nearly always right and is wrong
     * for anyone far enough east or west, because it is a UTC instant read through
     * a zone offset rather than a calendar date read as a date.
     */
    line: (c, now, tz) => {
      const upcoming = nextEvent(c, now, tz)
      // No structured events means no events. There is deliberately no prose
      // fallback here: inventing one is what made Home and Calendar disagree.
      if (!upcoming) return 'Nothing else scheduled.'
      if (!upcoming.allDay) {
        const t = new Date(upcoming.start)
        const day = relativeDay(dayIn(t, tz), now, tz)
        return `${upcoming.title} — ${day} at ${timeLabel(t, tz)}`
      }
      // All-day. The day is a fact we hold; the hour, if there is one, is in
      // his title already and is not ours to restate or to contradict.
      const day = relativeDay(upcoming.start.slice(0, 10), now, tz)
      return titleStatesTime(upcoming.title)
        ? `${upcoming.title} — ${day}`
        : `${upcoming.title} — ${day}, all day`
    },
    focus: (c, now, tz) => nextEvent(c, now, tz)?.id ?? null,
    /*
      THE COUNT IS OF WHAT IS STILL AHEAD.

      This counted `c.events`, which is everything the world holds — including
      the seven finished events his August had already accumulated. The row
      offered "Next 7 days · 8" on a week with two things in it.
    */
    stats: (c) => [{ l: 'Ahead', v: String(upcoming(c.events, new Date(c.at), c.tz).length) }],
    /**
     * Measured off the SAME `nextEvent` the line names, so the row cannot say
     * one thing and be coloured by another.
     *
     * An all-day event has no clock, so it can never be "in 40 minutes" — the
     * most it can be is today. Deriving an hour for it in order to sort it is
     * the prose-time mistake in another costume.
     */
    heat: (c, now, tz) => {
      const e = nextEvent(c, now, tz)
      if (!e) return QUIET
      const days = daysAway(e.start, e.allDay, now, tz)
      if (e.allDay) {
        // Same rule as the line: do not attach "all day" to a title that
        // already names an hour. The label says when, not how long.
        const span = titleStatesTime(e.title) ? 'scheduled' : 'all day'
        if (days <= 0) return { heat: 'warm', label: `on today · ${span}` }
        if (days === 1) return { heat: 'warm', label: `tomorrow · ${span}` }
        return QUIET
      }
      const mins = Math.round((Date.parse(e.start) - now.getTime()) / 60_000)
      if (mins <= 60) return { heat: 'hot', label: mins <= 5 ? 'starting · now' : `starts in · ${mins} min` }
      if (days === 0) return { heat: 'warm', label: 'on today · later' }
      if (days === 1) return { heat: 'warm', label: 'tomorrow · scheduled' }
      return QUIET
    },
  },
  {
    key: 'email',
    title: 'Mail',
    accent: 'amber',
    glyph: 'dots',
    /**
     * Sender and subject come off the typed message, not out of its rendered
     * sentence. `senderOf`/`subjectOf` were regexes over prose — the same
     * re-derivation that produced an event both "at 11 AM" and "all day".
     */
    line: (c, _now, _tz) => {
      const from = new Set(c.messages.map((m) => m.fromName || m.from).filter(Boolean))
      const newest = newestMessage(c)
      if (!newest) return 'Nothing in the last week.'
      const n = c.messages.length
      return `${n} in the last week from ${from.size} ${from.size === 1 ? 'sender' : 'senders'}. Newest: ${newest.subject}`
    },
    focus: (c) => newestMessage(c)?.id ?? null,
    stats: (c) => [{ l: 'This week', v: String(c.messages.length) }],
    /**
     * Unread is the only thing here that is genuinely waiting on him. Volume
     * is not heat: a hundred read messages are a busy week, not a demand, and a
     * row that warmed on arrival rate would be warm permanently.
     *
     * Never `hot`. Mail does not know what is urgent — that judgement needs the
     * contents and belongs to synthesis, which has a hero card to make it with.
     */
    heat: (c) => {
      const unread = c.messages.filter((m) => m.unread).length
      if (!unread) return QUIET
      return { heat: 'warm', label: `unread · ${unread}` }
    },
  },
  {
    key: 'health',
    title: 'Activity',
    accent: 'lime',
    glyph: 'bars',
    /**
     * THE ROW SAYS WHAT THE SURFACE SAYS, because it is the same sentence.
     *
     * It read `Steps 7-day average 4,385/day` — a number with nothing attached,
     * computed here from a merge of the step observations that had no idea which
     * source he trusts or what he is trying to achieve. `activityReport.says` is
     * the one honest sentence, and both this row and the surface header render it,
     * so they cannot disagree about a figure or about whether there is one.
     */
    line: (c) => c.activity?.says ?? (c.steps.length ? 'Working out where your activity stands.' : 'No step data yet.'),
    /**
     * The stat is the GOAL when there is one, and the average when there is not.
     *
     * "4,385 of 8,000" is a fact about his week; "4,385 steps/day" is trivia. And
     * when the sources disagree there is deliberately no stat at all rather than a
     * number picked from one of them — the row says so in its line instead.
     */
    stats: (c) => {
      const r = c.activity
      if (!r || r.source.by === 'disputed') return []
      if (r.goal) {
        return [{ l: r.goal.met ? 'Goal met' : 'Against goal', v: `${Math.round(r.goal.current).toLocaleString()}/${r.goal.target.toLocaleString()}` }]
      }
      if (r.trend.average === null) return []
      return [{ l: `${r.metric}/day`, v: r.trend.average.toLocaleString() }]
    },
    /**
     * Activity is warm when something needs deciding, never merely because he
     * walked less. A shortfall is not a demand on his attention; a disagreement
     * between sources and a feed that stopped delivering both are.
     */
    heat: (c) => {
      const r = c.activity
      if (!r) return QUIET
      if (r.source.by === 'disputed') return { heat: 'warm', label: 'sources disagree' }
      if (!r.source.canSupportGoal && r.source.by === 'chosen') return { heat: 'warm', label: 'cannot read source' }
      if (r.gap.staleDays >= 2) return { heat: 'warm', label: `no data · ${r.gap.staleDays}d` }
      return QUIET
    },
  },
  {
    key: 'youtube',
    title: 'YouTube',
    accent: 'violet',
    glyph: 'bars',
    line: (c, _now, _tz) => {
      const newest = c.videos[0]
      if (!newest) return 'Nothing watched recently.'
      return `${c.videos.length} recent. Newest: ${newest.title}`
    },
    focus: (c) => c.videos[0]?.id ?? null,
    stats: (c) => (c.videos.length ? [{ l: 'Recent', v: String(c.videos.length) }] : []),
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
    panes: widgetFor(canonical(key, obs)),
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
/**
 * THE CANONICAL OBJECT AN OBSERVATION ID STANDS FOR.
 *
 * The inverse of the connector id schemes, and it lives here because this is the
 * file where the forward direction happens: `gcal-<eventId>` becomes a `CalEvent`
 * with `id: eventId` twenty lines below, and `gmail-<messageId>` becomes a
 * `MailMessage` with `id: messageId`.
 *
 * It exists because a model-authored card attributes itself with `basis` — a list
 * of OBSERVATION ids — while every no-restatement check in `deck.ts` is written
 * against OBJECT ids. So a synthesis card that had correctly said which event it
 * was about looked, to the one guard that matters, exactly like a card that had
 * said nothing:
 *
 *     CALENDAR       Hiking with Mauro at 9am   ·  tomorrow
 *     RELEVANCE      Hiking with Mauro          ·  Scheduled for tomorrow
 *
 * Two rows about one event, the second of them below the first, with a clock
 * time the model had read out of the title. The guard was right and could not
 * see the evidence.
 */
export function objectIdsOf(basis: string[] | undefined): string[] {
  return (basis ?? []).flatMap((b) => {
    const m = /^(?:gcal|gmail|yt|health)-(.+)$/.exec(b)
    return m ? [m[1]!] : []
  })
}

/**
 * The widget for a source — chosen by WHICH APPLICATION THIS IS, not by what
 * the latest payload happened to contain.
 *
 * This used to end every branch with `if (!things.length) return fallbackList(…)`,
 * which reads like defensive coding and is in fact a renderer swap. The effect
 * was that Calendar stopped being Calendar and became a bulleted list of
 * sentences the moment its events could not be parsed — the surface changed
 * TYPE in response to a change of DATA. Every reported "the rich widget isn't
 * there" traced back to one of those lines, and they were invisible from the
 * screen: a list of calendar-ish text looks like a design choice, not a
 * degraded renderer.
 *
 * The rule for a standing application source is therefore: the kind is fixed by
 * `source`, and emptiness is passed INTO that kind as state. Missing data
 * changes what the calendar shows; it never changes that it is a calendar.
 *
 * Data-driven selection still applies below the known sources — an unrecognised
 * connector genuinely has no application identity to render, so shape is the
 * only thing left to go on. That is a different case, and it keeps a brand-new
 * connector useful on the day it lands.
 */
export function canonical(
  source: string,
  obs: Observation[],
  /**
   * The world this read belongs to, when the caller has one.
   *
   * OPTIONAL, and the reason is compatibility with the contract tests and with
   * every model-authored pane: `canonical` has always been a pure function of a
   * source name and a list of observations, and several callers have nothing else
   * to give it. Without a world there is no goal, no source preference and no
   * conflict state, so the activity report is simply absent and the surface
   * renders the chart alone — which is the honest degradation, not a broken one.
   */
  world?: Pick<World, 'observations' | 'timeZone' | 'person'>,
  now = new Date()
): Canonical {
  const newestFirst = [...obs].sort((a, b) => b.at.localeCompare(a.at))
  const c: Canonical = {
    source,
    events: [],
    messages: [],
    videos: [],
    steps: [],
    at: now.toISOString(),
    tz: world?.timeZone,
    obs,
  }

  if (source === 'calendar') {
    /*
      ONE REPRESENTATION PER REAL-WORLD COMMITMENT.

      Deduped HERE, at the canonical read, rather than in each projection — so
      it is not possible for Home to collapse two records that the Calendar
      surface draws twice. See `dedupeEvents` for why his calendar needs it.
    */
    c.events = dedupeEvents(obs.flatMap((o) => {
      const d = o.data
      if (d?.kind !== 'event') return []
      // Normalised HERE, once, where events enter the canonical model — so
      // every reader below (the Home line, the agenda, the day grid, the
      // prompt the model is given) is working from the same settled fact about
      // whether this event has a clock time. See `normaliseEvent`.
      return [normaliseEvent({
        id: d.eventId,
        title: d.summary,
        start: d.start,
        end: d.end,
        allDay: d.allDay,
        location: d.location,
        // Prose only — see `synopsis`. The promotional tail of a YouTube
        // description is not information about the video.
        description: synopsis(d.description) || undefined,
        attendees: d.attendees,
        response: d.response,
        organizer: d.organizer,
        calendarId: d.calendarId,
        accent: 'teal',
        actions: d.response && d.response !== 'accepted'
          ? ([{ kind: 'calendar.rsvp', label: 'Accept', params: { eventId: d.eventId, response: 'accepted' }, primary: true },
              { kind: 'calendar.rsvp', label: 'Decline', params: { eventId: d.eventId, response: 'declined' } }] as WidgetAction[])
          : undefined,
      })]
    }))
  }

  if (source === 'email') {
    c.messages = newestFirst.flatMap((o) => {
      const d = o.data
      if (d?.kind !== 'email') return []
      return [{
        id: d.messageId,
        threadId: d.threadId,
        subject: d.subject,
        from: d.from,
        fromName: d.fromName,
        to: d.to,
        /*
          CLEANED AT THE CANONICAL READ, not at ingestion alone.

          Ingestion cleans what arrives from now on; this cleans what is already
          in the world document, and it is the same function so the two cannot
          drift. Every projection — the widget row, the list, the reader and the
          prompt — is downstream of this one expression.
        */
        snippet: d.snippet ? cleanSnippet(d.snippet) || undefined : undefined,
        body: d.body ? cleanSnippet(d.body) : d.snippet ? cleanSnippet(d.snippet) || undefined : undefined,
        at: o.at,
        unread: d.unread,
        labels: d.labels,
        actions: [
          { kind: 'mail.archive', label: 'Archive', params: { messageId: d.messageId }, busy: 'Archiving…' },
          ...(d.unread ? [{ kind: 'mail.read', label: 'Mark read', params: { messageId: d.messageId } }] : []),
        ] as WidgetAction[],
      }]
    })
  }

  if (source === 'youtube') {
    c.videos = newestFirst.flatMap((o) => {
      const d = o.data
      if (d?.kind !== 'video') return []
      /**
       * A WATCH CONTROL IS ONLY OFFERED FOR A VIDEO WE CAN ACTUALLY IDENTIFY.
       *
       * Observations reach this point from several places, and only some of
       * them came from a YouTube API response: `POST /api/world/observations`
       * accepts arbitrary payloads, and the seeded fixture world in use during
       * development carries ids like `v1`. Those rendered a real-looking card
       * with a Watch button pointing at `youtube.com/watch?v=v1`, which is a
       * blank page. The card asserted a video exists; nothing had checked.
       *
       * So the URL is built from a VERIFIED id or not at all, and a video
       * without one keeps its card — the title and channel are still what the
       * record says — but offers no way to open something we cannot name.
       */
      const url = isVideoId(d.videoId) ? `https://www.youtube.com/watch?v=${d.videoId}` : undefined
      return [{
        id: d.videoId,
        title: d.title,
        channel: d.channel,
        thumbnail: d.thumbnail,
        publishedAt: d.publishedAt ?? o.at,
        seconds: d.durationSec,
        // Prose only — see `synopsis`. The promotional tail of a YouTube
        // description is not information about the video.
        description: synopsis(d.description) || undefined,
        url,
        actions: url
          ? [{ kind: 'media.open', label: 'Watch', params: { videoId: d.videoId }, primary: true }]
          : [],
      }]
    })
  }

  if (source === 'health') {
    /**
     * MERGE EVERY STEP RECORD, NEWEST READING OF EACH DAY WINNING.
     *
     * This used to be `newestFirst.find(...)` — one observation, chosen, and
     * every other one discarded. Each sync writes a whole window of days under
     * an id stamped with the sync's date, so a week's syncing leaves several
     * records whose day ranges OVERLAP and, because the buckets were misaligned
     * (see google.ts), DISAGREE about the same dates. Taking one of them meant
     * the chart was whichever record happened to sort first, the others were
     * invisible, and days present only in an older record were simply gone.
     *
     * Worse, `at` used to be a date-only string, so two records written on the
     * same day tied — and a stable sort over an append-ordered list resolves a
     * tie to the OLDEST. The "newest" record was sometimes the stale one.
     *
     * Merging per day is the honest read: a later sync is a better reading of a
     * given day than an earlier one, and a day nobody has re-read since keeps
     * the reading it has. `newestFirst` is already sorted, so first-write-wins
     * over that order is newest-wins per day.
     */
    const byDay = new Map<string, number>()
    for (const o of newestFirst) {
      if (o.data?.kind !== 'steps') continue
      for (const d of o.data.days) {
        if (!byDay.has(d.date)) byDay.set(d.date, d.steps)
      }
    }
    c.steps = [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, value]) => ({ date, value }))

    if (world) {
      const person = readPerson(world)
      c.activity = activityReport({ ...world, person }, person, { now })
    }
  }

  return c
}

/** The report, flattened for the wire. See `ActivityBrief` for why it is flat. */
function briefOf(r: ActivityReport): ActivityBrief {
  return {
    metric: r.metric,
    unit: r.unit,
    says: r.says,
    current: r.current ? { day: r.current.day, value: r.current.value, isToday: r.current.isToday } : null,
    freshness: r.freshness,
    source: r.source,
    trend: {
      average: r.trend.average,
      priorAverage: r.trend.priorAverage,
      changePercent: r.trend.changePercent,
      direction: r.trend.direction,
      covered: r.trend.covered,
      windowDays: r.trend.windowDays,
    },
    goal: r.goal
      ? {
          id: r.goal.goalId,
          description: r.goal.description,
          target: r.goal.target,
          unit: r.goal.unit,
          direction: r.goal.direction,
          current: r.goal.current,
          fraction: r.goal.fraction,
          met: r.goal.met,
          shortfall: r.goal.shortfall,
          timeframe: r.goal.timeframe,
        }
      : null,
    gap: r.gap,
    conflicts: r.conflicts.map((c) => ({
      metric: c.metric,
      scope: c.scope,
      readings: c.readings.map((x) => ({ source: x.source, value: x.value })),
      differencePercent: c.differencePercent,
    })),
    next: {
      label: r.next.label,
      detail: r.next.detail,
      does: r.next.does.kind,
      options: r.next.does.kind === 'choose-source' ? r.next.does.options : undefined,
    },
  }
}

function widgetFor(c: Canonical): WidgetPane[] {
  const { source, obs } = c
  const newestFirst = [...obs].sort((a, b) => b.at.localeCompare(a.at))

  if (source === 'email') {
    // No `fallbackList` here, deliberately — see widgetFor's contract. Mail with
    // no mail is still Mail. The messages are the canonical ones; this function
    // now only decides PRESENTATION, never what exists.
    return [{ widget: { kind: 'mail', messages: c.messages, empty: 'Nothing in the last week.' } }]
  }

  if (source === 'calendar') {
    return [{
      /*
        IT OPENS ON THE DAY.

        The Phase 1 design specifies Day as the landing view and this said
        `week`, so every tap on the Calendar widget arrived on a seven-column
        grid — with today's evening below the fold, because the week grid starts
        at 07:00 and the events that made the widget worth tapping were at 20:30.
        Week and Month are both still here; they are a switch away, which is
        where a view you have to choose belongs.
      */
      widget: { kind: 'calendar', events: c.events, view: 'day', empty: 'Nothing on the next seven days.' },
      actions: [{ kind: 'calendar.create', label: 'New event' }],
    }]
  }

  if (source === 'health') {
    const report = c.activity ? briefOf(c.activity) : undefined

    /**
     * THE CHART AND THE HEADLINE READ THE SAME SERIES. NOW STRUCTURALLY.
     *
     * They did not, and the way they diverged is the one §34 is about. The
     * headline came from `activityReport`, which reads ONE source — the one he
     * chose, or the only one there is, or none at all while two of them
     * disagree. The chart came from `c.steps`, which merged every source that
     * had ever reported a step. So on a day where his phone said 10,000 and
     * Google Fit said 2,310, the number said one thing and the bar under it drew
     * the other, and nothing on screen could explain the gap.
     *
     * `report.trend.days` is the window the report itself measured, one entry
     * per day including the empty ones, from the source it names. Reading the
     * chart off it means a disagreement produces NO bars and a stated reason,
     * exactly as it produces no headline figure — which is the honest picture of
     * a metric nobody can currently vouch for.
     */
    const trusted = c.activity?.trend.days ?? []
    if (!trusted.length) {
      return [{ widget: { kind: 'fitness', series: [], report, empty: 'No step data yet.' } }]
    }
    return [{
      widget: {
        kind: 'fitness',
        series: [{
          key: 'steps',
          label: 'Steps',
          unit: 'steps',
          // 'lime' is not one of the design's accent names, so it silently fell
          // through to the heat's own dot and drew activity in violet.
          accent: 'sage',
          days: trusted,
          source: {
            id: c.activity?.source.id ?? 'none',
            lastReportedDay: c.activity?.gap.lastDay ?? null,
          },
        }],
        report,
        empty: 'No step data yet.',
      },
      /**
       * "MAKE THAT THE GOAL" — offered only when it would MEAN something.
       *
       * Four conditions, and each one removes a version of this button that
       * would have been a lie. There must be no goal already, or the offer is to
       * overwrite something he stated. There must be a trustworthy average to
       * propose, so the target is a number he is actually near rather than one
       * invented to fill the chip. The source must be able to supply a series at
       * all, or nothing could ever report progress against it — `canSupportGoal`
       * is the report's own answer to exactly that question. And there must be
       * enough covered days for the average to be an average.
       *
       * The target is the rounded trend, not a stretch: the design's move is
       * turning what he already does into the line the future is read against,
       * and inflating it here would be the app deciding what he should want.
       */
      actions:
        report && !report.goal && report.source.canSupportGoal
          && report.trend.average !== null && report.trend.covered >= 3
          ? [{
              kind: 'activity.goal',
              label: `Make ${Math.round(report.trend.average)} the goal`,
              primary: true,
              // Configuration. Offered on the Activity surface, never on the
              // Home card — see `WidgetAction.setting`.
              setting: true,
              params: {
                metric: report.metric,
                target: Math.round(report.trend.average),
                unit: report.unit ?? '',
                direction: 'up',
                source: report.source.id,
                description: goalPhrase(Math.round(report.trend.average), report.metric, report.unit),
              },
            }]
          : undefined,
    }]
  }

  if (source === 'youtube') {
    return [{ widget: { kind: 'video', videos: c.videos, empty: 'Nothing watched recently.' } }]
  }


  /**
   * Anything with coordinates gets a map, whatever source it came from.
   *
   * Checked last and by SHAPE rather than by source name, so a connector nobody
   * has written a branch for — a bank that geocodes card purchases, a track
   * that files a trailhead — gets a real map the day it lands. The source list
   * above is an optimisation for the four we can describe better by hand, not
   * the set of things allowed to have a widget.
   */
  const places = newestFirst.flatMap((o) => (o.data?.kind === 'place' ? [{ o, d: o.data }] : []))
  if (places.length) {
    return [{
      widget: {
        kind: 'map',
        places: places.slice(0, 20).map(({ o, d }) => ({
          id: o.id,
          label: d.label,
          lat: d.lat,
          lon: d.lon,
          sub: d.address,
        })),
        searchable: true,
        follow: true,
        route: 'walk',
      },
    }]
  }

  return fallbackList(newestFirst, 'Nothing here yet.', new Date(c.at), c.tz)
}

/**
 * The generic pane: whatever the observations say, as a list.
 *
 * Reached by any source without a hand-written widget and by old observations
 * with no structured payload. It is the reason a brand-new connector is useful
 * the day it lands — it gets a real, scrollable, expandable pane without a line
 * of code being written about it.
 */
function fallbackList(obs: Observation[], empty: string, now: Date, tz?: string): WidgetPane[] {
  const items: WidgetItem[] = obs.slice(0, 40).map((o) => ({
    id: o.id,
    title: clip(o.text, 90),
    body: o.text.length > 90 ? o.text : undefined,
    meta: shortWhen(o.at, now, tz),
    at: o.at,
  }))
  return [{ widget: { kind: 'list', items, expandable: true, empty } }]
}

/**
 * `clockOf` and `dayLabel` USED TO LIVE HERE and are deleted.
 *
 * `clockOf` sliced the hour out of an ISO string, which is the UTC hour — "leave
 * at 14:30" for a 16:30 departure, for exactly the person trying to catch a bus.
 * `dayLabel` read `getUTCDay()` off a date string and printed the result beside
 * local times, so a Sunday in Rome was labelled Saturday. Both are `clock.ts`'s
 * job now (`timeLabel`, `weekdayName`), where the zone is a parameter and the
 * answers are asserted against fixed dates in `scripts/dates.mjs`.
 */

/**
 * "today", "yesterday", "3d ago" — counted on HIS calendar.
 *
 * The old version divided a millisecond difference by 86,400,000, which is only
 * "days" if nobody ever changes their clocks: across a DST boundary a 23-hour
 * yesterday rounds to 1 and a 25-hour yesterday rounds to 1 as well, but an event
 * 11 hours ago across the boundary rounded to 0 or 1 depending on direction. It
 * also read `Date.now()` rather than the instant being rendered against, so a
 * cached feed could not be re-projected onto a stated time — the exact property
 * `readSnapshot` needs in order to be testable.
 */
function shortWhen(at: string, now: Date, tz?: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return at
  const days = -daysBetweenDays(dayIn(now, tz), dayIn(d, tz))
  if (!Number.isFinite(days)) return at
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  return weekdayName(dayIn(d, tz), 'short') || at.slice(5, 10)
}

// ── Keep an eye ──────────────────────────────────────────────────────────────

/**
 * The standing interests, as an operational dashboard.
 *
 * A track was previously invisible unless it happened to produce an
 * observation, which meant the one thing he most needs to know about a watch —
 * that it is armed and when it last actually ran — could only be inferred from
 * its output. "Watching, checked 40 minutes ago, unchanged" and "watching,
 * never once succeeded" looked identical, and the second is a bug he could not
 * see.
 *
 * History is reconstructed from the research observations each track filed.
 * That is a real reconstruction rather than a stored log: `researchGap` writes
 * `Looked up "<question>" — …`, so the question is the join key. Where a track
 * has never produced one, the dashboard says the check has not returned
 * anything rather than inventing a state for it.
 */
function watchPane(tracks: Track[], obs: Observation[]): WidgetPane[] {
  const answers = obs.filter((o) => o.source === 'research')

  const watches: WatchObject[] = tracks.map((t) => {
    const q = (t.question ?? '').toLowerCase()
    const mine = q
      ? answers
          .filter((o) => o.text.toLowerCase().includes(`looked up "${q}"`))
          .sort((a, b) => b.at.localeCompare(a.at))
      : []
    const history = mine.slice(0, 12).map((o, i) => {
      const text = answerOf(o.text)
      // "Changed" means different from the check BEFORE it, which is the only
      // thing that makes a watch worth having. Comparing against the newest
      // answer instead would mark every historical row as changed.
      const prev = mine[i + 1]
      return { at: o.at, text, changed: prev ? answerOf(prev.text) !== text : false }
    })
    const changedAt = history.find((h) => h.changed)?.at ?? history[history.length - 1]?.at ?? null

    return {
      id: t.id,
      what: t.what,
      why: t.why,
      question: t.question,
      everyHours: t.everyHours,
      lastRunAt: t.lastRunAt,
      nextRunAt: t.lastRunAt && t.active
        ? new Date(new Date(t.lastRunAt).getTime() + t.everyHours * 3_600_000).toISOString()
        : null,
      active: t.active,
      by: t.by,
      state: history[0]?.text,
      changedAt,
      history,
      actions: [
        { kind: 'track.check', label: 'Check now', params: { id: t.id }, busy: 'Checking…', primary: true },
        { kind: 'track.toggle', label: t.active ? 'Pause' : 'Resume', params: { id: t.id, active: !t.active } },
        { kind: 'track.remove', label: 'Stop watching', params: { id: t.id }, irreversible: true },
      ] as WidgetAction[],
    }
  })

  return [{ widget: { kind: 'watch', watches, empty: 'Nothing being watched yet.' } }]
}

/** The answer out of `Looked up "…" — answer [sources: …]`. */
function answerOf(text: string): string {
  const after = text.replace(/^Looked up "[^"]*"\s*—\s*/i, '')
  return after.replace(/\s*\[(sources|ungrounded)[^\]]*\]\s*$/i, '').trim()
}

/** Sources that are not connectors and must never become panes of their own. */
const NOT_A_SOURCE = new Set(['user', 'seed', 'research', 'note'])

export function sourcePanes(world: World, now = new Date()): Need[] {
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
    //
    // That was the stated intent and the `!by.has(s.key)` clause quietly
    // contradicted it: a source with zero observations produced no card at all,
    // so the first thing an empty Calendar did was cease to exist. An app he
    // has switched on is an app he expects to see, whether or not it has
    // anything to report yet.
    if (!on(s.key)) continue
    /**
     * ONE canonical read, from which BOTH the Home line and the full surface
     * are projected. This single binding is what makes it structurally
     * impossible for Home to know about an event the Calendar does not have.
     */
    const c = canonical(s.key, obs, world, now)
    out.push(row({
      key: s.key,
      title: s.title,
      accent: s.accent,
      glyph: s.glyph,
      line: s.line(c, now, world.timeZone),
      focus: s.focus?.(c, now, world.timeZone) ?? null,
      stats: s.stats?.(c) ?? [],
      count: obs.length,
      panes: widgetFor(c),
      heat: s.heat?.(c, now, world.timeZone),
    }))
  }

  for (const [key, obs] of by) {
    if (SOURCES.some((s) => s.key === key) || NOT_A_SOURCE.has(key)) continue
    if (!on(key)) continue
    const pane = genericPane(key, obs)
    if (pane) out.push(pane)
  }

  /**
   * Keep an eye is not a connector, so it is built here rather than from the
   * observation map. It exists the moment he has a single standing interest,
   * whether or not any of them have ever returned anything — a watch that has
   * never fired is precisely the one he needs to see.
   */
  const tracks = world.tracks ?? []
  // Zero watches is a state of the dashboard, not the absence of one — the
  // empty dashboard is where starting a watch is explained and offered.
  if (on('keepaneye')) {
    const active = tracks.filter((t) => t.active).length
    const stale = tracks.filter((t) => t.active && t.question && !t.lastRunAt).length
    out.push(row({
      key: 'keepaneye',
      title: 'Keep an eye',
      accent: 'amber',
      glyph: 'dots',
      line: !tracks.length
        ? 'Nothing being watched yet.'
        : stale
          ? `${active} watching · ${stale} not checked yet`
          : `${active} watching · ${tracks.length - active} paused`,
      stats: [{ l: 'Watching', v: String(active) }],
      count: tracks.length,
      panes: watchPane(tracks, world.observations ?? []),
      // A watch he started that has never once run is the failure this card
      // exists to make visible; it must not look like the ones that are working.
      heat: stale ? { heat: 'warm', label: `not checked · ${stale}` } : QUIET,
    }))
  }

  /**
   * Places, as a standing map.
   *
   * Like Keep an eye, this is not a connector: places arrive by SHAPE from
   * whichever source geocoded something. Until now that meant the map existed
   * only as a side effect — a source whose observations happened to carry
   * coordinates got a map inside its own card, and there was no Maps
   * application anywhere. So there was no way to open a map and look something
   * up, which is most of what a map is for.
   *
   * It is its own card now, gathering places from every source, and it is
   * present with none: an empty map is still a map, and it is searchable.
   */
  if (on('map')) {
    const person = readPerson(world)
    const geocoded = (world.observations ?? []).flatMap((o) =>
      o.data?.kind === 'place' ? [{ id: o.id, label: o.data.label, lat: o.data.lat, lon: o.data.lon, sub: o.data.address, self: false }] : []
    )

    /**
     * WHERE HE IS, OUT OF WHAT HE HAS ALREADY TOLD US.
     *
     * The Places widget said "Nowhere with coordinates yet" on an account that
     * knows exactly where he lives. Nothing was broken; nothing was CONNECTED.
     * The map was built only from observations carrying `kind:'place'`, and no
     * connector in the app has ever written one — so the one domain whose whole
     * subject is geography was structurally guaranteed to be empty, on a device
     * holding a geocoded village and five located calendar events.
     *
     * `positionOf` is the precedence the travel planner has always used — a
     * live fix, else the geocoded home — reused rather than restated, so the
     * map and the departure times can never disagree about where he is.
     *
     * AND THE LIVE FIX IS WHAT SAVES IT ON HIS REAL ACCOUNT. Production holds a
     * verified `location.last` from a connector, and an `identity.home` reading
     * `Current location data is "home"` — a sentence fragment that was lifted
     * into a user fact and can never geocode, which is exactly why the coords
     * were absent and the map was blank. Reading position from the coordinate
     * that exists rather than from the prose that does not is the difference
     * between a working map and a widget apologising.
     *
     * The label travels with the point and is the honest part: "where you are"
     * for a fresh fix, "where you last were" for an old one, the village name
     * when it is only ever his stated home. What it must never become is a pin
     * labelled "you" over a position nobody verified.
     */
    const at = positionOf(person, now)
    const self = at
      ? [{ id: 'here', label: at.label, lat: at.lat, lon: at.lon, sub: undefined, self: true }]
      : []

    /*
      The places his own calendar is sending him arrive as ordinary `place`
      observations, folded in by the feed build from the travel plans it has
      already resolved (see feed.ts). Nothing is geocoded here: this function is
      synchronous and on the instant-paint path, and a pin dropped at a guessed
      coordinate is exactly the invented map this widget was rewritten to stop
      drawing.
    */
    const places = [...self, ...geocoded]
      // One pin per coordinate. The same restaurant reached from an event and
      // from a search is one place, and two pins on it is a map saying there
      // are two of them.
      .filter((p, i, all) => all.findIndex((q) => q.lat.toFixed(5) === p.lat.toFixed(5) && q.lon.toFixed(5) === p.lon.toFixed(5)) === i)
      .slice(0, 20)

    const marks = places.filter((p) => !p.self)
    out.push(row({
      key: 'map',
      title: 'Places',
      accent: 'teal',
      glyph: 'dots',
      line: marks.length
        ? `${marks.length} place${marks.length > 1 ? 's' : ''} · ${marks[0]!.label}`
        : self.length
          ? `${self[0]!.label} · search for somewhere`
          : 'Search for somewhere.',
      stats: marks.length ? [{ l: 'Places', v: String(marks.length) }] : [],
      count: marks.length,
      panes: [{
        widget: { kind: 'map', places, searchable: true, follow: true, route: 'walk' },
      }],
    }))
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
  /** The one object the line names, if it names one. */
  focus?: string | null
  stats: { l: string; v: string }[]
  count: number
  panes: WidgetPane[]
  /** How live this row is. Omitted means the row has no way to be anything else. */
  heat?: HeatRead
}): Need {
  const { heat, label } = x.heat ?? QUIET
  return {
    id: `src-${x.key}`,
    // Quiet by design and not by omission — see `HeatRead`. A source row never
    // takes hero or ember; those belong to synthesis.
    tier: 'quiet',
    heat,
    heatLabel: label,
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
    focus: x.focus ?? null,
    panes: x.panes,
  }
}

/** Three values that rise with how much is there, without pretending to be data. */
function spark(n: number): number[] {
  const f = Math.min(1, n / 12)
  return [0.35 + f * 0.5, 0.2 + f * 0.7, 0.5 + f * 0.4].map((v) => Math.round(v * 100) / 100)
}

/**
 * `senderOf`, `subjectOf` and `firstNumber` used to live here: regexes that
 * recovered a sender, a subject and a step count from rendered prose. They are
 * deleted rather than left unused. Every one of them was a second, weaker
 * reading of data the typed object already carried exactly, and that second
 * reading is what let Home and the applications disagree.
 */
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// ── Phase 8: what the memory core adds to a source pane ──────────────────────

/**
 * ATTACH THE DOMAIN CONTEXT TO THE PANES `sourcePanes` JUST BUILT.
 *
 * A SEPARATE PASS, and separate for two reasons that are both structural rather
 * than tidiness.
 *
 *   · `sourcePanes` is the instant-paint projection: a pure function of the
 *     stored world and the clock, with no store read in it. Reaching into the
 *     memory core from inside it would put a database on the path the first
 *     frame runs. Here the store read is explicit, isolated and skippable.
 *
 *   · The compilers need the DOMAIN'S OWN FACTS — how many events are on today,
 *     what the trusted step figure was, where the pins ended up — and those are
 *     decided by the projection. Reading them off the built widget is what makes
 *     the enrichment a comment on what is actually drawn, rather than a second
 *     computation that can disagree with it.
 *
 * MUTATES NOTHING. New needs, new panes, new widgets: the caller's array is left
 * exactly as it was, so a caller that wants the unenriched projection still has
 * it. That matters for the cold path, which paints before this can run.
 *
 * FAILS QUIETLY AND WHOLLY. §27: a store that throws costs the enrichment and
 * never the domain. The per-domain isolation is inside `domainContexts`; this
 * outer catch is for the store itself being unreadable.
 */
export function enrichPanes(
  needs: Need[],
  store: MemoryStore,
  opts: DomainContextOptions & { now: Date },
): Need[] {
  try {
    return needs.map((n) => {
      const panes = (n.panes ?? []).map((p) => {
        const facts = factsOf(p.widget, opts.now, opts.timeZone)
        if (!facts) return p
        const context = domainContexts(store, facts, opts)
        if (!context.length) return p
        return { ...p, widget: place(p.widget, context) }
      })
      return panes.length ? { ...n, panes } : n
    })
  } catch {
    return needs
  }
}

/**
 * PUT EACH LINE WHERE ITS WEIGHT SAYS IT GOES — AND ONLY THERE.
 *
 * ONE CARRIER PER DESTINATION, which is the property worth the extra function.
 *
 *   card   stays on `widget.context`, a typed array `deck.ts` reads through
 *          `contextFor`. It is the only thing a Home card ever draws.
 *   depth  is PROJECTED ONTO THE DOMAIN MODEL'S OWN SLOT — `CalEvent.note`,
 *          `MailMessage.note` — and is then not on `widget.context` at all.
 *
 * That asymmetry is deliberate. `note` predates Phase 8: it was designed for a
 * routed leave-by, it requires its own grounds, and the calendar's detail sheet
 * has been drawing it since it was written, against a field nothing ever
 * populated. A depth line living in BOTH places would be one fact with two
 * carriers, which is exactly the arrangement that lets a card and a surface
 * start disagreeing — so the context object is the boundary, and what crosses
 * into React is the domain model it was folded into. §17.
 */
function place(w: Widget, context: DomainContext[]): Widget {
  const card = context.filter((c) => c.weight === 'card')
  const depth = context.filter((c) => c.weight === 'depth' && c.subject && c.grounds)
  const noteFor = (id: string) => {
    const c = depth.find((d) => d.subject === id)
    return c ? { says: c.line, grounds: c.grounds! } : undefined
  }

  /*
    Switched on the kind rather than spread generically, because `context` is
    declared on exactly the four widget kinds that have a renderer able to draw
    it. A generic spread would attach the field to `list`, `chart` and the rest —
    a payload carrying something nothing will ever read, which is how a type
    stops describing what is actually there.
  */
  switch (w.kind) {
    case 'calendar':
      return {
        ...w,
        context: card,
        // The event keeps whatever note it already had: a routed leave-by is a
        // stronger claim than a baseline and must not be overwritten by one.
        events: depth.length ? w.events.map((e) => (e.note ? e : { ...e, note: noteFor(e.id) })) : w.events,
      }
    case 'mail':
      return {
        ...w,
        context: card,
        messages: depth.length ? w.messages.map((m) => (m.note ? m : { ...m, note: noteFor(m.id) })) : w.messages,
      }
    case 'fitness':
    case 'map':
      return { ...w, context: card }
    default:
      return w
  }
}

/**
 * The facts one widget can be asked about, in the shape the compilers take.
 *
 * The mapping is deliberately narrow: each domain hands over the minimum its
 * comparison needs and nothing else. Calendar gives a count and a list of
 * ids/starts, not the titles; Mail gives addresses, not subjects. A compiler
 * that had the prose would eventually read it.
 */
function factsOf(w: Widget, now: Date, timeZone?: string): DomainFacts | null {
  const today = dayIn(now, timeZone)

  if (w.kind === 'calendar') {
    const events = w.events.filter((e) => !e.allDay)
    return {
      calendar: {
        today,
        todayEvents: w.events.filter((e) => dayIn(new Date(e.start), timeZone) === today).length,
        events: events.map((e) => ({ id: e.id, start: e.start, located: !!e.location })),
      },
    }
  }

  if (w.kind === 'fitness') {
    /*
      MISSING IS NOT ZERO, AND THIS IS THE LINE THAT KEEPS IT THAT WAY.

      `report.current` is null when there is no trustworthy figure — two sources
      disagreeing, or nothing reported at all — and that null is passed straight
      through rather than being replaced by the newest bar or by a zero. A
      comparison built from "whatever the chart last drew" is exactly how a gap
      in the feed becomes a sentence about him sitting still.
    */
    const current = w.report?.current
    return {
      activity: {
        metric: w.report?.metric ?? 'steps',
        current: current ? { day: current.day, value: current.value } : null,
      },
    }
  }

  if (w.kind === 'map') {
    return { places: { now, pins: w.places.map((p) => ({ id: p.id, lat: p.lat, lon: p.lon })) } }
  }

  if (w.kind === 'mail') {
    return { mail: { now, messages: w.messages.map((m) => ({ id: m.id, from: m.from })) } }
  }

  return null
}
