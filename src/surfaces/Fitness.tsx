import { useMemo, useRef, useState } from 'react'
import { css, cssv } from '../css'
import { accentOf } from '../heat'
import { correct } from '../api'
import type { ActivityBrief, FitnessSeries } from '../api'
import { useSurface, useSurfaceState } from '../surface/store'
import type { SurfaceObject } from '../surface/types'
import { friendlyDate, fromYmd, today, ymd } from '../surface/reducer'
import { CARD, Chip, Segments, Swipe, Toolbar } from './kit'
import { TYPE } from '../tokens'

/**
 * Activity, as something you can interrogate.
 *
 * The chart primitive drew seven bars and a dashed average. It could not answer
 * "compare last month", because it had no notion of a period; it could not
 * answer "open Tuesday", because a bar was not a thing you could point at; and
 * it could not answer "hide sleep", because there was only ever one series.
 * Each of those is a question about the data rather than about the picture,
 * which is why they all needed the state to move up here.
 *
 * The comparison is drawn as ghost bars in the same geometry rather than as a
 * second chart, so "up on last month" is a thing the eye does, not a number the
 * app asserts.
 *
 * WHAT THE CHART WAS STILL MISSING, and what `report` is for.
 *
 * Everything above is about interrogating the DATA, and all of it was true while
 * the surface remained unable to say the one thing he actually opens it for:
 * whether any of this is going the way he wants. Read against his real world model
 * it said "Steps 7-day average 4,385/day" — a number with no meaning attached,
 * because 4,385 is progress for one person and a red flag for another, and the app
 * had a stored goal, a stored source preference and an open source disagreement
 * that no part of this file could see.
 *
 * So the surface now LEADS with the report and the chart sits under it. Five things
 * in order: the trusted current figure (or a refusal, when two sources disagree and
 * he has not ruled), the trend, progress against the goal, what is missing or in
 * dispute, and one next action. None of it is computed here — see `ActivityBrief`
 * for why the arithmetic stays on the server.
 */

interface Props {
  surfaceKey: string
  title: string
  series: FitnessSeries[]
  /** What the numbers mean. Absent on a bare model-authored series. */
  report?: ActivityBrief
  empty?: string
  heat: string
}

const addDays = (day: string, n: number) => {
  const d = fromYmd(day)
  d.setDate(d.getDate() + n)
  return ymd(d)
}

