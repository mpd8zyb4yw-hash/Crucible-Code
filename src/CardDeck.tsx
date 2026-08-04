// ── CardDeck — the phone layout policy ─────────────────────────────────────────
// Cards as a book's pages: one card fills the frame, the next few show only as edge
// slivers, and swiping the front card away brings the next forward. A phone shows one
// widget at full size instead of a column of squashed ones, and the peeking edges are
// what make the gesture discoverable without a hint.
//
// WHY THE CARDS BEHIND ARE BLANK SLIVERS, not real cards at reduced opacity:
// these cards are frosted GLASS. Stacking translucent cards means you read straight
// through the front one into the ones behind, and the deck becomes a pile of
// overlapping text. (The first implementation did exactly that — it was unusable.)
// Only the front card renders content; the cards behind are plain rounded shapes.
// The design's own item-card deck specifies precisely this.
//
// Design constraints (DESIGN_HANDOFF §5.2, §6.1):
//   · The card tracks the finger 1:1 while dragging, then settles with --ease-glide.
//   · Rubber-band at the ends: resistance, no wrap, and NO bounce.
//   · Counter, not dots, past ~7 items — dots stop scaling.
//   · A swipe that only animates on release feels broken on a phone.
//
// Accessibility, deliberately not optional:
//   · Pointer Events, so a mouse can drag too — no touch-only branch.
//   · Arrows and ←/→ are rendered ON PHONE as well, not just desktop. A gesture-only
//     control is unreachable for a motor-impaired user.
//   · Under prefers-reduced-motion the drag is NOT ATTACHED AT ALL — arrows and keys
//     only, with an opacity cross-fade. index.css clamps CSS *transitions* globally,
//     but finger-tracking is an inline transform, so it must be gated here in JS.
//     Do not "simplify" that away.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

const PEEK = 13            // px each sliver shows at the right edge
const DEPTH_Y = 7
const SLIVERS = 2          // how many edges show behind the front card
const COMMIT_RATIO = 0.25  // fraction of width that commits a swipe
const COMMIT_VELOCITY = 0.45 // px/ms

/** Asymptotic resistance — the card visibly fights back and never leaves the frame. */
function rubberBand(dx: number, width: number): number {
  const limit = width * 0.28
  const sign = dx < 0 ? -1 : 1
  return sign * limit * (1 - 1 / (1 + Math.abs(dx) / limit))
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
  })
  useEffect(() => {
    let mq: MediaQueryList
    try { mq = window.matchMedia('(prefers-reduced-motion: reduce)') } catch { return }
    const h = () => setReduced(mq.matches)
    mq.addEventListener('change', h)
    return () => mq.removeEventListener('change', h)
  }, [])
  return reduced
}

