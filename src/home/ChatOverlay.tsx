import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { css, cssv } from '../css'
import { INSET } from '../tokens'
import { TYPE } from '../tokens'
import { useViewport } from '../viewport'
import type { Msg } from '../Report'

/**
 * CHAT RISES OVER HOME. It does not navigate away from it.
 *
 * Tapping the composer used to push a generic chat card — a whole view, with
 * Home gone behind it, for the sake of asking one question. Steering is not a
 * destination. The panel comes up as a frosted foreground layer with Home still
 * visible underneath as context, and retreats cleanly when it is done.
 *
 * THREE SNAP STATES, AND NO FOURTH.
 *
 *   collapsed  the narrow composer, the default resting state
 *   expanded   ~38% of the resolved usable viewport — where tapping the
 *              composer takes you
 *   max        ~58%, for reading something long
 *
 * A drag follows the finger continuously and a release snaps to one of the
 * three; there is no arbitrary resting height, so the panel is never at 47% of
 * the screen because that is where a thumb stopped.
 *
 * MAX IS THE USER'S. The old "structured presentation transition" let the model
 * decide the panel should be bigger, which is the agent taking the screen. Max
 * is entered by drag, by the expand control, or because he asked for more room
 * in words — and by nothing else. A structured artefact too tall for Expanded
 * scrolls inside it, or offers an explicit control; it does not grow the panel
 * on its own.
 *
 * The percentages are of the RESOLVED usable viewport, so the panel is the same
 * proportion of the screen in Safari, in a Home Screen launch, and with the
 * keyboard up.
 */

export type Snap = 'collapsed' | 'expanded' | 'max'

const SHARE: Record<Snap, number> = { collapsed: 0, expanded: 0.38, max: 0.58 }

/** Drag physics. Distance decides, velocity overrides — the same tokens the decks use. */
const FLICK = 0.5

