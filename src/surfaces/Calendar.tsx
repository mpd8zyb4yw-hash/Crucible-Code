import { useEffect, useMemo, useRef, useState } from 'react'
import { css, cssv } from '../css'
import { accentOf } from '../heat'
import { useMeasured } from '../fit'
import type { CalEvent, WidgetAction } from '../api'
import { useSurface } from '../surface/store'
import { CHROME, TYPE } from '../tokens'
import type { SurfaceObject } from '../surface/types'
import { dayOf, friendlyDate, fromYmd, parseOpening, today, ymd } from '../surface/reducer'
import { Actions, CARD, Chip, Segments, Swipe, Toolbar, clockOf } from './kit'

/**
 * An actual calendar.
 *
 * What was here before was an agenda: events grouped under day headings, which
 * answers "what is next" and nothing else. It cannot show that Thursday is
 * empty, that two things collide at four, or where a ninety-minute gap is —
 * and those are the questions a calendar exists to answer. A list of the days
 * that HAVE something on them is structurally incapable of showing you the days
 * that do not.
 *
 * So this draws time. Month is a grid of every day including the blank ones;
 * week and day are hour rules with events placed and sized by their real start
 * and end. Free windows found by `findOpenings` are drawn in the same geometry,
 * dashed, which is why "find me ninety minutes" produces a place on the screen
 * rather than a sentence.
 *
 * Every control emits a command. There is no path in this file that writes
 * state directly, so tapping Tuesday and being told "open Tuesday" run the same
 * code, and either can be undone by the same button.
 */

/** The comfortable hour row, and the shortest one that is still readable. */
const HOUR_H = 34
const MIN_HOUR_H = 22
const MIN_HOUR = 7
const MAX_HOUR = 22

/**
 * THE DAY IS DRAWN AT 44px AN HOUR AND SCROLLS. Week is fitted to its box.
 *
 * Two different answers to the same question, and deliberately so. A week has to
 * be comparable across seven columns, so it is fitted — see `Grid`, and the 48px
 * of clipped evening that made fitting necessary. A DAY is a thing you read, and
 * the design fixes its rhythm: 44px per hour, every hour the same, scrolled
 * rather than squeezed. Squeezing a day to fit is how an event became four
 * pixels tall on a short screen.
 */
const DAY_HOUR_H = 44

interface Props {
  surfaceKey: string
  title: string
  events: CalEvent[]
  empty?: string
  heat: string
  /** Pane-level actions. Calendar decides where they live inside its own UI. */
  actions?: WidgetAction[]
  onAction: (a: NonNullable<CalEvent['actions']>[number]) => Promise<void>
}

const startOfWeek = (day: string): string => {
  const d = fromYmd(day)
  // Monday-first. He lives in Italy; a Sunday-first grid would be a locale
  // assumption imported from somewhere he does not live.
  const shift = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - shift)
  return ymd(d)
}

const addDays = (day: string, n: number) => {
  const d = fromYmd(day)
  d.setDate(d.getDate() + n)
  return ymd(d)
}

const hourFraction = (iso: string): number => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? 0 : d.getHours() + d.getMinutes() / 60
}

