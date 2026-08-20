import { useEffect, useRef, useState } from 'react'
import { css, cssv } from '../css'
import { GESTURE } from '../tokens'
import { CARD_H, DeckWidgetCard } from './DeckWidget'
import type { DeckChip, DeckWidget as W } from '../api'

/**
 * THE DECK — the widgets ARE the navigation.
 *
 * One full-width domain at a time, swiped sideways, snapped. This is the only
 * place in the app that pages horizontally and it is the only vertical
 * exemption Home has: the column does not scroll, the deck scrolls on x.
 *
 * RANKING NO LONGER DECIDES WHETHER A DOMAIN IS HERE. Every domain he has
 * switched on is in the deck whether or not it has news — a quiet one just gets
 * a quieter widget. Ordering (see `buildDeck`) chooses which one he lands on
 * first, and nothing else.
 *
 * THE DOTS ARE A READOUT AND NOT A CONTROL. Eight dots tell you how far away
 * Money is but not where it is, and answering that with a permanent launcher is
 * the thing this design deleted. They are not tappable, they carry no cursor,
 * and the zoomed-out grid is reached by pinch instead — transient, closing the
 * moment a domain is picked, so it can never settle into a home screen.
 *
 * AND IT IS NOT SWIPE-ONLY. Swipe may be primary and may never be the only path
 * (gesture rule, ui-contract). The deck is a focusable group: arrow keys page
 * it, and a visually-hidden control opens the overview for anyone who cannot
 * pinch. Neither spends a permanent pixel, which is the constraint that made a
 * `‹ • ›` row wrong in the first place.
 *
 * ── IT IS NO LONGER A SCROLLER, AND THAT FIXED TWO REPORTED DEFECTS ──
 *
 * This was a native `overflow-x:auto` scroller with `scroll-snap-type`. Both
 * bugs he reported came from that single decision, and neither was fixable
 * inside it:
 *
 * ONE. THE DECK ENDED. Six domains in a bounded scroller means Places is five
 * swipes from Calendar and there is no way round the back — "multiple swipes
 * left and right to get to the outermost cards". Modulo indexing makes first ↔
 * last an ordinary page, so nothing is ever more than three swipes away.
 *
 * TWO. IT LOST ITS PLACE. Position lived in `scrollLeft`, which is DOM state,
 * and opening a surface unmounts Home — so coming back rebuilt the scroller at
 * zero and an effect scrolled it to where the state said it should be. That is
 * the "cards restart at the beginning and then slide back" he saw, and it is
 * structural: the restore cannot precede the mount that needs restoring. Here
 * the position IS `index`, a prop, so the first painted frame is already right
 * and there is nothing to animate back from.
 *
 * The transform approach is not new to this codebase — `src/home/Deck.tsx` has
 * used it for the lanes since they existed, for these exact reasons. This is
 * the widget deck catching up with it.
 *
 * A GESTURE THAT STARTS ON A PANNABLE IS NOT THE DECK'S. Widgets are now
 * interactive in place — the activity chart scrubs, the map pans — so those
 * declare `data-pannable` and the deck does not arbitrate for their fingers at
 * all. `data-pannable` is not a new vocabulary: the capture gate already knows
 * it as "this region extends past its box on purpose".
 */

/** Distance between two touches, for the pinch that zooms the deck out. */
const spread = (t: TouchList): number => {
  if (t.length < 2) return 0
  const dx = t[0]!.clientX - t[1]!.clientX
  const dy = t[0]!.clientY - t[1]!.clientY
  return Math.hypot(dx, dy)
}

