import { CAPABILITIES, type SurfaceCommand, type SurfaceObject, type SurfaceState } from './types'

/**
 * One reducer, for both of them.
 *
 * Every change to a surface arrives here as a command, whether it came from a
 * tap or from a sentence. That is not tidiness — it is the only way the two can
 * be guaranteed not to diverge. If tapping Tuesday went one way and "open
 * Tuesday" went another, then either the model would be reasoning about a state
 * he cannot see, or he would be looking at a state it cannot reason about, and
 * both of those are the failure this whole layer exists to remove.
 *
 * It is a pure function. No fetching, no side effects, no external actions:
 * selecting three messages and archiving three messages are different kinds of
 * event and only the first one happens here. What leaves the device goes
 * through the action path, with its authorisation and its audit record intact.
 */

export interface Applied {
  state: SurfaceState
  /** True when anything actually changed. A no-op is reported, not hidden. */
  changed: boolean
  /** What happened, in his words. Shown in the thread and set as the note. */
  said: string
}

const arr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : []

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

// ── Dates, in his timezone ───────────────────────────────────────────────────
// Everything here is LOCAL. A calendar that quietly worked in UTC would put a
// 23:30 event on the wrong day for half the year, which is the kind of bug that
// makes someone stop trusting the whole surface.

export const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export const fromYmd = (s: string): Date => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}

export const today = (): string => ymd(new Date())

const addDays = (s: string, n: number): string => {
  const d = fromYmd(s)
  d.setDate(d.getDate() + n)
  return ymd(d)
}

const addMonths = (s: string, n: number): string => {
  const d = fromYmd(s)
  d.setMonth(d.getMonth() + n)
  return ymd(d)
}

/** The local day an ISO timestamp falls on. */
export const dayOf = (iso: string): string => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : ymd(d)
}

/**
 * A date said in his own words.
 *
 * Deliberately small: weekday names, "today", "tomorrow", "next Tuesday", and
 * an ISO date. Anything beyond that is the model's job — it can compute a date
 * and pass it as `date`, which is why this does not need to grow into a parser.
 */
export function resolveDate(text: string, from = today()): string | null {
  const t = text.trim().toLowerCase()
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t
  if (t === 'today') return today()
  if (t === 'tomorrow') return addDays(today(), 1)
  if (t === 'yesterday') return addDays(today(), -1)

  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const m = t.match(/^(next |this |last )?(sun|mon|tues|tue|wednes|wed|thurs|thur|thu|fri|satur|sat)\w*$/)
  if (m) {
    const stem = m[2]!
    const want = days.findIndex((d) => d.startsWith(stem.slice(0, 3)))
    if (want < 0) return null
    const base = fromYmd(from)
    const delta = (want - base.getDay() + 7) % 7
    // "This Tuesday" on a Tuesday means today; "next Tuesday" means the one
    // after. A bare weekday means the next one to come, today included.
    const jump = m[1]?.trim() === 'next' ? (delta === 0 ? 7 : delta + 7) : m[1]?.trim() === 'last' ? delta - 7 : delta
    return addDays(from, jump)
  }
  return null
}

// ── Matching ─────────────────────────────────────────────────────────────────

/**
 * Turn what he (or the model) said into ids that are actually on screen.
 *
 * Ids given directly are still checked against the live objects, so a model
 * that hallucinates one selects nothing rather than something. A `match` is run
 * over the label and subtitle, plus a positional form — "number three", "the
 * third" — because that is how people refer to things in a grid.
 */
