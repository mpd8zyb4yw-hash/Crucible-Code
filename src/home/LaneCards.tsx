import { useLayoutEffect, useRef, useState } from 'react'
import { useMeasured, useRootFontPx } from '../fit'
import { css, cssv } from '../css'
import { CLAMP, RADIUS, S, TONE, TYPE, type StateTone } from '../tokens'
import type { HomeObject } from './lanes'
import { QuestionCard } from './QuestionCard'

/**
 * HOME CARDS ARE ATTENTION PROJECTIONS.
 *
 * Not miniature applications. A card says the ONE most relevant current state of
 * the thing it stands for and nothing else — no application toolbar, no filter
 * strip, no second row of metadata answering a question the app answers better
 * one tap away. Tapping opens the full domain app focused on the SAME canonical
 * object the card was about, which is what makes the card a projection rather
 * than a summary that has to be re-resolved.
 *
 * Every card fills its lane's fixed frame exactly. Nothing here measures its
 * content: a long title clamps, a missing line collapses to nothing, and the
 * card is the same height either way. That is the load-bearing property — it is
 * why nothing below a lane moves when its card changes.
 */

/*
  A CARD IS ITS LANE'S BOX EXACTLY.

  `height:100%` of the lane, `overflow:hidden` so nothing inside can reach past
  it, and `min-height:0` so a flex child cannot refuse to shrink — which is how
  a supporting line came to be rendered as a seven-pixel band with the control
  row painted on top of it. Same rule as `Fit`; stated inline because the card
  shell is a style string rather than a component. See fit.tsx.
*/
const shell = (tone: StateTone) =>
  `height:100%; width:100%; min-height:0; min-width:0; box-sizing:border-box;
   display:flex; flex-direction:column; cursor:pointer;
   padding:${S.base}px ${S.gap}px; border-radius:${RADIUS.panel}px; overflow:hidden;
   background:${tone === 'neutral' ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.055)'};
   box-shadow:inset 0 0 0 1px rgba(255,255,255,.07);`

/** The state row. Colour is state, never rank — see TONE in tokens.ts. */
function StateRow({ o, extra }: { o: HomeObject; extra?: React.ReactNode }) {
  return (
    <div style={css('display:flex; align-items:center; gap:6px; flex:none; min-height:14px;')}>
      <div style={cssv`width:5px; height:5px; flex:none; border-radius:999px; background:${TONE[o.tone]};`} />
      <div style={cssv`flex:1; min-width:0; font-size:${TYPE.micro}; font-weight:600; letter-spacing:.07em;
        text-transform:uppercase; color:${o.tone === 'neutral' ? 'rgba(237,238,241,.4)' : TONE[o.tone]};
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`}>
        {o.stateLabel}
      </div>
      {extra}
    </div>
  )
}

/** A quiet inline control. Deliberately smaller than content; see tokens. */
function Control({ label, onClick, tone }: { label: string; onClick: () => void; tone?: StateTone }) {
  return (
    <button
      type="button"
      data-role={label}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      style={cssv`flex:none; border:0; padding:4px 9px; border-radius:999px; cursor:pointer; font-family:inherit;
        font-size:${TYPE.micro}; font-weight:600; white-space:nowrap;
        background:rgba(255,255,255,.07); color:${tone ? TONE[tone] : 'rgba(237,238,241,.72)'};`}
    >{label}</button>
  )
}

/**
 * ONE LINE, ALWAYS. THE CONTRACT ALLOWS TWO; THE CARD TAKES ONE.
 *
 * A two-line title was allowed once and it is what broke the cards: a long title
 * pushed the supporting line down until the flex row underneath shrank it to a
 * seven-pixel band of clipped glyphs — text that is present, unreadable, and
 * visibly cut. Inside a fixed frame the only honest options are "fits" and
 * "ellipsis", and a title that has to wrap to be understood is a title the card
 * cannot carry. The whole thing is one tap away.
 *
 * `CLAMP.title` is 1 for that reason. The contract's ceiling is two lines, and
 * this stays a line under it deliberately rather than by omission — see
 * docs/ui-contract.md. What matters to the rule is the CLAMP: an arbitrary
 * provider string, a 90-character Italian place name or a model-authored label
 * cannot make this box taller.
 */
