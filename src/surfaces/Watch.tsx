import { useMemo, useState } from 'react'
import { css, cssv } from '../css'
import type { WatchObject, WidgetAction } from '../api'
import { useSurface, useSurfaceState } from '../surface/store'
import type { SurfaceObject } from '../surface/types'
import { Actions, Bar, CARD, Chip, Segments, Toolbar, shortWhen } from './kit'
import { TYPE } from '../tokens'

/**
 * Keep an eye, as an operating console.
 *
 * A standing interest used to be invisible unless it happened to produce
 * something, which meant the two states that matter most looked identical:
 * "watching, checked an hour ago, nothing changed" and "watching, never once
 * managed to run". The first is the system working. The second is a silent
 * failure that could sit there for weeks.
 *
 * So every row states its own operational truth — armed or paused, when it last
 * ran, when it runs next, what it found, and when that answer last CHANGED
 * rather than when it was last looked at. A watch that has never returned
 * anything says exactly that instead of showing a blank where a state would go.
 */

interface Props {
  surfaceKey: string
  title: string
  watches: WatchObject[]
  empty?: string
  onAction: (a: WidgetAction) => Promise<void>
}

const INTERVALS = [1, 6, 12, 24, 72, 168]

const everyLabel = (h: number) =>
  h < 24 ? `every ${h}h` : h === 24 ? 'daily' : h === 168 ? 'weekly' : `every ${Math.round(h / 24)}d`

/** "in 4h", "overdue by 2h", or nothing when there is no next run to speak of. */
function dueIn(iso: string | null | undefined): string {
  if (!iso) return ''
  const ms = Date.parse(iso) - Date.now()
  if (!Number.isFinite(ms)) return ''
  const h = Math.round(Math.abs(ms) / 3_600_000)
  const said = h < 1 ? 'under an hour' : h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
  return ms >= 0 ? `next in ${said}` : `overdue by ${said}`
}

