import { useEffect, useMemo, useState } from 'react'
import { css, cssv } from './css'
import { accentOf } from './heat'
import type { Widget, WidgetAction, WidgetItem, WidgetPane } from './api'
import Calendar from './surfaces/Calendar'
import Mail from './surfaces/Mail'
import Video from './surfaces/Video'
import Fitness from './surfaces/Fitness'
import Watch from './surfaces/Watch'
import MapSurface from './surfaces/Map'
import { Actions, CARD, Empty, clockOf, shortWhen } from './surfaces/kit'
import { arriveAt, registerDiag, useSurfaces } from './surface/store'
import type { SurfaceKind } from './surface/types'
import { Boundary } from './Boundary'
import { Fit } from './fit'

import { poisoned } from './poison'

/**
 * The widget renderer.
 *
 * Two families live behind one switch, and the split is the point of the
 * design. The generic primitives — list, agenda, chart, media, detail, compose
 * — are what a card the MODEL invented is allowed to use: a small fixed
 * vocabulary, so a novel card gets a real interface without the model ever
 * emitting markup. The domain surfaces are what a card the APP built from a
 * connector gets: a real calendar, a real mailbox, a real map, each with typed
 * state that he and the model drive through the same commands.
 *
 * A spec naming a kind this build has never heard of renders as nothing rather
 * than as an error. The brain and the app deploy separately — one on the Mac,
 * one on a Worker — and the phone caches an older bundle than either, so an
 * unknown primitive has to be survivable: the card falls back to its chat
 * thread and nothing crashes on a screen he is holding.
 */

interface Props {
  panes: WidgetPane[]
  heat: string
  /**
   * Stable prefix for the surface keys of everything in here.
   *
   * A surface's state — which day, which selection — is keyed by this plus the
   * pane's index, which is what makes it survive a reload and a re-render. It
   * must therefore be the OWNER's stable id (a pane id, a card id) and never
   * anything derived from the contents.
   */
  owner: string
  /**
   * The object the thing that opened this was ABOUT, if it was about one.
   *
   * Applied to whichever pane actually contains it, once, on arrival. See
   * `arriveAt` in the store for why it is an intent rather than a command.
   */
  focus?: string | null
  /** Perform a named action. Resolves when it is done, throws to show an error. */
  onAction: (action: WidgetAction) => Promise<void>
  /** Ask the source for something different. Present only where there is a plan. */
  onRefine?: (intent: string) => Promise<void>
}

export default function Widgets({ panes, heat, owner, focus, onAction, onRefine }: Props) {
  if (!panes?.length) return null
  return (
    /*
      This wrapper must PASS THROUGH the frame's height, not collapse to its
      content. It was `display:flex; flex-direction:column` with no growth, so
      a domain application asking for `height:100%` measured itself against an
      auto-height parent and resolved to nothing — the Maps canvas came out
      0px tall inside a 351px frame. Filling the frame only works if every link
      in the chain agrees to be filled.
    */
    <div style={css('flex:1; min-height:0; display:flex; flex-direction:column; gap:16px;')}>
      {panes.map((p, i) => (
        <Pane key={i} pane={p} heat={heat} surfaceKey={`${owner}#${i}`} focus={focus} onAction={onAction} onRefine={onRefine} />
      ))}
    </div>
  )
}

/**
 * THE DECLARED EMPTY STATE FOR EACH RENDERER, or `null` when there is content.
 *
 * One table, so "what does this application say when it has nothing" is
 * answerable without opening it, and so a new renderer cannot ship without
 * answering the question — an unhandled kind falls through to `null`, which the
 * runtime blank-destination test in `scripts/shots.mjs` reports as a surface
 * that neither drew content nor declared an emptiness.
 *
 * The strings are the LAST resort. Every one of these can be overridden by the
 * widget's own `empty`, which is what the server sends when it knows something
 * more specific than "nothing here" — "connect Gmail and this fills in" is a
 * different fact from "your mailbox is empty", and only the server can tell them
 * apart.
 */