const Title = ({ text }: { text: string }) => (
  <div data-role="card-title" style={cssv`margin-top:${S.snug}px; flex:none; font-size:${TYPE.title}; font-weight:600;
    letter-spacing:-.022em; line-height:1.2; color:rgba(237,238,241,.95); max-height:${(CLAMP.title * 1.2).toFixed(1)}em;
    display:-webkit-box; -webkit-line-clamp:${CLAMP.title}; -webkit-box-orient:vertical; overflow:hidden;
    overflow-wrap:anywhere;`}>
    {text}
  </div>
)

/**
 * The supporting line, at a height it is GUARANTEED.
 *
 * `-webkit-line-clamp` counts lines but does not bound the box, and `flex:1`
 * let a flex row shrink it below one line rather than clipping cleanly — which
 * is how a sentence came to be rendered as a seven-pixel strip with the control
 * row sitting on top of it. So the height is stated outright: n whole lines,
 * never fewer, never a fraction of one. It is the last thing in the card that
 * can yield, and it yields by ellipsis rather than by being sliced.
 */
const Line = ({ text, lines = CLAMP.meta }: { text: string; lines?: number }) => (
  <div style={cssv`margin-top:${S.tight}px; flex:none; height:${(lines * 1.4).toFixed(1)}em; overflow-wrap:anywhere;
    font-size:${TYPE.small}; line-height:1.4; color:rgba(237,238,241,.5);
    display:-webkit-box; -webkit-line-clamp:${lines}; -webkit-box-orient:vertical; overflow:hidden;`}>
    {text}
  </div>
)

/** The slack a card leaves between its content and its controls. */
const Slack = () => <div style={css('flex:1; min-height:0;')} />

/**
 * HOW MUCH CARD THERE IS, and therefore how much of it to draw.
 *
 * A lane is sized from the device, so on a short window — a landscape phone, or
 * any window with the keyboard up — it reaches its floor and the card's fixed
 * stack of rows no longer fits inside it. What happened then was not a
 * squeeze, it was a STRANDING: the shell clips, so the bottom control row was
 * painted outside its own card with nothing able to scroll to it. "save" and
 * "retry" were on screen in the DOM's opinion and unreachable by any gesture.
 *
 * So a card asks its own box how much it can afford and drops the optional
 * parts in order of what he loses least by not seeing: first the preview, then
 * the supporting prose. The state row, the title and the controls are what
 * survive, because a control you cannot reach is worse than a card that says
 * less. Nothing is ever cut in half.
 *
 * THE THRESHOLDS ARE IN TEXT, NOT IN PIXELS. 132 and 104 were the heights at
 * which the optional parts fit AT THE DEFAULT FONT SIZE, which is the same
 * mistake `rowHeight` was: a number that describes text, frozen at one text
 * size. At 1.5× the identical stack needs half again the room, and a card that
 * kept both parts because it was "over 132px" is a card that clips one of them.
 * Scaled against the reader's own root size, they mean what they always meant.
 */
function useCardRoom() {
  const { ref, size } = useMeasured<HTMLDivElement>()
  const scale = useRootFontPx() / 16
  return {
    ref,
    /** The prose line and the preview both fit. */
    full: size.h >= 132 * scale,
    /** Only one of them does. */
    room: size.h >= 104 * scale,
  }
}

// ── the preview ──────────────────────────────────────────────────────────────

/**
 * WHAT THE CARD IS ACTUALLY ABOUT, drawn from the object's own widget.
 *
 * Home was four titles and four sentences on a black field. Every fact on it
 * was correct and none of it was usable: to find out whether the mail mattered
 * you opened Mail, and to see when lunch was you opened Calendar — so the
 * screen whose entire job is attention could not hold your attention, and two
 * thirds of every card was empty.
 *
 * A card is a projection of a canonical object, so it projects the object's
 * CONTENTS: the next events, the actual senders, the week's steps. Read from
 * the same `Widget` its application renders, which is what stops the card and
 * the app from ever disagreeing — there is one list and the card shows its top.
 *
 * Two properties this must not break, both load-bearing:
 *
 *   · FIXED GEOMETRY. Rows are a fixed height and the region clips. Three
 *     events and thirty produce the same card, so nothing below moves.
 *   · IT IS NOT THE APPLICATION. No toolbar, no filters, no actions on rows.
 *     Reading, and one tap to the real thing — focused on the row he tapped.
 */
