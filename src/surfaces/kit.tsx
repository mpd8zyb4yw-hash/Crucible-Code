import { useEffect, useRef, useState } from 'react'
import { css, cssv } from '../css'
import type { WidgetAction } from '../api'
import type { Operation } from '../surface/types'
import { CHROME, RADIUS, TYPE } from '../tokens'
import { useEditingInSurface } from '../editing'

/**
 * The furniture every surface is built out of.
 *
 * Pulled out of `Widgets.tsx` when the domain renderers arrived, so a card, a
 * chip and a confirmed action look identical in the mailbox, the calendar and
 * the watch dashboard without three copies of the same style string drifting
 * apart. Nothing here introduces a colour: the palette comes from `heat.ts`.
 */

export const CARD = 'border-radius:15px; background:rgba(255,255,255,.05); box-shadow:inset 0 0 0 1px rgba(255,255,255,.07);'

export type Act = (action: WidgetAction) => Promise<void>

export function Empty({ text }: { text: string }) {
  return (
    <div style={cssv`padding:20px 15px; text-align:center; font-size:12.5px; color:rgba(237,238,241,.38); ${CARD}`}>
      {text}
    </div>
  )
}

/**
 * A pill.
 *
 * `on` is the only state it has, and it is always driven from surface state
 * rather than from a local `useState` — a chip that remembered its own
 * selection would be a second copy of the truth, and the model changing the
 * filter would leave the chip looking unpressed.
 */
export function Chip({
  label, on, onClick, dim,
}: {
  label: string
  on?: boolean
  onClick?: () => void
  dim?: boolean
}) {
  return (
    <div
      onClick={onClick}
      style={cssv`flex:none; padding:6px 12px; border-radius:999px; font-size:11.5px; cursor:${onClick ? 'pointer' : 'default'}; white-space:nowrap; background:rgba(255,255,255,${on ? '.14' : '.05'}); box-shadow:inset 0 0 0 1px rgba(255,255,255,${on ? '.18' : '.08'}); color:rgba(237,238,241,${on ? '.95' : dim ? '.4' : '.6'});`}
    >
      {label}
    </div>
  )
}

/** A small row of numbers under a heading. */
export function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={cssv`flex:1; min-width:0; padding:9px 11px; ${CARD}`}>
      <div style={css('font-size:10.5px; color:rgba(237,238,241,.45); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>{label}</div>
      <div style={cssv`margin-top:3px; font-size:15px; font-weight:600; letter-spacing:-.02em; color:${accent ?? 'rgba(237,238,241,.92)'};`}>{value}</div>
    </div>
  )
}

/**
 * Action buttons.
 *
 * An action marked irreversible asks first, in place, every time — sending mail
 * or cancelling an event is visible to someone else and cannot be taken back,
 * and a mis-tap on a phone is not a decision. The confirmation is the same
 * button turning into "sure?" rather than a modal, so it stays inside the card.
 */
