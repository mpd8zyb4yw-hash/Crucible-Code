import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { css, cssv } from './css'
import { INSET, TYPE } from './tokens'
import { SurfaceFrame } from './SurfaceFrame'
import { useEditingInSurface } from './editing'

/**
 * THE APPLICATION IS THE SCREEN. THE CONVERSATION IS A DRAWER ON IT.
 *
 * What this replaced gave chat a permanent, uncollapsible region at the bottom
 * of every opened application — a fixed share whatever it held and whether or
 * not there was anything to say. Opening Calendar meant looking at a calendar
 * squeezed into the top half with a "What would you like to do?" bubble
 * occupying the rest, and there was no gesture, control or state that made the
 * bubble go away. The application he opened was never the main thing on screen.
 *
 * So the conversation now has three states and starts in the smallest:
 *
 *   closed    the composer alone. THE DEFAULT. The application has the screen.
 *   peek      ~30% — the last exchange, entered automatically when something is
 *             actually said, because an answer he asked for must be visible.
 *   full      ~62% — for reading something long, and only ever by his hand.
 *
 * The seam between them is a real control: it names the state, shows what is
 * waiting when the panel is closed, drags continuously, and taps to toggle. A
 * region that cannot be dismissed is not a panel, it is a wall, and that is
 * what this was.
 *
 * WHAT THE APPLICATION IS GUARANTEED.
 *
 * `minmax(0, 1fr)` on the surface row and a hard cap on the chat row: the
 * application always takes everything the conversation is not using, and the
 * conversation can never take more than `SHARE.full`. A thread's length is not
 * a request for more of the screen; neither is a model that likes talking.
 *
 * Both scrollers set `overscroll-behavior: contain`, which stops a flick that
 * reaches the end of the chat from chaining into the page — the same mechanism
 * that keeps a Maps drag from turning into a page scroll.
 */

export type ChatSnap = 'closed' | 'peek' | 'full'

/** Fractions of the workspace the conversation may occupy in each state. */
const SHARE: Record<ChatSnap, number> = { closed: 0, peek: 0.3, full: 0.62 }

/** The conversation never shrinks below one exchange, so the seam stays legible. */
const FLOOR = 92

/** Drag physics, matched to the decks and the Home overlay. */
const FLICK = 0.5

/** Where each surface's chat was last scrolled to, and how open it was. */
const chatScroll = new Map<string, number>()
const chatOpen = new Map<string, ChatSnap>()

/**
 * THE SEAM.
 *
 * Application above, conversation below, and the eye must be able to find the
 * line between them without reading anything. Three quiet cues, together, so no
 * single one has to be loud: the application sits on a slightly raised plane, a
 * hairline runs under it with a highlight above and a shadow below, and the
 * conversation sits on a plane recessed below the shell.
 */
const SURFACE_PLANE = 'background:rgba(255,255,255,.028);'
const CHAT_PLANE = 'background:rgba(0,0,0,.22);'
const SEAM =
  'box-shadow:inset 0 -1px 0 rgba(255,255,255,.10), 0 1px 0 rgba(0,0,0,.55), 0 6px 16px rgba(0,0,0,.35);'