/**
 * A PREVIEW ROW'S HEIGHT, MEASURED RATHER THAN ASSUMED.
 *
 * This was `const ROW = 19` — a constant chosen because 13px body text occupies
 * about nineteen pixels, which is true at the default font size and false at
 * every other one. At the largest supported text size the row still claimed 19px
 * and held 22px of text, so every row on every card clipped its own descenders,
 * and `Preview`'s "how many WHOLE rows fit" calculation was dividing by a number
 * that had stopped describing a row. Three pixels per row, on a card that was
 * otherwise exactly right, which is why it survived every capture until one ran
 * at 1.5×.
 *
 * `TYPE.body` over a 1.45 line box, against the reader's actual root size.
 */
const rowHeight = (rootPx: number) => Math.round((13 / 16) * rootPx * 1.45)

/** One line of a preview. `lead` is the fixed-width fact; `text` is the object. */
function Row({
  lead, text, dot, onOpen, h,
}: {
  lead?: string
  text: string
  dot?: boolean
  onOpen?: () => void
  h: number
}) {
  return (
    <div
      data-preview-row={text}
      onClick={onOpen ? (e) => { e.stopPropagation(); onOpen() } : undefined}
      style={cssv`height:${h}px; flex:none; display:flex; align-items:center; gap:7px;
        cursor:${onOpen ? 'pointer' : 'inherit'};`}
    >
      {dot && <div style={cssv`width:4px; height:4px; flex:none; border-radius:999px; background:${TONE.changed};`} />}
      {/*
        THE LEAD IS A FIXED-WIDTH FACT, AND IT HAD NO WIDTH.

        `flex:none; min-width:38px` and nothing else, on the assumption that a
        lead is always a clock time or a first name. Maps passes a place's
        `sub`, and a real Italian comune is "San Giovanni in Persiceto, Città
        metropolitana di Bologna, Emilia-Romagna" — 72 characters in a column
        that refuses to shrink, so the row laid out 391px wide inside a 338px
        card and the object's own title was pushed off the right edge. Found by
        the hostile fixture on its first run; invisible for as long as every
        fixture lead was "11:00" or "Odelia".

        A third of the row, and it ellipsises. Metadata may not cost the thing
        it is annotating — see the clamp table in docs/ui-contract.md.
      */}
      {lead && (
        <div style={cssv`flex:none; min-width:38px; max-width:34%; font-size:${TYPE.small};
          font-variant-numeric:tabular-nums; color:rgba(237,238,241,.42);
          white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`}>{lead}</div>
      )}
      <div style={cssv`flex:1; min-width:0; font-size:${TYPE.body}; color:rgba(237,238,241,.78);
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`}>{text}</div>
    </div>
  )
}

/**
 * WHEN, at the width a preview row has.
 *
 * "08:30 AM Dentist" with no day is worse than useless on a card whose state
 * row says "next 7 days" — it reads as this morning, and the dentist is on
 * Tuesday. So anything not today carries its day, because on a multi-day list
 * the day is the fact that distinguishes the rows and the clock is the detail.
 */
const when = (iso: string, allDay?: boolean): string => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const today = new Date().toDateString() === d.toDateString()
  const at = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).replace(/\s?[AP]M$/i, (m) => m.trim().toLowerCase())
  if (allDay) return today ? 'today' : d.toLocaleDateString([], { weekday: 'short' })
  return today ? at : `${d.toLocaleDateString([], { weekday: 'short' })} ${at}`
}

const day = (iso?: string): string => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const days = Math.round((d.getTime() - Date.now()) / 86_400_000)
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  return d.toLocaleDateString([], { weekday: 'short' })
}

/**
 * A week of numbers, as a shape rather than a sentence.
 *
 * "9,180 steps yesterday — above your week" is one fact and a claim you cannot
 * check. Seven bars is the same pixels and shows the trend the claim is about.
 */