export function Actions({
  actions,
  onAction,
  intercept,
}: {
  actions: WidgetAction[]
  onAction: Act
  /** Handle an action in the client instead of sending it. True = handled. */
  intercept?: (a: WidgetAction) => boolean
}) {
  const [busy, setBusy] = useState<number | null>(null)
  const [confirming, setConfirming] = useState<number | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  const run = async (a: WidgetAction, i: number) => {
    if (busy !== null) return
    if (intercept?.(a)) return
    if (a.irreversible && confirming !== i) { setConfirming(i); return }
    setConfirming(null)
    setBusy(i)
    setFailed(null)
    try {
      await onAction(a)
    } catch (e) {
      setFailed((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={css('display:flex; flex-direction:column; gap:6px;')}>
      <div style={css('display:flex; gap:7px; flex-wrap:wrap;')}>
        {actions.map((a, i) => (
          <div
            key={i}
            onClick={(e) => { e.stopPropagation(); void run(a, i) }}
            style={a.primary
              ? cssv`padding:8px 14px; border-radius:999px; background:rgba(237,238,241,${busy === null ? '.9' : '.4'}); color:#101012; font-size:12.5px; font-weight:600; cursor:pointer; white-space:nowrap;`
              : cssv`padding:8px 14px; border-radius:999px; background:rgba(255,255,255,.06); box-shadow:inset 0 0 0 1px rgba(255,255,255,.14); font-size:12.5px; color:rgba(237,238,241,${busy === null ? '.82' : '.4'}); cursor:pointer; white-space:nowrap;`}
          >
            {busy === i ? (a.busy ?? 'Working…') : confirming === i ? `${a.label} — sure?` : a.label}
          </div>
        ))}
      </div>
      {failed && (
        <div style={css('font-size:11.5px; color:rgba(255,170,170,.8); line-height:1.45;')}>{failed}</div>
      )}
    </div>
  )
}

/**
 * The line a surface prints about what just happened to it.
 *
 * Every operation says something, whoever ran it, so a change he did not make
 * is never silent. It is deliberately quiet typography: this is a receipt, not
 * an announcement.
 */
export function Note({ text }: { text: string | null }) {
  if (!text) return null
  return (
    <div style={css('padding:1px 3px; font-size:11px; line-height:1.4; color:rgba(240,165,107,.72);')}>
      {text}
    </div>
  )
}

/**
 * Operation state, drawn inside the surface that owns it.
 *
 * This is the visible half of the operation runtime. It exists because the
 * only evidence that a search was happening used to be a sentence in chat and
 * a `busy` string in a component — neither of which anything was obliged to
 * clear, which is how "Searching for scary stories." became permanent.
 *
 * Terminal states are not silent: a search that legitimately found nothing
 * says so, because an empty surface and a failed request look identical and
 * mean opposite things.
 */
export function Op({ op, onRetry, onCancel }: {
  op: Operation | null
  onRetry?: () => void
  onCancel?: () => void
}) {
  if (!op) return null
  const live = op.status === 'running' || op.status === 'requested' || op.status === 'partial'

  // A completed operation that produced results needs no chrome — the results
  // ARE the report. Only a zero-result completion has something to say.
  if (op.status === 'completed' && (op.resultCount ?? 0) > 0) return null

  const text = live
    ? (op.status === 'partial'
        ? `${op.resultCount ?? 0} so far${op.phase ? ` · ${op.phase}` : ''}…`
        : `${verb(op.kind)}${op.phase ? ` · ${op.phase}` : ''}…`)
    : op.status === 'completed'
      ? 'Nothing matched.'
      : op.reason ?? 'It failed.'

  const bad = !live && op.status !== 'completed'
  return (
    <div style={cssv`display:flex; align-items:center; gap:8px; padding:7px 10px; border-radius:12px;
      background:${bad ? 'rgba(224,122,95,.10)' : 'rgba(255,255,255,.04)'};
      box-shadow:inset 0 0 0 1px ${bad ? 'rgba(224,122,95,.22)' : 'rgba(255,255,255,.07)'};
      font-size:11.5px; color:${bad ? 'rgba(240,150,130,.92)' : 'rgba(237,238,241,.62)'};`}>
      {live && <Spinner />}
      <div style={css('flex:1; min-width:0;')}>{text}</div>
      {live && op.cancellable && onCancel && (
        <div onClick={onCancel} style={tap}>stop</div>
      )}
      {!live && op.retryable && onRetry && (
        <div onClick={onRetry} style={tap}>retry</div>
      )}
    </div>
  )
}

const tap = css('flex:none; cursor:pointer; opacity:.8; text-decoration:underline; text-underline-offset:2px;')

const verb = (kind: string) =>
  kind === 'search' ? 'Searching'
  : kind === 'route' ? 'Finding a route'
  : kind === 'locate' ? 'Getting your location'
  : kind === 'refresh' ? 'Refreshing'
  : 'Working'

function Spinner() {
  return (
    <div style={css('flex:none; width:9px; height:9px; border-radius:999px; border:1.5px solid rgba(237,238,241,.25); border-top-color:rgba(237,238,241,.75); animation:cruSpin .7s linear infinite;')} />
  )
}

/**
 * The one compact toolbar every domain application uses.
 *
 * A single fixed-height row: context on the left, one or two high-frequency
 * actions on the right, and everything else behind `more`. This replaces the
 * stacks of pill rows each surface had grown — capability does not justify
 * permanent pixels, and anything the toolbar cannot hold is still reachable
 * through the overflow sheet or by simply asking for it in chat.
 */
export function Toolbar({ left, right, more }: {
  left?: React.ReactNode
  right?: React.ReactNode
  /** Secondary controls, revealed on demand rather than always resident. */
  more?: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div style={css('flex:none; display:flex; flex-direction:column; gap:6px;')}>
      <div style={cssv`display:flex; align-items:center; gap:6px; height:${CHROME.toolbar}px; flex:none;`}>
        {left}
        <div style={css('flex:1; min-width:0;')} />
        {right}
        {more && (
          <div
            onClick={() => setOpen((v) => !v)}
            style={cssv`flex:none; width:${CHROME.control}px; height:${CHROME.control}px; border-radius:999px;
              display:flex; align-items:center; justify-content:center; cursor:pointer; font-size:14px;
              background:rgba(255,255,255,${open ? '.14' : '.05'});
              box-shadow:inset 0 0 0 1px rgba(255,255,255,${open ? '.18' : '.08'});
              color:rgba(237,238,241,.7);`}
          >⋯</div>
        )}
      </div>
      {open && more && <Bar>{more}</Bar>}
    </div>
  )
}

/** A segmented control. One row, no wrapping, for mutually exclusive views. */
export function Segments<T extends string>({ value, options, onChange }: {
  value: T
  options: { v: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div style={cssv`flex:none; display:flex; gap:1px; padding:2px; border-radius:999px;
      background:rgba(255,255,255,.05); box-shadow:inset 0 0 0 1px rgba(255,255,255,.07);`}>
      {options.map((o) => (
        <div
          key={o.v}
          onClick={() => onChange(o.v)}
          style={cssv`padding:4px 10px; border-radius:999px; font-size:11px; cursor:pointer; white-space:nowrap;
            background:${value === o.v ? 'rgba(255,255,255,.14)' : 'transparent'};
            color:rgba(237,238,241,${value === o.v ? '.95' : '.5'});`}
        >{o.label}</div>
      ))}
    </div>
  )
}

/** A round icon button. The compact form of a secondary action. */
export function IconButton({ glyph, onClick, title }: { glyph: string; onClick?: () => void; title?: string }) {
  return (
    <div
      onClick={onClick}
      title={title}
      style={cssv`flex:none; width:${CHROME.control}px; height:${CHROME.control}px; border-radius:999px;
        display:flex; align-items:center; justify-content:center; cursor:pointer; font-size:13px;
        background:rgba(255,255,255,.05); box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);
        color:rgba(237,238,241,.72);`}
    >{glyph}</div>
  )
}

/**
 * THE ONE BOUNDED DRAWER.
 *
 * Contextual detail — a reply, an event's particulars, a video's description, a
 * watch's settings — may REALLOCATE space inside a surface. It may never expand
 * the surface. Six renderers were each solving that separately and two of them
 * had already got it wrong: Calendar's detail sheet, then Mail's reply
 * composer, which grew with the draft until it was cut off by the frame edge
 * with the send button on the wrong side of it.
 *
 * What makes this safe is not the styling, it is the three rules it applies
 * that nobody remembers to apply by hand:
 *
 *   · it is anchored to the surface root, which is clipped by `SurfaceFrame`,
 *     so it cannot paint over chat however tall its contents want to be;
 *   · its height is a SHARE of the surface, so the frame decides, not the
 *     content — and the body scrolls internally once that share is used up;
 *   · what it covers stays mounted underneath, so closing it returns to
 *     exactly the state it opened over.
 *
 * The surface root it is placed in must be `position:relative`.
 */
export function BoundedDrawer({
  title, sub, onClose, children, footer, share = 0.74,
}: {
  title: string
  sub?: string
  onClose: () => void
  children: React.ReactNode
  /** Pinned below the scrolling body — actions must never scroll out of reach. */
  footer?: React.ReactNode
  /** Fraction of the surface this may occupy at most. */
  share?: number
}) {
  /**
   * WHILE HE IS TYPING IN IT, THE DRAWER IS THE WHOLE APPLICATION.
   *
   * A reply editor given 74% of a frame that has itself been squeezed by the
   * keyboard is a 118px textarea with a mailbox visible above it that he cannot
   * act on and would not want to. The share becomes the whole frame the moment
   * a field inside has focus, and goes back the moment it does not.
   */
  const editing = useEditingInSurface()
  const takes = editing ? 1 : share

  return (
    <>
      {/*
        THE APPLICATION BEHIND A DETAIL STAYS LEGIBLE AND STAYS LIVE.

        This was `rgba(6,6,8,.5)` over a `backdrop-filter: blur(1.5px)` across
        the whole surface, and it turned opening one event into losing the
        calendar: the grid, the week header, the D/W/M control and the
        navigation arrows all went to an unreadable smear, and every one of them
        stopped responding, because the scrim also swallowed the tap. A sheet
        about one event is not a modal about the application.

        So the dim is a soft gradient with NO blur, and it is
        `pointer-events:none`. Both consequences are deliberate: the grid stays
        readable underneath, and tapping another event switches the detail to
        THAT event instead of dismissing this one — which is what someone
        comparing two things is trying to do. The ✕ closes it.
      */}
      <div
        aria-hidden="true"
        style={css(
          'position:absolute; inset:0; z-index:8; pointer-events:none; animation:cruFade .18s ease;' +
          (editing ? 'background:#0E0E11;' : 'background:linear-gradient(180deg, rgba(6,6,8,0) 38%, rgba(6,6,8,.44) 100%);'),
        )}
      />
      <div
        data-role="drawer"
        style={cssv`position:absolute; left:0; right:0; bottom:0; z-index:9; box-sizing:border-box;
          max-height:${Math.round(takes * 100)}%; height:${editing ? '100%' : 'auto'};
          display:flex; flex-direction:column;
          border-radius:${editing ? '0' : `${RADIUS.panel}px ${RADIUS.panel}px 0 0`}; overflow:hidden;
          background:linear-gradient(180deg, rgba(30,31,36,.99), rgba(20,21,25,.99));
          box-shadow:inset 0 1px 0 rgba(255,255,255,.10), 0 -10px 30px rgba(0,0,0,.5);
          animation:cruDrawer .22s cubic-bezier(.2,.7,.2,1);`}
      >
        <div style={cssv`flex:none; display:flex; align-items:center; gap:8px; padding:9px 12px 7px;
          box-shadow:inset 0 -1px 0 rgba(255,255,255,.07);`}>
          <div style={css('flex:1; min-width:0;')}>
            <div style={cssv`font-size:${TYPE.small}; font-weight:600; letter-spacing:-.01em;
              color:rgba(237,238,241,.92); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`}>
              {title}
            </div>
            {sub && (
              <div style={cssv`margin-top:1px; font-size:${TYPE.micro}; color:rgba(237,238,241,.42);
                white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`}>{sub}</div>
            )}
          </div>
          <div
            data-role="drawer-close"
            onClick={onClose}
            style={cssv`flex:none; width:${CHROME.control}px; height:${CHROME.control}px; border-radius:999px;
              display:flex; align-items:center; justify-content:center; cursor:pointer; font-size:13px;
              background:rgba(255,255,255,.06); color:rgba(237,238,241,.66);`}
          >✕</div>
        </div>

        {/*
          The body absorbs everything. `min-height:0` is what makes the scroll
          happen here instead of the drawer growing past its share.

          A COLUMN, so a child that declares `flex:1` fills it. That is what
          lets a reply editor become the whole drawer while he is typing —
          without it the textarea kept its `rows={5}` height and sat in 366px of
          empty drawer, which is the same wasted screen one level further in.
        */}
        <div style={css('flex:1; min-height:0; overflow-y:auto; overscroll-behavior:contain; -webkit-overflow-scrolling:touch; padding:10px 12px; display:flex; flex-direction:column;')}>
          {children}
        </div>

        {footer && (
          <div style={css('flex:none; padding:8px 12px 10px; box-shadow:inset 0 1px 0 rgba(255,255,255,.07);')}>
            {footer}
          </div>
        )}
      </div>
    </>
  )
}

/**
 * HORIZONTAL PAGING, WITHOUT TAKING VERTICAL MOVEMENT AWAY.
 *
 * The axis is decided once, on the first few pixels of movement, and never
 * revisited for that gesture — which is what stops a diagonal flick from both
 * scrolling the hours and jumping a week. Below the threshold nothing is
 * claimed at all, so a tap on an event is still a tap.
 *
 * `touch-action:pan-y` is the other half and is not optional: it tells the
 * browser this element handles horizontal movement itself while native vertical
 * scrolling continues to work, which is what keeps the grid's own scroller
 * smooth on iOS instead of being driven from JavaScript.
 */
export function Swipe({
  onNext, onPrev, children,
}: {
  onNext: () => void
  onPrev: () => void
  children: React.ReactNode
}) {
  const from = useRef<{ x: number; y: number; axis: 'x' | 'y' | null } | null>(null)

  return (
    <div
      data-role="swipe"
      onPointerDown={(e) => { from.current = { x: e.clientX, y: e.clientY, axis: null } }}
      onPointerMove={(e) => {
        const f = from.current
        if (!f || f.axis) return
        const dx = e.clientX - f.x
        const dy = e.clientY - f.y
        if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return
        f.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
      }}
      onPointerUp={(e) => {
        const f = from.current
        from.current = null
        if (!f || f.axis !== 'x') return
        const dx = e.clientX - f.x
        // A real page, not a wobble. 48px is roughly a thumb's width of travel.
        if (Math.abs(dx) < 48) return
        dx < 0 ? onNext() : onPrev()
      }}
      onPointerCancel={() => { from.current = null }}
      style={css('flex:1; min-height:0; overflow-y:auto; overscroll-behavior:contain; -webkit-overflow-scrolling:touch; position:relative; touch-action:pan-y;')}
    >
      {children}
    </div>
  )
}

/** A toolbar row that scrolls sideways rather than wrapping on a 375px screen. */
export function Bar({ children }: { children: React.ReactNode }) {
  return (
    <div style={css('display:flex; gap:6px; align-items:center; overflow-x:auto; padding-bottom:2px; -webkit-overflow-scrolling:touch;')}>
      {children}
    </div>
  )
}

export const clockOf = (iso: string, hour12 = true) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12 })
}

/**
 * ONE CONVENTION, NOT TWO.
 *
 * `at.slice(5, 10)` is a substring of an ISO string, so past a week the column
 * switched from "5d ago" to `08-11` — a bare month-day, in a format nobody
 * speaks, mixed into a list whose other rows were relative. His Mail list had
 * all three at once: `5d ago`, `08-11`, `08-08`.
 *
 * A weekday inside the fortnight and a real date beyond it, which is how a
 * person refers to a message they have not read yet.
 */
export function shortWhen(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return at
  const days = Math.round((Date.now() - d.getTime()) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  if (days < 14) return d.toLocaleDateString(undefined, { weekday: 'short' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** "1h 04m", "22 min". Blank when nothing knows the duration. */
export function runtime(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds)) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`
}

/**
 * A FIELD HE CAN ACTUALLY CHANGE.
 *
 * Every surface in this app could show him a fact and none of them could let
 * him correct one. The event was called "Comic concert in avano 9PM", the name
 * was wrong, and the only route to fixing it was to describe the problem to a
 * chat panel that had no verb for renaming anything — so the app agreed the
 * name was wrong, said it was fixing it, refreshed, and showed him the same
 * wrong name again. A surface that displays a value it will not let him edit is
 * a screenshot of his life, not a way of living it.
 *
 * The editor is not mounted until he taps, which is the whole of the
 * no-accidental-keyboard rule here: reading a detail must never raise a
 * keyboard, and there is no focused input to raise one from until he asks for
 * it. Escape and blur cancel; Enter and the tick commit.
 */
export function EditableRow({
  label, value, placeholder, onSave, multiline = false,
}: {
  label: string
  value: string
  placeholder?: string
  /** Throws to keep the editor open with the error shown. */
  onSave: (next: string) => Promise<void>
  multiline?: boolean
}) {
  /**
   * FOCUS MODE HAS TO REACH THE FIELD, NOT JUST THE FRAME.
   *
   * The workspace already collapses its header, seam, chat and composer the
   * moment something inside the surface has focus, and `BoundedDrawer` already
   * takes the whole frame. Both of those worked. What arrived in the space they
   * cleared was a `rows={3}` textarea: 66px of editor at the top of a 724px
   * drawer, with 430px of black under it and the fourth line of the note cut
   * through the middle of its letters.
   *
   * That is the SAME defect the mail composer was fixed for — a fixed intrinsic
   * height inside a frame that had just been given the screen — and fixing it
   * only in Mail is what left Calendar like this. So it is fixed here, in the
   * shared field, and every surface that grows an editable row gets it.
   */
  const surfaceEditing = useEditingInSurface()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null)

  // The value can change underneath a closed editor — a refresh, an undo, a
  // change he made in Google. It must not clobber a draft he is mid-way through.
  useEffect(() => { if (!editing) setDraft(value) }, [value, editing])

  const open = () => { setFailed(null); setDraft(value); setEditing(true) }
  useEffect(() => {
    if (editing) field.current?.focus()
  }, [editing])

  const commit = async () => {
    const next = draft.trim()
    if (!next || next === value) { setEditing(false); return }
    setBusy(true)
    setFailed(null)
    try {
      await onSave(next)
      setEditing(false)
    } catch (e) {
      // Kept open, with the draft intact: a failed save that discards what he
      // typed asks him to type it a second time to find out it still fails.
      setFailed((e as Error).message || 'That didn’t save.')
    } finally {
      setBusy(false)
    }
  }

  if (!editing) {
    return (
      <div
        data-role="editable"
        onClick={open}
        style={css('display:flex; gap:10px; align-items:baseline; cursor:text; padding:2px 0;')}
      >
        <div style={css('flex:none; width:30%; font-size:11px; color:rgba(237,238,241,.4);')}>{label}</div>
        <div style={css('flex:1; min-width:0; font-size:12px; color:rgba(237,238,241,.8); text-wrap:pretty;')}>
          {value || <span style={css('color:rgba(237,238,241,.3);')}>{placeholder ?? 'Not set'}</span>}
        </div>
        <div
          aria-hidden="true"
          style={css('flex:none; font-size:10.5px; color:rgba(237,238,241,.3);')}
        >edit</div>
      </div>
    )
  }

  /**
   * Does this field get the room the mode just cleared?
   *
   * Only a multiline field, and only while the surface is genuinely in focus
   * mode. A one-line name stretched to 600px would be the same mistake in the
   * other direction — the space belongs to whatever is actually being written,
   * and a name is one line however much screen happens to be free.
   */
  const fill = multiline && surfaceEditing

  const fieldStyle = css(
    'flex:1; min-width:0; padding:8px 10px; border-radius:10px; border:0; outline:0; resize:none;' +
    'font-family:inherit; font-size:13px; line-height:1.4; color:rgba(237,238,241,.95);' +
    'background:rgba(255,255,255,.07); box-shadow:inset 0 0 0 1px rgba(255,255,255,.14);' +
    // A FLOOR, NOT A HEIGHT — the same distinction the mail composer makes.
    // `rows={3}` stays the size it was whenever the drawer is only a share of
    // the frame; when the frame IS the editor, the field takes the frame.
    (fill ? 'min-height:96px; height:100%;' : ''),
  )
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); setEditing(false) }
    if (e.key === 'Enter' && !e.shiftKey && !multiline) { e.preventDefault(); void commit() }
  }
  return (
    <div
      data-role="editing"
      /* This row ASKS for focus mode, and earns it: it carries its own ✓ and ✕,
         and it only ever appears inside a drawer that carries ✕ too. A field
         that takes the whole frame must provide the way back off it — see
         editing.ts for the toolbar search box that did not. */
      data-editor="frame"
      data-fill={fill ? 'yes' : undefined}
      style={css('display:flex; flex-direction:column; gap:6px; padding:2px 0;' + (fill ? ' flex:1; min-height:0;' : ''))}
    >
      <div style={css('font-size:11px; color:rgba(237,238,241,.4);')}>{label}</div>
      <div style={css(
        'display:flex; gap:7px;' +
        // `stretch` is what lets the field take the row's height. The controls
        // keep their own 28px and pin to the BOTTOM of it, beside where the
        // writing ends rather than floating next to its first line.
        (fill ? ' flex:1; min-height:0; align-items:stretch;' : ' align-items:flex-end;'),
      )}>
        {multiline ? (
          <textarea
            ref={field}
            value={draft}
            disabled={busy}
            rows={3}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={keys}
            style={fieldStyle}
          />
        ) : (
          <input
            ref={field}
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={keys}
            style={fieldStyle}
          />
        )}
        <div
          data-role="editable-save"
          onClick={() => void commit()}
          style={cssv`flex:none; align-self:flex-end; width:${CHROME.control}px; height:${CHROME.control}px; border-radius:999px;
            display:flex; align-items:center; justify-content:center; cursor:pointer; font-size:13px;
            background:rgba(237,238,241,${busy ? '.35' : '.9'}); color:#0B0B0D;`}
        >{busy ? '·' : '✓'}</div>
        <div
          data-role="editable-cancel"
          onClick={() => setEditing(false)}
          style={cssv`flex:none; align-self:flex-end; width:${CHROME.control}px; height:${CHROME.control}px; border-radius:999px;
            display:flex; align-items:center; justify-content:center; cursor:pointer; font-size:12px;
            background:rgba(255,255,255,.06); color:rgba(237,238,241,.6);`}
        >✕</div>
      </div>
      {failed && (
        <div style={css('font-size:11px; line-height:1.4; color:#F0938B;')}>{failed}</div>
      )}
    </div>
  )
}
