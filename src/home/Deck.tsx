import { useRef, useState, type ReactNode } from 'react'
import { css, cssv } from '../css'
import { GESTURE, INSET, TYPE } from '../tokens'
import { failIfPoisoned } from '../poison'
import { Boundary } from '../Boundary'

/**
 * A PAGED DECK. One card in the slot, everything else one deterministic page
 * away.
 *
 * This replaces the free-scrolling rail, and the difference is the whole
 * spatial argument. A rail rests wherever momentum leaves it — 1.3 cards
 * showing, a sliver of the next one, a different resting position every flick —
 * so "what is on Home" was a question about scroll offset. A deck has exactly
 * one answer at all times: full-card alignment, absolute snapping, no partial
 * resting state, one swipe moving exactly one card.
 *
 * Three implementation decisions worth the words.
 *
 * IT IS NOT A SCROLLER. CSS scroll-snap gets the alignment right and the
 * discreteness wrong: one hard flick crosses several snap points, which is
 * exactly the "I lost my place" the fixed geometry exists to prevent. The
 * transform is driven directly so a gesture can only ever commit one page.
 *
 * IT RENDERS THREE SLOTS. Previous, current and next, indexed modulo the deck,
 * so first ↔ last wraparound is a normal page rather than a special case that
 * rewinds the whole track. After a commit the index moves and the transform
 * snaps back to centre with transitions off — invisible, and it means a deck of
 * twenty costs the same as a deck of two.
 *
 * IT ARBITRATES, RATHER THAN GUESSING. Below the intent threshold everything is
 * a tap and card controls behave normally. Past it, and only when horizontal
 * movement clearly dominates vertical, the deck takes the gesture and cancels
 * the activation that was otherwise about to happen — which is why a swipe that
 * starts on a button does not press it.
 */

export interface DeckProps<T> {
  items: T[]
  /** Stable identity. Everything here is keyed by id, never by index. */
  keyOf: (item: T) => string
  /** Which card is showing. Owned by the caller, persisted per device. */
  visibleId: string | null
  onVisible: (id: string) => void
  height: number
  render: (item: T, showing: boolean) => ReactNode
  /** Drawn when the deck is empty. Quiet, and the lane keeps its geometry. */
  empty: ReactNode
  /** Marks the one allowed automatic move, so it reads as cleanup not navigation. */
  replaced?: boolean
  /**
   * The band this deck draws, as a stable machine id.
   *
   * SEPARATE FROM `label`, and the separation earned itself: the two were one
   * string, so the selector every capture and every geometry assertion depends
   * on — `[data-deck="…"]` — was the same string as the words on the screen.
   * Renaming a band from "insights" to "quietly true" would then silently
   * unhook the harness from the thing it measures, and a harness that stops
   * measuring passes.
   */
  id: string
  label: string
  /**
   * How many cards in this deck are new or changed since he last looked.
   *
   * The agent is allowed to INSERT into a lane and to say so; it is not allowed
   * to page the lane to what it inserted. This count is the whole of that
   * permission — an indicator he can act on, rather than a viewport change made
   * on his behalf while he was reading something else.
   */
  news?: number
}

/**
 * A LANE FAILS ALONE.
 *
 * Four lanes at fixed positions is a claim about geometry, and a throw inside
 * one of them used to be a claim about the whole screen — Home has no boundary
 * between a deck and the app root, so one bad card took all four lanes, the
 * context row and the composer with it. Deliberate failure injection is what
 * surfaced that; nothing about the code reads as risky.
 *
 * The fallback keeps the lane's EXACT height, which is the part that matters
 * beyond not crashing: a failed lane that collapsed would move every lane below
 * it, and "nothing moves when a lane's content changes" is the whole point of
 * the fixed geometry.
 */
export function Deck<T>(props: DeckProps<T>) {
  return (
    <Boundary
      scope={`The ${props.label} lane`}
      level="component"
      fallback={() => (
        <div
          data-deck={props.id}
          data-empty="yes"
          role="alert"
          style={cssv`height:${props.height}px; flex:none; display:flex; flex-direction:column;`}
        >
          <div
            style={cssv`flex:1; min-height:0; margin:0 ${INSET.page}px; box-sizing:border-box; display:flex; align-items:center;
              padding:0 ${INSET.card}px; border-radius:20px; background:rgba(255,255,255,.012);
              box-shadow:inset 0 0 0 1px rgba(255,255,255,.035); font-size:${TYPE.small}; color:rgba(237,238,241,.36);`}
          >
            This lane couldn’t be drawn.
          </div>
          <div style={css('height:20px; flex:none;')} />
        </div>
      )}
    >
      <DeckBody {...props} />
    </Boundary>
  )
}