/**
 * `null` IS A DAY NOBODY REPORTED, EVEN AT THIS SIZE.
 *
 * A spark is a shape rather than a figure, which is an argument for drawing it
 * simply and not an argument for drawing an absence as a floor. A missing day
 * used to arrive here as a number — because the series type could not express
 * "nothing" — and the six-pixel minimum made it look exactly like a quiet day.
 * The card and the surface now tell the same truth about the same week.
 */
function Spark({ values, accent }: { values: (number | null)[]; accent?: string }) {
  const max = Math.max(1, ...values.filter((v): v is number => v !== null))
  return (
    <div style={css('flex:1; min-height:0; display:flex; align-items:flex-end; gap:4px; padding-top:6px;')}>
      {values.slice(-7).map((v, i, all) => (
        <div
          key={i}
          data-state={v === null ? 'missing' : v === 0 ? 'zero' : 'value'}
          style={v === null
            ? css('flex:1; min-width:0; height:100%; border-radius:2px; box-sizing:border-box; border:1px dashed rgba(237,238,241,.14);')
            : cssv`flex:1; min-width:0; border-radius:2px 2px 0 0;
              height:${v === 0 ? '2px' : `${Math.max(6, Math.round((v / max) * 100))}%`};
              background:${i === all.length - 1 ? (accent ?? TONE.active) : 'rgba(237,238,241,.16)'};`}
        />
      ))}
    </div>
  )
}

export function Preview({
  o, onOpenObject,
}: {
  o: HomeObject
  /** Open this object's app, focused on the row he tapped. */
  onOpenObject?: (app: string, objectId: string) => void
}) {
  /**
   * WHOLE ROWS ONLY.
   *
   * `overflow:hidden` alone cuts the last row through the middle of its
   * letters, which reads as broken rather than as "there is more" — a sliced
   * glyph is the exact artefact this file's other comments were written about.
   * So the region measures itself and renders the number of rows that FIT.
   *
   * This does not make the card content-sized: the region's height comes from
   * the lane, the count comes from the region, and a card with thirty events is
   * the same size as a card with two. Geometry still flows one way.
   */
  const ROW = rowHeight(useRootFontPx())
  const box = useRef<HTMLDivElement>(null)
  const [fits, setFits] = useState(3)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const read = () => setFits(Math.max(0, Math.floor(el.clientHeight / ROW)))
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ROW])

  const w = o.preview
  if (!w) return <Slack />

  const open = (id: string) => onOpenObject && (() => onOpenObject(o.opens, id))

  /**
   * The title is already at the top of the card. A row repeating it is the same
   * sentence twice in 150px, which is how the insight card came to say
   * "Restaurant with Odelia" three times.
   */
  const isEcho = (text: string) => text.trim().toLowerCase() === o.title.trim().toLowerCase()

  const rows = (list: { key: string; text: string; node: React.ReactNode }[]) => {
    const kept = list.filter((r) => !isEcho(r.text)).slice(0, fits)
    /*
      NO WHOLE ROW FITS, SO SAY IT IN A SENTENCE INSTEAD.

      "Whole rows only" is right — a row cut through its letters reads as broken
      — but at the largest text size a standard card has room for zero of them,
      and the rule as written then drew an empty box under a title. That is the
      overflow ladder's FIRST rung skipped: show less information before showing
      none. The object's own summary line is one line at any text size and says
      most of what two rows would have.
    */
    if (!kept.length && o.line) return <><Line text={o.line} lines={CLAMP.secondary} /><Slack /></>
    return (
      <div
        ref={box}
        data-preview={o.id}
        style={css('flex:1; min-height:0; overflow:hidden; display:flex; flex-direction:column; padding-top:6px;')}
      >
        {kept.map((r) => r.node)}
      </div>
    )
  }

  switch (w.kind) {
    case 'calendar':
      // Only what is still ahead — a card advertising this morning's meeting at
      // four in the afternoon is the failure `nextEvent` exists to prevent.
      return rows(
        w.events
          .filter((e) => new Date(e.end ?? e.start).getTime() >= Date.now() - 3_600_000)
          .sort((a, b) => a.start.localeCompare(b.start))
          .map((e) => ({
            key: e.id,
            text: e.title,
            node: <Row key={e.id} h={ROW} lead={when(e.start, e.allDay)} text={e.title} onOpen={open(e.id)} />,
          })),
      )

    case 'mail':
      return rows(w.messages.map((m) => ({
        key: m.id,
        text: m.subject,
        node: <Row key={m.id} h={ROW} dot={m.unread} lead={m.fromName?.split(' ')[0]} text={m.subject} onOpen={open(m.id)} />,
      })))

    case 'video':
      return rows(w.videos.map((v) => ({
        key: v.id,
        text: v.title,
        node: <Row key={v.id} h={ROW} text={v.title} lead={v.channel?.split(' ')[0]} onOpen={open(v.id)} />,
      })))

    case 'watch':
      return rows(w.watches.filter((x) => x.active).map((x) => ({
        key: x.id,
        text: x.state || x.what,
        node: <Row key={x.id} h={ROW} dot={!!x.changedAt} text={x.state || x.what} onOpen={open(x.id)} />,
      })))

    case 'map':
      return rows(w.places.filter((p) => !p.self).map((p) => ({
        key: p.id,
        text: p.label,
        node: <Row key={p.id} h={ROW} text={p.label} lead={p.sub} onOpen={open(p.id)} />,
      })))

    case 'fitness': {
      const s = w.series[0]
      return s?.days?.length
        ? <Spark values={s.days.map((d) => d.value)} accent={s.accent} />
        : <Slack />
    }

    case 'chart':
      return w.points.length
        ? <Spark values={w.points.map((p) => p.value)} accent={w.accent} />
        : <Slack />

    case 'detail':
      return rows(w.rows.map((r, i) => ({
        key: String(i),
        text: r.value,
        node: <Row key={i} h={ROW} lead={r.label} text={r.value} />,
      })))

    case 'list':
    case 'agenda':
    case 'media':
      return rows(w.items.map((it) => ({
        key: it.id,
        text: it.title,
        node: <Row key={it.id} h={ROW} lead={it.at ? day(it.at) : undefined} text={it.title} onOpen={open(it.id)} />,
      })))

    // A composer is a thing to do, not a result to preview.
    case 'compose':
      return <Slack />
  }
}