export function SurfaceWorkspace({
  header, surface, status, chat, chips, composer, scrollKey, messages = 0, latest,
}: {
  header: ReactNode
  /** One quiet line at the seam: what the surface just did, or is doing. */
  status?: ReactNode
  /**
   * THE domain application. Exactly one, and it owns the whole frame.
   *
   * Not a fragment of surface-ish pieces: no stats row, no action bar, no
   * filter strip alongside it. Anything belonging to the domain is rendered
   * BY the domain, inside `SurfaceFrame`. There is deliberately no second slot
   * here to put such things in.
   */
  surface: ReactNode
  chat: ReactNode
  chips?: ReactNode
  composer: ReactNode
  /** Surface identity — chat scroll position and open state are restored per surface. */
  scrollKey: string
  /** How many messages the thread holds. Growth is what "something was said" means. */
  messages?: number
  /** The most recent line, previewed on the seam while the panel is closed. */
  latest?: string
}) {
  const chatRef = useRef<HTMLDivElement>(null)
  const restored = useRef(false)

  /**
   * FOCUS MODE — the application, the editor, and nothing else.
   *
   * While he is typing into the surface the workspace stops presenting itself.
   * Header, seam, chat handle, conversation, chips and the assistant's own
   * composer all collapse to zero, and the surface takes every pixel above the
   * keyboard. Measured on the case that prompted it: writing a mail reply went
   * from 118px of usable editor out of 538px to the whole of it.
   *
   * The rows are HIDDEN, not unmounted — `display:none` collapses a grid track
   * exactly as well and keeps `SurfaceFrame` mounted, which matters because
   * unmounting it would take the half-written draft and the focus with it, and
   * the mode would end the instant it began.
   */
  const editing = useEditingInSurface()

  const [snap, setSnap] = useState<ChatSnap>(() => chatOpen.get(scrollKey) ?? 'closed')
  /** Live height while a finger is down. null when the snap state governs. */
  const [dragH, setDragH] = useState<number | null>(null)
  const drag = useRef<{ y: number; h: number; t: number } | null>(null)

  /**
   * The workspace's own height, measured.
   *
   * A `max-height:62%` on a grid item resolves against a track that is itself
   * being sized by that item — circular, and browsers resolve it to "no limit".
   * Home solves the same problem the same way, and `viewport.ts` is still the
   * only thing that reads the window.
   */
  const box = useRef<HTMLDivElement>(null)
  const [boxH, setBoxH] = useState(0)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const read = () => setBoxH(Math.round(el.clientHeight))
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const heightFor = (s: ChatSnap) => (s === 'closed' ? 0 : Math.max(FLOOR, Math.round(boxH * SHARE[s])))
  const height = dragH ?? heightFor(snap)
  const open = snap !== 'closed'

  const go = (s: ChatSnap) => { setSnap(s); chatOpen.set(scrollKey, s) }

  // A different surface has its own conversation and its own idea of how much
  // of it he wanted to see.
  useEffect(() => {
    restored.current = false
    setSnap(chatOpen.get(scrollKey) ?? 'closed')
  }, [scrollKey])

  /**
   * AN ANSWER HE ASKED FOR IS NOT ALLOWED TO BE INVISIBLE.
   *
   * The panel defaults closed, which would silently swallow replies if nothing
   * brought it back. So a thread that grew opens it — to `peek`, never to
   * `full`. Growing the panel past that is his decision; showing him the reply
   * is the app's obligation, and those are two different sizes.
   */
  const [seen, setSeen] = useState(messages)
  const unread = Math.max(0, messages - seen)
  useEffect(() => {
    if (open) setSeen(messages)
    else if (messages > seen) go('peek')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, open])

  useEffect(() => {
    const el = chatRef.current
    if (!el || !open) return
    if (!restored.current) {
      const at = chatScroll.get(scrollKey)
      el.scrollTop = at ?? el.scrollHeight
      restored.current = true
      return
    }
    // Follow the conversation only when he is already near the bottom, so a new
    // message never yanks him away from something he scrolled up to read.
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight
  })

  const remember = () => {
    const el = chatRef.current
    if (el) chatScroll.set(scrollKey, el.scrollTop)
  }

  const snapTo = (h: number, velocity: number) => {
    if (velocity < -FLICK) return go(h > heightFor('peek') ? 'full' : 'peek')
    if (velocity > FLICK) return go(h < heightFor('peek') ? 'closed' : 'peek')
    const options: ChatSnap[] = ['closed', 'peek', 'full']
    let best: ChatSnap = 'closed'
    let bestD = Infinity
    for (const s of options) {
      const d = Math.abs(h - heightFor(s))
      if (d < bestD) { bestD = d; best = s }
    }
    go(best)
  }

  const onDown = (e: React.PointerEvent) => {
    drag.current = { y: e.clientY, h: height, t: e.timeStamp }
    // Capture is an ENHANCEMENT — it keeps a finger that slides off the handle
    // still dragging the panel — and it throws `NotFoundError` for any pointer
    // the browser is not actively tracking. Unguarded, that exception aborts
    // the rest of this handler and the drag never starts. Map.tsx learned this
    // and wrapped it; the other three copies did not, so the lesson is applied
    // everywhere it exists rather than where it was first noticed.
    try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId) } catch { /* not tracked */ }
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    setDragH(Math.max(0, Math.min(boxH * 0.72, d.h - (e.clientY - d.y))))
  }
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    const dy = e.clientY - d.y
    setDragH(null)
    // A press that never moved is a tap, and a tap toggles rather than snapping
    // to wherever a stationary finger happens to sit.
    if (Math.abs(dy) < 6) return go(open ? 'closed' : 'peek')
    snapTo(Math.max(0, d.h - dy), dy / Math.max(1, e.timeStamp - d.t))
  }

  return (
    /*
      A grid rather than a flex column, so the rows are sized by the WORKSPACE
      rather than negotiated between the two things inside it.

      `minmax(0, …)` everywhere rather than bare track sizes: without the
      explicit 0 minimum a grid row refuses to shrink below its content, which
      is how a tall widget would push the chat off the bottom.

      THE COLUMN NEEDS THE SAME RULE, AND NOT HAVING IT COST THE WAY OUT.

      The rows were reasoned about carefully and the single implicit COLUMN was
      left at `auto` — which takes its minimum from the widest row's min-content.
      One row was wide: the chat handle, whose preview line is the surface's
      opening sentence ("6 in the last week from 5 senders. Newest: …"). Its
      min-content dragged the whole track to 464px inside a 402px phone, so
      every row — header included — was laid out 62px too wide, and `close`, the
      only way back to Home, was rendered from x=397 to x=446 on a 402px screen.
      `elementFromPoint` at its centre returned null: not merely hard to hit,
      not present. An opened application became a one-way trip.

      `minmax(0, 1fr)` is the same statement as the rows: the WORKSPACE decides
      the width, content adapts to it. Nothing inside may widen the frame.
    */
    <div
      ref={box}
      data-frame="workspace"
      style={css(
        'flex:1; min-width:0; min-height:0; display:grid; grid-template-columns: minmax(0, 1fr); ' +
        // header · APPLICATION · status · seam · conversation · chips · composer
        (editing
          ? 'grid-template-rows: minmax(0, 1fr); '
          : 'grid-template-rows: auto minmax(0, 1fr) auto auto minmax(0, auto) auto auto; ') +
        'animation:cruExpand .3s cubic-bezier(.2,.7,.2,1);',
      )}
    >
      {!editing && header}

      {/*
        THE SURFACE BUDGET. Everything the conversation is not using.

        A renderer that does not fit compresses itself — horizontal rails,
        tighter toolbars, progressive disclosure, internal scrolling. It does
        not get more height, and it no longer gets less than half of the screen
        because a chat panel was told to be there whether or not it had anything
        to say.
      */}
      <SurfaceFrame plane={SURFACE_PLANE + SEAM}>{surface}</SurfaceFrame>

      {/*
        The seam's own row. It carries the surface's status line when there is
        one — which is where retrieval and refresh chatter goes now that chat
        does not carry it. With nothing to say it is a 0px row.
      */}
      {!editing && <div style={css('min-height:0; ' + CHAT_PLANE)}>{status}</div>}

      {/*
        THE HANDLE. The control that was missing.

        It is a button, a drag target, and — while the panel is closed — the
        only place the last thing said is visible. Closed, it reads as an
        invitation; open, as a way out. Either way it is 26px, which is the
        entire permanent cost of the conversation on an opened application.
      */}
      {!editing && (
      <div
        data-role="chat-handle"
        data-snap={snap}
        role="button"
        tabIndex={-1}
        aria-label={open ? 'collapse the conversation' : 'open the conversation'}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        /* `min-width:0` because this row carries a nowrap sentence: without it
           the row's min-content is the whole sentence, and a grid item that
           cannot shrink is a grid item that sets the track. See the column
           note above — this is the same bug prevented a second way. */
        style={cssv`display:flex; align-items:center; gap:8px; padding:6px ${INSET.page}px; min-width:0;
          touch-action:none; cursor:${open ? 'grab' : 'pointer'}; ${CHAT_PLANE}
          box-shadow:inset 0 1px 0 rgba(255,255,255,.05);`}
      >
        <div style={css('width:26px; height:3px; flex:none; border-radius:999px; background:rgba(237,238,241,.28);')} />
        {!open && (
          <div style={cssv`flex:1; min-width:0; font-size:${TYPE.small}; color:rgba(237,238,241,.40);
            white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`}>
            {latest || 'Ask about this'}
          </div>
        )}
        {open && <div style={css('flex:1;')} />}
        {unread > 0 && !open && (
          <div style={cssv`flex:none; padding:1px 7px; border-radius:999px; background:rgba(240,165,107,.18);
            font-size:${TYPE.micro}; color:#F0A56B;`}>{unread} new</div>
        )}
        <div style={cssv`flex:none; font-size:${TYPE.micro}; color:rgba(237,238,241,.34);`}>
          {open ? '▾' : '▴'}
        </div>
      </div>
      )}

      {/*
        THE CONVERSATION. Capped, scrolling internally, and zero when closed.
      */}
      {!editing && (
      <div
        ref={chatRef}
        data-frame="chat"
        data-snap={snap}
        onScroll={remember}
        style={cssv`min-height:0; height:${height}px; overflow-y:auto; overscroll-behavior:contain;
          -webkit-overflow-scrolling:touch; padding:${open ? `8px ${INSET.page}px 4px` : '0'};
          display:flex; flex-direction:column; ${CHAT_PLANE}
          transition:${dragH === null ? 'height .24s cubic-bezier(.25,.8,.3,1)' : 'none'};`}
      >
        {/*
          The thread hugs the composer.

          `margin-top:auto` rather than `justify-content:flex-end`, which looks
          identical and silently makes the TOP of an overflowing thread
          unreachable in every WebKit build. This pushes a short conversation
          down to the seam and does nothing at all once it is taller than the
          box.
        */}
        {open && (
          <div style={css('margin-top:auto; display:flex; flex-direction:column; gap:10px;')}>
            {chat}
          </div>
        )}
      </div>
      )}

      {!editing && <div style={css(CHAT_PLANE)}>{chips}</div>}
      {!editing && <div style={css(CHAT_PLANE)}>{composer}</div>}
    </div>
  )
}