function DeckBody<T>({
  items, keyOf, visibleId, onVisible, height, render, empty, replaced, id, label, news = 0,
}: DeckProps<T>) {
  failIfPoisoned('deck')
  const n = items.length
  const index = Math.max(0, items.findIndex((i) => keyOf(i) === visibleId))

  const [dx, setDx] = useState(0)
  const [animating, setAnimating] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const gesture = useRef<{ x: number; y: number; t: number; taken: boolean; settled: boolean } | null>(null)
  /** Set the moment paging is established; swallows the click that would follow. */
  const paged = useRef(false)

  const width = () => box.current?.clientWidth ?? 1

  const step = (delta: number) => {
    if (n < 2) return
    const next = items[(index + delta + n * 2) % n]
    // The animation runs on the transform, then the index changes and the
    // transform is reset to centre with transitions off — so the wraparound
    // from last to first is the same motion as any other page.
    setAnimating(true)
    setDx(-delta * width())
    window.setTimeout(() => {
      setAnimating(false)
      setDx(0)
      onVisible(keyOf(next))
    }, 220)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (n < 2) return
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
      // for its whole life, so a diagonal drag cannot flip the lane mid-swipe.
      g.settled = true
      g.taken = Math.abs(mx) >= Math.abs(my) * GESTURE.horizontalDominance
      if (g.taken) {
        paged.current = true
        // An enhancement that must never decide whether the lane pages: it
        // throws for a pointer the browser is not tracking, and unguarded that
        // exception aborts the rest of this handler mid-swipe. Same guard as
        // Map.tsx, which is where this was first paid for.
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
    const velocity = Math.abs(mx) / dt
    const far = Math.abs(mx) > width() * GESTURE.commitFraction
    if (far || velocity > GESTURE.commitVelocity) step(mx < 0 ? 1 : -1)
    else { setAnimating(true); setDx(0); window.setTimeout(() => setAnimating(false), 200) }
  }

  /**
   * AN EMPTY BAND COLLAPSES. IT DOES NOT KEEP A CARD'S GEOMETRY.
   *
   * This reverses the previous rule, deliberately and under the contract. An
   * empty band used to keep its ENTIRE budget — frame, height and pager — so
   * that Home's Y positions never moved. The argument was internally consistent
   * and the result was the screenshot: a quarter of a 6.3" phone spent on a
   * bordered rectangle containing the words "Nothing needs you", which reads as
   * the app being broken rather than as the morning being calm.
   *
   * Fixed geometry survives, because the thing that was actually being defended
   * is still true: nothing here is content-driven. A band is its tier, or it is
   * one line, and the choice between those is "does this band contain anything
   * at all" — the single fact Home exists to communicate. What is NOT allowed,
   * and what the gate still asserts, is a band whose height varies with how MUCH
   * it contains. See docs/ui-contract.md and `laneHeights`.
   *
   * Unboxed, at `LANE.empty`. No frame, because a frame is a promise that
   * something belongs there, and drawing three of them is the app filing its
   * own taxonomy on his home screen.
   */
  if (!n) {
    return (
      <div
        data-deck={id}
        data-empty="yes"
        style={cssv`height:${height}px; flex:none; display:flex; align-items:center;
          padding:0 ${INSET.page}px; box-sizing:border-box;`}
      >
        {empty}
      </div>
    )
  }

  // Previous, current, next — always three, whatever the deck holds.
  const slots = [-1, 0, 1].map((d) => items[(index + d + n * 2) % n])

  return (
    <div data-deck={id} style={cssv`flex:none; height:${height}px; display:flex; flex-direction:column;`}>
      <div
        ref={box}
        data-track={id}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        /*
          THE NON-TOUCH PATH, now that the arrows are gone.

          A band is a list you move through, so it answers the two keys a list
          answers. This is not a smaller version of the arrows: it costs no
          pixels, it is where a keyboard user's hand already is, and it works
          identically on all three bands. `tabIndex` is what makes it reachable
          at all — the track was previously focusable only through the arrow
          buttons it contained, so removing them without this would have made
          swipe the only path, which is the thing §14 forbids.
        */
        tabIndex={n > 1 ? 0 : -1}
        role="group"
        aria-label={`${label}, ${index + 1} of ${n}`}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
          e.preventDefault()
          step(e.key === 'ArrowRight' ? 1 : -1)
        }}
        // Capture, so the swallow happens before any card control sees it.
        onClickCapture={(e) => {
          if (!paged.current) return
          e.preventDefault()
          e.stopPropagation()
          paged.current = false
        }}
        style={css(
          'flex:1; min-height:0; position:relative; overflow:hidden; ' +
          // The browser keeps vertical panning; horizontal is ours, which is
          // what stops a swipe from turning into Safari's back gesture.
          'touch-action:pan-y; -webkit-user-select:none; user-select:none;',
        )}
      >
        <div
          style={cssv`position:absolute; inset:0; display:flex; will-change:transform;
            transform:translate3d(calc(-100% + ${Math.round(dx)}px), 0, 0);
            transition:${animating ? 'transform .22s cubic-bezier(.25,.8,.3,1)' : 'none'};`}
        >
          {slots.map((item, i) => (
            <div
              key={`${keyOf(item)}-${i}`}
              data-card={i === 1 ? keyOf(item) : undefined}
              aria-hidden={i !== 1}
              style={cssv`flex:none; width:100%; height:100%; padding:0 ${INSET.page}px; box-sizing:border-box;
                animation:${i === 1 && replaced ? 'cruFade .28s ease' : 'none'};`}
            >
              {render(item, i === 1)}
            </div>
          ))}
        </div>
      </div>

      <Pager
        i={index}
        n={n}
        id={id}
        label={label}
        onGo={(k) => onVisible(keyOf(items[k]))}
        news={news}
      />
    </div>
  )
}