export function resolveIds(
  args: Record<string, unknown>,
  objects: SurfaceObject[]
): string[] {
  const known = new Set(objects.map((o) => o.id))

  if (args.all === true) return objects.map((o) => o.id)

  const ids = [...arr(args.ids), ...arr(args.id)].filter((i) => known.has(i))
  if (ids.length) return ids

  const raw = [...arr(args.match), ...arr(args.query)].join(' ').trim().toLowerCase()
  if (!raw) return []

  /**
   * "number three", "the 3rd", "#3", "number two" — a position in what is
   * currently listed.
   *
   * Cardinals are in the table as well as ordinals because that is what people
   * actually say when a grid is numbered: "number two", not "the second". A
   * model reading a numbered grid says it the same way, and leaving the
   * cardinals out made "select number two" match nothing at all.
   */
  const ord = raw.match(
    /(?:number|no\.?|#)\s*(\d+)|^(\d+)(?:st|nd|rd|th)?$|\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|one|two|three|four|five|six|seven|eight|nine|ten)\b/
  )
  if (ord) {
    const ordinals = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth']
    const cardinals = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
    const word = ord[3] ? Math.max(ordinals.indexOf(ord[3]), cardinals.indexOf(ord[3])) + 1 : 0
    const n = ord[1] ? Number(ord[1]) : ord[2] ? Number(ord[2]) : word
    const hit = n > 0 ? objects[n - 1] : undefined
    if (hit) return [hit.id]
  }

  const words = raw.split(/\s+/).filter((w) => w.length > 2)
  const scored = objects
    .map((o) => {
      const hay = `${o.label} ${o.sub ?? ''} ${(o.tags ?? []).join(' ')}`.toLowerCase()
      if (hay.includes(raw)) return { o, score: 100 }
      const hits = words.filter((w) => hay.includes(w)).length
      return { o, score: hits }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)

  if (!scored.length) return []
  // Everything as good as the best answer, so "the Chase emails" takes all
  // three rather than an arbitrary one of them.
  const best = scored[0]!.score
  return scored.filter((x) => x.score === best).map((x) => x.o.id)
}

// ── Free windows ─────────────────────────────────────────────────────────────

/** The hours a meeting could plausibly go in. Not a preference he has stated. */
const DAY_START = 8
const DAY_END = 21

/**
 * Gaps of at least `minutes`, across `days` days from the cursor.
 *
 * Computed here rather than asked of a model, and that is the point of the
 * whole exercise: the app holds every event with a start and an end, so the
 * answer is arithmetic. Asking a language model to subtract times when the
 * data is right there is how you get a confident wrong answer about your own
 * afternoon.
 */
export function openings(
  objects: SurfaceObject[],
  from: string,
  days: number,
  minutes: number
): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = []

  for (let i = 0; i < days; i++) {
    const day = addDays(from, i)
    const busy = objects
      .filter((o) => o.at && !o.allDay && dayOf(o.at) === day)
      .map((o) => {
        const s = new Date(o.at!)
        // An event with no end is treated as an hour. Better than treating it
        // as instantaneous and offering him a window inside his own meeting.
        const e = o.end ? new Date(o.end) : new Date(s.getTime() + 3_600_000)
        return { s, e }
      })
      .filter((b) => !Number.isNaN(b.s.getTime()))
      .sort((a, b) => a.s.getTime() - b.s.getTime())

    const dayStart = fromYmd(day)
    dayStart.setHours(DAY_START, 0, 0, 0)
    const dayEnd = fromYmd(day)
    dayEnd.setHours(DAY_END, 0, 0, 0)

    let cursor = dayStart
    for (const b of busy) {
      if (b.s.getTime() - cursor.getTime() >= minutes * 60_000) {
        out.push({ start: cursor.toISOString(), end: b.s.toISOString() })
      }
      if (b.e > cursor) cursor = b.e
    }
    if (dayEnd.getTime() - cursor.getTime() >= minutes * 60_000) {
      out.push({ start: cursor.toISOString(), end: dayEnd.toISOString() })
    }
  }
  return out
}

/** An opening, encoded as a mark the calendar renderer knows how to draw. */
export const markOfOpening = (o: { start: string; end: string }) => `open:${o.start}:${o.end}`

export function parseOpening(mark: string): { start: string; end: string } | null {
  if (!mark.startsWith('open:')) return null
  const rest = mark.slice(5)
  const i = rest.indexOf(':', rest.indexOf('T'))
  // Both halves are full ISO timestamps, which themselves contain colons — so
  // the split is at the colon that ends the first one, not at the first colon.
  const m = rest.match(/^(.+?Z|.+?[+-]\d{2}:\d{2})(.+)$/)
  if (m) return { start: m[1]!, end: m[2]!.replace(/^:/, '') }
  return i > 0 ? { start: rest.slice(0, i), end: rest.slice(i + 1) } : null
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

// ── The reducer ──────────────────────────────────────────────────────────────

export function apply(
  state: SurfaceState,
  cmd: SurfaceCommand,
  objects: SurfaceObject[]
): Applied {
  const args = cmd.args ?? {}
  const allowed = CAPABILITIES[state.kind] ?? []
  if (!allowed.some((c) => c.op === cmd.op)) {
    return { state, changed: false, said: `A ${state.kind} surface can't ${cmd.op}.` }
  }

  const next: SurfaceState = { ...state, filters: { ...state.filters }, note: null }
  let said = ''

  switch (cmd.op) {
    case 'setView': {
      const view = String(args.view ?? '').trim()
      if (!view) break
      next.view = view
      said = `Showing the ${view}.`
      break
    }

    case 'navigate': {
      const base = state.cursor ?? today()
      const step = state.view === 'month' ? 'month' : state.view === 'day' ? 'day' : 'week'
      const to = String(args.to ?? '').trim().toLowerCase()
      const explicit = args.date ? resolveDate(String(args.date), base) : null
      const spoken = !explicit && to && !['today', 'next', 'prev', 'previous', 'back'].includes(to)
        ? resolveDate(to, base)
        : null
      const delta = num(args.delta) ?? num(args.days)

      let target: string | null = explicit ?? spoken
      if (!target && to === 'today') target = today()
      if (!target && (to === 'next' || to === 'prev' || to === 'previous' || to === 'back')) {
        const dir = to === 'next' ? 1 : -1
        target = step === 'month' ? addMonths(base, dir) : addDays(base, dir * (step === 'week' ? 7 : 1))
      }
      if (!target && delta !== null) target = addDays(base, delta)
      if (!target) { said = 'I couldn’t work out which date you meant.'; break }

      next.cursor = target
      next.range = null
      // Moving somewhere else is not a reason to lose what he picked, but an
      // opening found for last week is meaningless on this one.
      next.marks = []
      said = `Showing ${friendlyDate(target)}.`
      break
    }

    case 'range': {
      const from = args.from ? resolveDate(String(args.from)) : null
      const to = args.to ? resolveDate(String(args.to)) : null
      if (!from || !to) { said = 'I need a start and an end date.'; break }
      next.range = { from, to }
      next.cursor = from
      said = `Showing ${friendlyDate(from)} to ${friendlyDate(to)}.`
      break
    }

    case 'focus': {
      const [id] = resolveIds(args, objects)
      if (!id) { said = 'I couldn’t find that one.'; break }
      next.focus = id
      /*
        FOCUSING SOMETHING IS OPENING IT, on a surface that has a detail mode.

        Calendar's tap already meant "show me this one" and the renderer drew a
        drawer off the back of `focus` alone. Making the mode explicit is what
        lets the way BACK be a real transition rather than a renderer's private
        boolean — and it keeps the model's `focus` and his tap on exactly the
        same path, which is the whole premise of this reducer.
      */
      if (state.kind === 'calendar') next.mode = 'detail'
      // Focusing something on a dated surface takes the view to its day —
      // otherwise "open my 3 PM event" selects something that is off screen.
      const obj = objects.find((o) => o.id === id)
      if (obj?.at && (state.kind === 'calendar')) next.cursor = dayOf(obj.at)
      said = `Opened ${objects.find((o) => o.id === id)?.label ?? 'it'}.`
      break
    }

    /**
     * THE MODE TRANSITION. One field, and it carries focus with it.
     *
     * Every rule the handoff states about stacking is enforced right here rather
     * than in each renderer: there is no state in which a surface is browsing
     * AND showing a detail AND editing, because there is one `mode` and it holds
     * one value. `browse` clears the focus with it — an event still highlighted
     * behind a calendar he has gone back to is the residue that made the old
     * drawer feel like a layer rather than a step.
     *
     * Entering `detail`, `read` or `edit` without a focused object is refused
     * rather than being allowed to draw an empty one. That refusal is the same
     * rule as `nav.ts`'s: nothing may open onto nothing.
     */
    case 'mode': {
      const to = String(args.to ?? args.mode ?? '').trim() as SurfaceState['mode']
      if (!to || !['browse', 'detail', 'read', 'edit'].includes(to)) {
        said = 'I don’t know which mode you mean.'
        break
      }
      const [named] = resolveIds(args, objects)
      const on = named ?? state.focus
      if (to !== 'browse' && !on) {
        said = 'There’s nothing open to do that with.'
        break
      }
      next.mode = to
      if (to === 'browse') {
        next.focus = null
        next.expanded = null
      } else {
        next.focus = on!
        next.expanded = to === 'read' ? on! : state.expanded
        const obj = objects.find((o) => o.id === on)
        if (obj?.at && state.kind === 'calendar') next.cursor = dayOf(obj.at)
      }
      const label = objects.find((o) => o.id === on)?.label
      said =
        to === 'browse' ? 'Back to the list.'
        : to === 'edit' ? `Editing ${label ?? 'it'}.`
        : `Opened ${label ?? 'it'}.`
      break
    }

    case 'expand': {
      const [id] = resolveIds(args, objects)
      if (!id) { said = 'I couldn’t find that one.'; break }
      next.expanded = id
      next.focus = id
      said = `Opened ${objects.find((o) => o.id === id)?.label ?? 'it'}.`
      break
    }

    case 'collapse':
      next.expanded = null
      said = 'Closed it.'
      break

    case 'select': {
      const ids = resolveIds(args, objects)
      if (!ids.length) { said = 'Nothing there matched.'; break }
      const set = new Set(args.replace === true ? [] : state.selected)
      for (const i of ids) set.add(i)
      next.selected = objects.map((o) => o.id).filter((i) => set.has(i))
      said = `Selected ${next.selected.length}.`
      break
    }

    case 'deselect': {
      const ids = new Set(resolveIds(args, objects))
      next.selected = state.selected.filter((i) => !ids.has(i))
      said = next.selected.length ? `${next.selected.length} still selected.` : 'Selection cleared.'
      break
    }

    case 'clearSelection':
      next.selected = []
      said = 'Selection cleared.'
      break

    case 'keepOnly': {
      const ids = resolveIds(args, objects)
      if (!ids.length) { said = 'Nothing there matched.'; break }
      next.filters = { ...next.filters, only: ids.join(',') }
      next.selected = ids
      said = `Keeping ${ids.length}, hiding the rest.`
      break
    }

    case 'filter': {
      const entries = Object.entries(args).filter(([k]) => k !== 'surface')
      if (!entries.length) break
      for (const [k, v] of entries) {
        if (v === null || v === false || v === '') delete next.filters[k]
        else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') next.filters[k] = v
      }
      said = describeFilters(next.filters)
      break
    }

    case 'clearFilters':
      next.filters = {}
      next.query = ''
      said = 'Showing everything again.'
      break

    case 'search': {
      next.query = String(args.query ?? args.text ?? '')
      said = next.query ? `Searching for “${next.query}”.` : 'Cleared the search.'
      break
    }

    case 'sort': {
      const by = String(args.by ?? '').trim()
      if (!by) break
      const dir = String(args.dir ?? 'desc') === 'asc' ? 'asc' : 'desc'
      next.sort = `${by}:${dir}`
      said = `Sorted by ${by}, ${dir === 'asc' ? 'ascending' : 'descending'}.`
      break
    }

    case 'toggleSeries': {
      const key = String(args.key ?? '').trim()
      if (!key) break
      const on = args.on === undefined ? state.hidden.includes(key) : args.on === true
      next.hidden = on ? state.hidden.filter((k) => k !== key) : [...new Set([...state.hidden, key])]
      said = on ? `Showing ${key}.` : `Hiding ${key}.`
      break
    }

    case 'compare': {
      const key = args.key === null || args.key === false ? null : String(args.key ?? 'previous')
      next.compare = key
      said = key ? 'Drawing the previous period behind it.' : 'Dropped the comparison.'
      break
    }

    case 'viewport': {
      const lat = num(args.lat)
      const lon = num(args.lon)
      const zoom = num(args.zoom)
      if (lat === null || lon === null) {
        if (zoom !== null && state.viewport) {
          next.viewport = { ...state.viewport, zoom }
          said = `Zoom ${zoom}.`
          break
        }
        said = 'I need coordinates to move the map.'
        break
      }
      next.viewport = { lat, lon, zoom: zoom ?? state.viewport?.zoom ?? 13 }
      said = 'Moved the map.'
      break
    }

    case 'draft': {
      const text = String(args.text ?? '').trim()
      if (!text) { said = 'There was nothing to put in the composer.'; break }
      next.draft = {
        text,
        to: args.to ? String(args.to) : state.draft?.to,
        subject: args.subject ? String(args.subject) : state.draft?.subject,
        replyTo: args.replyTo ? String(args.replyTo) : resolveIds(args, objects)[0] ?? state.draft?.replyTo,
        byModel: args.byModel !== false,
      }
      if (next.draft.replyTo) next.expanded = next.draft.replyTo
      // Deliberately never sends. The composer is where a draft stops.
      said = 'Put a draft in the composer — read it before it goes anywhere.'
      break
    }

    case 'findOpenings': {
      const minutes = num(args.minutes) ?? num(args.length) ?? 60
      const days = Math.max(1, Math.min(31, num(args.days) ?? (state.view === 'month' ? 30 : 7)))
      const found = openings(objects, state.cursor ?? today(), days, minutes)
      next.marks = found.map(markOfOpening)
      /*
        THE MARKS ARE THE ANSWER. THE SENTENCE SAYS WHAT THEY CANNOT.

        It used to name the count, the length, the full friendly date and the
        time — while the dashed regions were on screen showing exactly where the
        openings are, on a day the header is already naming. Four presentations
        of one result, and the prose was the weakest of them.

        What the regions genuinely cannot say is whether the first opening is on
        the day being looked at or somewhere further out, so that is what is
        left. When it is on this day the sentence is just the time, because the
        date is on the screen twice already.
      */
      const firstDay = found.length ? dayOf(found[0]!.start) : null
      const here = firstDay === (state.cursor ?? today())
      said = found.length
        ? here
          ? `First is ${clock(found[0]!.start)}.`
          : `First is ${friendlyDate(firstDay!)} at ${clock(found[0]!.start)}.`
        : `No ${minutes}-minute openings in the next ${days} days.`
      break
    }

    case 'mark': {
      const ids = resolveIds(args, objects)
      next.marks = ids
      said = ids.length ? `Highlighted ${ids.length}.` : 'Nothing there matched.'
      break
    }

    case 'clear':
      next.selected = []
      next.marks = []
      next.expanded = null
      next.focus = null
      // Clearing is a way back to the application, so it is also a way out of
      // whatever mode the object had opened.
      next.mode = 'browse'
      next.query = ''
      next.filters = {}
      said = 'Cleared.'
      break
  }

  next.note = said || null
  const changed = JSON.stringify({ ...next, note: null }) !== JSON.stringify({ ...state, note: null })
  return { state: next, changed, said: said || 'Nothing changed.' }
}

function describeFilters(f: Record<string, string | number | boolean>): string {
  const parts = Object.entries(f).map(([k, v]) => {
    if (k === 'unread' && v === true) return 'unread only'
    if (k === 'minMinutes') return `over ${v} minutes`
    if (k === 'maxMinutes') return `under ${v} minutes`
    if (k === 'only') return `${String(v).split(',').length} kept`
    if (v === true) return k
    return `${k}: ${v}`
  })
  return parts.length ? `Showing ${parts.join(', ')}.` : 'Showing everything again.'
}

export function friendlyDate(day: string): string {
  const d = fromYmd(day)
  if (Number.isNaN(d.getTime())) return day
  const diff = Math.round((d.getTime() - fromYmd(today()).getTime()) / 86_400_000)
  if (diff === 0) return 'today'
  if (diff === 1) return 'tomorrow'
  if (diff === -1) return 'yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })
}