/*
  WHERE THE APPLICATION STRIP WAS.

  `AppStrip` drew six tiles — Cal, Mail, Map, Video, Steps, Watch — permanently
  at the foot of Home, and it is deleted rather than hidden, shrunk or moved.
  It was the second attempt at one idea: the first was a whole LANE of app
  cards, this was the same six at chrome height, and the demotion was real but
  the premise never changed. An integration does not earn permanent pixels for
  existing. Six tiles that say nothing on a quiet day are six tiles of the phone
  spent on a filing system he did not ask for, and the screen's entire job is to
  decide which one or two things deserve pixels NOW.

  A source reaches Home the way everything else does: `classify` promotes it to
  a card when it is hot or warm, ranked against every other claim on his
  attention, and leaves it out when it is quiet. Reaching a quiet application is
  a navigation, and navigation is the composer — plus `#/open/<app>`, which is a
  URL and costs no screen. See docs/ui-contract.md §8, which freezes this.
*/

// ── one card per kind of object ──────────────────────────────────────────────

/**
 * THE BAND DECIDES WHERE; THIS DECIDES HOW.
 *
 * A band is "how much of his attention this deserves" and says nothing about
 * what the thing IS — two cards in `now` can be a disagreement between two
 * health sources and a research task waiting on an answer, and they need
 * completely different controls. So the band renders through here, and here
 * dispatches on `kind`.
 *
 * Written as one entry point rather than as a switch in Home so that adding a
 * kind cannot mean adding it to three bands and forgetting the fourth.
 */