export default function Watch({ surfaceKey, title, watches, empty, onAction }: Props) {
  const [seed] = useState(() => ({ view: 'list' }))
  const pre = useSurfaceState(surfaceKey, 'watch', seed)

  const visible = useMemo(() => {
    const f = pre.filters
    const q = pre.query.trim().toLowerCase()
    return watches.filter((w) => {
      if (f.active === true && !w.active) return false
      if (f.active === false && w.active) return false
      if (f.changed === true && !w.history?.some((h) => h.changed)) return false
      if (typeof f.only === 'string' && !f.only.split(',').includes(w.id)) return false
      if (q && !`${w.what} ${w.why ?? ''} ${w.state ?? ''}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [watches, pre.filters, pre.query])

  const objects: SurfaceObject[] = useMemo(
    () => visible.map((w) => ({ id: w.id, label: w.what, sub: w.state ?? w.why, at: w.lastRunAt ?? undefined })),
    [visible]
  )

  const [state, send] = useSurface(surfaceKey, 'watch', title, objects, seed)

  // No top-level empty return: an empty dashboard is still Keep an eye. The chrome and
  // its controls stay on screen and the emptiness is reported inside them,
  // because a surface that vanishes when it has nothing to show cannot be
  // navigated back to something worth showing.

  const armed = watches.filter((w) => w.active).length
  const never = watches.filter((w) => w.active && !w.lastRunAt).length

  const scope: 'all' | 'active' | 'paused' =
    state.filters.active === true ? 'active' : state.filters.active === false ? 'paused' : 'all'

  /**
   * The one line this surface must never lose.
   *
   * Three separate blocks used to sit between the filters and the first watch:
   * a note, a "never returned anything" warning, and an empty state. Only one
   * of them is ever the most important thing, and the never-ran warning
   * outranks the rest — it is the silent-failure alarm this whole surface
   * exists to make audible.
   */
  /*
    ONE SCHEDULER FAILURE IS ONE SENTENCE.

    When every armed watch is overdue, nothing is wrong with any of them — the
    thing that runs them has stopped. Said here, once, instead of as `overdue by
    9d` repeated down the list.
  */
  const overdue = watches.filter((w) => w.active && w.nextRunAt && Date.parse(w.nextRunAt) < Date.now())
  const stalled = armed > 0 && overdue.length === armed

  const status =
    (never > 0 ? `${never} ${never === 1 ? 'watch has' : 'watches have'} never returned anything yet.` : null)
    ?? (stalled ? `Nothing has been checked when it was due — ${armed === 1 ? 'this watch is' : 'all of these are'} overdue.` : null)
    ?? (!visible.length ? (watches.length ? 'Nothing matches that.' : empty ?? 'Nothing being watched yet.') : null)

  return (
    /*
      THE WHOLE FRAME IS KEEP AN EYE.

      A four-chip filter row, a warning line, a note line and an empty state
      each claimed permanent height above the first watch. Filters collapse to
      one segmented control, the three status blocks collapse to one ranked
      line, and the list gets the rest of the frame.
    */
    <div style={css('position:relative; height:100%; min-height:0; display:flex; flex-direction:column; gap:6px; padding:8px 14px 6px; box-sizing:border-box;')}>
      {/*
        NOTHING TO FILTER MEANS NO FILTERS.

        With no watches at all this drew `All · Armed 0 · Paused · Changed` above
        the sentence "Nothing being watched yet." — four controls partitioning an
        empty set, every one of which does exactly nothing when tapped. §19: a
        control that cannot change what is on screen has not earned its space,
        and here it also makes an empty state look like a failed load.

        The threshold is two, not one: a single watch has nothing to sort into
        piles either.
      */}
      {watches.length > 1 && (
      <Toolbar
        left={
          <>
            <Segments
              value={scope}
              options={[{ v: 'all', label: 'All' }, { v: 'active', label: `Armed ${armed}` }, { v: 'paused', label: 'Paused' }]}
              onChange={(v) => send({ op: 'filter', args: { active: v === 'all' ? null : v === 'active' } })}
            />
          </>
        }
        right={
          <Chip
            label="Changed"
            on={state.filters.changed === true}
            onClick={() => send({ op: 'filter', args: { changed: state.filters.changed === true ? null : true } })}
          />
        }
      />
      )}

      {status && (
        <div style={cssv`flex:none; padding:0 2px; font-size:${TYPE.small}; line-height:1.35; color:rgba(240,165,107,.75); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`}>
          {status}
        </div>
      )}

      {/* THE APPLICATION. */}
      <div style={css('flex:1; min-height:0; overflow-y:auto; overscroll-behavior:contain; -webkit-overflow-scrolling:touch; display:flex; flex-direction:column; gap:5px; padding-bottom:4px;')}>
        {visible.map((w) => {
          const open = state.expanded === w.id
          const changed = w.history?.filter((h) => h.changed).length ?? 0
          return (
            /* `flex:none`: rows in a flex-column scroller are flex items, and
               without it a long list shrinks every row instead of scrolling. */
            <div key={w.id} data-object={w.id} style={cssv`flex:none; ${CARD} overflow:hidden;`}>
              <div
                onClick={() => send({ op: open ? 'collapse' : 'expand', args: { id: w.id } })}
                style={css('padding:8px 10px; display:flex; gap:9px; align-items:flex-start; cursor:pointer;')}
              >
                <div style={cssv`flex:none; width:7px; height:7px; margin-top:5px; border-radius:999px; background:${w.active ? '#5FC9A6' : 'rgba(237,238,241,.25)'}; ${w.active ? 'box-shadow:0 0 7px rgba(95,201,166,.6);' : ''}`} />
                <div style={css('flex:1; min-width:0;')}>
                  <div style={cssv`font-size:${TYPE.body}; font-weight:500; color:rgba(237,238,241,.9); text-wrap:pretty;`}>{w.what}</div>
                  <div style={cssv`margin-top:2px; font-size:${TYPE.small}; line-height:1.4; color:rgba(237,238,241,.55); ${open ? 'text-wrap:pretty;' : 'white-space:nowrap; overflow:hidden; text-overflow:ellipsis;'}`}>
                    {w.state ?? (w.lastRunAt ? 'Checked, nothing came back.' : 'Not checked yet.')}
                  </div>
                  {/*
                    WHAT THE WATCH FOUND — AND NOT HOW THE SCHEDULER IS DOING.

                    Every row carried `every 12h · checked 08-07 · overdue by 9d`.
                    The last of those was on all three rows at once, because it
                    was not three facts about three watches: it was ONE fact
                    about a scheduler that had stopped running, reported as
                    per-row metadata. Reading it there, the natural conclusion is
                    that three separate things are broken.

                    Cadence and last-checked are engine state — true, and no
                    answer to "why should I care about this row". They are in the
                    expansion, beside the other operational facts, where somebody
                    asking about THIS watch will find them. The one thing that
                    stays is what changed, because that is the news the watch
                    exists to produce. The scheduler's own health is now one
                    sentence in the status line above, said once.
                  */}
                  {changed > 0 && (
                    <div style={cssv`margin-top:3px; font-size:${TYPE.micro}; color:rgba(240,165,107,.8); white-space:nowrap; overflow:hidden;`}>
                      {changed} change{changed === 1 ? '' : 's'}
                    </div>
                  )}
                </div>
              </div>

              {open && (
                <div style={css('padding:0 10px 10px 26px; display:flex; flex-direction:column; gap:9px;')}>
                  {/* The operational facts, where somebody asking about this
                      particular watch will look for them. */}
                  <div style={cssv`display:flex; gap:7px; flex-wrap:wrap; font-size:${TYPE.micro}; color:rgba(237,238,241,.3);`}>
                    <div>{w.by === 'agent' ? 'I started this' : 'you started this'}</div>
                    <div>{w.active ? everyLabel(w.everyHours) : 'paused'}</div>
                    <div>{w.lastRunAt ? `checked ${shortWhen(w.lastRunAt)}` : 'never run'}</div>
                    {w.active && w.nextRunAt && <div>{dueIn(w.nextRunAt)}</div>}
                  </div>
                  {w.why && (
                    <div style={css('font-size:11.5px; line-height:1.45; color:rgba(237,238,241,.5);')}>
                      Why: {w.why}
                    </div>
                  )}
                  {w.question && (
                    <div style={css('font-size:11.5px; line-height:1.45; color:rgba(237,238,241,.42); font-style:italic;')}>
                      Asks: “{w.question}”
                    </div>
                  )}

                  {/* The trigger. The only knob a watch has, and it is now a
                      knob rather than a number chosen once at creation. */}
                  <div style={css('display:flex; flex-direction:column; gap:5px;')}>
                    <div style={css('font-size:10.5px; letter-spacing:.05em; text-transform:uppercase; color:rgba(237,238,241,.34);')}>How often</div>
                    <Bar>
                      {INTERVALS.map((h) => (
                        <Chip
                          key={h}
                          label={everyLabel(h)}
                          on={w.everyHours === h}
                          onClick={() => void onAction({ kind: 'track.interval', label: everyLabel(h), params: { id: w.id, everyHours: h } })}
                        />
                      ))}
                    </Bar>
                  </div>

                  {w.history?.length ? (
                    <div style={css('display:flex; flex-direction:column; gap:6px;')}>
                      <div style={css('font-size:10.5px; letter-spacing:.05em; text-transform:uppercase; color:rgba(237,238,241,.34);')}>History</div>
                      {w.history.slice(0, 6).map((h, i) => (
                        <div key={i} style={css('display:flex; gap:8px; align-items:flex-start;')}>
                          <div style={cssv`flex:none; width:5px; height:5px; margin-top:6px; border-radius:999px; background:${h.changed ? 'rgba(240,165,107,.9)' : 'rgba(237,238,241,.22)'};`} />
                          <div style={css('flex:1; min-width:0;')}>
                            <div style={css('font-size:11.5px; line-height:1.45; color:rgba(237,238,241,.66); text-wrap:pretty;')}>{h.text}</div>
                            <div style={css('margin-top:2px; font-size:10px; color:rgba(237,238,241,.3);')}>
                              {shortWhen(h.at)}{h.changed ? ' · changed' : ''}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={css('font-size:11.5px; color:rgba(237,238,241,.35);')}>
                      No checks have returned anything yet.
                    </div>
                  )}

                  {w.actions?.length ? <Actions actions={w.actions} onAction={onAction} /> : null}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
