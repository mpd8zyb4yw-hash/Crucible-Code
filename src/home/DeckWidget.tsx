import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { css, cssv } from '../css'
import { GESTURE } from '../tokens'
import type { DeckChip, DeckRow, DeckWidget as W } from '../api'

/**
 * ONE DOMAIN, DRAWN AS A PICTURE.
 *
 * Eight renderings, and they are the Phase 1 design's declarations pasted
 * through `css()` rather than retyped — a transcription slip in a gradient or a
 * box-shadow is invisible in review and visible on the screen. Every number
 * here came from the design doc; none of them was chosen in this file.
 *
 * WHAT LEFT THESE CARDS, AND WHY IT IS NOT COMING BACK. The date, the day name,
 * the clock, the town, the "as of" stamp and every source label. The phone
 * already says the time and the widget already says which domain it is. What
 * replaced them is picture — thumbnails, bars, a route, depletion, a runway —
 * and prose survives in exactly one place, `foot`, for the cases where a number
 * cannot carry the meaning.
 *
 * TWO OF THE EIGHT DRAW NOTHING TODAY. `runway` and `drift` are Money and Sleep,
 * which have no connector, no observations and no capability. They are written
 * because the design specifies them and because writing them is how the shape is
 * agreed before there is data to argue about — but nothing constructs them, and
 * `server/deck.ts` has no branch that can. A widget of invented numbers would be
 * worse here than anywhere else in the app, because the deck is now the
 * navigation: it would be a lie you have to swipe through.
 */

/** The card's own box. Identical for all eight; only the picture inside differs. */
export const CARD_H = 340

/**
 * Renderings whose picture absorbs the card's leftover height.
 *
 * The day strip and the map are both better the taller they are — an hour axis
 * with more room separates two adjacent meetings, and a map with more room
 * shows more ground. Everything else is a fixed stack and yields its remainder
 * to the spacer.
 */
const GROWS = new Set<W['render']>(['cal', 'places', 'stock', 'video', 'bars'])

/**
 * THE WHOLE CARD IS THE WAY IN.
 *
 * It used to be the 20px header row and nothing else, which is what he meant by
 * "only clickable at the top thin region". Two of the six domains — Activity and
 * Places — had no other handler anywhere on them, so 320 of their 340 pixels
 * were inert: a picture of a chart that could not be touched, above a name that
 * could.
 *
 * So the tap moves to the card, and everything inside it that has a destination
 * of its own stops the event. The order matters and is the whole rule: a row
 * opens ITS object, a chip runs ITS capability, and anything with neither opens
 * the application. There is no longer any part of a widget that does nothing.
 *
 * WHICH DOES NOT MEAN EVERYTHING IS A LINK. `data-pannable` regions — the chart,
 * the map — handle their own fingers first and only fall through to this when
 * the gesture turned out to be a tap. That is what makes a widget usable
 * WITHOUT opening it, which is the other half of what he asked for.
 */