function StepButton({ label, dir, onClick, disabled }: {
  label: string; dir: -1 | 1; onClick: () => void; disabled: boolean
}) {
  return (
    <button
      aria-label={label} title={label} onClick={onClick} disabled={disabled}
      style={{
        width: 32, height: 32, borderRadius: 10, flexShrink: 0, padding: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: disabled ? 'default' : 'pointer', fontFamily: 'inherit',
        background: 'rgba(127,127,150,0.16)', border: '1px solid var(--glass-edge)',
        color: 'var(--glass-text)', opacity: disabled ? 0.35 : 1,
        transition: 'opacity var(--dur-fast) var(--ease-standard)',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path d={dir === -1 ? 'M10 3L5 8l5 5' : 'M6 3l5 5-5 5'}
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

export default function CardDeck({ items, labels }: {
  /** One node per card, already rendered. Order is the user's board order. */
  items: React.ReactNode[]
  /** Accessible name per card. Same length as `items`. */
  labels: string[]
}) {
  const n = items.length
  const [front, setFront] = useState(0)
  const [dx, setDx] = useState(0)
  const [settling, setSettling] = useState(false)
  /** The card being swiped away, kept mounted so it can animate off-screen. */
  const [leaving, setLeaving] = useState<{ index: number; dir: -1 | 1 } | null>(null)
  const [height, setHeight] = useState(200)
  const frameRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: number; x0: number; y0: number; t0: number; axis: 'none' | 'x' | 'y' } | null>(null)
  const reduced = usePrefersReducedMotion()

  useEffect(() => { if (front > n - 1) setFront(Math.max(0, n - 1)) }, [n, front])

  // The deck needs an explicit height so the absolutely-positioned cards have a box,
  // and it tracks the FRONT card. Card bodies differ wildly (a Gmail list vs a one-line
  // Watch state), so sizing to the tallest would leave a crater under the short ones;
  // instead the frame animates between heights on the same glide curve as the swipe.
  useLayoutEffect(() => {
    const el = cardRef.current
    if (!el) return
    const measure = () => setHeight(Math.max(120, el.offsetHeight))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [front, items])

  const go = useCallback((next: number, dir: -1 | 1) => {
    if (next < 0 || next > n - 1) return
    setLeaving({ index: front, dir })
    setFront(next)
    setDx(0)
    setSettling(true)
    window.setTimeout(() => setLeaving(null), 300)
  }, [front, n])

  const step = useCallback((d: -1 | 1) => go(front + d, d), [front, go])

  const onPointerDown = (e: React.PointerEvent) => {
    if (reduced || n < 2) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    // A drag that starts on a control belongs to that control — the widget's own "ask"
    // pill and its rows must stay tappable.
    if ((e.target as HTMLElement).closest('button, a, input, textarea, [role="button"]')) return
    drag.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), axis: 'none' }
    setSettling(false)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const mx = e.clientX - d.x0
    const my = e.clientY - d.y0
    if (d.axis === 'none') {
      // Axis lock: claim the gesture only once it is clearly horizontal, so a finger
      // that starts on a card can still scroll the page vertically.
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return
      if (Math.abs(mx) <= Math.abs(my)) { drag.current = null; return }
      d.axis = 'x'
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* best effort */ }
    }
    const w = frameRef.current?.offsetWidth ?? 320
    const blocked = (front === 0 && mx > 0) || (front === n - 1 && mx < 0)
    setDx(blocked ? rubberBand(mx, w) : mx)
  }

  const endDrag = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    if (d.axis !== 'x') return
    const w = frameRef.current?.offsetWidth ?? 320
    const mx = e.clientX - d.x0
    const fast = Math.abs(mx) / Math.max(1, performance.now() - d.t0) > COMMIT_VELOCITY
    const far = Math.abs(mx) > w * COMMIT_RATIO
    if ((far || fast) && ((mx < 0 && front < n - 1) || (mx > 0 && front > 0))) {
      go(front + (mx < 0 ? 1 : -1), mx < 0 ? 1 : -1)
    } else {
      setSettling(true)
      setDx(0)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1) }
    else if (e.key === 'Home') { e.preventDefault(); if (front > 0) go(0, -1) }
    else if (e.key === 'End') { e.preventDefault(); if (front < n - 1) go(n - 1, 1) }
  }

  if (n === 0) return null

  const w = frameRef.current?.offsetWidth ?? 320
  const settle = 'transform 280ms var(--ease-glide), opacity 280ms var(--ease-glide)'
  const behind = Math.min(SLIVERS, n - 1 - front)
  // The slivers slide toward the front slot as the front card is dragged away.
  const progress = Math.min(1, Math.abs(dx) / Math.max(1, w))

  return (
    <div>
      <div
        ref={frameRef}
        tabIndex={0}
        role="group"
        aria-roledescription="carousel"
        aria-label="Home widgets"
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{
          position: 'relative', height, minWidth: 0, outline: 'none',
          transition: 'height 280ms var(--ease-glide)',
          // The deck owns horizontal; the page keeps vertical. Without this the browser
          // steals the gesture and the deck feels dead on iOS.
          touchAction: 'pan-y',
        }}
      >
        {/* Edge slivers — pure shape, NO content. See the header note on why. */}
        {Array.from({ length: behind }, (_, k) => {
          const depth = Math.max(0.001, k + 1 - progress)
          return (
            <div key={`sliver-${k}`} aria-hidden style={{
              position: 'absolute', top: depth * DEPTH_Y, bottom: -depth * DEPTH_Y,
              left: depth * PEEK, right: -depth * PEEK,
              borderRadius: 'var(--radius-card)',
              background: 'var(--glass-fill)',
              border: '1px solid var(--glass-edge)',
              boxShadow: 'var(--glass-inner-light)',
              opacity: Math.max(0, 0.85 - k * 0.3),
              zIndex: 10 - k,
              transition: settling ? settle : 'none',
              pointerEvents: 'none',
            }} />
          )
        })}

        {/* The card leaving. It must visibly go TO THE BACK OF THE DECK, not fly off
            the screen — that motion is what makes the stack read as a stack rather than
            as a horizontal filmstrip. Going forward, the old front tucks in behind the
            new one: it scales down into the deepest sliver slot and drops BELOW the new
            front in z. Going back, it does the reverse and slides out to the right,
            because that card is returning to the position it came from. */}
        {leaving && !reduced && (
          <div aria-hidden style={{
            position: 'absolute', top: 0, left: 0, right: 0,
            // Forward: behind the new front (z below 20). Back: above it, sliding away.
            zIndex: leaving.dir === 1 ? 5 : 30,
            transform: leaving.dir === 1
              // Tuck to the back: settle into the deepest sliver's geometry.
              ? `translate3d(${SLIVERS * PEEK}px, ${SLIVERS * DEPTH_Y}px, 0) scale(${1 - SLIVERS * 0.045})`
              // Return: back out to where a "next" card lives.
              : `translate3d(${w * 1.05}px, 0, 0) scale(0.96)`,
            transformOrigin: 'center left',
            opacity: leaving.dir === 1 ? 0.55 : 0,
            transition: settle,
            pointerEvents: 'none',
          }}>{items[leaving.index]}</div>
        )}

        {/* The front card — the only one with content. */}
        <div
          key={front}
          ref={cardRef}
          aria-label={`${labels[front] ?? ''}, ${front + 1} of ${n}`}
          className={!reduced && leaving ? (leaving.dir === 1 ? 'cru-deck-in-fwd' : 'cru-deck-in-back') : undefined}
          style={{
            position: 'absolute', top: 0, left: 0, right: 0, zIndex: 20,
            transform: reduced ? undefined : `translate3d(${dx}px, 0, 0)`,
            transition: reduced ? 'opacity 120ms var(--ease-standard)' : (settling ? settle : 'none'),
            willChange: 'transform',
          }}
          onTransitionEnd={() => setSettling(false)}
        >{items[front]}</div>
      </div>

      {/* Progress + the non-gesture path. Both always rendered, phone included. */}
      <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <StepButton label="Previous widget" dir={-1} onClick={() => step(-1)} disabled={front === 0} />
        {n <= 7 ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} aria-hidden>
            {items.map((_, i) => (
              <span key={i} style={{
                width: i === front ? 16 : 5, height: 5, borderRadius: 3,
                background: i === front ? 'var(--glass-text)' : 'var(--glass-text-3)',
                opacity: i === front ? 1 : 0.45,
                transition: 'width var(--dur-fast) var(--ease-standard), opacity var(--dur-fast) var(--ease-standard)',
              }} />
            ))}
          </div>
        ) : (
          <span aria-hidden style={{
            font: '500 11px/1 var(--mono)', color: 'var(--glass-text-2)',
            fontVariantNumeric: 'tabular-nums', minWidth: 46, textAlign: 'center',
          }}>{front + 1} / {n}</span>
        )}
        <StepButton label="Next widget" dir={1} onClick={() => step(1)} disabled={front === n - 1} />
      </div>

      <div aria-live="polite" style={{
        position: 'absolute', width: 1, height: 1, overflow: 'hidden',
        clip: 'rect(0 0 0 0)', clipPath: 'inset(50%)', whiteSpace: 'nowrap',
      }}>{labels[front] ?? ''}, {front + 1} of {n}</div>
    </div>
  )
}