function emptyStateOf(w?: Widget): string | null {
  if (!w) return 'Nothing to show'
  const declared = (fallback: string) =>
    ('empty' in w && typeof w.empty === 'string' && w.empty) || fallback
  switch (w.kind) {
    case 'calendar': return w.events.length ? null : declared('No events in this period')
    case 'mail': return w.messages.length ? null : declared('No messages match this filter')
    case 'video': return w.videos.length ? null : declared('No verified videos found')
    case 'watch': return w.watches.length ? null : declared('Nothing is being watched')
    case 'fitness': return w.series.length ? null : declared('No activity recorded')
    // A map with only "you" on it is a map with no place selected. Counting the
    // self marker as content is how an empty Places came to look populated.
    case 'map': return w.places.some((p) => !p.self) ? null : declared('No place selected')
    case 'chart': return w.points.length ? null : declared('Nothing to chart yet')
    case 'detail': return w.rows.length ? null : declared('Nothing recorded')
    case 'list':
    case 'agenda':
    case 'media': return w.items.length ? null : declared('Nothing here yet')
    // A composer is a thing to do rather than a result, so it is never empty.
    case 'compose': return null
  }
}

function Pane({
  pane, heat, surfaceKey, focus, onAction, onRefine,
}: {
  pane: WidgetPane
  heat: string
  surfaceKey: string
  focus?: string | null
  onAction: Props['onAction']
  onRefine?: Props['onRefine']
}) {
  // Registered before the body renders, so the intent is already waiting when
  // the surface publishes its objects a moment later.
  useEffect(() => { arriveAt(surfaceKey, focus) }, [surfaceKey, focus])
  const focused = useSurfaces()[surfaceKey]?.focus ?? null
  return (
    /*
      No chrome around the application.

      This used to render the pane's title as an eyebrow and its actions as a
      button row, both OUTSIDE `Body` — so every domain renderer was boxed in
      by furniture it did not control and could not integrate. Title and
      actions are handed INTO the application now; a surface decides where its
      own "New event" button belongs, which is inside its toolbar, not floating
      above it.
    */
    /*
      `data-focus` is the observable half of a focus intent.

      Focus lived only in the store, so "the card opened its app focused on the
      right object" was a claim no test and no screenshot could check — which is
      how a Home card that navigated nowhere in particular passed a full gate.
      The surface publishes which object it is actually focused on; that is what
      the acceptance test reads.
    */
    /*
      `data-renderer` is the same argument as `data-focus`, one level up.

      Which renderer mounted lived only in `registerDiag`, so "tapping Calendar
      opens Calendar" was checkable from a console and not from a capture — and
      the failure it hides is the one that actually happened: a card that
      resolved to nothing at all, which no assertion about a surface's INTERNAL
      state can see, because there was no surface. The kind is published where
      a screenshot-time assertion can read it.
    */
    /*
      `data-empty-state` is the third of the same argument.

      §12 of the contract: after a navigation, a valid surface holds either real
      content or a DECLARED designed empty state. A title over a black rectangle
      is neither, and it is indistinguishable from a crash — which is why the
      blank-pane complaint kept coming back after each fix. Every renderer
      already had an empty sentence written for it; what none of them had was a
      way for anything outside the component to know that the sentence is what is
      on screen.

      Declared HERE rather than in six components, because the question "is this
      surface empty" is answered by the payload, and the payload is what this
      file dispatches on. Six independent answers would drift, and the one that
      drifted would be the one nobody captured.
    */
    <div
      data-surface={surfaceKey}
      data-renderer={pane.widget?.kind ?? undefined}
      data-empty-state={emptyStateOf(pane.widget) ?? undefined}
      data-focus={focused ?? undefined}
      style={css('flex:1; min-height:0; display:flex; flex-direction:column;')}
    >
      <Diag pane={pane} surfaceKey={surfaceKey} />
      <Boundary
        key={surfaceKey}
        scope={pane.title || RENDERER[pane.widget?.kind ?? ''] || 'This surface'}
        level="surface"
      >
        {/*
          EVERY PANE IS ITS OWN EXACT BOX.

          A surface with two panes used to divide the frame by flex and hope:
          each renderer was told nothing about its share, so a Maps pane sized
          itself for the whole frame and painted over the one beneath it. `Fit`
          measures each pane's real box and hands it the number, and bounds it
          so a renderer that gets it wrong is clipped rather than overlapping.
          See fit.tsx.
        */}
        <Fit name={`pane:${pane.widget?.kind ?? 'unknown'}`}>
          <Body
            widget={pane.widget}
            heat={heat}
            surfaceKey={surfaceKey}
            title={pane.title ?? ''}
            actions={pane.actions}
            onAction={onAction}
            onRefine={onRefine}
          />
        </Fit>
      </Boundary>
    </div>
  )
}