export function BandCard(props: {
  o: HomeObject
  pinned: boolean
  onOpen: (id: string) => void
  onOpenObject?: (app: string, objectId: string) => void
  onPin: (on: boolean) => void
  onArchive: () => void
  onRetry: () => void
  onSave: () => void
  onDismiss: () => void
  /** An answered question: what the server wrote, and rebuild what it unblocked. */
  onAnswer?: (said: string) => void
  /** "Something else…" — put the question in front of the composer. */
  onElaborate?: (question: string) => void
}) {
  const { o } = props
  switch (o.kind) {
    case 'source':
      return <SourceCard o={o} onOpen={props.onOpen} onOpenObject={props.onOpenObject} />
    case 'pane':
      return (
        <PaneCard
          o={o} pinned={props.pinned} onOpen={props.onOpen} onOpenObject={props.onOpenObject}
          onPin={props.onPin} onArchive={props.onArchive}
        />
      )
    case 'watch':
      return <WatchCard o={o} onOpen={props.onOpen} />
    case 'task':
      return (
        <TaskCard
          o={o} onOpen={props.onOpen} onOpenObject={props.onOpenObject}
          onRetry={props.onRetry} onSave={props.onSave} onDismiss={props.onDismiss}
        />
      )
    case 'attention':
      /*
        A QUESTION IS ANSWERED WHERE IT IS ASKED.

        The dispatch is on `needsUser` — the server's own `asks` — rather than on
        a new card kind, because a clarification IS an attention item in every
        other respect: it is scored, ranked, banded and expired by the same
        machinery. What differs is that it has no surface to open, and drawing it
        as an ordinary card is what put an empty workspace one tap away.
      */
      return o.needsUser && props.onAnswer
        ? (
          <QuestionCard
            o={o}
            onAnswered={props.onAnswer}
            onElaborate={props.onElaborate ?? (() => {})}
          />
        )
        : (
          <InsightCard
            o={o} onOpen={props.onOpen} onOpenObject={props.onOpenObject}
            onSave={props.onSave} onDismiss={props.onDismiss}
          />
        )
  }
}

/**
 * A SOURCE THAT HAS SOMETHING TO SAY.
 *
 * Not the application — the application is a tile at the foot of the screen.
 * This is the mailbox on the morning six things arrived, which is a fact about
 * today and belongs beside every other fact about today. When the mailbox goes
 * quiet this card simply stops being produced.
 */
export function SourceCard({
  o, onOpen, onOpenObject,
}: {
  o: HomeObject
  onOpen: (id: string) => void
  onOpenObject?: (app: string, objectId: string) => void
}) {
  const { ref, room } = useCardRoom()
  return (
    <div ref={ref} data-open={o.opens} onClick={() => onOpen(o.opens)} style={css(shell(o.tone))}>
      <StateRow o={o} />
      <Title text={o.title} />
      {/* The prose line is what the card said INSTEAD of showing anything. It
          stays only when there is nothing real to show — a summary of an empty
          mailbox is the most useful thing an empty mailbox has. */}
      {!room ? <Slack />
        : o.preview ? <Preview o={o} onOpenObject={onOpenObject} />
        : <><Line text={o.line} lines={CLAMP.secondary} /><Slack /></>}
    </div>
  )
}

/** A workspace he saved. His, and persistent until he archives it. */
export function PaneCard({
  o, pinned, onOpen, onOpenObject, onPin, onArchive,
}: {
  o: HomeObject
  pinned: boolean
  onOpen: (id: string) => void
  onOpenObject?: (app: string, objectId: string) => void
  onPin: (on: boolean) => void
  onArchive: () => void
}) {
  const { ref, room } = useCardRoom()
  return (
    <div ref={ref} data-open={o.opens} onClick={() => onOpen(o.opens)} style={css(shell(o.tone))}>
      <StateRow o={o} extra={<Control label={pinned ? 'unpin' : 'pin'} onClick={() => onPin(!pinned)} />} />
      <Title text={o.title} />
      {!room ? <Slack />
        : o.preview ? <Preview o={o} onOpenObject={onOpenObject} />
        : <><Line text={o.line} /><Slack /></>}
      <div style={css('flex:none; display:flex; align-items:center; gap:6px;')}>
        <div style={css('flex:1;')} />
        {/* Never a silent destruction of something he owns: this removes the
            Home placement and the pane state, and it is undoable from the seam. */}
        <Control label="archive" onClick={onArchive} />
      </div>
    </div>
  )
}

/**
 * ACTIVE AGENTIC WORK.
 *
 * The card exposes the four things that decide what he does next — what phase
 * it is in, the strongest thing known so far, whether it needs him, and how to
 * end it. It does NOT try to hold the research report; tapping opens the task's
 * own workspace, which is where a report belongs.
 *
 * Failure is explicit and split. Retryable failure keeps a retry and stays until
 * he deals with it. Terminal failure states itself compactly and leaves on its
 * own after its window, because a failure that cannot be acted on must never
 * become permanent furniture.
 */