/**
 * DISCOVERABILITY, WITHOUT SPENDING THE PHONE ON NAVIGATION CHROME.
 *
 * WHAT CHANGED, AND WHY THE ARROWS WENT. This drew `‹ ● ● ›` under every band —
 * so a three-band Home carried three arrow pairs, six permanent tap targets
 * whose entire job duplicated a swipe, plus a fourth row of them if a deck ever
 * appeared elsewhere. On the phone that is a legible fraction of the screen
 * spent telling him that a gesture he already made exists. The dots survive and
 * the arrows do not, because the dots are doing two jobs (WHERE AM I, and a way
 * to get elsewhere) and the arrows were doing one that swipe already does.
 *
 * IT IS STILL NOT SWIPE-ONLY, which was the arrows' real argument and is a real
 * requirement — a gesture is not an accessible interface. Three paths remain:
 *
 *   · the dots are ordinary buttons with `aria-current`, so they are operable by
 *     tap, by keyboard and by assistive technology;
 *   · the track itself is focusable and takes ← / → (see `DeckBody`), which is
 *     what someone on a keyboard actually reaches for;
 *   · past `dotsMax` the position becomes text, which is what twenty dots should
 *     always have been — that many is a texture, not a control.
 *
 * See §14/§15 of docs/ui-contract.md: the requirement is a non-touch path, not a
 * permanently visible one.
 */
function Pager({
  i, n, id, label, onGo, news,
}: {
  i: number; n: number; id: string; label: string; news: number
  onGo: (i: number) => void
}) {
  const badge = news > 0 && (
    <div
      data-role="new-count"
      style={cssv`position:absolute; right:${INSET.page}px; font-size:${TYPE.micro}; font-weight:600; letter-spacing:.04em;
        color:rgba(240,165,107,.9);`}
    >{news} new</div>
  )
  if (n < 2) return <div style={css('height:20px; flex:none; position:relative; display:flex; align-items:center;')}>{badge}</div>

  return (
    <div
      data-pager={id}
      role="group"
      aria-label={`${label}, ${i + 1} of ${n}`}
      style={cssv`height:20px; flex:none; position:relative; display:flex; align-items:center; justify-content:center; gap:4px; padding:0 ${INSET.page}px;`}
    >
      {n <= GESTURE.dotsMax ? (
        <div style={css('display:flex; align-items:center; gap:8px;')}>
          {Array.from({ length: n }, (_, k) => (
            <button
              key={k}
              type="button"
              aria-label={`${label} ${k + 1} of ${n}`}
              aria-current={k === i}
              onClick={() => onGo(k)}
              /*
                Five pixels of paint, twenty of target. A dot that is only its own
                size is a decoration someone can see and cannot press, which is
                the failure mode that made the arrows look necessary.
              */
              style={cssv`width:5px; height:5px; padding:0; border:0; border-radius:999px; cursor:pointer;
                position:relative; background:rgba(237,238,241,${k === i ? '.6' : '.18'});
                box-shadow:0 0 0 7px rgba(0,0,0,0);`}
            />
          ))}
        </div>
      ) : (
        <div style={cssv`font-size:${TYPE.micro}; letter-spacing:.05em; color:rgba(237,238,241,.4);
          min-width:52px; text-align:center; font-variant-numeric:tabular-nums;`}>
          {i + 1} / {n}
        </div>
      )}
      {badge}
    </div>
  )
}