/** The component actually drawing each widget kind. Kept beside the switch. */
const RENDERER: Record<string, string> = {
  calendar: 'CalendarSurface', mail: 'MailSurface', video: 'VideoSurface',
  fitness: 'FitnessSurface', watch: 'KeepAnEyeSurface', map: 'MapSurface',
  list: 'ListWidget', agenda: 'AgendaWidget', chart: 'ChartWidget',
  media: 'MediaWidget', detail: 'DetailWidget', compose: 'ComposeWidget',
}

/**
 * Record what is mounted here, next to the switch that mounts it.
 *
 * Registering from the dispatcher rather than from inside each surface is the
 * point: a domain surface cannot claim to be something it is not, because it
 * never gets to describe itself. The kind recorded is the kind that was
 * actually switched on.
 *
 * `map.route` on a watch registers under actionTargetKinds, never under
 * currentSurfaceKind — which is exactly the distinction that "Opened Maps…"
 * inside Keep an eye was blurring.
 */
function Diag({ pane, surfaceKey }: { pane: WidgetPane; surfaceKey: string }) {
  const kind = pane.widget?.kind
  useEffect(() => {
    if (!kind) return
    const w = pane.widget as unknown as Record<string, unknown>
    const collections = ['events', 'messages', 'videos', 'watches', 'places', 'items', 'series']
    const objectActions = collections
      .flatMap((c) => (Array.isArray(w[c]) ? (w[c] as Record<string, unknown>[]) : []))
      .flatMap((o) => (Array.isArray(o?.actions) ? (o.actions as { kind?: string }[]) : []))
    const app = (a: { kind?: string }) => (a.kind ?? '').split('.')[0] ?? ''
    registerDiag({
      surfaceKey,
      currentSurfaceKind: kind as SurfaceKind,
      rendererComponent: RENDERER[kind] ?? 'unknown',
      title: pane.title ?? '',
      objectSourceKinds: [...new Set(objectActions.map(app).filter(Boolean))],
      actionTargetKinds: [...new Set((pane.actions ?? []).map(app).filter(Boolean))],
    })
  })
  return null
}

function Body({
  widget, heat, surfaceKey, title, actions, onAction, onRefine,
}: {
  widget: Widget
  heat: string
  surfaceKey: string
  title: string
  /** Pane-level actions, for the DOMAIN to place inside its own UI. */
  actions?: WidgetAction[]
  onAction: Props['onAction']
  onRefine?: Props['onRefine']
}) {
  /**
   * Failure injection, reachable from a phone with no tooling:
   *
   *   __cruPoison('map')   → the Maps surface throws on its next render
   *   __cruPoison()        → clear
   *
   * This is the only honest way to check containment on the real device. A
   * boundary that has never actually caught anything is a claim, not a
   * guarantee, and the failure it defends against is one I cannot reproduce on
   * demand from real data. Costs one Set lookup per render.
   */
  if (poisoned(widget?.kind ?? '')) {
    throw new Error(`Injected failure in '${widget?.kind}' surface (__cruPoison)`)
  }

  switch (widget?.kind) {
    // ── Domain surfaces ──────────────────────────────────────────────────────
    case 'calendar':
      return (
        <Calendar
          surfaceKey={surfaceKey}
          title={title || 'Calendar'}
          events={widget.events}
          empty={widget.empty}
          heat={heat}
          actions={actions}
          onAction={onAction}
        />
      )
    case 'mail':
      return (
        <Mail
          surfaceKey={surfaceKey}
          title={title || 'Mail'}
          messages={widget.messages}
          empty={widget.empty}
          onAction={onAction}
        />
      )
    case 'video':
      return (
        <Video
          surfaceKey={surfaceKey}
          title={title || 'Videos'}
          videos={widget.videos}
          empty={widget.empty}
          onAction={onAction}
          onRefine={onRefine}
        />
      )
    case 'fitness':
      return (
        <Fitness
          surfaceKey={surfaceKey}
          title={title || 'Activity'}
          series={widget.series}
          report={widget.report}
          empty={widget.empty}
          heat={heat}
        />
      )
    case 'watch':
      return (
        <Watch
          surfaceKey={surfaceKey}
          title={title || 'Keep an eye'}
          watches={widget.watches}
          empty={widget.empty}
          onAction={onAction}
        />
      )
    case 'map':
      return (
        <MapSurface
          surfaceKey={surfaceKey}
          title={title || 'Map'}
          places={widget.places}
          follow={widget.follow}
          searchable={widget.searchable}
          route={widget.route}
          zoom={widget.zoom}
          heat={heat}
        />
      )

    // ── Generic primitives ───────────────────────────────────────────────────
    case 'list': return <ListWidget w={widget} heat={heat} onAction={onAction} />
    case 'agenda': return <AgendaWidget w={widget} heat={heat} onAction={onAction} />
    case 'chart': return <ChartWidget w={widget} heat={heat} />
    case 'media': return <MediaWidget w={widget} onAction={onAction} />
    case 'detail': return <DetailWidget w={widget} heat={heat} />
    case 'compose': return <ComposeWidget w={widget} onAction={onAction} />
    default: return null
  }
}