export function TaskCard({
  o, onOpen, onOpenObject, onRetry, onSave, onDismiss,
}: {
  o: HomeObject
  onOpen: (id: string) => void
  onOpenObject?: (app: string, objectId: string) => void
  onRetry: () => void
  onSave: () => void
  onDismiss: () => void
}) {
  const state = o.task?.state
  const { ref, room } = useCardRoom()
  return (
    <div ref={ref} data-open={o.opens} onClick={() => onOpen(o.opens)} style={css(shell(o.tone))}>
      <StateRow o={o} extra={<Control label="dismiss" onClick={onDismiss} />} />
      <Title text={o.title} />
      {/* A task that produced something shows what it produced. A task that
          produced nothing shows why, which is what its line is for. */}
      {!room ? <Slack />
        : o.preview && o.task?.state === 'completed'
          ? <Preview o={o} onOpenObject={onOpenObject} />
          : <><Line text={o.line} /><Slack /></>}
      <div style={css('flex:none; display:flex; align-items:center; gap:6px;')}>
        {o.task?.phase && (
          <div style={cssv`font-size:${TYPE.micro}; color:rgba(237,238,241,.38); white-space:nowrap;`}>{o.task.phase}</div>
        )}
        <div style={css('flex:1;')} />
        {state === 'failedRetryable' && <Control label="retry" onClick={onRetry} tone="warning" />}
        {/* Saving is what stops a completed task from leaving. It is offered
            here rather than buried, because the window is short by design. */}
        {state === 'completed' && <Control label="keep" onClick={onSave} tone="resolved" />}
      </div>
    </div>
  )
}

/** An individual watch, projected from the same canonical object Keep an Eye owns. */
export function WatchCard({ o, onOpen }: { o: HomeObject; onOpen: (id: string) => void }) {
  const { ref, room } = useCardRoom()
  return (
    <div ref={ref} data-open={o.opens} onClick={() => onOpen(o.opens)} style={css(shell(o.tone))}>
      <StateRow o={o} />
      <Title text={o.title} />
      {/* A watch's whole content IS its last finding, so the line is the
          projection and there is nothing further to unfold. */}
      {room ? <Line text={o.line} lines={CLAMP.secondary} /> : null}
      <Slack />
    </div>
  )
}

/**
 * EPHEMERAL INTELLIGENCE.
 *
 * It expires. Producing it once never makes it permanent — the only way it
 * survives is that he saves it, and saving moves it out of this lane and into
 * the ones he owns.
 */
export function InsightCard({
  o, onOpen, onOpenObject, onSave, onDismiss,
}: {
  o: HomeObject
  onOpen: (id: string) => void
  onOpenObject?: (app: string, objectId: string) => void
  onSave: () => void
  onDismiss: () => void
}) {
  const { ref, room, full } = useCardRoom()
  return (
    <div ref={ref} data-open={o.opens} onClick={() => onOpen(o.opens)} style={css(shell(o.tone))}>
      <StateRow o={o} extra={<Control label="dismiss" onClick={onDismiss} />} />
      <Title text={o.title} />
      {room ? <Line text={o.line} lines={CLAMP.secondary} /> : null}
      {full && o.preview ? <Preview o={o} onOpenObject={onOpenObject} /> : <Slack />}
      {/* No second rendering of the time. The state row above already carries
          when this is about ("tomorrow · 11:00"), and printing "11:00 AM" again
          underneath is the same fact twice in one card. */}
      <div style={css('flex:none; display:flex; align-items:center; gap:6px;')}>
        <div style={css('flex:1;')} />
        <Control label="save" onClick={onSave} />
      </div>
    </div>
  )
}

/**
 * A quiet empty lane.
 *
 * The geometry stays. No giant call to action, no tutorial prose, no oversized
 * furniture explaining what the lane would contain — an empty lane is a fact
 * about today, not an onboarding opportunity.
 */
export function LaneEmpty({ text }: { text: string }) {
  return (
    <div style={cssv`font-size:${TYPE.small}; color:rgba(237,238,241,.26);`}>{text}</div>
  )
}