export function DeckWidgetCard({
  w, showing = true, onOpen, onOpenObject, onChip,
}: {
  w: W
  /**
   * This is the slide in front, as opposed to the deck's mounted neighbours.
   *
   * In-place interaction is only offered by the card he can actually reach:
   * a scrub state on an off-screen slide would be a readout nobody asked for,
   * still showing Tuesday when he swipes back to it a minute later.
   */
  showing?: boolean
  onOpen: (navId: string) => void
  onOpenObject: (navId: string, objectId: string) => void
  onChip: (c: DeckChip) => void
}) {
  /*
    A DOMAIN WITH NOTHING TO SHOW COLLAPSES.

    This is the contract's own rule — an empty region is a compact unboxed row,
    never a bordered card-sized one — arriving in the deck, which was built
    without it. On his real account three of the six widgets were a filled 340px
    rectangle containing a single word: "clear", "nothing new", "Nowhere with
    coordinates yet". More than half of Home was black boxes to swipe past, and
    a box is a promise that something is in it.

    The slide keeps its height, because deck geometry is fixed and a card that
    sized itself to its content would break the snap. What goes is the CARD: no
    fill, no rounded surface, no 340px of nothing. What is left is the domain's
    name, one true line, and the one action worth offering — and the space reads
    as space rather than as a widget that failed to load.
  */
  if (w.quiet) {
    return (
      <div
        data-deck-widget={w.id}
        data-quiet=""
        data-hot={w.hot ? '' : undefined}
        onClick={() => onOpen(w.id)}
        style={cssv`height:${CARD_H}px; box-sizing:border-box; padding:15px 4px 14px; display:flex; flex-direction:column; cursor:pointer;`}
      >
        <div style={css('flex:none; display:flex; align-items:baseline; gap:8px;')}>
          <div style={css('flex:0 1 auto; min-width:0; font-size:13px; font-weight:600; letter-spacing:-.01em; color:rgba(237,238,241,.5); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>{w.name}</div>
          <div style={css('flex:1 0 8px;')} />
          <div style={css('font-size:11px; color:rgba(237,238,241,.26); white-space:nowrap;')}>{w.meta}</div>
        </div>

        {/* The one true line. `foot` when the projection had something to say,
            `mini.line` otherwise — both are written on the server, and neither
            is invented here to fill the space. */}
        <div style={css('flex:none; margin-top:7px; font-size:13.5px; line-height:1.4; color:rgba(237,238,241,.34); text-wrap:pretty;')}>
          {w.foot || w.mini.line}
        </div>

        {w.chips.length > 0 && (
          <div style={css('flex:none; margin-top:12px; display:flex; gap:7px;')}>
            {w.chips.map((c, i) => (
              <div
                key={i}
                data-role="deck-chip"
                onClick={(e) => { e.stopPropagation(); onChip(c) }}
                style={css('padding:7px 13px; border-radius:999px; cursor:pointer; font-size:12.5px; white-space:nowrap; background:rgba(255,255,255,.06); color:rgba(237,238,241,.7);')}
              >{c.label}</div>
            ))}
          </div>
        )}

        {/* Deliberately no filler below. The rest of the slide is background. */}
        <div style={css('flex:1; min-height:0;')} />
      </div>
    )
  }

  return (
    <div
      data-deck-widget={w.id}
      data-hot={w.hot ? '' : undefined}
      /* `data-preview` / `data-preview-row` keep the "Home is not titles on a
         black field" assertion alive against the deck. It is the one check that
         cannot be made geometrically — an empty card and a full one are the
         same rectangle — so the markers move with the design. */
      data-preview=""
      onClick={() => onOpen(w.id)}
      style={cssv`height:${CARD_H}px; box-sizing:border-box; border-radius:24px; padding:15px 15px 14px; overflow:hidden; display:flex; flex-direction:column; cursor:pointer; background:${w.hot ? 'rgba(231,178,76,.065)' : 'rgba(255,255,255,.05)'};`}
    >
      {/*
        The name is the widget's only label. It is no longer also the only way
        in — the card is — so there is still no "open" affordance, because a
        chevron on every card is six chevrons saying the same thing.
      */}
      <div style={css('flex:none; display:flex; align-items:center; gap:8px;')}>
        {/*
          THE NAME IS ONE LINE. It is a domain name in every real case, and the
          long-title capture is what proved that "in every real case" is not an
          argument: a long name wrapped to three lines, made the header 48px
          instead of 20, and pushed the fourth row 27px out of the card. Rung 4
          of the overflow ladder, applied where it was missing.
        */}
        <div style={css('flex:0 1 auto; min-width:0; font-size:13px; font-weight:600; letter-spacing:-.01em; color:rgba(237,238,241,.82); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>{w.name}</div>
        <div style={css('flex:1 0 8px;')} />
        <div style={css('font-size:11px; color:rgba(237,238,241,.32); white-space:nowrap;')}>{w.meta}</div>
      </div>

      <Picture w={w} showing={showing} onOpenObject={onOpenObject} />

      {/*
        THE SPACER IS FOR PICTURES THAT DO NOT GROW.

        Calendar's strip and the Places map take whatever the card has left, so
        for those two a second `flex:1` here would split the remaining space in
        half and hand a quarter of the widget back to the void — which is the
        bug this spacer was introduced to fix, reintroduced from the other side.
      */}
      {!GROWS.has(w.render) && <div style={css('flex:1; min-height:4px;')} />}

      {w.foot && (
        /* `margin-top` rather than a gap on the column: a picture that grows
           runs right up to this line, and without it the strip's bottom hour
           and the sentence were printed through one another. */
        <div style={css('flex:none; margin-top:7px; font-size:12.5px; line-height:1.4; color:rgba(237,238,241,.46); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; text-wrap:pretty;')}>
          {w.foot}
        </div>
      )}

      {w.chips.length > 0 && (
        <div style={css('flex:none; margin-top:9px; display:flex; gap:7px;')}>
          {w.chips.map((c, i) => (
            <div
              key={i}
              data-role="deck-chip"
              onClick={(e) => { e.stopPropagation(); onChip(c) }}
              style={cssv`padding:8px 14px; border-radius:999px; cursor:pointer; font-size:12.5px; white-space:nowrap; font-weight:${c.primary ? '600' : '400'}; background:${c.primary ? 'rgba(237,238,241,.92)' : 'rgba(255,255,255,.07)'}; color:${c.primary ? '#0B0B0D' : 'rgba(237,238,241,.82)'};`}
            >{c.label}</div>
          ))}
        </div>
      )}
    </div>
  )
}

function Picture({ w, showing, onOpenObject }: { w: W; showing: boolean; onOpenObject: (navId: string, objectId: string) => void }) {
  // An object tap with no object is the whole application — better than a tap
  // that resolves to nothing, which is the blank-destination failure.
  const tap = (id: string) => (e: React.MouseEvent) => {
    e.stopPropagation()
    if (id) onOpenObject(w.id, id)
  }

  switch (w.render) {
    /* ── Calendar: the next thing, large, then the rest of the day as rows ── */
    case 'cal':
      return (
        <>
          {w.hero && (
            <div
              onClick={tap(w.heroId ?? '')}
              style={css('flex:none; margin-top:12px; border-radius:18px; padding:13px 14px; background:rgba(240,165,107,.14); display:flex; align-items:center; gap:12px; cursor:pointer;')}
            >
              <div style={css('flex:none; width:3px; height:56px; border-radius:999px; background:#F0A56B;')} />
              <div style={css('flex:1; min-width:0;')}>
                <div style={css('font-size:20px; font-weight:600; letter-spacing:-.03em; color:#F7DCC2; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>{w.hero.title}</div>
                {w.hero.sub && <div style={css('margin-top:5px; font-size:12.5px; color:rgba(247,220,194,.62);')}>{w.hero.sub}</div>}
              </div>
              {w.hero.rel && (
                <div style={css('flex:none; font-size:12.5px; font-weight:600; color:rgba(247,220,194,.8); white-space:nowrap;')}>{w.hero.rel}</div>
              )}
            </div>
          )}
          {/*
            ALL-DAY IS A BAND, NEVER A BLOCK.

            `normaliseEvent` guarantees an event is timed or all-day and never
            both, and this is where that guarantee is spent: an all-day event
            has no clock time, so it cannot be positioned on an hour axis, and
            drawing it at midnight would be inventing the one field it does not
            have.
          */}
          {!!w.strip?.allDay.length && (
            <div style={css('flex:none; margin-top:8px; display:flex; gap:5px;')}>
              {w.strip.allDay.map((a) => (
                <div
                  key={a.id}
                  data-preview-row=""
                  onClick={tap(a.id)}
                  style={css('flex:1; min-width:0; height:22px; box-sizing:border-box; border-radius:7px; padding:0 8px; display:flex; align-items:center; cursor:pointer; background:rgba(240,165,107,.1); font-size:11.5px; color:rgba(247,220,194,.72); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}
                >{a.title}</div>
              ))}
            </div>
          )}

          {/*
            THE DAY, AS A SHAPE.

            An hour axis with the events on it at their real positions and real
            durations. What this replaced was four rows of "09:00 · Standup",
            which is a list that happens to be sorted by time — it can tell you
            what is on and it cannot tell you that two of them are at once, that
            there is a three-hour hole after lunch, or that the next thing is
            about to start. Those are the questions a calendar is for, and all
            three are answered by position.
          */}
          {!!w.strip?.blocks.length && (
            /* `min-height:0`, not 60. A floor here cannot be honoured when the card
                 is also carrying a hero, an all-day band, a footing sentence and
                 a chip row — it just moved the 2px the card could not fit from
                 the strip to the card's own box, which is the overflow the gate
                 reported. Everything in the strip is positioned as a percentage,
                 so a short axis is a smaller true picture rather than a broken
                 one: rung one of the ladder, not rung zero. */
              <div style={css('flex:1 1 0; min-height:0; margin-top:9px; position:relative; display:flex; gap:8px;')}>
              <div style={css('flex:none; width:32px; position:relative;')}>
                {/*
                  THE LAST HOUR LABEL IS NOT DRAWN.

                  Every label is centred on its line, so the one at the bottom of
                  the axis has half its glyph box below the strip — and the strip
                  is flush against the footing sentence. On the first capture
                  "23:00" and "Two of these are at the same time." were printed
                  through each other. The rule is the axis, not the last number
                  on it: the line still draws, and its hour is implied by the
                  four above it.
                */}
                {w.strip.ticks.filter((t) => t.at < 0.97).map((t, i) => (
                  <div
                    key={i}
                    style={cssv`position:absolute; top:${(t.at * 100).toFixed(3)}%; left:0; transform:translateY(-50%); font:500 9.5px ui-monospace,Menlo,monospace; color:rgba(237,238,241,.26);`}
                  >{t.label}</div>
                ))}
              </div>
              <div style={css('flex:1; min-width:0; position:relative;')}>
                {w.strip.ticks.map((t, i) => (
                  <div key={i} style={cssv`position:absolute; left:0; right:0; top:${(t.at * 100).toFixed(3)}%; height:1px; background:rgba(255,255,255,.045);`} />
                ))}
                {w.strip.blocks.map((b) => (
                  <div
                    key={b.id}
                    data-preview-row=""
                    onClick={tap(b.id)}
                    /* Positioned by time and laned by collision: two blocks
                       side by side ARE the conflict, stated as a shape. */
                    style={cssv`position:absolute; top:${(b.top * 100).toFixed(3)}%; height:${Math.max(4.5, b.height * 100).toFixed(3)}%; left:${((b.lane / b.lanes) * 100).toFixed(2)}%; width:${(100 / b.lanes - 1.5).toFixed(2)}%; box-sizing:border-box; border-radius:6px; padding:2px 6px; overflow:hidden; cursor:pointer; ${b.tentative ? 'box-shadow:inset 0 0 0 1px rgba(240,165,107,.45);' : `background:${b.hot ? 'rgba(240,165,107,.4)' : 'rgba(240,165,107,.2)'};`}`}
                  >
                    <div style={cssv`font-size:10.5px; font-weight:600; line-height:1.25; color:${b.hot ? '#FCE8D5' : 'rgba(247,220,194,.85)'}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`}>{b.title}</div>
                  </div>
                ))}
                {/* The one hairline in the widget that carries meaning. */}
                {/*
                  THE NOW-LINE'S CAP IS A SHADOW, NOT A CHILD.

                  It was a 5px dot positioned at `top:-2px` inside a 1px-tall
                  line, so that line reported `scrollHeight 3` against
                  `clientHeight 1` — two pixels of real, measurable overflow that
                  the capture gate attributed to the whole Calendar card and that
                  nobody could see. A box-shadow paints the same cap and occupies
                  no layout box at all, which is the same answer the Places
                  distance rings got for the same reason.
                */}
                {w.strip.nowAt !== null && (
                  <div style={cssv`position:absolute; left:0; right:0; top:${(w.strip.nowAt * 100).toFixed(3)}%; height:1px; background:#F0A56B; box-shadow:0 0 6px rgba(240,165,107,.5), -4px 0 0 2px #F0A56B;`} />
                )}
              </div>
            </div>
          )}

          {/*
            THE DAYS THE STRIP CANNOT DRAW.

            The axis is today. When today has no timed events there is no axis
            to draw, and this card spent that space on nothing: on his real
            calendar — which is nearly all all-day events — the entire Calendar
            widget was a hero and two chips over 200px of black, and the hike he
            actually had tomorrow appeared nowhere on Home at all.

            These are the design's "following two, each with its time as the lead
            column", and the lead is a clock for today and a day name otherwise.
            The server decides both, and how many of them fit; this draws them.
          */}
          {!!w.rows?.length && (
            /* `overflow:hidden` as well as `min-height:0`: the rows are fixed
               height, so a card asked for more of them than fit must clip the
               list rather than push its own box — rung four, not rung zero. */
            <div style={css('flex:1 1 0; min-height:0; overflow:hidden; margin-top:10px; display:flex; flex-direction:column; gap:6px;')}>
              {w.rows.map((r) => (
                <div
                  key={r.id}
                  data-preview-row=""
                  onClick={tap(r.id)}
                  style={css('flex:none; height:44px; box-sizing:border-box; border-radius:12px; padding:0 12px; display:flex; align-items:center; gap:11px; cursor:pointer; background:rgba(255,255,255,.045);')}
                >
                  {/* The lead is the anchor and is monospaced so a column of
                      times reads as a column rather than as ragged prose. */}
                  <div style={css('flex:none; min-width:58px; font:600 11px ui-monospace,Menlo,monospace; color:rgba(247,220,194,.72); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>{r.lead}</div>
                  <div style={css('flex:1 1 auto; min-width:0; font-size:13.5px; font-weight:500; color:rgba(237,238,241,.82); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>{r.title}</div>
                  {r.sub && (
                    <div style={css('flex:0 1 auto; min-width:0; font-size:11.5px; color:rgba(237,238,241,.34); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>{r.sub}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )

    /* ── Mail: who, about what, how long they have been waiting ── */
    case 'mail':
      return (
        <div style={css('flex:none; margin-top:12px; display:flex; flex-direction:column; gap:6px;')}>
          {(w.rows ?? []).map((r) => (
            <div
              key={r.id}
              data-preview-row=""
              onClick={tap(r.id)}
              style={cssv`height:64px; box-sizing:border-box; border-radius:16px; padding:0 13px; display:flex; align-items:center; gap:11px; cursor:pointer; background:${r.hot ? 'rgba(169,143,224,.11)' : 'rgba(255,255,255,.045)'};`}
            >
              <div style={cssv`flex:none; width:34px; height:34px; border-radius:999px; display:flex; align-items:center; justify-content:center; font-size:13.5px; font-weight:600; background:${r.hot ? 'rgba(169,143,224,.28)' : 'rgba(255,255,255,.08)'}; color:${r.hot ? '#DDCDF6' : 'rgba(237,238,241,.6)'};`}>{r.lead}</div>
              <div style={css('flex:1; min-width:0;')}>
                <div style={css('display:flex; align-items:baseline; gap:6px;')}>
                  <div style={cssv`flex:0 1 auto; min-width:0; font-size:13.5px; font-weight:600; color:${r.hot ? 'rgba(237,238,241,.92)' : 'rgba(237,238,241,.6)'}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`}>{r.title}</div>
                  {/* THE ROW IS A CONVERSATION. The numeral is how many messages
                      are in it, and it appears only when that is more than one —
                      "1" on every row would be four pixels of noise. */}
                  {!!r.count && (
                    <div style={css('flex:none; padding:1px 5px; border-radius:5px; background:rgba(255,255,255,.08); font:600 9.5px ui-monospace,Menlo,monospace; color:rgba(237,238,241,.5);')}>{r.count}</div>
                  )}
                </div>
                {/* Subject and snippet are ONE line: the subject at reading
                    weight, the snippet dimmed behind it. They are one thought,
                    and two grey rows said less than this does. */}
                {/*
                  TWO BOXES, NOT TWO SPANS.

                  Ellipsis on the parent clips the PAINT and not the layout: an
                  inline span still reports its full text width, so the capture
                  gate saw the snippet's rectangle hanging up to 922px outside
                  the card — a true measurement of a node with no width bound of
                  its own. As flex children with `min-width:0` each half clips
                  itself, the subject keeps priority, and the snippet gives up
                  its space first.
                */}
                <div style={css('margin-top:2px; display:flex; align-items:baseline; gap:5px; font-size:12px; color:rgba(237,238,241,.42);')}>
                  <div style={cssv`flex:0 1 auto; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:rgba(237,238,241,${r.hot ? '.62' : '.5'});`}>{r.sub}</div>
                  {r.note ? (
                    <div style={css('flex:1 1 0; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:rgba(237,238,241,.3);')}>{`— ${r.note}`}</div>
                  ) : null}
                </div>
              </div>
              <div style={css('flex:none; display:flex; flex-direction:column; align-items:flex-end; gap:5px;')}>
                <div style={css('font:500 10.5px ui-monospace,Menlo,monospace; color:rgba(237,238,241,.3);')}>{r.trail}</div>
                {/* THE DOT IS UNREAD, THE TINT IS THE ONE THAT NEEDS HIM.
                    They were one field, so eight unread messages made every row
                    on the card an accent — see `DeckRow.hot`. */}
                <div style={cssv`width:6px; height:6px; border-radius:999px; background:${r.unread ? '#A98FE0' : 'transparent'}; opacity:${r.hot ? '1' : '.5'};`} />
              </div>
            </div>
          ))}
        </div>
      )

    /* ── Video: the thing itself, then what else is waiting ── */
    case 'video':
      /*
        NO PICTURES MEANS NO PICTURE LAYOUT.

        `art` is false when the store carries no thumbnails at all — which is
        the state his account is actually in, and where a hero panel plus three
        empty gradient rectangles is 200px of widget saying nothing. The titles
        ARE the information in that case, so the widget draws them: six real
        videos, readable, each one still opening its own object.
      */
      if (!w.art) {
        return (
          <div style={css('flex:1; min-height:0; margin-top:12px; display:flex; flex-direction:column; gap:8px;')}>
            {[
              ...(w.hero ? [{ id: w.heroId ?? '', title: w.hero.title, channel: w.hero.sub, dur: w.hero.dur }] : []),
              ...(w.thumbs ?? []).map((t) => ({ id: t.id, title: t.title ?? '', channel: t.channel, dur: t.dur })),
            ].map((v) => (
              <div
                key={v.id}
                data-preview-row=""
                onClick={tap(v.id)}
                style={css('flex:none; display:flex; align-items:baseline; gap:9px; cursor:pointer;')}
              >
                <div style={css('flex:1; min-width:0;')}>
                  <div style={css('font-size:13.5px; font-weight:600; line-height:1.3; letter-spacing:-.01em; color:rgba(237,238,241,.88); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;')}>{v.title}</div>
                  {v.channel && (
                    <div style={css('margin-top:2px; font-size:11.5px; color:rgba(237,238,241,.38); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>{v.channel}</div>
                  )}
                </div>
                {v.dur && (
                  <div style={css('flex:none; font:600 10.5px ui-monospace,Menlo,monospace; color:rgba(237,238,241,.34);')}>{v.dur}</div>
                )}
              </div>
            ))}
          </div>
        )
      }
      return (
        <>
          <div
            onClick={tap(w.heroId ?? '')}
            style={cssv`flex:none; margin-top:10px; position:relative; height:124px; border-radius:16px; overflow:hidden; cursor:pointer; background:${w.hero?.image ? `center/cover no-repeat url("${w.hero.image}")` : 'linear-gradient(150deg,#2A2530,#15141A 62%,#101018)'};`}
          >
            {/* THE ▶ IS A PROMISE THAT IT WILL PLAY. Drawn only when the video
                carries a verified url, because an unidentified video opens into
                a surface that explains itself — and a play button that lands
                there is the blank destination with a picture on it. */}
            {w.hero?.play && (
              <div style={css('position:absolute; inset:0; display:flex; align-items:center; justify-content:center;')}>
                <div style={css('width:44px; height:44px; border-radius:999px; background:rgba(10,10,12,.55); box-shadow:inset 0 0 0 1px rgba(255,255,255,.22); display:flex; align-items:center; justify-content:center; font-size:15px; color:rgba(237,238,241,.92); padding-left:3px;')}>▶</div>
              </div>
            )}
            {w.hero?.dur && (
              <div style={css('position:absolute; right:8px; bottom:8px; padding:3px 7px; border-radius:6px; background:rgba(8,8,10,.78); font:600 10.5px ui-monospace,Menlo,monospace; color:rgba(237,238,241,.86);')}>{w.hero.dur}</div>
            )}
          </div>
          {/*
            TITLE AND CHANNEL UNDER THE PICTURE, NOT INSTEAD OF IT.

            The title used to be one clamped line with nothing beside it, so the
            widget could tell him a video existed and not who made it — which is
            most of how anyone decides whether to watch something. Two lines of
            title and the channel beneath, and the channel is not an ambient
            source label: it is the author, and it changes the decision.
          */}
          <div style={css('flex:none; margin-top:9px; font-size:14px; font-weight:600; letter-spacing:-.015em; line-height:1.28; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;')}>{w.hero?.title}</div>
          {w.hero?.sub && (
            <div style={css('flex:none; margin-top:3px; font-size:11.5px; color:rgba(237,238,241,.42); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>{w.hero.sub}</div>
          )}
          {!!w.thumbs?.length && (
            /* The strip of what else is waiting takes the card's remainder
               rather than sitting at a fixed 52px above a black band. Media is
               the one domain where more picture is strictly more information. */
            <div style={css('flex:1; min-height:52px; margin-top:9px; display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px;')}>
              {w.thumbs.map((t) => (
                <div
                  key={t.id}
                  data-preview-row=""
                  onClick={tap(t.id)}
                  style={cssv`position:relative; min-height:52px; border-radius:11px; overflow:hidden; cursor:pointer; background:${t.image ? `center/cover no-repeat url("${t.image}")` : 'linear-gradient(150deg,#26222C,#141319)'};`}
                >
                  {t.dur && (
                    <div style={css('position:absolute; right:5px; bottom:4px; padding:2px 5px; border-radius:5px; background:rgba(8,8,10,.78); font:600 9px ui-monospace,Menlo,monospace; color:rgba(237,238,241,.8);')}>{t.dur}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )

    /* ── Activity: seven days against a goal line, and you can touch them ── */
    case 'bars':
      return <Bars w={w} showing={showing} />

    /* ── Places: where things are, relative to where he is ── */
    case 'places':
      return (
        <>
          {/*
            A REAL MAP, OR NO MAP.

            What was here was a drawing: two radial gradients for distance
            rings, his dot pinned at 24%/66%, a destination dot at 64%/36%, and
            a "route" that was `transform:rotate(-34deg)`. None of it moved when
            the data did. On the one widget whose entire subject is where things
            are relative to each other, that is not decoration — it is a claim
            about geography, and it was false every time.

            Tiles and pin positions are Web-Mercator arithmetic done in
            `server/deck.ts`, so this element positions what it is given and
            computes nothing. When there are no coordinates there is no map: an
            empty panel is the honest answer, and a map of somewhere he has
            never been is not.
          */}
          {w.map ? (
            <MiniMap map={w.map} showing={showing} />
          ) : (
            <div style={css('flex:1; min-height:96px; margin-top:10px; border-radius:18px; background:rgba(255,255,255,.03); display:flex; align-items:center; justify-content:center; font-size:12px; color:rgba(237,238,241,.32);')}>
              Nowhere with coordinates yet.
            </div>
          )}
          <div style={css('flex:none; margin-top:10px; display:flex; flex-direction:column; gap:6px;')}>
            {(w.rows ?? []).map((r) => (
              <div
                key={r.id}
                data-preview-row=""
                onClick={tap(r.id)}
                style={css('height:40px; box-sizing:border-box; border-radius:13px; padding:0 13px; display:flex; align-items:center; gap:10px; cursor:pointer; background:rgba(255,255,255,.045);')}
              >
                {/* `flex:none` with no clamp is how a long name pushed the
                    row past its card. The name still gets priority — it shrinks
                    last — but it can shrink. */}
                <div style={css('flex:0 1 auto; min-width:0; font-size:13.5px; font-weight:600; color:rgba(237,238,241,.85); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>{r.lead}</div>
                <div style={css('flex:1; min-width:0; font-size:12px; color:rgba(237,238,241,.42); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>{r.title}</div>
                {r.trail && (
                  <div style={cssv`flex:none; font:600 12px ui-monospace,Menlo,monospace; color:${r.hot ? '#E7B24C' : 'rgba(237,238,241,.6)'};`}>{r.trail}</div>
                )}
              </div>
            ))}
          </div>
        </>
      )

    /* ── Watch: what it is watching, what it last found, when that moved ── */
    case 'stock':
      return (
        /*
          THE WATCHES SPREAD DOWN THE CARD RATHER THAN STACKING AT THE TOP.

          Three quiet watches occupied 100px and left 230px of black — the same
          "bottom third of the widget is void" the row-count measurement fixed
          for Calendar and Mail, arriving here from the other direction: it is
          not that too few rows are drawn, it is that this domain genuinely has
          three things in it. Distributed, three rows read as a list that is
          complete; stacked, they read as a list that was cut off.
        */
        <div style={css('flex:1; min-height:0; margin-top:13px; display:flex; flex-direction:column; justify-content:space-evenly; gap:11px;')}>
          {(w.rows ?? []).map((r) => (
            /*
              THE ANSWER IS THE ROW.

              This was a progress bar draining towards the next poll — a picture
              of the scheduler, on a card whose subject is what the scheduler
              FOUND. The state sentence is the watch's own last answer and it is
              the only reason to keep a watch at all; the timestamp beside it is
              when that answer last changed, not when it was last checked, so a
              watch that has run forty times without moving reads as quiet
              rather than as busy.
            */
            <div key={r.id} data-preview-row="" onClick={tap(r.id)} style={css('display:flex; gap:9px; align-items:flex-start; cursor:pointer;')}>
              <div style={cssv`flex:none; width:7px; height:7px; margin-top:5px; border-radius:999px; background:${r.hot ? '#E7B24C' : 'rgba(237,238,241,.22)'}; ${r.hot ? 'box-shadow:0 0 7px rgba(231,178,76,.55);' : ''}`} />
              <div style={css('flex:1; min-width:0;')}>
                <div style={css('display:flex; align-items:baseline; gap:8px;')}>
                  <div style={css('flex:0 1 auto; min-width:0; font-size:13px; font-weight:600; color:rgba(237,238,241,.86); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>{r.lead}</div>
                  <div style={css('flex:1 0 6px;')} />
                  <div style={cssv`flex:none; font:600 10.5px ui-monospace,Menlo,monospace; color:${r.hot ? '#E7B24C' : 'rgba(237,238,241,.34)'};`}>{r.trail}</div>
                </div>
                <div style={css('margin-top:3px; font-size:11.5px; line-height:1.35; color:rgba(237,238,241,.5); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;')}>{r.title}</div>
                {/* THE CHECKS, AND WHICH ONES MOVED. Ten dots is the difference
                    between "nothing has changed" and "nothing ever changes". */}
                {!!r.spark?.length && (
                  <div style={css('margin-top:6px; display:flex; align-items:center; gap:4px;')}>
                    {r.spark.map((s, i) => (
                      <div key={i} style={cssv`width:${s.changed ? '5px' : '3px'}; height:${s.changed ? '5px' : '3px'}; border-radius:999px; background:${s.changed ? '#E7B24C' : 'rgba(237,238,241,.2)'};`} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )

    /*
      ── Money and Sleep ──

      Specified by the design, drawn here, and constructed by nothing. See the
      note at the top of this file: the shape is agreed, the data does not exist,
      and the deck would rather be six honest widgets than eight where two are
      invented.
    */
    case 'runway':
      return (
        <>
          <Figure w={w} />
          <div style={css('flex:none; margin-top:18px; display:flex; gap:4px;')}>
            {(w.bars ?? []).map((m, i) => (
              <div key={i} style={cssv`flex:1; height:40px; border-radius:5px; background:${m.v === null ? 'rgba(255,255,255,.045)' : `rgba(231,178,76,${(0.62 - i * 0.07).toFixed(2)})`};`} />
            ))}
          </div>
          <div style={css('flex:none; margin-top:7px; display:flex; gap:4px;')}>
            {(w.bars ?? []).map((m, i) => (
              <div key={i} style={cssv`flex:1; text-align:center; font:500 9px ui-monospace,Menlo,monospace; color:rgba(231,178,76,${m.now ? '.8' : '.55'}); white-space:nowrap;`}>{m.label}</div>
            ))}
          </div>
        </>
      )

    case 'drift':
      return (
        <>
          <Figure w={w} />
          <div style={css('flex:none; margin-top:16px; position:relative; height:88px;')}>
            {(w.bars ?? []).map((p, i, all) => (
              p.v === null ? null : (
                <div
                  key={i}
                  style={cssv`position:absolute; left:${Math.round((i / Math.max(1, all.length - 1)) * 92)}%; top:${Math.round(p.v * 76)}px; width:${p.now ? '9px' : '6px'}; height:${p.now ? '9px' : '6px'}; border-radius:999px; background:${p.now ? '#F0A56B' : `rgba(237,238,241,${(0.16 + (i / Math.max(1, all.length - 1)) * 0.3).toFixed(2)})`};`}
                />
              )
            ))}
          </div>
        </>
      )
  }
}

/** Web-Mercator world pixel. The same four lines as `project` in server/deck.ts. */
const worldPx = (lat: number, lon: number, z: number) => {
  const n = 256 * 2 ** z
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180)
  return {
    x: ((lon + 180) / 360) * n,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n,
  }
}

/**
 * PLACES, AND YOU CAN DRAG IT.
 *
 * What was here drew the server's precomputed tiles into a fixed frame. That is
 * genuinely a map — real OSM raster, real projected pins — and it is a map you
 * can only look at, which on the one domain whose subject is "where things are
 * relative to each other" is most of the value left on the table.
 *
 * So the canvas is measured, the tiles for it are derived here, and a finger
 * moves the centre. The arithmetic is the same `project` the server runs; that
 * duplication is deliberate and is the reason `lat`/`lon`/`z` are on `DeckMap`
 * at all — one of them has to own a frame, and the client is the only one that
 * knows how big its own box is or where the finger went.
 *
 * THE FIRST PAINT IS STILL THE SERVER'S. `tiles` arrive with the feed, so the
 * map is drawn before this component has measured anything; the derived grid
 * takes over on the first layout pass. That ordering is the instant-paint rule
 * and it is why both exist.
 *
 * PAN IS BOUNDED, and honestly so: two canvases in any direction. A widget is
 * not the Places application, and an unbounded drag on a 96px strip is a way to
 * lose the pin you were looking at with no way back. Opening it is the way to
 * roam — which is the delta the depth spec asks every domain to justify.
 */
function MiniMap({ map, showing }: { map: NonNullable<W['map']>; showing: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const from = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Recentre when the feed moves the map somewhere else, so a rebuild does not
  // leave him looking at ground the pins are no longer on.
  useEffect(() => { setPan({ x: 0, y: 0 }) }, [map.lat, map.lon, map.z])

  const TILE = 256
  const centre = worldPx(map.lat, map.lon, map.z)
  const view = size ?? { w: map.w, h: map.h }
  const limit = { x: view.w * 2, y: view.h * 2 }
  const px = Math.max(-limit.x, Math.min(limit.x, pan.x))
  const py = Math.max(-limit.y, Math.min(limit.y, pan.y))

  // Top-left of the canvas in world pixels, after the drag.
  const originX = centre.x - view.w / 2 - px
  const originY = centre.y - view.h / 2 - py

  const derived: { key: string; url: string; left: number; top: number }[] = []
  if (size) {
    const n = 2 ** map.z
    for (let ty = Math.floor(originY / TILE); ty <= Math.floor((originY + view.h) / TILE); ty++) {
      if (ty < 0 || ty >= n) continue
      for (let tx = Math.floor(originX / TILE); tx <= Math.floor((originX + view.w) / TILE); tx++) {
        const wx = ((tx % n) + n) % n
        derived.push({
          key: `${map.z}/${wx}/${ty}`,
          url: `https://tile.openstreetmap.org/${map.z}/${wx}/${ty}.png`,
          left: Math.round(tx * TILE - originX),
          top: Math.round(ty * TILE - originY),
        })
      }
    }
  }
  const tiles = derived.length ? derived : map.tiles

  return (
    <div
      ref={box}
      data-pannable=""
      data-role="places-map"
      onPointerDown={(e) => {
        if (!showing) return
        from.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y, moved: false }
      }}
      onPointerMove={(e) => {
        const g = from.current
        if (!g) return
        const dx = e.clientX - g.x
        const dy = e.clientY - g.y
        if (!g.moved) {
          if (Math.hypot(dx, dy) < GESTURE.dragIntentThreshold) return
          g.moved = true
          try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId) } catch { /* not tracked */ }
        }
        e.preventDefault()
        setPan({ x: g.px + dx, y: g.py + dy })
      }}
      onPointerUp={(e) => {
        const g = from.current
        from.current = null
        // A drag moved the map. Only a gesture that stayed a tap opens Places.
        if (g?.moved) { e.preventDefault(); e.stopPropagation() }
      }}
      onPointerCancel={() => { from.current = null }}
      onClickCapture={(e) => { if (from.current?.moved) { e.preventDefault(); e.stopPropagation() } }}
      style={css('flex:1; min-height:96px; margin-top:10px; position:relative; border-radius:18px; overflow:hidden; background:#0F1218; touch-action:pan-y;')}
    >
      {/*
        THE TILES ARE ONE NODE, NOT SIX.

        Six `<img>` children, each 256px, positioned to cover the box: visually
        clipped by the parent, and six elements whose rectangles hang up to
        187px outside the card. The capture gate reports those as content
        stranded outside its box, and it is right to — nothing in the DOM
        distinguishes "decorative and clipped" from "content that did not fit".
        Layered backgrounds on a single element: no children, no overflow.

        `grayscale` FIRST in the filter, and that ordering is the colour fix:
        inverting OSM's raster directly turns its landcover olive and its
        motorways pink, so the card came out the only warm-green rectangle in a
        near-black app. Desaturating before inverting leaves a neutral plate the
        accent pins can sit on.
      */}
      <div
        aria-hidden
        style={cssv`position:absolute; inset:0; background-repeat:no-repeat; background-size:256px 256px;
          background-image:${tiles.map((t) => `url("${t.url}")`).join(',')};
          background-position:${tiles.map((t) => `${t.left}px ${t.top}px`).join(',')};
          filter:grayscale(1) invert(1) brightness(.58) contrast(1.05); opacity:.55;`}
      />
      {map.marks.map((m) => {
        // Re-projected rather than offset, so a pin sits on its own ground at
        // any pan rather than sliding relative to the raster under it.
        const left = size ? m.left + (map.w - view.w) / 2 + px : m.left + (map.w - view.w) / 2
        const top = size ? m.top + (map.h - view.h) / 2 + py : m.top + (map.h - view.h) / 2
        return m.self ? (
          <div key={m.id} style={cssv`position:absolute; left:${left - 6}px; top:${top - 6}px; width:12px; height:12px; border-radius:999px; background:#F0A56B; box-shadow:0 0 0 5px rgba(240,165,107,.18);`} />
        ) : (
          <div key={m.id} style={cssv`position:absolute; left:${left - 5}px; top:${top - 5}px;`}>
            <div style={css('width:10px; height:10px; border-radius:999px; background:rgba(240,244,250,.9); box-shadow:0 0 0 2px rgba(10,12,16,.55);')} />
            {/* Bounded as well as positioned: a marker label is the one string
                on the map with nothing to push against, and the bound is what
                is LEFT of the canvas from this pin rather than a constant — a
                fixed 120px is right for a pin on the left and 100px of text off
                the card for one on the right. */}
            {m.label && (
              <div style={cssv`position:absolute; left:14px; top:-3px; max-width:${Math.max(36, view.w - left - 24)}px; font-size:10.5px; font-weight:500; color:rgba(237,238,241,.72); text-shadow:0 1px 3px rgba(0,0,0,.8); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`}>{m.label}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * ACTIVITY, AND YOU CAN PUT YOUR FINGER ON IT.
 *
 * "Finger sliding on the step graph to show steps by hour/day." Seven bars that
 * could only be looked at were the clearest case of the gimmick complaint: the
 * one widget in the app holding a real series, drawn as decoration.
 *
 * THE SCRUB IS A DRAG, THE TAP STILL OPENS. Both have to work on the same
 * pixels, so the two are told apart the way the deck tells them apart —
 * `dragIntentThreshold`. Below it the pointer never scrubbed and the click runs
 * normally, which is how a chart you can read is also a chart you can open.
 * Above it the readout follows the finger and the click is swallowed.
 *
 * RELEASE RESTORES. The figure returns to today the moment he lets go, and that
 * is not a detail: a chart left showing Monday's 4,102 under a heading that
 * means "now" is the app quietly lying about the present, which is the exact
 * failure `note` and `freshness` exist upstream to prevent. A readout that
 * survives the gesture would reintroduce it at the last possible moment.
 *
 * `data-pannable` is what stops the deck from stealing the same horizontal
 * movement. See WidgetDeck.
 */
function Bars({ w, showing }: { w: W; showing: boolean }) {
  const bars = w.bars ?? []
  const [at, setAt] = useState<number | null>(null)
  const strip = useRef<HTMLDivElement>(null)
  const from = useRef<{ x: number; y: number; moved: boolean } | null>(null)

  /** Which bar is under this x. Measured, never assumed from a constant. */
  const barAt = (clientX: number): number | null => {
    const el = strip.current
    if (!el || !bars.length) return null
    const b = el.getBoundingClientRect()
    if (b.width <= 0) return null
    const k = Math.floor(((clientX - b.left) / b.width) * bars.length)
    return Math.max(0, Math.min(bars.length - 1, k))
  }

  const held = at === null ? null : bars[at] ?? null

  return (
    <>
      {/*
        THE FIGURE ROW IS THE READOUT. It is not a tooltip floating over the
        bars, because a 340px card has nowhere to float one that does not cover
        the picture being interrogated — and the figure row is already exactly
        "the number, large, with what qualifies it beside it".
      */}
      {held ? (
        <div data-role="bar-readout" style={css('flex:none; margin-top:10px; display:flex; align-items:baseline; gap:8px;')}>
          <div style={css('font-size:44px; font-weight:600; letter-spacing:-.045em; line-height:1.15; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>
            {held.value || '—'}
          </div>
          <div style={css('flex:1;')} />
          <div style={css('padding:4px 9px; border-radius:999px; font:500 10.5px ui-monospace,Menlo,monospace; background:rgba(240,165,107,.16); color:#F0A56B; white-space:nowrap;')}>
            {held.day || held.label}
          </div>
        </div>
      ) : (
        <Figure w={w} />
      )}

      <div
        ref={strip}
        data-pannable=""
        data-role="activity-scrub"
        role="group"
        aria-label="Seven days of activity"
        onPointerDown={(e) => {
          if (!showing || !bars.length) return
          from.current = { x: e.clientX, y: e.clientY, moved: false }
        }}
        onPointerMove={(e) => {
          const g = from.current
          if (!g) return
          if (!g.moved) {
            if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < GESTURE.dragIntentThreshold) return
            g.moved = true
            try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId) } catch { /* not tracked */ }
          }
          e.preventDefault()
          setAt(barAt(e.clientX))
        }}
        onPointerUp={(e) => {
          const g = from.current
          from.current = null
          setAt(null)
          // A drag was an interrogation, not a navigation. Only a gesture that
          // never became one is allowed through to open the application.
          if (g?.moved) { e.preventDefault(); e.stopPropagation() }
        }}
        onPointerCancel={() => { from.current = null; setAt(null) }}
        onClickCapture={(e) => { if (from.current?.moved) { e.preventDefault(); e.stopPropagation() } }}
        /*
          A STALE CHART IS DESATURATED, and that is the picture saying it.

          `freshness.level === 'stale'` means the source stopped reporting, so
          these bars are history rather than news. Left at full strength they
          read as a real decline — "you barely moved this week" — which is the
          opposite of what happened. The sentence underneath says which day it
          stopped; the greying is what makes anyone read the sentence.
        */
        style={cssv`flex:1; min-height:92px; margin-top:14px; position:relative; touch-action:pan-y;
          ${w.stale ? 'opacity:.45; filter:saturate(.25);' : ''}`}
      >
        {w.goal && (
          <>
            <div style={cssv`position:absolute; left:0; right:0; top:${((1 - w.goal.at) * 100).toFixed(2)}%; height:1px; background:rgba(127,179,213,.4);`} />
            <div style={cssv`position:absolute; right:0; top:${((1 - w.goal.at) * 100).toFixed(2)}%; margin-top:-13px; font:500 9.5px ui-monospace,Menlo,monospace; color:rgba(127,179,213,.7);`}>{w.goal.label}</div>
          </>
        )}
        <div style={css('position:absolute; inset:0; display:flex; align-items:flex-end; gap:6px;')}>
          {bars.map((b, i) => (
            /*
              MISSING IS NOT ZERO, and this is where a bar chart breaks that
              rule most easily. A day with no reading is drawn as an outline
              at full height — an absence you can see — rather than as a bar
              of height 0, which is the claim that he did not move.
            */
            b.v === null ? (
              <div
                key={i}
                style={cssv`flex:1; height:100%; border-radius:6px;
                  box-shadow:inset 0 0 0 1px rgba(237,238,241,${i === at ? '.28' : '.09'});`}
              />
            ) : (
              <div
                key={i}
                style={cssv`flex:1; height:${Math.max(2, b.v * 100).toFixed(2)}%; border-radius:6px;
                  background:${i === at ? 'rgba(247,220,194,.95)' : b.now ? 'rgba(240,165,107,.85)' : 'rgba(237,238,241,.22)'};`}
              />
            )
          ))}
        </div>
      </div>
      <div style={css('flex:none; margin-top:7px; display:flex; gap:6px;')}>
        {bars.map((b, i) => (
          <div
            key={i}
            style={cssv`flex:1; text-align:center; font:500 9.5px ui-monospace,Menlo,monospace;
              color:${i === at ? 'rgba(247,220,194,.95)' : b.now ? 'rgba(240,165,107,.8)' : 'rgba(237,238,241,.3)'};`}
          >{b.label}</div>
        ))}
      </div>
    </>
  )
}

/** The big number, its unit, and the one badge that qualifies it. */
function Figure({ w }: { w: W }) {
  return (
    <div style={css('flex:none; margin-top:10px; display:flex; align-items:baseline; gap:8px;')}>
      {/*
        `line-height:1` on a 44px face is SMALLER than the font's own glyph box,
        so the element reports 5px of overflow — real by the gate's definition
        and invisible on screen, which is the worst combination: it trains you
        to ignore the check. 1.15 is the font's actual line box, so the number
        occupies the space it really takes.
      */}
      <div style={css('font-size:44px; font-weight:600; letter-spacing:-.045em; line-height:1.15;')}>{w.figure}</div>
      {w.unit && <div style={css('font-size:13px; color:rgba(237,238,241,.44);')}>{w.unit}</div>}
      {/* WHICH DAY THE NUMBER IS FROM, when it is not today's. Printing a
          Friday count in the place a reader takes for "today" is a true number
          that reads as a false one — `isToday` is on the brief for this. */}
      {w.note && <div style={css('font-size:11.5px; color:rgba(237,238,241,.34);')}>{w.note}</div>}
      <div style={css('flex:1;')} />
      {w.delta && (
        <div style={cssv`padding:4px 9px; border-radius:999px; font:500 10.5px ui-monospace,Menlo,monospace; background:${w.goal ? 'rgba(127,179,213,.16)' : 'rgba(255,255,255,.06)'}; color:${w.goal ? '#9FC8E2' : 'rgba(237,238,241,.5)'};`}>{w.delta}</div>
      )}
    </div>
  )
}

export type { DeckRow }