// ── compose ──────────────────────────────────────────────────────────────────

/**
 * The one primitive that produces text rather than showing it.
 *
 * Sending is irreversible and visible to someone else, so the send button
 * confirms before it fires and the text it will send is on screen while it
 * does. Nothing auto-sends: there is no path from a model deciding something to
 * a message leaving, only from his thumb.
 */
function ComposeWidget({ w, onAction }: { w: Extract<Widget, { kind: 'compose' }>; onAction: Props['onAction'] }) {
  const [text, setText] = useState(w.value ?? '')
  const [sending, setSending] = useState(false)
  const [sure, setSure] = useState(false)
  const [done, setDone] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  const submit = async () => {
    if (!text.trim() || sending) return
    if (w.submit.irreversible !== false && !sure) { setSure(true); return }
    setSending(true)
    setFailed(null)
    try {
      await onAction({ ...w.submit, params: { ...(w.submit.params ?? {}), text } })
      setDone(true)
      setText('')
    } catch (e) {
      setFailed((e as Error).message)
    } finally {
      setSending(false)
      setSure(false)
    }
  }

  if (done) {
    return (
      <div style={cssv`padding:14px; text-align:center; font-size:12.5px; color:rgba(237,238,241,.6); ${CARD}`}>
        Sent.
      </div>
    )
  }

  return (
    <div style={cssv`padding:12px 13px; display:flex; flex-direction:column; gap:10px; ${CARD}`}>
      {w.to && (
        <div style={css('font-size:11.5px; color:rgba(237,238,241,.45);')}>
          To <span style={css('color:rgba(237,238,241,.75);')}>{w.to}</span>
        </div>
      )}
      <textarea
        value={text}
        rows={w.multiline === false ? 1 : 4}
        placeholder={w.placeholder ?? 'Write a reply…'}
        onChange={(e) => { setText(e.target.value); setSure(false) }}
        style={css('width:100%; box-sizing:border-box; resize:vertical; background:rgba(0,0,0,.22); border:0; outline:0; border-radius:11px; padding:10px 12px; font-family:inherit; font-size:13px; line-height:1.5; color:rgba(237,238,241,.92); box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);')}
      />
      <div style={css('display:flex; align-items:center; gap:9px;')}>
        <div
          onClick={() => void submit()}
          style={cssv`padding:8px 16px; border-radius:999px; background:rgba(237,238,241,${text.trim() && !sending ? '.9' : '.35'}); color:#101012; font-size:12.5px; font-weight:600; cursor:pointer;`}
        >
          {sending ? (w.submit.busy ?? 'Sending…') : sure ? 'Tap again to send' : w.submit.label}
        </div>
        {sure && (
          <div style={css('font-size:11.5px; color:rgba(237,238,241,.5);')}>this leaves your account</div>
        )}
      </div>
      {failed && <div style={css('font-size:11.5px; color:rgba(255,170,170,.8); line-height:1.45;')}>{failed}</div>}
    </div>
  )
}