export default function Calendar({ surfaceKey, title, events, empty, heat, actions, onAction }: Props) {
  const objects: SurfaceObject[] = useMemo(
    () => events.map((e) => ({
      id: e.id,
      label: e.title,
      sub: e.location,
      at: e.start,
      end: e.end,
      allDay: e.allDay,
      tags: e.response ? [e.response] : undefined,
    })),
    [events]
  )

  const [state, send] = useSurface(surfaceKey, 'calendar', title, objects, {
    /*
      DAY, NOT WEEK, IS WHERE CALENDAR OPENS.

      A week across a 390pt phone is 50pt a column, which is why an event in it
      renders as "Restau…" in a violet rectangle — a picture of an event rather
      than an event. The Phase 1 design draws the day for exactly this reason,
      and the day carries the week's shape in its strip, so nothing is lost by
      landing here: the seven days are still one tap each, and the one you are
      on is legible.

      Week and Month both still exist and both still draw; they are a tap away
      on the range label. Nothing is offered in that picker that does not work.
    */
    view: 'day',
    cursor: today(),
  })

  const cursor = state.cursor ?? today()

  /**
   * A CURSOR FROM A DAY THAT HAS SINCE PASSED IS NOT WHERE HE MEANT TO BE.
   *
   * Surface state persists, which is right — closing the calendar on Thursday
   * and reopening it a minute later should still be Thursday. It is not right
   * across days: reopen it a week later and it lands on the week he last looked
   * at, with today's dot off the end of the strip and every gap the finder marks
   * already in the past.
   *
   * ON MOUNT ONLY, and that qualifier is the whole correctness of it. Written as
   * an expression over `state.cursor` — `cursor >= today() ? cursor : today()` —
   * it re-ran on every render, so it did not adopt a stale cursor, it FORBADE a
   * past one: tapping back a day snapped straight forward again, and an event
   * focused on a day gone by could not be reached at all. The interaction gate
   * caught it as "Calendar has an event to tap".
   *
   * Deliberately going back still works and still sticks for the session. This
   * decides where the surface OPENS, which is a different question from where he
   * can go.
   */
  const adopted = useRef(false)
  useEffect(() => {
    if (adopted.current) return
    adopted.current = true
    const stored = state.cursor
    if (stored && stored < today()) send({ op: 'range', args: { from: today(), to: today() } })
    // Mount only. Re-running this on a cursor change is precisely the bug above.
     
  }, [])
  /**
   * A SURFACE PERSISTED BEFORE MODES EXISTED STILL HAS TO OPEN.
   *
   * Surface state is stored in localStorage and survives the deploy that
   * introduced `mode`, so a browser that had an event focused came back with
   * `focus` set and `mode` undefined — which reads as `browse`, and drew a
   * highlighted event with no card and no way to act on it. The old field is the
   * migration: focus WAS the detail state, so it means the detail state.
   */
  const mode = state.mode ?? (state.focus ? 'detail' : 'browse')
  /*
    THE EVENT BEING CREATED, while it is still only a time he tapped.

    Held here rather than in surface state because it is not shared: nothing the
    model does creates one of these, and a half-typed title is not something the
    reducer's undo history should carry. It leaves the moment the editor closes.
  */
  const [newIn, setNewIn] = useState<{ start: string; end: string } | null>(null)
  /** The view chooser, revealed by the range label rather than always resident. */
  const [picking, setPicking] = useState(false)
  const byId = useMemo(() => new Map(events.map((e) => [e.id, e])), [events])
  const focused = state.focus ? byId.get(state.focus) ?? null : null

  const marks = useMemo(
    () => state.marks.map(parseOpening).filter((m): m is { start: string; end: string } => !!m),
    [state.marks]
  )

  /**
   * There is deliberately no `if (!events.length) return <Empty/>` here.
   *
   * That line replaced the entire calendar with a grey box of text whenever the
   * week happened to be clear — so "nothing on this week" and "this app is not
   * working" looked identical, and there was no way to page to a week that DID
   * have something, because the controls that page were inside the thing being
   * replaced. An empty calendar is a calendar: the grid, the view switch and
   * the navigation all still mean something, and the emptiness is a note inside
   * the geometry rather than instead of it.
   */
  const days =
    state.view === 'day' ? [cursor]
    : state.view === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(cursor), i))
    : []

  const rangeLabel =
    state.view === 'month'
      ? fromYmd(cursor).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
      : state.view === 'day'
        ? friendlyDate(cursor)
        : `${fromYmd(days[0]!).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${fromYmd(days[6]!).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`

  return (
    /*
      THE WHOLE FRAME IS CALENDAR.

      Previously this surface contributed one item to a stack: a stats tile, a
      row of view chips, a row of navigation chips, a heading, a secondary
      action and a status line all sat above it, and the grid — the only part
      anybody opens Calendar to see — got whatever height was left. Everything
      in that list belongs to Calendar, so all of it is now inside Calendar,
      compressed into one toolbar, and the grid takes the rest of the frame.

      Height comes from the frame, never from content: `flex:1; min-height:0`
      on the grid with its own scroll means a busy month scrolls internally
      instead of pushing chat down the screen.
    */
    /* `position:relative` is load-bearing: the detail overlay below is
       absolutely positioned, and without a positioned ancestor here it
       resolved against the page — the opened event drew itself on top of the
       chat composer, outside the frame that is supposed to contain it. */
    <div style={css('position:relative; height:100%; min-height:0; display:flex; flex-direction:column; gap:6px; padding:8px 14px 6px; box-sizing:border-box;')}>
      {/*
        EDITING REPLACES THE CALENDAR. It does not sit on top of it.

        This is §16 and §28 as a `return`: while he is editing, the frame holds
        the editor and nothing else — no grid behind it, no toolbar above it, no
        chat composer competing with the fields. The way back is inside the
        editor, where it belongs, and it is the only way out, which is what makes
        the transition legible as a step rather than as another layer.
      */}
      {newIn ? (
        <EventEditor
          /* No id: `EventEditor` reads that as a create. The time is his tap. */
          event={{ id: '', title: '', start: newIn.start, end: newIn.end }}
          onAction={onAction}
          onDone={() => setNewIn(null)}
        />
      ) : mode === 'edit' && focused ? (
        <EventEditor
          event={focused}
          onAction={onAction}
          onDone={() => send({ op: 'mode', args: { to: 'detail' } })}
        />
      ) : (
      <>
      <Toolbar
        left={
          <>
            {/*
              THE RANGE IS THE ONLY PERMANENT CONTROL, and it is a control.

              What was here: a D/W/M segment, then a previous button, a today
              button and a next button — five permanent controls for navigating
              a surface where the familiar gesture is a swipe. §12 and §30 both
              land on the same answer, so paging is a swipe (see `Swipe`), the
              view choice is behind a tap on the range it changes, and "today"
              appears only when he is not on it.
            */}
            <div
              data-role="range"
              onClick={() => setPicking((v) => !v)}
              style={css('min-width:0; padding:4px 9px; border-radius:999px; cursor:pointer; background:rgba(255,255,255,' + (picking ? '.12' : '.05') + '); font-size:12.5px; font-weight:600; letter-spacing:-.01em; color:rgba(237,238,241,.9); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}
            >
              {rangeLabel}
            </div>
            {/* CONTEXTUAL, not permanent: there is nothing to return to while
                he is already looking at today. */}
            {!days.includes(today()) && state.view !== 'month' && (
              <Chip label="Today" onClick={() => send({ op: 'navigate', args: { to: 'today' } })} />
            )}
          </>
        }
        more={
          <>
            <Chip label="find 90 min" onClick={() => send({ op: 'findOpenings', args: { minutes: 90 } })} />
            <Chip label="find 30 min" onClick={() => send({ op: 'findOpenings', args: { minutes: 30 } })} />
            {/* Pane-level actions — "New event" — belong to Calendar, and this
                is where Calendar chooses to put them. */}
            {actions?.map((a, i) => (
              <Chip key={i} label={a.label} onClick={() => void onAction(a)} />
            ))}
          </>
        }
      />

      {/* The view choice, revealed by the thing it changes and gone once used. */}
      {picking && (
        <div style={css('flex:none;')}>
          <Segments
            value={state.view as 'day' | 'week' | 'month'}
            options={[{ v: 'day', label: 'Day' }, { v: 'week', label: 'Week' }, { v: 'month', label: 'Month' }]}
            onChange={(v) => { send({ op: 'setView', args: { view: v } }); setPicking(false) }}
          />
        </div>
      )}

      {/* One compact status line carrying note, emptiness and openings. These
          were three separate blocks each reserving vertical space. */}
      {!events.length && !marks.length && (
        <div style={css('flex:none; padding:0 2px; font-size:11px; line-height:1.35; color:rgba(240,165,107,.7); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>
          {/*
            THE MARKS ARE THE ANSWER — the reducer says so at length and then
            this said it again, as prose, in 12-hour time beside a 24-hour axis:
            "7 free windows: tomorrow 08:00 AM, Thursday, Aug 20 08:00 AM" over a
            grid already showing all seven of them, on a day the header names.
            Four presentations of one result, and this was the weakest.
          */}
          {marks.length ? '' : (empty ?? 'Nothing scheduled.')}
        </div>
      )}

      {/*
        THE APPLICATION, and the gesture that moves it through time.

        `Swipe` is horizontal-only and hands vertical movement straight back to
        the scroller underneath, so paging a week and scrolling to the evening
        are the same finger doing two unambiguous things.
      */}
      <Swipe
        onNext={() => send({ op: 'navigate', args: { to: 'next' } })}
        onPrev={() => send({ op: 'navigate', args: { to: 'prev' } })}
      >
        {state.view === 'month'
          ? <Month cursor={cursor} events={events} heat={heat} state={state} send={send} />
          : state.view === 'day'
            ? <Day cursor={cursor} events={events} marks={marks} heat={heat} state={state} send={send} onOpening={setNewIn} />
            : <Grid days={days} events={events} marks={marks} heat={heat} state={state} send={send} />}
      </Swipe>

      {/*
        THE OPENED EVENT, AS A COMPACT CARD RATHER THAN HALF THE SCREEN.

        What this replaces took `share: 0.7` of the frame — a name field, a
        location field, an owner row, a guest row, a response row and a notes
        editor, all of it permanently over the calendar, to say what the event
        block he tapped already said. §15 is the rule and this is the shape: the
        event, when it is, where it is, and the three things there are to DO with
        it. Everything else is one tap away, in the editor, where the frame is
        actually his to use.
      */}
      {mode === 'detail' && focused && (
        <EventCard
          event={focused}
          onAction={onAction}
          onEdit={() => send({ op: 'mode', args: { to: 'edit' } })}
          onClose={() => send({ op: 'mode', args: { to: 'browse' } })}
        />
      )}
      </>
      )}
    </div>
  )
}

// ── Month ────────────────────────────────────────────────────────────────────

function Month({
  cursor, events, heat, state, send,
}: {
  cursor: string
  events: CalEvent[]
  heat: string
  state: ReturnType<typeof useSurface>[0]
  send: ReturnType<typeof useSurface>[1]
}) {
  const first = fromYmd(cursor)
  first.setDate(1)
  const gridStart = startOfWeek(ymd(first))
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
  const month = first.getMonth()

  const counts = new Map<string, CalEvent[]>()
  for (const e of events) {
    const d = dayOf(e.start)
    if (!counts.has(d)) counts.set(d, [])
    counts.get(d)!.push(e)
  }

  // Six rows is enough for any month but is often one row of the next month;
  // dropping trailing rows that are entirely outside it keeps the grid honest.
  const rows = cells.slice(0, fromYmd(cells[35]!).getMonth() === month ? 42 : 35)
  const dayEvents = counts.get(cursor) ?? []

  return (
    <div style={css('display:flex; flex-direction:column; gap:8px;')}>
      <div style={cssv`padding:9px 8px 10px; ${CARD}`}>
        <div style={css('display:grid; grid-template-columns:repeat(7,1fr); gap:2px; margin-bottom:5px;')}>
          {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
            <div key={i} style={css('text-align:center; font-size:9.5px; font-weight:600; letter-spacing:.06em; color:rgba(237,238,241,.32);')}>{d}</div>
          ))}
        </div>
        <div style={css('display:grid; grid-template-columns:repeat(7,1fr); gap:2px;')}>
          {rows.map((day) => {
            const here = counts.get(day) ?? []
            const isCursor = day === cursor
            const isToday = day === today()
            const outside = fromYmd(day).getMonth() !== month
            return (
              <div
                key={day}
                onClick={() => send({ op: 'navigate', args: { date: day } })}
                style={cssv`aspect-ratio:1; border-radius:8px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; cursor:pointer; background:rgba(255,255,255,${isCursor ? '.13' : '0'}); box-shadow:${isToday ? 'inset 0 0 0 1px rgba(240,165,107,.55)' : 'none'};`}
              >
                <div style={cssv`font-size:11.5px; font-variant-numeric:tabular-nums; color:rgba(237,238,241,${outside ? '.22' : isCursor ? '.95' : '.66'});`}>
                  {fromYmd(day).getDate()}
                </div>
                <div style={css('display:flex; gap:2px; height:4px; align-items:center;')}>
                  {here.slice(0, 3).map((e) => (
                    <div key={e.id} style={cssv`width:3.5px; height:3.5px; border-radius:999px; background:${accentOf(e.accent, heat)};`} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <DayList day={cursor} events={dayEvents} heat={heat} state={state} send={send} />
    </div>
  )
}

// ── One day, at a size you can actually read ─────────────────────────────────

/**
 * THE DAY VIEW, AS THE PHASE 1 DESIGN DRAWS IT.
 *
 * Three bands and they answer three different questions. The strip carries the
 * shape of the WEEK — which days have something, which one is today, which one
 * you are on — so moving through the week costs a tap and no navigation chrome.
 * The all-day row is separated because an all-day event has no hour and placing
 * it on an hour grid is the "at 11 AM … (all day)" lie in another costume. The
 * timeline is the shape of the DAY, at a fixed 44px rhythm.
 *
 * The strip replaces four permanent controls — prev, next, today, and the D/W/M
 * segment — with the thing they were for.
 */
function Day({
  cursor, events, marks, heat, state, send, onOpening,
}: {
  cursor: string
  events: CalEvent[]
  marks: { start: string; end: string }[]
  onOpening?: (m: { start: string; end: string }) => void
  heat: string
  state: ReturnType<typeof useSurface>[0]
  send: ReturnType<typeof useSurface>[1]
}) {
  const week = Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(cursor), i))
  const timed = events.filter((e) => !e.allDay && dayOf(e.start) === cursor)
  const allDay = events.filter((e) => e.allDay && dayOf(e.start) === cursor)

  /*
    The hours shown are the ones the day needs, never a constant window. A day
    whose only event is at 06:30 must not push it off the top of a grid that
    starts at 08:00 — the same rule the week grid learned, applied here.
  */
  const lo = Math.floor(Math.min(MIN_HOUR + 1, ...timed.map((e) => hourFraction(e.start))))
  const hi = Math.ceil(Math.max(MAX_HOUR - 2, ...timed.map((e) => hourFraction(e.end ?? e.start) + (e.end ? 0 : 1))))
  const from = Math.max(0, Math.min(lo, MIN_HOUR))
  const to = Math.min(24, Math.max(hi, MAX_HOUR))
  const hours = Array.from({ length: to - from }, (_, i) => from + i)

  const now = new Date()
  const nowHour = now.getHours() + now.getMinutes() / 60
  const isToday = cursor === today()

  const place = (startIso: string, endIso: string | undefined) => {
    const s = hourFraction(startIso)
    const e = endIso ? hourFraction(endIso) : s + 1
    return {
      top: (s - from) * DAY_HOUR_H,
      height: Math.max(50, (Math.max(e, s + 0.25) - s) * DAY_HOUR_H - 4),
    }
  }

  return (
    <div style={css('height:100%; min-height:0; display:flex; flex-direction:column; gap:6px;')}>
      <div data-role="week-strip" style={css('flex:none; display:flex; gap:4px; padding:2px 0 4px;')}>
        {week.map((d) => {
          const here = events.filter((e) => dayOf(e.start) === d)
          const sel = d === cursor
          const isNow = d === today()
          const warn = here.some((e) => e.allDay)
          return (
            <div
              key={d}
              onClick={() => send({ op: 'navigate', args: { date: d } })}
              style={cssv`flex:1; min-width:0; height:56px; border-radius:14px; cursor:pointer; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; background:${sel ? 'rgba(237,238,241,.92)' : 'transparent'}; box-shadow:${sel ? 'none' : isNow ? 'inset 0 0 0 1px rgba(240,165,107,.35)' : 'inset 0 0 0 1px rgba(255,255,255,.06)'};`}
            >
              <div style={cssv`font-size:9.5px; letter-spacing:.04em; text-transform:uppercase; color:${sel ? 'rgba(11,11,13,.5)' : 'rgba(237,238,241,.34)'};`}>
                {fromYmd(d).toLocaleDateString(undefined, { weekday: 'short' })}
              </div>
              <div style={cssv`font-size:15px; font-weight:600; letter-spacing:-.02em; font-variant-numeric:tabular-nums; color:${sel ? '#0B0B0D' : isNow ? '#F0A56B' : 'rgba(237,238,241,.8)'};`}>
                {fromYmd(d).getDate()}
              </div>
              <div style={cssv`width:4px; height:4px; border-radius:999px; background:${!here.length ? 'transparent' : sel ? 'rgba(11,11,13,.45)' : warn ? '#E7B24C' : '#F0A56B'};`} />
            </div>
          )
        })}
      </div>

      {allDay.map((e) => (
        <div
          key={e.id}
          data-object={e.id}
          onClick={() => send({ op: 'focus', args: { id: e.id } })}
          style={css('flex:none; display:flex; align-items:center; gap:9px; padding:9px 12px; border-radius:13px; cursor:pointer; background:rgba(231,178,76,.1); box-shadow:inset 0 0 0 1px rgba(231,178,76,.26);')}
        >
          <div style={css('font-size:9.5px; letter-spacing:.05em; text-transform:uppercase; color:rgba(231,178,76,.8);')}>all day</div>
          <div style={css('flex:1; min-width:0; font-size:13px; font-weight:600; color:#F0D9A6; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>{e.title}</div>
          {e.location && (
            <div style={css('font-size:11px; color:rgba(231,178,76,.75); white-space:nowrap;')}>{e.location}</div>
          )}
        </div>
      ))}

      <div style={css('flex:1; min-height:0; overflow-y:auto; overscroll-behavior:contain; -webkit-overflow-scrolling:touch; position:relative; padding-top:8px;')}>
        <div style={cssv`position:relative; height:${hours.length * DAY_HOUR_H}px;`}>
          {hours.map((h, i) => (
            <div key={h} style={cssv`position:absolute; left:0; right:0; top:${i * DAY_HOUR_H}px; height:${DAY_HOUR_H}px;`}>
              <div style={css('position:absolute; left:0; top:-5px; font-size:10px; line-height:1; font-variant-numeric:tabular-nums; color:rgba(237,238,241,.28);')}>
                {String(h).padStart(2, '0')}:00
              </div>
              <div style={css('position:absolute; left:44px; right:0; top:0; height:1px; background:rgba(255,255,255,.055);')} />
            </div>
          ))}

          {/* Now, and only when now is actually on this day and inside the
              window. A mark for a moment the grid does not cover is not a mark,
              it is a wrong answer. */}
          {isToday && nowHour >= from && nowHour <= to && (
            <div style={cssv`position:absolute; left:36px; right:0; top:${(nowHour - from) * DAY_HOUR_H}px; height:1px; background:rgba(240,165,107,.55); z-index:3;`}>
              <div style={css('position:absolute; left:-4px; top:-3.5px; width:8px; height:8px; border-radius:999px; background:#F0A56B;')} />
            </div>
          )}

          {/* A FREE WINDOW IS A TAP TARGET. See `EventEditor`'s `creating`. */}
          {marks.filter((m) => dayOf(m.start) === cursor).map((m, i) => {
            const p = place(m.start, m.end)
            return (
              <div
                key={`m${i}`}
                data-opening={m.start}
                onClick={() => onOpening?.(m)}
                style={cssv`position:absolute; left:44px; right:0; top:${p.top}px; height:${p.height}px; border-radius:12px; box-sizing:border-box; border:1px dashed rgba(123,217,184,.7); background:rgba(123,217,184,.10); z-index:1; cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:11px; color:rgba(123,217,184,.85);`}
              >{p.height >= 26 ? 'free — put something here' : ''}</div>
            )
          })}

          {timed.map((e) => {
            const p = place(e.start, e.end)
            const on = state.focus === e.id || state.selected.includes(e.id)
            const tint = accentOf(e.accent, heat)
            return (
              <div
                key={e.id}
                data-object={e.id}
                onClick={() => send({ op: 'focus', args: { id: e.id } })}
                style={cssv`position:absolute; left:44px; right:0; top:${p.top}px; height:${p.height}px; border-radius:12px; padding:9px 12px; box-sizing:border-box; cursor:pointer; overflow:hidden; display:flex; flex-direction:column; justify-content:center; z-index:2; background:${tint}22; box-shadow:inset 0 0 0 1px ${on ? 'rgba(237,238,241,.5)' : `${tint}4D`};`}
              >
                <div style={css('font-size:13.5px; font-weight:600; letter-spacing:-.015em; color:rgba(237,238,241,.95); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>{e.title}</div>
                <div style={css('margin-top:3px; font-size:11.5px; color:rgba(237,238,241,.5); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>
                  {clockOf(e.start)}{e.end ? `–${clockOf(e.end)}` : ''}{e.location ? ` · ${e.location}` : ''}
                </div>
              </div>
            )
          })}

          {/*
            AN EMPTY DAY IS A DESIGNED STATE, NOT A SENTENCE DROPPED ON THE GRID.

            This was `top:96px` — a constant, which put the line straight through
            the 09:00 rule and left it reading as a label for that hour. 96 was
            never a measurement of anything; it was a number that looked right on
            the day it was written.

            Centred in the grid instead, on its own plate so no rule runs through
            the words, and inert so the empty day is still tappable underneath —
            selecting a free interval is the one thing worth doing on a day with
            nothing in it.
          */}
          {!timed.length && (
            <div style={css('position:absolute; inset:0; display:flex; align-items:center; justify-content:center; pointer-events:none;')}>
              <div style={css('padding:7px 14px; border-radius:999px; background:rgba(20,20,22,.86); font-size:12.5px; color:rgba(237,238,241,.42);')}>
                {allDay.length ? 'Nothing else scheduled.' : 'Nothing scheduled this day.'}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Week and day: real time geometry ─────────────────────────────────────────

function Grid({
  days, events, marks, heat, state, send,
}: {
  days: string[]
  events: CalEvent[]
  marks: { start: string; end: string }[]
  heat: string
  state: ReturnType<typeof useSurface>[0]
  send: ReturnType<typeof useSurface>[1]
}) {
  const shown = new Set(days)
  const timed = events.filter((e) => !e.allDay && shown.has(dayOf(e.start)))
  const allDay = events.filter((e) => e.allDay && shown.has(dayOf(e.start)))

  // The visible hours follow what is actually on: a day whose only event is at
  // 06:30 must not push it off the top of a grid that starts at 08:00.
  const lo = Math.floor(Math.min(MIN_HOUR + 1, ...timed.map((e) => hourFraction(e.start))))
  const hi = Math.ceil(Math.max(MAX_HOUR - 2, ...timed.map((e) => hourFraction(e.end ?? e.start) + (e.end ? 0 : 1))))
  const from = Math.max(0, Math.min(lo, MIN_HOUR))
  const to = Math.min(24, Math.max(hi, MAX_HOUR))
  const hours = Array.from({ length: to - from }, (_, i) => from + i)

  /*
    THE DAY FITS THE BOX IT WAS GIVEN.

    An hour was 34px, always — a constant — so a grid showing eighteen hours
    was 612px tall whatever frame it had been handed. In a 563px frame the
    difference was not a scrollbar, it was 48px of the evening CLIPPED and
    unreachable: the container that cut it had `overflow:hidden`, and the
    scroller above it saw a child that claimed to fit and therefore had nothing
    to scroll. Late events simply did not exist on screen.

    So the hour height comes from the measured box. The day is drawn to the
    frame instead of the frame being asked to accommodate a constant — which is
    the universal fit rule (see fit.tsx) applied to the one renderer that most
    obviously violated it.

    The floor is the point at which an hour row stops being legible. Below it
    the grid keeps that height and SCROLLS, which is honest and reachable —
    unlike clipping, which is neither.
  */
  const now = new Date()
  const nowHour = now.getHours() + now.getMinutes() / 60

  const { ref: gridRef, size } = useMeasured<HTMLDivElement>()
  const hourH = Math.max(MIN_HOUR_H, Math.floor((size.h || hours.length * HOUR_H) / hours.length))
  const height = hours.length * hourH

  const place = (startIso: string, endIso: string | undefined) => {
    const s = hourFraction(startIso)
    const e = endIso ? hourFraction(endIso) : s + 1
    const top = (s - from) * hourH
    return { top, height: Math.max(15, (Math.max(e, s + 0.25) - s) * hourH - 2) }
  }

  return (
    <div style={cssv`height:100%; min-height:0; display:flex; flex-direction:column;
      padding:8px 8px 8px 0; ${CARD} overflow:hidden;`}>
      {days.length > 1 && (
        <div style={css('display:flex; padding-left:30px; margin-bottom:6px;')}>
          {days.map((d) => {
            const isCursor = d === state.cursor
            return (
              <div
                key={d}
                onClick={() => send({ op: 'navigate', args: { date: d } })}
                style={cssv`flex:1; min-width:0; text-align:center; cursor:pointer; padding:3px 0; border-radius:7px; background:rgba(255,255,255,${isCursor ? '.12' : '0'});`}
              >
                <div style={css('font-size:9px; letter-spacing:.05em; color:rgba(237,238,241,.34); text-transform:uppercase;')}>
                  {fromYmd(d).toLocaleDateString(undefined, { weekday: 'narrow' })}
                </div>
                <div style={cssv`font-size:11.5px; font-variant-numeric:tabular-nums; color:rgba(237,238,241,${d === today() ? '.95' : '.6'}); font-weight:${d === today() ? '700' : '400'};`}>
                  {fromYmd(d).getDate()}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {allDay.length > 0 && (
        <div style={css('display:flex; flex-direction:column; gap:3px; margin:0 0 7px 30px;')}>
          {allDay.map((e) => (
            <div
              key={e.id}
              onClick={() => send({ op: 'focus', args: { id: e.id } })}
              style={cssv`padding:3px 7px; border-radius:6px; font-size:10.5px; cursor:pointer; color:#F0D9A6; background:rgba(231,178,76,.1); box-shadow:inset 0 0 0 1px rgba(231,178,76,.26); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`}
            >
              {e.title}
            </div>
          ))}
        </div>
      )}

      {/* The grid's own box. It measures itself, sizes the day to fit, and
          scrolls only in the case where fitting would make an hour illegible. */}
      <div
        ref={gridRef}
        style={css('flex:1; min-height:0; overflow-y:auto; overscroll-behavior:contain; -webkit-overflow-scrolling:touch;')}
      >
      <div style={cssv`position:relative; height:${height}px; display:flex;`}>
        <div style={css('width:30px; flex:none; position:relative;')}>
          {hours.map((h, i) => (
            <div
              key={h}
              /* Nudged up to sit ON its rule rather than under it — but never
                 above the grid's own top, where the first label used to hang
                 5px outside the scroller with no way to scroll to it. */
              style={cssv`position:absolute; top:${Math.max(0, i * hourH - 5)}px; right:6px; font-size:9px; font-variant-numeric:tabular-nums; color:rgba(237,238,241,.28);`}
            >
              {String(h).padStart(2, '0')}
            </div>
          ))}
        </div>

        <div style={css('flex:1; position:relative; min-width:0;')}>
          {hours.map((h, i) => (
            <div key={h} style={cssv`position:absolute; left:0; right:0; top:${i * hourH}px; height:1px; background:rgba(255,255,255,.055);`} />
          ))}

          {/*
            Now, as a line. The single most useful mark on a day view — and only
            when now is actually ON it. The grid shows a window of hours, and at
            06:00 against a window starting at 07:00 this drew the line 181px
            ABOVE the grid: outside the scroller, unreachable, and claiming the
            current time was somewhere it was not. A mark for a moment the grid
            does not cover is not a mark, it is a wrong answer.
          */}
          {days.includes(today()) && nowHour >= from && nowHour <= to && (
            <div style={cssv`position:absolute; left:${(days.indexOf(today()) / days.length) * 100}%; width:${100 / days.length}%; top:${(nowHour - from) * hourH}px; height:1.5px; background:rgba(240,115,107,.75); z-index:3;`} />
          )}

          {marks.map((m, i) => {
            const d = dayOf(m.start)
            const col = days.indexOf(d)
            if (col < 0) return null
            const p = place(m.start, m.end)
            return (
              <div
                key={`m${i}`}
                style={cssv`position:absolute; left:${(col / days.length) * 100}%; width:${100 / days.length}%; top:${p.top}px; height:${p.height}px; border-radius:6px; box-sizing:border-box; border:1px dashed rgba(123,217,184,.7); background:rgba(123,217,184,.10); z-index:1;`}
              />
            )
          })}

          {timed.map((e) => {
            const d = dayOf(e.start)
            const col = Math.max(0, days.indexOf(d))
            const p = place(e.start, e.end)
            const on = state.focus === e.id || state.selected.includes(e.id)
            return (
              <div
                key={e.id}
                data-object={e.id}
                onClick={() => send({ op: 'focus', args: { id: e.id } })}
                /* The same tinted treatment as the day view, so week and day
                   are one calendar rather than two that share a data source.
                   A solid accent block with black text was the only place in
                   the app still drawing an event as a colour swatch. */
                style={cssv`position:absolute; left:calc(${(col / days.length) * 100}% + 1px); width:calc(${100 / days.length}% - 2px); top:${p.top}px; height:${p.height}px; border-radius:6px; padding:2px 4px; box-sizing:border-box; overflow:hidden; cursor:pointer; z-index:2; background:${accentOf(e.accent, heat)}22; box-shadow:inset 0 0 0 1px ${on ? 'rgba(237,238,241,.5)' : `${accentOf(e.accent, heat)}4D`};`}
              >
                <div style={cssv`font-size:${days.length > 1 ? '8.5' : '11'}px; line-height:1.2; font-weight:600; color:rgba(237,238,241,.95); overflow:hidden; text-overflow:ellipsis; ${days.length > 1 ? 'white-space:nowrap;' : ''}`}>
                  {e.title}
                </div>
                {days.length === 1 && (
                  <div style={css('font-size:9.5px; color:rgba(237,238,241,.5); margin-top:1px;')}>
                    {clockOf(e.start)}{e.end ? `–${clockOf(e.end)}` : ''}{e.location ? ` · ${e.location}` : ''}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
      </div>
    </div>
  )
}

// ── The day's events, as rows ────────────────────────────────────────────────

function DayList({
  day, events, heat, state, send,
}: {
  day: string
  events: CalEvent[]
  heat: string
  state: ReturnType<typeof useSurface>[0]
  send: ReturnType<typeof useSurface>[1]
}) {
  if (!events.length) {
    return (
      <div style={cssv`padding:13px; text-align:center; font-size:12px; color:rgba(237,238,241,.35); ${CARD}`}>
        Nothing on {friendlyDate(day)}.
      </div>
    )
  }
  return (
    <div style={css('display:flex; flex-direction:column; gap:6px;')}>
      {[...events].sort((a, b) => a.start.localeCompare(b.start)).map((e) => (
        <div
          key={e.id}
          onClick={() => send({ op: 'focus', args: { id: e.id } })}
          style={cssv`padding:10px 12px; display:flex; gap:10px; align-items:flex-start; cursor:pointer; ${CARD} ${state.focus === e.id ? 'box-shadow:inset 0 0 0 1px rgba(237,238,241,.35);' : ''}`}
        >
          <div style={cssv`flex:none; width:3px; align-self:stretch; min-height:24px; border-radius:999px; background:${accentOf(e.accent, heat)};`} />
          <div style={css('flex:1; min-width:0;')}>
            <div style={css('font-size:13px; font-weight:500; color:rgba(237,238,241,.9);')}>{e.title}</div>
            {e.location && <div style={css('margin-top:2px; font-size:11.5px; color:rgba(237,238,241,.45);')}>{e.location}</div>}
          </div>
          <div style={css('flex:none; font-size:11px; color:rgba(237,238,241,.5); font-variant-numeric:tabular-nums;')}>
            {e.allDay ? 'all day' : clockOf(e.start)}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── One event, opened ────────────────────────────────────────────────────────

function whenOf(event: CalEvent): string {
  return event.allDay
    ? `${friendlyDate(dayOf(event.start))} · all day`
    : `${friendlyDate(dayOf(event.start))} · ${clockOf(event.start)}${event.end ? `–${clockOf(event.end)}` : ''}`
}

/**
 * THE COMPACT EVENT CARD.
 *
 * Everything it shows is a fact he cannot get from the block he tapped — the
 * full title (blocks ellipsise at 8.5px), when, where — and then the things
 * there are to do. Around 100px rather than 70% of the frame, and the calendar
 * behind it stays live: tapping another event switches this card to that event,
 * which is what someone comparing two things is trying to do.
 *
 * The intelligent actions are DELIBERATELY ABSENT unless they are grounded.
 * "Leave by…" is not offered here as a button, because the departure task has
 * prerequisites this card cannot see (§7); asking for it in the conversation
 * runs the real computation, with the real refusal when something is missing. A
 * button that produces a wrong time is worse than no button.
 */
function EventCard({
  event, onAction, onEdit, onClose,
}: {
  event: CalEvent
  onAction: Props['onAction']
  onEdit: () => void
  onClose: () => void
}) {
  return (
    /*
      A SHEET OVER A LIVE CALENDAR — AND IT DOES NOT SCRIM IT.

      The Phase 1 design drew a bottom gradient over the day behind this card.
      It was not taken, and the reason is what the card is FOR: the calendar
      stays live so that tapping another event switches this card to that event,
      which is exactly what someone comparing two things is doing. Dimming the
      thing you are comparing against is a modal pretending to be a sheet.

      Everything else here is the design to the pixel — 20px top corners, the
      rise — with one number changed for where it actually sits. The design's
      78px foot exists to clear a composer drawn inside the same phone frame;
      here the surface frame ENDS above the status row and the composer, so 78px
      of it is dead space at the bottom of the screen rather than clearance. A
      constant copied across a different layout is the same mistake as a constant
      standing in for a measurement.
    */
    <div
      data-role="event-card"
      style={css('position:absolute; left:0; right:0; bottom:0; z-index:9; border-radius:20px 20px 0 0; padding:12px 14px 16px; box-sizing:border-box; background:linear-gradient(180deg, rgba(30,31,36,.99), rgba(20,21,25,.99)); box-shadow:inset 0 1px 0 rgba(255,255,255,.1), 0 -10px 30px rgba(0,0,0,.5); animation:cruRise .22s cubic-bezier(.2,.7,.2,1);')}
    >
      <div style={css('display:flex; align-items:flex-start; gap:10px;')}>
        <div style={css('flex:1; min-width:0;')}>
          {/* The title WRAPS. It is the one string that disambiguates the event,
              and §25 puts it on the never-truncate side of the line. */}
          <div style={css('font-size:17px; font-weight:600; letter-spacing:-.025em; line-height:1.2; text-wrap:pretty;')}>{event.title}</div>
          <div style={css('margin-top:4px; font-size:12.5px; color:rgba(237,238,241,.5);')}>
            {whenOf(event)}{event.location ? ` · ${event.location}` : ''}
          </div>
          {/* Guests are a fact about the event that changes what he does next —
              who else is going is exactly what "ask about a lift" rests on. */}
          {event.attendees?.length ? (
            <div style={cssv`margin-top:4px; font-size:${TYPE.micro}; color:rgba(237,238,241,.38);
              white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`}>
              {event.attendees.slice(0, 4).map((a) => a.name ?? a.email).join(', ')}
            </div>
          ) : null}
        </div>
        <div
          data-role="event-close"
          onClick={onClose}
          style={cssv`flex:none; width:${CHROME.control}px; height:${CHROME.control}px; border-radius:999px;
            display:flex; align-items:center; justify-content:center; cursor:pointer; font-size:13px;
            background:rgba(255,255,255,.06); color:rgba(237,238,241,.66);`}
        >✕</div>
      </div>

      {/*
        ONE GROUNDED LINE, WITH WHAT IT WAS DERIVED FROM.

        Drawn only when the server computed one and only with its grounds
        attached — see `CalEvent.note`. There is deliberately no fallback that
        assembles a sentence out of the fields above: a departure time invented
        from a location is precisely the confident wrong answer this app keeps
        being asked not to give.
      */}
      {event.note?.says && event.note.grounds && (
        <div
          data-role="event-note"
          style={css('margin-top:11px; padding:11px 13px; border-radius:13px; background:rgba(255,255,255,.05); box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);')}
        >
          <div style={css('font-size:13px; line-height:1.5; color:rgba(237,238,241,.82); text-wrap:pretty;')}>{event.note.says}</div>
          <div style={css('margin-top:7px; font-size:10.5px; color:rgba(237,238,241,.34);')}>{event.note.grounds}</div>
        </div>
      )}

      <div style={css('margin-top:12px; display:flex; gap:7px; flex-wrap:wrap;')}>
        <Chip label="Edit" onClick={onEdit} />
        {event.actions?.length ? <Actions actions={event.actions} onAction={onAction} /> : null}
      </div>
    </div>
  )
}

/**
 * THE FOCUSED EVENT EDITOR — the whole frame, and the whole job.
 *
 * What this replaces: the same fields inside a drawer, over a calendar, under a
 * chat panel, each field committing its own write the instant its tick was
 * pressed. Three problems in one: the frame was shared three ways, "save" meant
 * something different per row, and a mis-typed name reached Google before he had
 * finished looking at it.
 *
 * Here the edits are a DRAFT and `Save` is one transition. That is what makes
 * `Cancel` meaningful — there is something to cancel — and it is what lets the
 * write be reported honestly: one action, one result, one failure to show if it
 * fails, with the draft still on screen so nothing he typed is lost.
 */
function EventEditor({
  event, onAction, onDone,
}: {
  event: CalEvent
  onAction: Props['onAction']
  onDone: () => void
}) {
  const [title, setTitle] = useState(event.title)
  const [location, setLocation] = useState(event.location ?? '')
  const [notes, setNotes] = useState(event.description ?? '')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  /*
    Only what actually changed is sent. A `calendar.update` carrying every field
    would overwrite a description someone else edited in Google between the read
    and the save — and the undo record would then restore the version he never
    saw. See `calendarUpdate`, which returns `before` for exactly that undo.
  */
  /*
    AN EVENT WITH NO ID DOES NOT EXIST YET, so saving it is a create.

    This is what makes selecting a free window mean something. `find 30 min`
    drew dashed regions on the grid and the regions had no handler at all — the
    control found the answer and then had nowhere to put it, which is §18's
    wrong-action failure rather than a dead one, and the worse of the two
    because it looks like it worked.

    One editor for both verbs, because they are the same screen with the same
    fields and the same way out; the only thing that differs is whether there is
    something to diff against.
  */
  const creating = !event.id

  const change = {
    ...(title.trim() && title !== event.title ? { summary: title.trim() } : {}),
    ...(location !== (event.location ?? '') ? { location } : {}),
    ...(notes !== (event.description ?? '') ? { description: notes } : {}),
  }
  // A new event needs a name and nothing else; an existing one needs a change.
  const dirty = creating ? !!title.trim() : Object.keys(change).length > 0

  const save = async () => {
    if (!dirty || busy) return onDone()
    setBusy(true)
    setFailed(null)
    try {
      await onAction(
        creating
          ? {
              kind: 'calendar.create',
              label: 'Create',
              params: {
                summary: title.trim(),
                start: event.start,
                ...(event.end ? { end: event.end } : {}),
                ...(location.trim() ? { location: location.trim() } : {}),
              },
            }
          : {
              kind: 'calendar.update',
              label: 'Save',
              params: { eventId: event.id, ...change },
            }
      )
      onDone()
    } catch (e) {
      // Kept open with the draft intact. A failed save that discards what he
      // typed asks him to type it again to find out it still fails.
      setFailed((e as Error).message || 'That didn’t save.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-role="event-editor"
      /* THE MODE CLAIMS THE FRAME, and earns it: ‹ Event, Cancel and Save are
         all inside this element, so nothing here can strand him. See editing.ts. */
      data-mode="frame"
      style={css('flex:1; min-height:0; display:flex; flex-direction:column; gap:10px;')}
    >
      {/*
        ONE HEADER, CARRYING THE TITLE AND BOTH WAYS OUT.

        The design puts Cancel and Save at the top beside the title, and that is
        also the fix for what was here: a back control at the top and a second
        cancel at the bottom, which are the same action twice, eighty pixels
        apart, one of them redundant. `data-role="editor-back"` stays on Cancel
        so `editing.ts` still finds the escape it asserts on.
      */}
      <div style={css('flex:none; display:flex; align-items:center; gap:8px; padding:4px 2px;')}>
        {/* The header names the verb. "Edit event" over an empty form the user
            reached by tapping an empty hour is the screen lying about itself. */}
        <div style={css('font-size:17px; font-weight:600; letter-spacing:-.025em;')}>{creating ? 'New event' : 'Edit event'}</div>
        <div style={css('flex:1;')} />
        <div
          data-role="editor-back"
          onClick={onDone}
          style={css('padding:7px 13px; border-radius:999px; cursor:pointer; font-size:12.5px; background:rgba(255,255,255,.06); box-shadow:inset 0 0 0 1px rgba(255,255,255,.14); color:rgba(237,238,241,.8);')}
        >Cancel</div>
        <div
          data-role="editor-save"
          onClick={() => void save()}
          style={cssv`padding:7px 15px; border-radius:999px; cursor:pointer; font-size:12.5px; font-weight:600; background:rgba(237,238,241,${dirty && !busy ? '.9' : '.35'}); color:#0B0B0D;`}
        >{busy ? (creating ? 'Creating…' : 'Saving…') : creating ? 'Create' : dirty ? 'Save' : 'Saved'}</div>
      </div>

      <div style={css('flex:1; min-height:0; overflow-y:auto; overscroll-behavior:contain; display:flex; flex-direction:column; gap:10px;')}>
        {/*
          THE SLOT HE PICKED, STATED BACK.

          Creating from a tap on the grid means the time is the one thing he did
          NOT type, so it is the one thing the form has to show him — otherwise
          the only way to check what is about to be created is to cancel.
        */}
        {creating && (
          <div style={cssv`font-size:${TYPE.small}; color:rgba(123,217,184,.85);`}>
            {friendlyDate(dayOf(event.start))} · {clockOf(event.start)}{event.end ? `–${clockOf(event.end)}` : ''}
          </div>
        )}
        <Field label="Name" value={title} onChange={setTitle} />
        <Field label="Where" value={location} onChange={setLocation} placeholder="Nowhere in particular" />
        <Field label="Notes" value={notes} onChange={setNotes} placeholder="Nothing written down" multiline />
        {event.organizer && (
          <div style={cssv`font-size:${TYPE.micro}; color:rgba(237,238,241,.34);`}>
            Organised by {event.organizer}
          </div>
        )}
      </div>

      {failed && (
        <div style={cssv`flex:none; font-size:${TYPE.small}; line-height:1.4; color:#F0938B;`}>{failed}</div>
      )}

      <div style={css('flex:none; font-size:11.5px; line-height:1.5; color:rgba(237,238,241,.34); text-wrap:pretty;')}>
        The calendar is gone while you are in here, and the way out is on this screen.
      </div>
    </div>
  )
}

/**
 * One editable field, always open.
 *
 * `EditableRow` is the shared tap-to-edit control and it is the wrong primitive
 * here: it commits per row, which is exactly what this screen exists to stop.
 * In a mode whose entire job is editing, a field that has to be tapped before it
 * can be typed into is a step that buys nothing.
 */
function Field({
  label, value, onChange, placeholder, multiline,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  multiline?: boolean
}) {
  /*
    THE FIELD IS THE ROW, rather than a label above a boxed input.

    The design draws one container per field with the label inside it, which is
    what removes the doubled outline this had: a bordered box under a caption,
    both drawing an edge, for one value. The input keeps no chrome of its own —
    it is transparent and borderless, and the row it sits in is the control.
  */
  const style = css(
    'width:100%; box-sizing:border-box; padding:0; border:0; outline:0; resize:none; background:transparent;' +
    'font-family:inherit; font-size:14px; line-height:1.45; color:rgba(237,238,241,.9);',
  )
  return (
    <div style={css('flex:none; padding:12px 14px; border-radius:15px; background:rgba(255,255,255,.05); box-shadow:inset 0 0 0 1px rgba(255,255,255,.07);')}>
      <div style={css('font-size:11px; color:rgba(237,238,241,.4);')}>{label}</div>
      <div style={css('margin-top:5px;')}>
        {multiline
          ? <textarea data-field={label} value={value} rows={5} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} style={style} />
          : <input data-field={label} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} style={style} />}
      </div>
    </div>
  )
}