export default function Fitness({ surfaceKey, title, series, report, empty, heat }: Props) {
  /*
    THE WINDOW IS ANCHORED ON THE SERVER'S TODAY, NOT THE BROWSER'S.

    `today()` is `ymd(new Date())` — the device clock — and it was the anchor for
    the whole range, so the seven days this surface drew were the seven days
    ending on whatever day the phone thought it was. Against a server whose
    readings ended earlier, that window contained none of them: the chart drew
    seven dashed outlines and said "7 days missing, not zero" while the Home
    widget, projected from the same series, showed six real bars. Two depths of
    one domain contradicting each other about the same week — which is exactly
    what §10 and `clock.ts` exist to stop, and it had simply not been applied
    here.

    `freshness.today` is the brief's own answer to which date is today, decided
    where the timezone lives. Falling back to the newest day the series actually
    carries keeps a bare series (no report) working, and falling back to the
    device clock is the last resort rather than the default.
  */
  const anchor =
    report?.freshness.today
    ?? series.flatMap((s) => s.days.map((d) => d.date)).sort().at(-1)
    ?? today()

  const [seed] = useState(() => ({ view: 'week', cursor: anchor }))
  const pre = useSurfaceState(surfaceKey, 'fitness', seed)

  const span = pre.view === 'month' ? 30 : 7
  const end = pre.range?.to ?? pre.cursor ?? anchor
  const start = pre.range?.from ?? addDays(end, -(span - 1))

  const dates = useMemo(() => {
    const out: string[] = []
    for (let d = start; d <= end; d = addDays(d, 1)) out.push(d)
    // A range he asked for could be any length; bound it so a mistyped year
    // cannot try to render forty thousand bars.
    return out.slice(-92)
  }, [start, end])

  const objects: SurfaceObject[] = useMemo(
    () => dates.map((d) => ({
      id: d,
      label: fromYmd(d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' }),
      sub: series
        .map((s) => {
          const v = s.days.find((x) => x.date === d)?.value
          // `null` and `undefined` are both "nothing recorded" and both must
          // publish as nothing, so that "why was Monday low?" cannot be answered
          // about a day that has no reading at all.
          return v === undefined || v === null ? null : `${s.label} ${Math.round(v).toLocaleString()}`
        })
        .filter(Boolean)
        .join(' · '),
      at: d,
    })),
    [dates, series]
  )

  const [state, send] = useSurface(surfaceKey, 'fitness', title, objects, seed)
  /** The window chooser, revealed by the range label rather than always resident. */
  const [picking, setPicking] = useState(false)

  // No top-level empty return: an empty chart is still Fitness. The chrome and
  // its controls stay on screen and the emptiness is reported inside them,
  // because a surface that vanishes when it has nothing to show cannot be
  // navigated back to something worth showing.

  const shown = series.filter((s) => !state.hidden.includes(s.key))

  /**
   * How much of the visible window any series actually covers.
   *
   * A day counts as covered if ANY shown series has a value for it — a step
   * count missing while sleep is present is a gap in one series, not a gap in
   * the record. `last` is the most recent day with anything at all, which is
   * the fact that turns "four blank bars" into something he can act on.
   */
  const coverage = useMemo(() => {
    const has = (d: string) => shown.some((s) => s.days.some((x) => x.date === d && x.value !== undefined && x.value !== null))
    const covered = dates.filter(has)
    return { missing: dates.length - covered.length, last: covered[covered.length - 1] ?? null }
  }, [dates, shown])

  const rangeLabel = dates.length
    ? `${friendlyDate(dates[0]!)} – ${friendlyDate(dates[dates.length - 1]!)}`
    : ''

  return (
    /*
      THE WHOLE FRAME IS ACTIVITY.

      Two full-width chip rows opened this surface — week/month, three
      navigation chips and a compare toggle on the first, then one chip per
      series on the second — followed by a note line, before a single bar was
      drawn. That is roughly a third of the frame spent restating what the
      chart's own axis already says. It is now one toolbar: period and range on
      the left, navigation on the right, series and compare behind the
      overflow. The charts get everything else and scroll internally.
    */
    <div style={css('position:relative; height:100%; min-height:0; display:flex; flex-direction:column; gap:6px; padding:8px 14px 6px; box-sizing:border-box;')}>
      {/*
        ONE PERMANENT CONTROL, and it is the range.

        The screenshot in the handoff shows, above one chart: a W/M segment, a
        date range, a previous button, a today button, a next button, an overflow
        button, a summary card, a warning line, a second Steps panel, an average
        tile and a total tile. §11 calls that control soup and it is. Paging is a
        swipe, the window is behind a tap on the label that names it, and Today
        exists only while he is not on today.
      */}
      <Toolbar
        left={
          <>
            <div
              data-role="range"
              onClick={() => setPicking((v) => !v)}
              style={cssv`min-width:0; padding:4px 9px; border-radius:999px; cursor:pointer;
                background:rgba(255,255,255,${picking ? '.12' : '.05'});
                font-size:12.5px; font-weight:600; letter-spacing:-.01em; color:rgba(237,238,241,.9);
                white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`}
            >
              {rangeLabel}
            </div>
            {end !== anchor && (
              <Chip label="Today" onClick={() => send({ op: 'navigate', args: { to: 'today' } })} />
            )}
          </>
        }
        more={
          <>
            <Chip
              label="vs previous"
              on={state.compare === 'previous'}
              onClick={() => send({ op: 'compare', args: { key: state.compare === 'previous' ? null : 'previous' } })}
            />
            {series.length > 1 && series.map((s) => (
              <Chip
                key={s.key}
                label={s.label}
                on={!state.hidden.includes(s.key)}
                dim
                onClick={() => send({ op: 'toggleSeries', args: { key: s.key, on: state.hidden.includes(s.key) } })}
              />
            ))}
          </>
        }
      />

      {picking && (
        <div style={css('flex:none;')}>
          <Segments
            value={state.view as 'week' | 'month'}
            options={[{ v: 'week', label: 'Last 7 days' }, { v: 'month', label: 'Last 30 days' }]}
            onChange={(v) => { send({ op: 'setView', args: { view: v } }); setPicking(false) }}
          />
        </div>
      )}

      {/* WHAT THE NUMBERS MEAN, above the picture of them. */}
      {report && <Report r={report} />}

      {/*
        WHERE THE DATA ACTUALLY STOPS.

        A day with no steps and a day the connector never delivered are drawn
        the same way — a 3px grey stub — and they mean opposite things. On the
        window that matters most, the one ending today, that is the difference
        between "you barely moved" and "this has not synced since Friday", and
        the surface said neither: it drew four grey stubs and no explanation.

        So the gap is named, in the terms the data supports: the last day
        anything was recorded, and how many days of the visible window have
        nothing. It is a statement about COVERAGE, not about him — the surface
        does not know why the days are missing, and does not guess.
      */}
      {!shown.length ? (
        <div style={cssv`flex:none; padding:0 2px; font-size:${TYPE.small}; line-height:1.35; color:rgba(240,165,107,.7); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`}>
          {series.length ? 'Every series is hidden.' : empty ?? 'Nothing recorded yet.'}
        </div>
      ) : /*
           SAID ONCE.

           The report band above states the gap in the metric's terms ("nothing since
           the 7th — 4 days with no reading"), and this line states it in the chart's
           ("no data since Friday — 4 of 7 days missing"). Both are true and printing
           both put two amber warnings about one fact directly above each other, which
           is a third of the frame spent saying the same thing twice — the exact
           complaint the toolbar rewrite was about. The report wins when it is present
           because it counts against the metric rather than against whichever window
           the chart happens to be showing.
         */
        (report?.gap.staleDays ?? 0) >= 2 ? null : coverage.missing > 0 ? (
        <div
          data-role="coverage"
          /* Two lines, clamped. On one nowrap line the sentence ellipsised at
             "…days are missing," and ate "not zero" — which is the entire
             point of saying it. The same mistake as the location banner: the
             half he can act on is the half that gets cut. */
          style={cssv`flex:none; padding:0 2px; font-size:${TYPE.small}; line-height:1.35; color:rgba(240,165,107,.7); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;`}
        >
          {coverage.last
            ? `No data since ${friendlyDate(coverage.last)} — ${coverage.missing} of ${dates.length} days missing, not zero.`
            : `No data in this window — ${dates.length} days missing, not zero.`}
        </div>
      ) : null}

      {/* THE APPLICATION — one chart, and the gesture that moves it through time. */}
      <Swipe
        onNext={() => send({ op: 'navigate', args: { to: 'next' } })}
        onPrev={() => send({ op: 'navigate', args: { to: 'prev' } })}
      >
        <div style={css('height:100%; min-height:0; display:flex; flex-direction:column; gap:7px; padding-bottom:4px;')}>
          {shown.map((s) => (
            <Series
              key={s.key}
              s={s}
              dates={dates}
              span={span}
              compare={state.compare === 'previous'}
              focus={state.focus}
              heat={heat}
              only={shown.length === 1}
              onPick={(d) => send({ op: 'focus', args: { id: d } })}
            />
          ))}
        </div>
      </Swipe>
    </div>
  )
}

/**
 * THE STATE OF THIS METRIC, AS A BAND ABOVE THE CHART.
 *
 * Reads the server's report and renders nothing of its own — no averages
 * recomputed, no percentages derived, no fallback to "the latest number we have"
 * when the trusted figure is absent. That restraint is the feature: the surface
 * used to compute its own average from whatever series it was handed, which is how
 * it could disagree with the Home row about the same seven days.
 *
 * Laid out as three rows that each earn their space:
 *
 *   · the figure, or the reason there is not one;
 *   · the goal, as a bar — but only when the goal HAS a direction that a bar can
 *     honestly represent, which 'steady' does not;
 *   · what is wrong and the one thing to do about it.
 *
 * Anything with nothing to say is absent rather than showing a zero or an em dash.
 */
function Report({ r }: { r: ActivityBrief }) {
  const [said, setSaid] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const act = async () => {
    setBusy(true)
    try {
      if (r.next.does === 'choose-source') {
        /**
         * The FIRST readable option, not a hardcoded vendor.
         *
         * The server computed which sources actually reported this metric; offering
         * "Apple Health" on a device that has never reported one is the mistake
         * `optionsFor` was written to avoid, and it would be just as wrong here.
         */
        const pick = (r.next.options ?? []).find((s) => s !== r.source.id)
        if (!pick) return setSaid('There is no other source to switch to.')
        const out = await correct({ verb: 'prefer-source', label: `Use ${pick}`, metric: r.metric, source: pick })
        setSaid(out.said)
      } else if (r.next.does === 'enter-reading') {
        /**
         * Deliberately NOT a silent write of a guessed number. It records that he
         * has nothing to report for today, which is a fact, and is different from
         * the app inventing one.
         */
        setSaid('Tell me the figure in chat and I will put it on the record beside what Fit says.')
      } else if (r.next.does === 'set-goal') {
        setSaid('Tell me what you are after in chat — "walk 8,000 a day" is enough — and I will measure against it.')
      } else {
        setSaid(r.next.detail)
      }
    } finally {
      setBusy(false)
    }
  }

  const disputed = r.source.by === 'disputed'
  /**
   * IS THE NUMBER ON SCREEN ABOUT NOW?
   *
   * Read off the server's `freshness` rather than compared here. The surface
   * used to ask `r.current.day !== today()`, which meant the browser's idea of
   * today — the one thing `clock.ts` exists to stop anything doing, and wrong by
   * a whole day for anyone whose zone is not the runtime's.
   */
  const stale = !!r.current && !disputed && !r.current.isToday
  const trendWord =
    r.trend.direction === 'up' ? '▲' : r.trend.direction === 'down' ? '▼' : r.trend.direction === 'flat' ? '=' : ''

  return (
    <div style={cssv`flex:none; padding:9px 11px 8px; display:flex; flex-direction:column; gap:7px; ${CARD}`}>
      {/*
        ROW 0 — HOW OLD THIS IS, WHEN IT IS OLD.

        Above the number rather than beside it, and dimming the number rather
        than annotating it. The previous version appended "· Fri 7 Aug" to a
        26px figure, which is true and is not enough: the eye reads the big
        number first and the qualifier second, so a four-day-old count still
        landed as "today". Staleness is not a footnote on a figure. When the
        feed has stopped, it is the most important thing on the surface, and it
        gets the position and the colour that says so.
      */}
      {stale && (
        <div
          data-role="staleness"
          style={cssv`display:flex; align-items:center; gap:6px; font-size:${TYPE.small}; font-weight:600;
            letter-spacing:.06em; text-transform:uppercase;
            color:${r.freshness.level === 'stale' ? 'rgba(240,165,107,.92)' : 'rgba(237,238,241,.5)'};`}
        >
          <div style={cssv`width:5px; height:5px; flex:none; border-radius:999px;
            background:${r.freshness.level === 'stale' ? '#F0A56B' : 'rgba(237,238,241,.4)'};`} />
          {r.freshness.level === 'stale'
            ? `${r.freshness.staleDays} days behind`
            : 'not today’s figure'}
        </div>
      )}

      {/* ROW 1 — the figure, or an honest refusal in its place. */}
      <div style={css('display:flex; align-items:baseline; gap:9px; min-width:0;')}>
        {r.current && !disputed ? (
          <>
            {/*
              THE FIGURE FADES WHEN IT IS NOT ABOUT NOW.

              Opacity is doing real work here, not styling: a full-strength 26px
              number is a claim about the present, and this one is not one. Read
              together with the row above, a dimmed figure and the day it belongs
              to cannot be mistaken for today's count.
            */}
            <div style={cssv`flex:none; font-size:26px; font-weight:650; letter-spacing:-.02em;
              color:rgba(237,238,241,${stale ? '.62' : '.96'});`}>
              {r.current.value.toLocaleString()}
            </div>
            <div style={cssv`flex:none; font-size:${TYPE.small}; color:rgba(237,238,241,.5);`}>
              {r.unit ?? r.metric}
              {r.current.isToday ? '' : ` · ${friendlyDate(r.current.day)}`}
            </div>
          </>
        ) : (
          <div
            data-role="no-figure"
            style={cssv`flex:1; min-width:0; font-size:13px; line-height:1.35; color:rgba(240,165,107,.85);`}
          >
            {/* No number at all, on purpose. See `ActivityBrief.current`. */}
            {disputed ? 'No single figure — your sources disagree.' : (r.source.why ?? 'Nothing recorded.')}
          </div>
        )}
        {r.trend.average !== null && !disputed && (
          <div style={cssv`flex:1; min-width:0; text-align:right; font-size:${TYPE.small}; color:rgba(237,238,241,.55); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`}>
            {/* The denominator is named whenever it is smaller than the window —
                an average over 3 of 7 days presented as a weekly figure is the
                commonest way a health chart lies. */}
            {trendWord} {r.trend.average.toLocaleString()} avg
            {r.trend.covered < r.trend.windowDays ? ` · ${r.trend.covered}/${r.trend.windowDays} days` : ''}
            {r.trend.changePercent !== null ? ` · ${r.trend.changePercent > 0 ? '+' : ''}${r.trend.changePercent}%` : ''}
          </div>
        )}
      </div>

      {/* ROW 2 — the goal. */}
      {r.goal ? (
        <div style={css('display:flex; flex-direction:column; gap:5px;')}>
          <div style={cssv`display:flex; gap:8px; align-items:baseline; font-size:${TYPE.small}; color:rgba(237,238,241,.7);`}>
            <div style={css('flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>
              {r.goal.description}
              {r.goal.timeframe ? ` · ${r.goal.timeframe}` : ''}
            </div>
            <div style={cssv`flex:none; color:${r.goal.met ? '#8FE0AE' : 'rgba(237,238,241,.7)'};`}>
              {Math.round(r.goal.current).toLocaleString()} / {r.goal.target.toLocaleString()}
            </div>
          </div>
          {/* A 'steady' goal gets NO BAR. There is no honest way to draw
              "keep it about here" as progress, and a bar implies a finish line
              that does not exist. */}
          {r.goal.fraction !== null && (
            <div style={css('height:5px; border-radius:3px; background:rgba(255,255,255,.07); overflow:hidden;')}>
              <div
                data-role="goal-bar"
                style={cssv`height:100%; width:${Math.round(r.goal.fraction * 100)}%; border-radius:3px; background:${r.goal.met ? '#8FE0AE' : '#C6D2A8'};`}
              />
            </div>
          )}
        </div>
      ) : (
        <div style={cssv`font-size:${TYPE.small}; line-height:1.35; color:rgba(237,238,241,.55);`}>
          {/* The state his account was actually in: real numbers, no goal, so the
              app declines to call them good or bad. */}
          I do not know what you are aiming for, so I will not call this good or bad.
        </div>
      )}

      {/* ROW 3 — what is wrong, and the one thing to do. */}
      {(r.gap.staleDays >= 2 || disputed || !r.source.canSupportGoal || r.conflicts.length > 0) && (
        <div style={cssv`font-size:${TYPE.small}; line-height:1.35; color:rgba(240,165,107,.75); display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden;`}>
          {r.conflicts.length
            ? r.conflicts
                .map((c) => `${c.readings.map((x) => `${x.source} says ${x.value.toLocaleString()}`).join(' vs ')} for ${c.scope} — ${c.differencePercent}% apart`)
                .join('; ')
            : r.gap.staleDays >= 2
              // `lastDayLabel`, not `lastDay`. This printed "Nothing since
              // 2026-08-07" — an ISO date on a screen where every other date
              // comes out of clock.ts's vocabulary.
              ? `Nothing since ${r.gap.lastDayLabel} — ${r.gap.staleDays} days with no reading, which is a gap in the feed rather than ${r.gap.staleDays} days of sitting still.`
              : (r.source.why ?? '')}
        </div>
      )}

      {said ? (
        <div style={cssv`font-size:${TYPE.small}; line-height:1.35; color:rgba(143,224,174,.85);`}>{said}</div>
      ) : (
        r.next.does !== 'nothing' && (
          <div style={css('display:flex; gap:6px; flex-wrap:wrap;')}>
            <Chip label={busy ? 'Working…' : r.next.label} on onClick={act} />
            <div style={cssv`flex:1; min-width:0; align-self:center; font-size:${TYPE.small}; color:rgba(237,238,241,.4); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`}>
              {r.next.detail}
            </div>
          </div>
        )
      )}
    </div>
  )
}

function Series({
  s, dates, span, compare, focus, heat, only, onPick,
}: {
  s: FitnessSeries
  dates: string[]
  span: number
  compare: boolean
  focus: string | null
  heat: string
  /** The sole visible series takes the whole frame; two share it. */
  only: boolean
  onPick: (date: string) => void
}) {
  /**
   * A DAY'S READING, WITH ITS ABSENCE PRESERVED.
   *
   * `undefined` (outside the delivered window) and `null` (delivered as nothing)
   * are both "no reading" here; what matters is that neither becomes 0. The bug
   * §35 names is one line long and this is the line: a chart that reads a missing
   * day as zero states that he did not move.
   */
  const value = (d: string): number | null => {
    const hit = s.days.find((x) => x.date === d)
    return hit?.value ?? null
  }
  const values = dates.map(value)
  const present = values.filter((v): v is number => v !== null)

  const prior = compare ? dates.map((d) => value(addDays(d, -span))) : []
  const max = Math.max(1, ...present, ...prior.filter((v): v is number => v !== null))

  const avg = present.length ? Math.round(present.reduce((a, b) => a + b, 0) / present.length) : 0

  const colour = accentOf(s.accent, heat)
  const picked = focus && dates.includes(focus) ? focus : null
  const pickedValue = picked ? value(picked) : null

  /**
   * SCRUBBING, rather than a control for choosing a day.
   *
   * The chart could be tapped, one bar at a time, and that is the interaction a
   * mouse has. On a phone the natural motion is to put a thumb on the chart and
   * move it, reading values as they pass — which is also the only way to inspect
   * a thirty-day chart whose bars are four pixels wide.
   *
   * The day is computed from the X POSITION over the whole plot rather than from
   * which element the finger is over, because at that width the gaps between
   * bars are a meaningful share of the row and a scrub that goes dead between
   * bars reads as a broken chart.
   */
  const plot = useRef<HTMLDivElement>(null)
  const scrubbing = useRef(false)
  const scrubTo = (clientX: number) => {
    const box = plot.current?.getBoundingClientRect()
    if (!box || !dates.length) return
    const t = Math.min(0.9999, Math.max(0, (clientX - box.left) / Math.max(1, box.width)))
    const d = dates[Math.floor(t * dates.length)]
    if (d && d !== picked) onPick(d)
  }

  return (
    <div style={cssv`flex:${only ? '1' : 'none'}; min-height:0; padding:10px 11px 8px; display:flex; flex-direction:column; gap:8px; ${CARD}`}>
      {/*
        THE READOUT. One line, always present, and it is the only place a
        per-day figure appears.

        What this replaces: an Average tile, a Total tile and a vs-previous tile
        sitting between the heading and the chart — three numbers derived from
        the same seven bars directly above the seven bars, which §14 is precisely
        about. The average is already stated once, by the report band above,
        which computes it from the same source the chart is drawn from. Saying it
        again here made two claims that could only ever agree by luck.
      */}
      <div style={css('display:flex; align-items:baseline; gap:8px;')}>
        <div style={css('flex:none; font-size:12px; font-weight:600; color:rgba(237,238,241,.85);')}>{s.label}</div>
        <div
          data-role="readout"
          style={cssv`flex:1; min-width:0; text-align:right; font-size:${TYPE.small};
            color:rgba(237,238,241,${picked ? '.75' : '.34'}); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`}
        >
          {picked
            ? `${friendlyDate(picked)} — ${
                pickedValue === null
                  ? 'no reading'
                  : `${Math.round(pickedValue).toLocaleString()} ${s.unit ?? ''}`.trim()
              }${s.source ? ` · ${s.source.id}` : ''}`
            : 'drag across the chart'}
        </div>
      </div>

      {/* The chart takes whatever the card has left rather than a fixed 92px,
          so a single series fills the frame instead of leaving a dead band. */}
      <div
        ref={plot}
        data-role="chart"
        onPointerDown={(e) => {
          scrubbing.current = true
          try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId) } catch { /* not tracked */ }
          scrubTo(e.clientX)
        }}
        onPointerMove={(e) => { if (scrubbing.current) scrubTo(e.clientX) }}
        onPointerUp={() => { scrubbing.current = false }}
        onPointerCancel={() => { scrubbing.current = false }}
        style={cssv`position:relative; flex:${only ? '1' : 'none'}; min-height:${only ? '70px' : '84px'};
          ${only ? '' : 'height:84px;'} display:flex; align-items:flex-end; gap:${dates.length > 14 ? '2' : '5'}px;
          touch-action:pan-y; cursor:crosshair;`}
      >
        {/* His own average, as the reference line. Not a number from a magazine. */}
        {avg > 0 && (
          <div style={cssv`position:absolute; left:0; right:0; bottom:${(avg / max) * 100}%; height:0; border-top:1px dashed rgba(237,238,241,.26); pointer-events:none;`} />
        )}
        {dates.map((d, i) => {
          const v = values[i]
          const p = prior[i]
          const on = picked === d
          return (
            <div
              key={d}
              /* `pointer-events:none` on the children: the whole plot is one
                 scrub target, and a per-bar hit test is what made the gaps dead. */
              style={css('flex:1; min-width:0; height:100%; display:flex; align-items:flex-end; justify-content:center; position:relative; pointer-events:none;')}
            >
              {p !== null && p !== undefined && (
                <div style={cssv`position:absolute; bottom:0; left:0; right:0; height:${Math.max(1, (p / max) * 100)}%; border-radius:4px 4px 2px 2px; background:rgba(237,238,241,.13);`} />
              )}

              {/*
                THREE STATES, THREE PICTURES. §35.

                  missing — a hollow dashed outline, full height. It reads as an
                            empty slot, which is what it is: nobody said.
                  zero    — a solid 3px nub in the series colour, sitting ON the
                            baseline. A real reading of nothing.
                  value   — the bar.

                The old code drew missing as a 3px grey stub and zero as a 2px
                coloured stub. Two pixels and a shade apart, for two facts that
                mean opposite things.
              */}
              {v === null ? (
                <div
                  data-day={d}
                  data-state="missing"
                  style={css('position:relative; width:100%; height:100%; border-radius:4px; box-sizing:border-box; border:1px dashed rgba(237,238,241,.16); background:transparent;')}
                />
              ) : (
                <div
                  data-day={d}
                  data-state={v === 0 ? 'zero' : 'value'}
                  style={cssv`position:relative; width:100%; border-radius:4px 4px 2px 2px; background:${colour};
                    opacity:${on ? '1' : '.8'};
                    height:${v === 0 ? '3px' : `${Math.max(2, (v / max) * 100)}%`};
                    box-shadow:${on ? '0 0 0 1.5px rgba(237,238,241,.85)' : 'none'};`}
                />
              )}
            </div>
          )
        })}
      </div>

      <div style={css('flex:none; display:flex; gap:4px;')}>
        {dates.map((d, i) => (
          <div key={d} style={cssv`flex:1; min-width:0; text-align:center; font-size:9px; color:rgba(237,238,241,${picked === d ? '.75' : '.34'}); overflow:hidden; white-space:nowrap;`}>
            {dates.length > 14 ? (i % 5 === 0 ? fromYmd(d).getDate() : '') : fromYmd(d).toLocaleDateString(undefined, { weekday: 'narrow' })}
          </div>
        ))}
      </div>
    </div>
  )
}