// ── list ─────────────────────────────────────────────────────────────────────

function ListWidget({ w, heat, onAction }: { w: Extract<Widget, { kind: 'list' }>; heat: string; onAction: Props['onAction'] }) {
  const [open, setOpen] = useState<string | null>(null)
  const [filter, setFilter] = useState<string | null>(null)

  const items = useMemo(
    () => (filter ? w.items.filter((i) => i.tags?.includes(filter)) : w.items),
    [w.items, filter]
  )

  if (!w.items.length) return <Empty text={w.empty ?? 'Nothing here.'} />

  return (
    <div style={css('display:flex; flex-direction:column; gap:8px;')}>
      {w.filters && w.filters.length > 1 && (
        <div style={css('display:flex; gap:6px; overflow-x:auto; padding-bottom:2px;')}>
          {[null, ...w.filters].map((f, i) => (
            <div
              key={i}
              onClick={() => setFilter(f)}
              style={cssv`flex:none; padding:6px 12px; border-radius:999px; font-size:11.5px; cursor:pointer; white-space:nowrap; background:rgba(255,255,255,${filter === f ? '.14' : '.05'}); color:rgba(237,238,241,${filter === f ? '.92' : '.55'});`}
            >{f ?? 'All'}</div>
          ))}
        </div>
      )}

      {items.map((it) => {
        const isOpen = open === it.id
        return (
          <div key={it.id} style={cssv`${CARD} overflow:hidden;`}>
            <div
              onClick={() => w.expandable !== false && setOpen(isOpen ? null : it.id)}
              style={cssv`padding:12px 13px; display:flex; gap:10px; align-items:flex-start; cursor:${w.expandable === false ? 'default' : 'pointer'};`}
            >
              {it.unread && (
                <div style={cssv`width:6px; height:6px; flex:none; margin-top:5px; border-radius:999px; background:${accentOf(it.accent, heat)};`} />
              )}
              <div style={css('flex:1; min-width:0;')}>
                <div style={cssv`font-size:13.5px; font-weight:${it.unread ? '600' : '500'}; letter-spacing:-.01em; color:rgba(237,238,241,${it.unread ? '.95' : '.82'}); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`}>
                  {it.title}
                </div>
                {it.sub && (
                  <div style={css('margin-top:3px; font-size:12px; color:rgba(237,238,241,.5); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;')}>
                    {it.sub}
                  </div>
                )}
              </div>
              {it.meta && (
                <div style={css('flex:none; font-size:11px; color:rgba(237,238,241,.38); padding-top:2px;')}>{it.meta}</div>
              )}
            </div>

            {isOpen && (
              <div style={css('padding:0 13px 12px; display:flex; flex-direction:column; gap:10px;')}>
                {it.body && (
                  <div style={css('font-size:12.5px; line-height:1.55; color:rgba(237,238,241,.72); text-wrap:pretty; white-space:pre-wrap;')}>
                    {it.body}
                  </div>
                )}
                {it.actions?.length ? <Actions actions={it.actions} onAction={onAction} /> : null}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── agenda ───────────────────────────────────────────────────────────────────

/**
 * Time-ordered items grouped by day.
 *
 * Kept for model-authored cards, which have items rather than events — a card
 * about "the three things this week that need money" is a legitimate agenda and
 * has no calendar behind it. The connector's calendar no longer comes through
 * here; it gets the real surface.
 */
function AgendaWidget({ w, heat, onAction }: { w: Extract<Widget, { kind: 'agenda' }>; heat: string; onAction: Props['onAction'] }) {
  const [open, setOpen] = useState<string | null>(null)
  if (!w.items.length) return <Empty text={w.empty ?? 'Nothing scheduled.'} />

  const groups = new Map<string, WidgetItem[]>()
  for (const it of [...w.items].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))) {
    const day = (it.at ?? '').slice(0, 10)
    if (!groups.has(day)) groups.set(day, [])
    groups.get(day)!.push(it)
  }

  return (
    <div style={css('display:flex; flex-direction:column; gap:14px;')}>
      {[...groups.entries()].map(([day, items]) => (
        <div key={day} style={css('display:flex; flex-direction:column; gap:7px;')}>
          <div style={css('font-size:11.5px; font-weight:600; letter-spacing:.02em; color:rgba(237,238,241,.5);')}>
            {dayHeading(day)}
          </div>
          {items.map((it) => {
            const isOpen = open === it.id
            return (
              <div key={it.id} style={cssv`${CARD} overflow:hidden;`}>
                <div onClick={() => setOpen(isOpen ? null : it.id)} style={css('padding:11px 13px; display:flex; gap:11px; cursor:pointer; align-items:flex-start;')}>
                  <div style={cssv`flex:none; width:3px; align-self:stretch; min-height:26px; border-radius:999px; background:${accentOf(it.accent, heat)};`} />
                  <div style={css('flex:1; min-width:0;')}>
                    <div style={css('font-size:13.5px; font-weight:500; letter-spacing:-.01em; color:rgba(237,238,241,.9);')}>{it.title}</div>
                    {it.sub && <div style={css('margin-top:3px; font-size:12px; color:rgba(237,238,241,.5);')}>{it.sub}</div>}
                  </div>
                  {it.meta && <div style={css('flex:none; font-size:11.5px; color:rgba(237,238,241,.55); font-variant-numeric:tabular-nums;')}>{it.meta}</div>}
                </div>
                {isOpen && (
                  <div style={css('padding:0 13px 12px 27px; display:flex; flex-direction:column; gap:10px;')}>
                    {it.body && <div style={css('font-size:12.5px; line-height:1.55; color:rgba(237,238,241,.7); white-space:pre-wrap;')}>{it.body}</div>}
                    {it.actions?.length ? <Actions actions={it.actions} onAction={onAction} /> : null}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function dayHeading(day: string): string {
  const d = new Date(`${day}T00:00:00`)
  if (Number.isNaN(d.getTime())) return day
  const today = new Date()
  const diff = Math.round((d.getTime() - new Date(today.toDateString()).getTime()) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  // Weekday plus date, in HIS conventions rather than a hardcoded locale —
  // the app is used by an American living in Italy and guessing either way is
  // the wrong inference.
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })
}

// ── chart ────────────────────────────────────────────────────────────────────

function ChartWidget({ w, heat }: { w: Extract<Widget, { kind: 'chart' }>; heat: string }) {
  const max = Math.max(...w.points.map((p) => Math.max(p.value, p.compare ?? 0)), 1)
  const colour = accentOf(w.accent, heat)

  return (
    <div style={cssv`padding:14px 13px 11px; ${CARD}`}>
      <div style={css('position:relative; display:flex; align-items:flex-end; gap:6px; height:96px;')}>
        {w.target !== undefined && w.target > 0 && (
          <div style={cssv`position:absolute; left:0; right:0; bottom:${(w.target / max) * 100}%; height:1px; background:rgba(237,238,241,.22); border-top:1px dashed rgba(237,238,241,.28);`} />
        )}
        {w.points.map((p, i) => (
          <div key={i} style={css('flex:1; display:flex; flex-direction:column; justify-content:flex-end; align-items:center; height:100%; gap:5px;')}>
            <div style={cssv`width:100%; border-radius:5px 5px 2px 2px; background:${colour}; opacity:.85; height:${Math.max(2, (p.value / max) * 100)}%;`} />
          </div>
        ))}
      </div>
      <div style={css('display:flex; gap:6px; margin-top:7px;')}>
        {w.points.map((p, i) => (
          <div key={i} style={css('flex:1; text-align:center; font-size:10px; color:rgba(237,238,241,.4); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;')}>
            {p.label}
          </div>
        ))}
      </div>
      {w.target !== undefined && (
        <div style={css('margin-top:8px; font-size:11px; color:rgba(237,238,241,.42);')}>
          {w.compareLabel ?? 'target'} {Math.round(w.target).toLocaleString()}{w.unit ? ` ${w.unit}` : ''}
        </div>
      )}
    </div>
  )
}

// ── media ────────────────────────────────────────────────────────────────────

/**
 * Where this row came from, in one dim line.
 *
 * The distinction it draws is the whole reason the provenance layer exists: a
 * title read out of an account thirty seconds ago and a title the model worked
 * out from three other things look identical once they are both text on a card.
 * Retrieved data gets the ordinary muted treatment and says nothing loud;
 * anything inferred, stale or missing is set in italic so the eye catches it
 * without a badge shouting on every row.
 */
function Provenance({ item }: { item: WidgetItem }) {
  if (!item.provenance) return null
  // `enriched` is two sources agreeing about one thing — as real as a single
  // live read, and it must not be set in the italic reserved for a guess.
  const soft = item.origin === 'retrieved' || item.origin === 'enriched'
  return (
    <div
      style={cssv`margin-top:3px; font-size:10.5px; letter-spacing:.01em; color:rgba(237,238,241,${soft ? '.3' : '.42'}); ${soft ? '' : 'font-style:italic;'}`}
    >
      {item.provenance}
    </div>
  )
}

function MediaWidget({ w, onAction }: { w: Extract<Widget, { kind: 'media' }>; onAction: Props['onAction'] }) {
  const [open, setOpen] = useState<string | null>(null)
  if (!w.items.length) return <Empty text={w.empty ?? 'Nothing here.'} />

  return (
    <div style={cssv`display:grid; grid-template-columns:repeat(${w.columns ?? 2}, 1fr); gap:9px;`}>
      {w.items.map((it) => {
        const isOpen = open === it.id
        return (
          <div key={it.id} style={cssv`${CARD} overflow:hidden; display:flex; flex-direction:column; grid-column:${isOpen ? '1 / -1' : 'auto'};`}>
            <div onClick={() => setOpen(isOpen ? null : it.id)} style={css('cursor:pointer;')}>
              {it.image ? (
                <img
                  src={it.image}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  style={css('width:100%; aspect-ratio:16/9; object-fit:cover; display:block; background:rgba(255,255,255,.04);')}
                />
              ) : (
                <div style={css('width:100%; aspect-ratio:16/9; background:rgba(255,255,255,.04);')} />
              )}
              <div style={css('padding:9px 11px 11px;')}>
                <div style={cssv`font-size:12.5px; font-weight:500; line-height:1.35; color:rgba(237,238,241,.9); display:-webkit-box; -webkit-line-clamp:${isOpen ? '4' : '2'}; -webkit-box-orient:vertical; overflow:hidden;`}>
                  {it.title}
                </div>
                {it.sub && <div style={css('margin-top:4px; font-size:11px; color:rgba(237,238,241,.45);')}>{it.sub}</div>}
                <Provenance item={it} />
              </div>
            </div>
            {isOpen && (
              <div style={css('padding:0 11px 11px; display:flex; flex-direction:column; gap:9px;')}>
                {it.body && <div style={css('font-size:12px; line-height:1.5; color:rgba(237,238,241,.65); white-space:pre-wrap;')}>{it.body}</div>}
                {it.actions?.length ? <Actions actions={it.actions} onAction={onAction} /> : null}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── detail ───────────────────────────────────────────────────────────────────

function DetailWidget({ w, heat }: { w: Extract<Widget, { kind: 'detail' }>; heat: string }) {
  return (
    <div style={cssv`padding:4px 13px; ${CARD}`}>
      {w.rows.map((r, i) => (
        <div
          key={i}
          style={cssv`display:flex; gap:12px; padding:10px 0; align-items:baseline; ${i ? 'box-shadow:inset 0 1px 0 rgba(255,255,255,.05);' : ''}`}
        >
          <div style={css('flex:none; width:34%; font-size:11.5px; color:rgba(237,238,241,.45);')}>{r.label}</div>
          <div style={cssv`flex:1; min-width:0; font-size:13px; color:${r.accent ? accentOf(r.accent, heat) : 'rgba(237,238,241,.88)'}; text-wrap:pretty;`}>
            {r.value}
          </div>
        </div>
      ))}
      {w.body && (
        <div style={css('padding:10px 0 12px; font-size:12.5px; line-height:1.55; color:rgba(237,238,241,.7); box-shadow:inset 0 1px 0 rgba(255,255,255,.05); white-space:pre-wrap;')}>
          {w.body}
        </div>
      )}
    </div>
  )
}

export { clockOf, shortWhen }
