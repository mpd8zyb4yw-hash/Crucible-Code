import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { css } from './css'

/**
 * THE UNIVERSAL FIT RULE.
 *
 * Every widget and every pane is drawn into a box whose exact pixel size it was
 * told, inside a boundary it cannot paint through. Nothing on screen is ever
 * sized by guesswork, by a viewport unit, by a media query, or by hoping the
 * content happens to be shorter than the space.
 *
 * This existed for exactly one level — `SurfaceFrame`, around a whole opened
 * application — and everything else was on trust. The results were visible in
 * every screenshot: a reply composer growing past its drawer, a preview row
 * sliced through the middle of its letters, two inches of black under a chat
 * region that had been handed 35% of the screen whatever it contained, cards
 * whose content ran under the controls sitting on top of them. Each of those is
 * the same bug — a box and its contents disagreeing about how big the box is —
 * and each was fixed once, locally, in the component where it showed up.
 *
 * `Fit` is that fix made structural and universal. Three guarantees, and they
 * hold for anything rendered inside one:
 *
 *   1  IT IS EXACTLY ITS BOX. `overflow:hidden` with `min-width/height:0`, so
 *      no descendant can paint outside it — not by absolute positioning, not by
 *      a long word, not by a drawer that grew.
 *   2  IT KNOWS ITS BOX. `useFit()` returns the measured pixels, so a renderer
 *      BUILDS a 343×248 application instead of rendering a desktop one and
 *      being clipped. Fixed frame plus adaptive content; never fixed frame plus
 *      clipped content.
 *   3  IT IS CHECKABLE. `data-fit` marks the boundary in the DOM, so the visual
 *      gate can assert on EVERY capture that nothing is cut off and unreachable
 *      — rather than only on the handful of captures someone remembered to flag.
 *
 * The escape hatch is explicit and narrow: a region that legitimately extends
 * past its box — map tiles you drag, a list you scroll — declares that with
 * `data-pannable` or by being a real scroller. An unmarked overflow is a bug,
 * and now it is a failing test rather than something to notice in a screenshot.
 */

export interface FitSize {
  w: number
  h: number
  /** Coarse buckets, so renderers branch on intent rather than pixel maths. */
  tight: boolean
  roomy: boolean
}

const FALLBACK: FitSize = { w: 343, h: 248, tight: false, roomy: false }

const FitContext = createContext<FitSize>(FALLBACK)

/**
 * The box this renderer actually has.
 *
 * Container-driven, never a media query: the same renderer is handed a card's
 * frame on Home and a workspace's frame in an opened app, and what it needs to
 * know is how much room IT has — not how wide the window is.
 */
export const useFit = () => useContext(FitContext)

/**
 * Measure a box, and keep measuring it.
 *
 * `useLayoutEffect` rather than `useEffect`: the first paint should already be
 * at the right size. A frame that measures after painting shows one frame of
 * wrong geometry, which on a slow phone is a visible jump.
 */
export function useMeasured<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [size, setSize] = useState<FitSize>(FALLBACK)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = (w: number, h: number) => {
      setSize((prev) =>
        // Sub-pixel churn is ignored; a resize loop here would thrash every
        // surface on the screen at once.
        Math.abs(prev.w - w) < 2 && Math.abs(prev.h - h) < 2
          ? prev
          : { w, h, tight: h < 220, roomy: h >= 380 },
      )
    }
    read(Math.round(el.clientWidth), Math.round(el.clientHeight))
    const ro = new ResizeObserver(([e]) => {
      read(Math.round(e.contentRect.width), Math.round(e.contentRect.height))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return { ref, size }
}

/**
 * THE READER'S TEXT SIZE, IN PIXELS.
 *
 * Everything that has to be laid out in px but sized by TEXT reads this. The
 * defect it exists for: a Home preview row was `height:19px`, a constant chosen
 * because 13px body text occupies about 19px — true at the default font size
 * and false at every other. At the largest supported size the same row holds
 * 22px of text inside its 19px box, so every row on every card clipped its own
 * descenders, and `Preview`'s "how many whole rows fit" arithmetic divided by a
 * number that had stopped describing a row.
 *
 * `document.documentElement`'s computed font-size is exactly what a browser's
 * text-size preference moves, which is what makes this a measurement rather
 * than another constant. See `TEXT_SCALE_MAX`.
 */
export function useRootFontPx(): number {
  const [px, setPx] = useState(16)
  useLayoutEffect(() => {
    const read = () => {
      const v = parseFloat(getComputedStyle(document.documentElement).fontSize)
      setPx(Number.isFinite(v) && v > 0 ? v : 16)
    }
    read()
    // The setting can change under a running app — a preference toggled in
    // another tab, or an OS-level change the browser forwards. A layout that
    // only read it once would be correct until the moment it mattered.
    const ro = new ResizeObserver(read)
    ro.observe(document.documentElement)
    return () => ro.disconnect()
  }, [])
  return px
}

/**
 * A bounded, self-measuring box.
 *
 * `position:relative` is part of the contract rather than decoration: it is
 * what an anchored drawer positions against, and it is why a drawer cannot
 * paint over whatever is below the frame however tall its contents get.
 */
export function Fit({
  children, name, frame, plane = '', grow = true,
}: {
  children: ReactNode
  /** What this box is, for diagnostics and for the gate's failure messages. */
  name: string
  /** The layout landmark this box also is, when it is one. */
  frame?: string
  /** Extra style for the box itself — background, seam, shadow. */
  plane?: string
  /** Whether it claims the space it is given, or wraps its content. */
  grow?: boolean
}) {
  const { ref, size } = useMeasured<HTMLDivElement>()
  return (
    <div
      ref={ref}
      data-fit={name}
      data-frame={frame}
      style={css(
        `${grow ? 'flex:1; ' : ''}position:relative; min-width:0; min-height:0; overflow:hidden; ` +
        'display:flex; flex-direction:column; ' + plane,
      )}
    >
      <FitContext.Provider value={size}>{children}</FitContext.Provider>
    </div>
  )
}