export function WidgetDeck({
  widgets, index, onIndex, onUserMove, onOverview, onOpen, onOpenObject, onChip,
}: {
  widgets: W[]
  index: number
  onIndex: (i: number) => void
  /**
   * HE TOUCHED THE DECK — as distinct from the deck moving.
   *
   * `onIndex` cannot carry this. It fires from `onScroll`, and `onScroll` also
   * fires while the deck is settling into the position it was GIVEN: at mount
   * that is one report of index 0, arriving before the effect has scrolled
   * anywhere, and Home read it as "he chose the first domain". Input events do
   * not have that ambiguity — a pointer went down, or a key was pressed.
   */
  onUserMove?: () => void
  onOverview: () => void
  onOpen: (navId: string) => void
  onOpenObject: (navId: string, objectId: string) => void
  onChip: (c: DeckChip) => void
}) {
  const n = widgets.length
  const scroller = useRef<HTMLDivElement>(null)

  /**
   * WHICH SLIDE IS IN FRONT, held here as well as by Home.
   *
   * Home owns the DURABLE answer — it is persisted by domain id and it is what
   * survives opening a surface — and this is the one being drawn right now.
   * They are the same number except during a page, where this one is ahead by
   * exactly the page in flight.
   *
   * The effect adopts any index Home arrives at by another route: a re-rank, a
   * pick from the overview, or the restore after a surface closes. Those are
   * cuts rather than pages, which is correct — none of them is a gesture, and
   * animating a restore is what made the deck appear to slide back from the
   * front every time he came out of an application.
   */
  const [i, setI] = useState(index)
  useEffect(() => { setI(index) }, [index])

  /** Live offset of the track while a finger is on it, in px from centre. */
  const [dx, setDx] = useState(0)
  const [animating, setAnimating] = useState(false)
  const gesture = useRef<{ x: number; y: number; t: number; taken: boolean; settled: boolean } | null>(null)
  /** Set the moment paging is established; swallows the click that would follow. */
  const paged = useRef(false)

  /**
   * THE SLIDE IS THE MEASURED BOX, NOT 390.
   *
   * The design is drawn at 390×844 and that is the reference, not the contract.
   * Every phone-only layout bug in this app has been a constant standing in for
   * a measurement, and a deck whose slide is a constant is a deck that drifts
   * further out of true with every page on any phone that is not the reference.
   */
  const width = () => scroller.current?.clientWidth ?? 1

  /**
   * ONE PAGE, WRAPPING. Never a rewind of the whole track.
   *
   * THE INDEX LEADS THE ANIMATION; IT DOES NOT TRAIL IT. The obvious ordering —
   * animate the transform, then commit the index on a timeout — drops any page
   * asked for while the previous one is still moving, because the second call
   * computes its destination from an `index` that has not been told about the
   * first yet. Measured, not theorised: seven ArrowLefts moved the deck four
   * domains, and a person swiping quickly through six is exactly the case.
   *
   * So the index moves NOW, the new slide is rendered where the old one was,
   * and the offset animates to zero. Same motion on screen, no lost pages, and
   * a second swipe mid-flight simply re-offsets from wherever it has got to.
   */
  const settle = (next: number, fromDx: number) => {
    // One frame at the old position with transitions off, so what animates is
    // the page and not a cut. Committing both in the same frame would paint the
    // destination immediately and the movement would never be drawn.
    releasing.current = true
    setI(next)
    setAnimating(false)
    setDx(fromDx)
    onIndex(next)
  }

  /**
   * AND THE RELEASE IS AN EFFECT, NOT A `requestAnimationFrame`.
   *
   * rAF does not run in a hidden tab. A page committed as the app goes to the
   * background would have kept its starting offset until it was foregrounded
   * again — a deck stranded half way between two domains, which is precisely
   * the "state says Mail, screen says Calendar" class of bug the scroller was
   * replaced to end. On a Home Screen PWA, being backgrounded mid-gesture is
   * ordinary rather than exotic.
   *
   * An effect is guaranteed to run after the commit that painted `fromDx`,
   * whatever the tab is doing.
   */
  const releasing = useRef(false)
  useEffect(() => {
    if (!releasing.current) return
    releasing.current = false
    setAnimating(true)
    setDx(0)
  }, [i])

  /**
   * `mx` is how far the finger had already carried the track, so the commit is
   * continuous with the gesture rather than a jump back to a slide boundary.
   * Zero for the keyboard, which has no finger to be continuous with.
   */
  const step = (delta: -1 | 1, mx = 0) => {
    if (n < 2) return
    settle((i + delta + n * 2) % n, mx + delta * width())
  }

  /**
   * PINCH IN TO SEE THEM ALL.
   *
   * Native listeners rather than React's synthetic ones because the move
   * handler must be non-passive to be able to suppress the browser's own zoom
   * on the same fingers.
   */
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    let from = 0
    const start = (e: TouchEvent) => { from = spread(e.touches) }
    const move = (e: TouchEvent) => {
      if (!from || e.touches.length < 2) return
      const now = spread(e.touches)
      if (now && now / from < 0.72) {
        from = 0
        e.preventDefault()
        onOverview()
      }
    }
    const end = () => { from = 0 }
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', end, { passive: true })
    return () => {
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', end)
    }
  }, [onOverview])

  /**
   * ARBITRATION, RATHER THAN GUESSING.
   *
   * Below the intent threshold everything is a tap, so the whole card stays
   * pressable. Past it, and only when horizontal clearly dominates vertical,
   * the deck takes the gesture and swallows the click that was otherwise about
   * to happen — which is why a swipe that starts on a widget row does not open
   * that row.
   */
  const onPointerDown = (e: React.PointerEvent) => {
    onUserMove?.()
    if (n < 2) return
    /*
      A PANNABLE OWNS ITS OWN FINGERS.

      The chart scrubs and the map pans, and both are horizontal gestures inside
      a horizontal pager. Without this the deck would win every one of them —
      the two interactions he asked for would be unreachable, and the arbitration
      threshold cannot tell them apart because they are the same shape of motion.
      Declared regions opt out entirely rather than competing.
    */
    if ((e.target as HTMLElement | null)?.closest?.('[data-pannable]')) { gesture.current = null; return }
    gesture.current = { x: e.clientX, y: e.clientY, t: e.timeStamp, taken: false, settled: false }
    paged.current = false
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current
    if (!g) return
    const mx = e.clientX - g.x
    const my = e.clientY - g.y
    if (!g.settled) {
      if (Math.hypot(mx, my) < GESTURE.dragIntentThreshold) return
      // One decision, once: a gesture that resolved as vertical stays vertical
      // for its whole life, so a diagonal drag cannot flip the deck mid-swipe.
      g.settled = true
      g.taken = Math.abs(mx) >= Math.abs(my) * GESTURE.horizontalDominance
      if (g.taken) {
        paged.current = true
        // Throws for a pointer the browser is not tracking, and unguarded that
        // exception aborts the rest of this handler mid-swipe. Same guard as
        // Deck.tsx and Map.tsx, which is where it was first paid for.
        try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId) } catch { /* not tracked */ }
      }
    }
    if (!g.taken) return
    e.preventDefault()
    setDx(mx)
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current
    gesture.current = null
    if (!g?.taken) return
    const mx = e.clientX - g.x
    const dt = Math.max(1, e.timeStamp - g.t)
    const far = Math.abs(mx) > width() * GESTURE.commitFraction
    if (far || Math.abs(mx) / dt > GESTURE.commitVelocity) step(mx < 0 ? 1 : -1, mx)
    else { setAnimating(true); setDx(0); window.setTimeout(() => setAnimating(false), 200) }
  }

  // Previous, current, next — always three, whatever the deck holds.
  const slots = n ? [-1, 0, 1].map((d) => widgets[(i + d + n * 2) % n]!) : []

  return (
    <>
      {/*
        THE POSITION READOUT. Sixteen pixels, no handler, no cursor.
        See this file's opening note — this is the rule, not an oversight.
      */}
      <div
        data-role="deck-dots"
        aria-hidden
        style={css('flex:none; height:16px; display:flex; align-items:center; justify-content:center; gap:5px;')}
      >
        {widgets.map((w, k) => (
          <div
            key={w.id}
            style={cssv`width:${k === i ? '16px' : '4px'}; height:4px; border-radius:999px; background:${k === i ? 'rgba(240,165,107,.85)' : 'rgba(237,238,241,.2)'};`}
          />
        ))}
      </div>

      <div
        ref={scroller}
        data-role="deck"
        data-deck="widgets"
        /*
          `data-track` GOES ON THE CLIPPING BOX, NOT ON THE THING THAT MOVES.

          It is the capture gate's word for "this region is moved by gesture, so
          its contents legitimately extend past its edges" — and the gate reads
          it while walking UP from a node to its nearest clipping ancestor, so
          the attribute only has any effect on that ancestor. Putting it on the
          transformed child instead left the child itself governed by the deck's
          `overflow:hidden`, and a track translated one full slide left is
          exactly one slide outside its box: 32 of 69 captures failed with
          "div escapes deck=widgets by 375px". `Deck.tsx` has always had it
          here, on the box; this is the widget deck matching it.
        */
        data-track="widgets"
        role="group"
        tabIndex={0}
        aria-label={`Domains. ${widgets[i]?.name ?? ''}, ${i + 1} of ${n}.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
          e.preventDefault()
          onUserMove?.()
          step(e.key === 'ArrowRight' ? 1 : -1)
        }}
        // Capture, so the swallow happens before any card control sees it.
        onClickCapture={(e) => {
          if (!paged.current) return
          e.preventDefault()
          e.stopPropagation()
          paged.current = false
        }}
        style={cssv`flex:none; height:${CARD_H}px; position:relative; overflow:hidden; outline:none;
          touch-action:pan-y; -webkit-user-select:none; user-select:none;`}
      >
        <div
          style={cssv`position:absolute; inset:0; display:flex; will-change:transform;
            transform:translate3d(calc(-100% + ${Math.round(dx)}px), 0, 0);
            transition:${animating ? 'transform .22s cubic-bezier(.25,.8,.3,1)' : 'none'};`}
        >
          {slots.map((w, i) => (
            /* `data-card` and the enclosing `data-deck` are what the capture
               harness measures: card box, inner overflow, and slot height. Only
               the CURRENT slide carries it — the neighbours are `aria-hidden`,
               which is both the truth for assistive technology and the gate's
               own exemption for a deck's off-screen pair. */
            <div
              key={`${w.id}-${i}`}
              data-card={i === 1 ? w.id : undefined}
              aria-hidden={i !== 1}
              style={css('flex:none; width:100%; height:100%; padding:0 16px; box-sizing:border-box;')}
            >
              <DeckWidgetCard w={w} showing={i === 1} onOpen={onOpen} onOpenObject={onOpenObject} onChip={onChip} />
            </div>
          ))}
        </div>
      </div>

      {/*
        THE NON-TOUCH WAY TO THE OVERVIEW — VISIBLE THE MOMENT IT IS FOCUSED.

        It was one pixel, clipped, in every state including focus. As a
        screen-reader affordance that is the canonical pattern and it was fine;
        as the "non-touch path" the contract requires it was a technicality,
        because a sighted keyboard user tabbing through Home landed on something
        with no position, no label on screen and no focus ring. The control
        existed in the DOM and nowhere a person could see.

        `:focus-visible` is the whole fix: zero permanent screen space, which is
        the constraint the contract actually sets — "must not spend permanent
        mobile screen space on redundant navigation chrome" — and a real, legible
        target at the moment somebody is using the path it exists for.
      */}
      <button
        type="button"
        data-role="deck-overview"
        onClick={onOverview}
        className="cru-skip"
      >Show all domains</button>
    </>
  )
}

/**
 * ZOOMED OUT — and it closes the moment you pick one.
 *
 * "It is transient, it is not on screen by default, and it is the only
 * concession." A grid of every domain is a launcher if it persists, so the one
 * thing that keeps it from becoming one is that there is no way to stay here.
 */
export function DeckOverview({
  widgets, onPick, onClose,
}: {
  widgets: W[]
  onPick: (i: number) => void
  onClose: () => void
}) {
  return (
    <div
      data-home-mode="overview"
      style={css('flex:1; min-height:0; display:flex; flex-direction:column; gap:10px; padding:0 16px; animation:cruFade .16s ease;')}
    >
      <div style={css('flex:none; display:flex; align-items:center; gap:8px;')}>
        <div style={css('font-size:16px; font-weight:600; letter-spacing:-.025em;')}>
          {widgets.length === 1 ? 'One domain' : `All ${widgets.length}`}
        </div>
        <div style={css('flex:1;')} />
        <div
          onClick={onClose}
          style={css('padding:6px 13px; border-radius:999px; cursor:pointer; font-size:12px; background:rgba(255,255,255,.07); color:rgba(237,238,241,.8);')}
        >Back</div>
      </div>

      <div style={css('flex:none; display:grid; grid-template-columns:1fr 1fr; gap:9px;')}>
        {widgets.map((w, i) => (
          <div
            key={w.id}
            data-role="overview-mini"
            onClick={() => onPick(i)}
            style={cssv`height:104px; box-sizing:border-box; border-radius:18px; padding:12px; cursor:pointer; overflow:hidden; display:flex; flex-direction:column; background:${w.hot ? 'rgba(231,178,76,.075)' : 'rgba(255,255,255,.05)'};`}
          >
            <div style={css('flex:none; font-size:12.5px; font-weight:600; color:rgba(237,238,241,.55);')}>{w.name}</div>
            <div style={css('flex:1;')} />
            <div style={cssv`flex:none; font-size:22px; font-weight:600; letter-spacing:-.035em; line-height:1; color:${w.hot ? '#EFD8A8' : 'rgba(237,238,241,.92)'};`}>{w.mini.value}</div>
            <div style={css('flex:none; margin-top:6px; font-size:11px; line-height:1.3; color:rgba(237,238,241,.4); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;')}>{w.mini.line}</div>
          </div>
        ))}
      </div>

      <div style={css('flex:1; min-height:0;')} />
      <div style={css('flex:none; font-size:11.5px; line-height:1.5; color:rgba(237,238,241,.34); text-wrap:pretty;')}>
        Pinch to get here. It closes the moment you pick one, so it never becomes a home screen.
      </div>
    </div>
  )
}

export { CARD_H }