export function ChatOverlay({
  snap, onSnap, thread, opening, suggestions, sending, onSend, onOpenSettings, interrupted,
  onComposerHeight,
}: {
  snap: Snap
  onSnap: (s: Snap) => void
  thread: Msg[]
  opening: string
  /**
   * SUGGESTIONS LIVE HERE, and only here.
   *
   * Never a Home lane: a fifth row of model guesses is exactly the accumulation
   * the four-class model exists to prevent. Two or three, each of which must be
   * relevant, non-duplicative, clearly referential, valid against a capability
   * that exists, and executable now — or backed by a defined clarification path.
   * A contextless "Why?" and a "Check route" next to a "Show route" are the two
   * failures this cap is drawn against.
   */
  suggestions: string[]
  sending: boolean
  onSend: (text: string) => void
  /**
   * The quiet way into settings: long-press the send button.
   *
   * It lives on the composer because the composer is the one control present in
   * every Home state — including the two where nothing else is, which are
   * exactly the states someone needs settings from.
   */
  onOpenSettings: () => void
  /** A critical interrupt owns input above this panel; see Interrupt.tsx. */
  interrupted?: boolean
  /**
   * How much room the collapsed composer actually takes, measured.
   *
   * Home has to hold back exactly this much and no less. It used to hold back a
   * constant 70, which was right in Chromium and two pixels short in Safari —
   * so the status line and the composer pill overlapped on his phone and
   * nowhere else. A constant standing in for a measurement is the same bug the
   * viewport had, one layer down.
   */
  onComposerHeight?: (px: number) => void
}) {
  const v = useViewport()
  const [draft, setDraft] = useState('')
  /** Live height while a finger is down. null when the snap state governs. */
  const [dragH, setDragH] = useState<number | null>(null)
  const drag = useRef<{ y: number; h: number; t: number } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const scroller = useRef<HTMLDivElement>(null)

  /**
   * THE ROOM THE PANEL IS A PROPORTION OF.
   *
   * The usable viewport minus whatever the keyboard is covering. Taking the
   * share of the full height instead is how a maxed panel with the keyboard up
   * ran off the top of the screen: 58% of the whole window, raised by 336px,
   * is not 58% of anything the person can see.
   */
  const room = Math.max(0, v.height - v.lift)
  const target = Math.round(room * SHARE[snap])
  const height = dragH ?? target
  const open = snap !== 'collapsed'

  // Follow the conversation, but only when he is already at the bottom — a new
  // message must never yank him away from something he scrolled up to read.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight
  }, [thread.length, snap])

  /**
   * FOCUS FOLLOWS THE GESTURE THAT OPENED THE PANEL — AND NOTHING ELSE.
   *
   * This used to focus whenever `open` was true, which includes the first
   * render. The snap state is persisted, so leaving chat expanded and coming
   * back to the app later opened it with the keyboard already climbing up the
   * screen, from no gesture at all. Only the transition into open focuses now,
   * so the keyboard is always something he just did.
   */
  const wasOpen = useRef(open)
  useEffect(() => {
    if (open && !wasOpen.current) input.current?.focus()
    wasOpen.current = open
  }, [open])

  const snapTo = (h: number, velocity: number) => {
    // A decisive flick decides on its own; anything slower goes to the nearest
    // of the three. Either way the result is one of exactly three heights.
    if (velocity < -FLICK) return onSnap(h > room * SHARE.expanded ? 'max' : 'expanded')
    if (velocity > FLICK) return onSnap(h < room * SHARE.expanded ? 'collapsed' : 'expanded')
    const options: Snap[] = ['collapsed', 'expanded', 'max']
    let best: Snap = 'collapsed'
    let bestD = Infinity
    for (const s of options) {
      const d = Math.abs(h - room * SHARE[s])
      if (d < bestD) { bestD = d; best = s }
    }
    onSnap(best)
  }

  const handleDown = (e: React.PointerEvent) => {
    drag.current = { y: e.clientY, h: height, t: e.timeStamp }
    // Guarded for the same reason as Map, Deck and the workspace seam: capture
    // throws for a pointer the browser is not actively tracking, and an
    // exception here would abort the handler that starts the drag.
    try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId) } catch { /* not tracked */ }
  }
  const handleMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    // Continuous, deliberately: the panel under the finger is the affordance
    // that teaches the three positions exist.
    setDragH(Math.max(0, Math.min(room * 0.72, d.h - (e.clientY - d.y))))
  }
  const handleUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    const dy = e.clientY - d.y
    const velocity = dy / Math.max(1, e.timeStamp - d.t)
    const h = Math.max(0, d.h - dy)
    setDragH(null)
    snapTo(h, velocity)
  }

  /**
   * The collapsed composer's real outer height, published upward.
   *
   * Only while collapsed: open, the pill loses its margin and gains a panel
   * above it, and reporting that would make Home's reserve breathe every time
   * chat opened.
   */
  const composerBox = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = composerBox.current
    if (!el || open) return
    const read = () => {
      const style = getComputedStyle(el)
      const outer = el.offsetHeight + (parseFloat(style.marginBottom) || 0) + (parseFloat(style.marginTop) || 0)
      onComposerHeight?.(Math.ceil(outer))
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [open, onComposerHeight])

  const send = () => {
    const text = draft.trim()
    if (!text || sending) return
    setDraft('')
    onSend(text)
  }

  // Long-press to open settings, and the press that opened them must not also
  // fire a send on release.
  const hold = useRef<{ timer: number; fired: boolean } | null>(null)
  const startHold = () => {
    const state = { timer: 0, fired: false }
    state.timer = window.setTimeout(() => { state.fired = true; onOpenSettings() }, 500)
    hold.current = state
  }
  const endHold = (): boolean => {
    const state = hold.current
    hold.current = null
    if (!state) return false
    window.clearTimeout(state.timer)
    return state.fired
  }

  return (
    <>
      {/*
        STRICT FOREGROUND INPUT OWNERSHIP.

        While chat is up it owns input completely. Home behind the glass is
        visual context and nothing else — no card activation, no lane paging, no
        background button. The scrim is what enforces it, and its ONLY behaviour
        is to collapse: a tap outside must not both dismiss the panel and press
        whatever was underneath, because the finger was aiming at the panel.
        Getting back to Home costs a second, deliberate interaction, and that is
        the correct price.

        `inert` is applied to Home itself by the caller, so assistive technology
        follows the same rule the finger does rather than being able to reach
        controls the eye is told are inactive.
      */}
      {open && (
        <div
          data-role="chat-scrim"
          onPointerDown={(e) => { e.preventDefault(); e.stopPropagation() }}
          onClick={(e) => { e.stopPropagation(); if (!interrupted) onSnap('collapsed') }}
          style={css('position:absolute; inset:0; z-index:20; background:rgba(6,6,8,.34); animation:cruFade .2s ease;')}
        />
      )}

      {/*
        A CRITICAL INTERRUPT OWNS INPUT FROM CHAT TOO, NOT ONLY FROM HOME.

        `Interrupt.tsx` says "Home stays inert underneath, chat stays inert
        beneath the interrupt" and the second half was never implemented: the
        caller applies `inert` to Home, and nothing applied it here. So with an
        interrupt up, the composer's send button sat UNDER the interrupt layer
        and remained focusable, tabbable and clickable by assistive technology
        — the one place the modal layer could be reached through, which is
        precisely the hole `inert` exists to close.

        Found by the reachability gate rather than by looking: it is invisible
        in a screenshot, because the button is drawn exactly where it belongs.
      */}
      <div
        data-frame="chat"
        data-snap={snap}
        inert={interrupted ? true : undefined}
        style={cssv`position:absolute; left:0; right:0; bottom:${v.lift}px; z-index:21;
          display:flex; flex-direction:column; max-height:${room}px;
          transition:${dragH === null ? 'height .26s cubic-bezier(.25,.8,.3,1)' : 'none'};`}
      >
        {open && (
          <div
            style={cssv`height:${Math.round(height)}px; min-height:0; display:flex; flex-direction:column;
              border-radius:26px 26px 0 0; overflow:hidden;
              background:rgba(20,20,24,.72); backdrop-filter:blur(26px); -webkit-backdrop-filter:blur(26px);
              box-shadow:inset 0 1px 0 rgba(255,255,255,.14), 0 -18px 40px rgba(0,0,0,.5);`}
          >
            {/* The grab handle. Dragging it is how Max is reached by hand. */}
            <div
              onPointerDown={handleDown}
              onPointerMove={handleMove}
              onPointerUp={handleUp}
              onPointerCancel={handleUp}
              style={css('flex:none; padding:9px 0 7px; touch-action:none; cursor:grab; display:flex; justify-content:center;')}
            >
              <div style={css('width:38px; height:4px; border-radius:999px; background:rgba(237,238,241,.26);')} />
            </div>

            <div style={css('flex:none; padding:0 18px 6px; display:flex; align-items:center; gap:8px;')}>
              <div style={cssv`flex:1; font-size:${TYPE.micro}; font-weight:600; letter-spacing:.07em;
                text-transform:uppercase; color:rgba(237,238,241,.34);`}>Crucible</div>
              {/* The explicit control. Together with the drag, these are the only
                  two ways into Max that are not him saying so in words. */}
              <button
                type="button"
                data-role="expand-chat"
                aria-label={snap === 'max' ? 'shrink chat' : 'expand chat'}
                onClick={() => onSnap(snap === 'max' ? 'expanded' : 'max')}
                style={cssv`border:0; background:transparent; cursor:pointer; font-family:inherit;
                  font-size:${TYPE.micro}; color:rgba(237,238,241,.5); padding:2px 4px;`}
              >{snap === 'max' ? 'shrink' : 'expand'}</button>
            </div>

            {/*
              Ordinary long conversations scroll here. They do not grow the
              panel: a thread's length is not a request for more of the screen.
            */}
            <div
              ref={scroller}
              data-role="chat-scroll"
              style={cssv`flex:1; min-height:0; overflow-y:auto; overscroll-behavior:contain;
                -webkit-overflow-scrolling:touch; padding:2px ${INSET.page}px 8px; display:flex; flex-direction:column;`}
            >
              {/*
                The thread hugs the composer here too. The panel's height is his
                — he dragged it there — but an opening line stranded at the top
                of an otherwise empty sheet is the same band of black the
                workspace had, and it is not what he asked for by opening chat.
              */}
              <div style={css('margin-top:auto; display:flex; flex-direction:column; gap:9px;')}>
              {[{ who: 'ai' as const, text: opening }, ...thread].map((m, i) => {
                const b = m.who === 'ai'
                  ? { justify: 'flex-start', radius: '16px 16px 16px 5px', bg: 'rgba(255,255,255,.07)', fg: 'rgba(237,238,241,.92)' }
                  : { justify: 'flex-end', radius: '16px 16px 5px 16px', bg: 'rgba(237,238,241,.92)', fg: '#101012' }
                return (
                  <div key={i} style={cssv`display:flex; justify-content:${b.justify}; animation:cruRise .3s ease;`}>
                    <div style={cssv`max-width:82%; padding:10px 13px; border-radius:${b.radius}; background:${b.bg};
                      color:${b.fg}; font-size:13.5px; line-height:1.5; text-wrap:pretty;`}>{m.text}</div>
                  </div>
                )
              })}
              </div>
            </div>

            {suggestions.length > 0 && (
              <div style={css('flex:none; padding:0 16px 8px; display:flex; gap:8px; overflow-x:auto;')}>
                {suggestions.slice(0, 3).map((c, i) => (
                  <div
                    key={i}
                    data-role="suggestion"
                    onClick={() => onSend(c)}
                    style={cssv`flex:none; padding:8px 13px; border-radius:999px; background:rgba(255,255,255,.07);
                      box-shadow:inset 0 0 0 1px rgba(255,255,255,.13); font-size:12.5px; white-space:nowrap;
                      color:rgba(237,238,241,${sending ? '.36' : '.82'}); cursor:pointer;`}
                  >{c}</div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* The composer. The same element in all three states, so opening chat
            is the panel growing behind it rather than a different control. */}
        <div
          ref={composerBox}
          data-frame="composer"
          data-open="ask"
          onClick={() => { if (!open) onSnap('expanded') }}
          style={cssv`flex:none; margin:${open ? '0' : `0 ${INSET.page}px 12px`}; padding:${open ? `10px ${INSET.page}px 14px` : `13px ${INSET.page}px`};
            border-radius:${open ? '0' : '22px'}; display:flex; align-items:center; gap:11px; cursor:text;
            background:${open ? 'rgba(20,20,24,.86)' : 'rgba(30,32,37,.4)'};
            backdrop-filter:${open ? 'blur(26px)' : 'none'}; -webkit-backdrop-filter:${open ? 'blur(26px)' : 'none'};
            box-shadow:${open ? 'none' : 'inset 0 1px 0 rgba(255,255,255,.16), inset 0 0 0 1px rgba(255,255,255,.08)'};`}
        >
          <input
            ref={input}
            value={draft}
            disabled={sending}
            placeholder={sending ? 'Thinking…' : 'Ask Crucible anything…'}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => { if (!open) onSnap('expanded') }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            style={css('flex:1; min-width:0; background:transparent; border:0; outline:0; font-family:inherit; font-size:14px; color:rgba(237,238,241,.92);')}
          />
          <div
            data-role="composer-send"
            role="button"
            tabIndex={0}
            aria-label="Send. Press and hold for settings."
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send() } }}
            onPointerDown={startHold}
            onPointerLeave={() => endHold()}
            onContextMenu={(e) => e.preventDefault()}
            onPointerUp={(e) => { e.stopPropagation(); if (!endHold()) send() }}
            style={cssv`width:30px; height:30px; flex:none; border-radius:999px; display:flex; align-items:center;
              touch-action:none; -webkit-user-select:none; user-select:none;
              justify-content:center; color:#0B0B0D; font-size:15px; cursor:pointer;
              background:rgba(237,238,241,${draft.trim() && !sending ? '.9' : '.4'});`}
          >↑</div>
        </div>
      </div>
    </>
  )
}

/**
 * "Give me more room" — the third and last way into Max.
 *
 * A conversational command, recognised narrowly and only in the imperative. It
 * is here rather than in the model's hands on purpose: the model may not decide
 * the panel should be bigger, but it must be able to hear him ask.
 */
/**
 * "SETTINGS" — THE DISCOVERABLE WAY IN, AND THE ONLY ONE THAT COSTS NO PIXELS.
 *
 * Settings was reachable by exactly one route: a 500ms press on the send arrow,
 * with no affordance anywhere saying so. "How do I open settings" had no
 * answer a person could find by looking, which for the screen that holds the
 * model keys is the worst place in the app to hide.
 *
 * The obvious fixes are both forbidden and rightly so: a permanent settings
 * button is new global navigation chrome, and a row of icons is the launcher
 * that keeps being deleted. So the route is the composer, which is already on
 * every screen, already says "Ask Crucible anything…", and already recognises a
 * narrow set of imperatives — see `asksForRoom` directly below, which is the
 * same idea and the reason this shape is not an invention.
 *
 * Narrow on purpose. It matches a request to open settings and not the word
 * appearing in a sentence: "what are your settings" opens them, "I changed the
 * settings on my camera" is a remark and goes to the model.
 */
export function asksForSettings(text: string): boolean {
  const t = text.toLowerCase().trim().replace(/[?.!]+$/, '')
  if (/^(settings|preferences|options)$/.test(t)) return true
  return /^(open|show|go to|take me to|let me see|where are|what are)\s+(the\s+|your\s+|my\s+)?(settings|preferences)$/.test(t)
}

export function asksForRoom(text: string): Snap | null {
  const t = text.toLowerCase().trim()
  if (/\b(bigger|more room|more space|expand|full screen|fullscreen)\b/.test(t)) return 'max'
  if (/\b(smaller|less room|shrink|collapse|close chat)\b/.test(t)) return 'collapsed'
  return null
}
