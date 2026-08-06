import { useEffect, useMemo, useState } from 'react'
import { css, cssv } from './css'
import { accentOf } from './heat'
import type { Widget, WidgetAction, WidgetItem, WidgetPane } from './api'

/**
 * The widget renderer.
 *
 * Every card used to open into the same header-stats-chat view, so tapping Mail
 * gave you a conversation about your mail instead of your mail. This renders
 * the declarative specs from `server/widgets.ts` so a card opens into the thing
 * itself — and because the vocabulary is fixed and small, a card the model
 * invented gets a real interface without the model ever emitting markup.
 *
 * Style strings are pasted from the design and parsed by `css()` rather than
 * hand-converted, for the same reason as everywhere else in this app: the
 * visual design is finished work and a retyped shadow is an invisible
 * regression. Nothing here introduces a colour of its own — accents come from
 * `accentOf`, so a widget cannot drift the palette.
 */

interface Props {
  panes: WidgetPane[]
  heat: string
  /** Perform a named action. Resolves when it is done, throws to show an error. */
  onAction: (action: WidgetAction) => Promise<void>
}

export default function Widgets({ panes, heat, onAction }: Props) {
  if (!panes?.length) return null
  return (
    <div style={css('display:flex; flex-direction:column; gap:16px;')}>
      {panes.map((p, i) => (
        <Pane key={i} pane={p} heat={heat} onAction={onAction} />
      ))}
    </div>
  )
}

function Pane({ pane, heat, onAction }: { pane: WidgetPane; heat: string; onAction: Props['onAction'] }) {
  return (
    <div style={css('display:flex; flex-direction:column; gap:9px;')}>
      {pane.title && (
        <div style={css('font-size:11px; font-weight:600; letter-spacing:.07em; text-transform:uppercase; color:rgba(237,238,241,.42);')}>
          {pane.title}
        </div>
      )}
      <Body widget={pane.widget} heat={heat} onAction={onAction} />
      {pane.actions?.length ? <Actions actions={pane.actions} onAction={onAction} /> : null}
    </div>
  )
}

/**
 * An unknown widget kind renders as nothing rather than as an error.
 *
 * The brain and the app are deployed separately — one on the Mac, one on a
 * Worker, and the phone caches an older bundle than either. A spec naming a
 * primitive this build has never heard of therefore has to be survivable: the
 * card falls back to its chat thread, which is exactly what it did before, and
 * nothing crashes on a screen he is holding.
 */
function Body({ widget, heat, onAction }: { widget: Widget; heat: string; onAction: Props['onAction'] }) {
  switch (widget?.kind) {
    case 'list': return <ListWidget w={widget} heat={heat} onAction={onAction} />
    case 'agenda': return <AgendaWidget w={widget} heat={heat} onAction={onAction} />
    case 'chart': return <ChartWidget w={widget} heat={heat} />
    case 'media': return <MediaWidget w={widget} onAction={onAction} />
    case 'detail': return <DetailWidget w={widget} heat={heat} />
    case 'compose': return <ComposeWidget w={widget} onAction={onAction} />
    case 'map': return <MapWidget w={widget} heat={heat} />
    default: return null
  }
}

// ── compose ──────────────────────────────────────────────────────────────────

/**
 * The one primitive that produces text rather than showing it.
 *
 * A reply lives here rather than in Gmail, which is the whole point of the
 * exercise — but sending is irreversible and visible to someone else, so the
 * send button confirms before it fires and the text it will send is on screen
 * while it does. Nothing auto-sends: there is no path from a model deciding
 * something to a message leaving, only from his thumb.
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

// ── Shared furniture ─────────────────────────────────────────────────────────

const CARD = 'border-radius:15px; background:rgba(255,255,255,.05); box-shadow:inset 0 0 0 1px rgba(255,255,255,.07);'

function Empty({ text }: { text: string }) {
  return (
    <div style={cssv`padding:20px 15px; text-align:center; font-size:12.5px; color:rgba(237,238,241,.38); ${CARD}`}>
      {text}
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
function Actions({
  actions,
  onAction,
  intercept,
}: {
  actions: WidgetAction[]
  onAction: Props['onAction']
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
            onClick={() => void run(a, i)}
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

// ── list ─────────────────────────────────────────────────────────────────────

function ListWidget({ w, heat, onAction }: { w: Extract<Widget, { kind: 'list' }>; heat: string; onAction: Props['onAction'] }) {
  const [open, setOpen] = useState<string | null>(null)
  const [filter, setFilter] = useState<string | null>(null)
  /**
   * Which row is being replied to.
   *
   * Reply is the one action that does not simply happen — it needs him to write
   * something first. Rather than a separate screen, the composer unfolds under
   * the message it answers, so the thing being replied to stays on screen while
   * the reply is written. Intercepted here rather than sent to the server,
   * because there is nothing yet to send.
   */
  const [replying, setReplying] = useState<string | null>(null)

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
                {it.actions?.length ? (
                  <Actions
                    actions={it.actions}
                    onAction={onAction}
                    intercept={(a) => {
                      if (a.kind !== 'mail.reply') return false
                      setReplying(replying === it.id ? null : it.id)
                      return true
                    }}
                  />
                ) : null}

                {replying === it.id && (
                  <ComposeWidget
                    w={{
                      kind: 'compose',
                      to: it.sub,
                      placeholder: `Reply to ${it.sub ?? 'this'}…`,
                      submit: {
                        kind: 'mail.send',
                        label: 'Send reply',
                        busy: 'Sending…',
                        // Sending is visible to someone else and cannot be
                        // taken back, so the composer confirms before it fires.
                        irreversible: true,
                        params: { messageId: it.id },
                      },
                    }}
                    onAction={onAction}
                  />
                )}
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
 * A calendar is not a list.
 *
 * What matters about an event is which day it falls on and what else is on that
 * day, so items are grouped by date with the day as a heading. Rendering them
 * as a flat list — which is what the generic list would do — loses exactly the
 * information a calendar exists to carry.
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

// ── map ──────────────────────────────────────────────────────────────────────

/**
 * A map, built from tile images rather than a mapping library.
 *
 * Leaflet or MapLibre would be the obvious choice and both are the wrong one
 * here: the hosted app runs under a strict CSP with no external scripts, and
 * pulling a mapping stack into the bundle to draw a dozen pins is a lot of
 * weight for a phone on a mountain connection. A slippy map is a grid of 256px
 * PNGs at computed coordinates — that part is arithmetic, and the arithmetic is
 * below.
 *
 * Everything is keyless: OpenStreetMap tiles, Nominatim for search, OSRM for
 * routing. No billing account, nothing to expire, and no API key that could
 * leak from a phone. Google's Directions and Places APIs are billable and would
 * have meant putting a payment method behind a card he taps.
 */
const TILE = 256

const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * Math.pow(2, z)
const latToY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z)
}

function MapWidget({ w, heat }: { w: Extract<Widget, { kind: 'map' }>; heat: string }) {
  const [places, setPlaces] = useState(w.places)
  const [me, setMe] = useState<{ lat: number; lon: number } | null>(null)
  const [route, setRoute] = useState<{ lat: number; lon: number }[] | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  const W = 343
  const H = 210

  /**
   * His own position, asked for only when the widget says it needs it.
   *
   * The browser prompts once and the phone is the device that actually knows —
   * which is the whole reason this works at all, since the life data is on the
   * phone and not the Mac.
   */
  useEffect(() => {
    if (!w.follow || !navigator.geolocation) return
    const id = navigator.geolocation.watchPosition(
      (p) => setMe({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => setFailed('I could not get your location — the browser refused it.'),
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: 12_000 }
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [w.follow])

  const pins = useMemo(
    () => (me ? [...places, { id: 'me', label: 'You', lat: me.lat, lon: me.lon, self: true }] : places),
    [places, me]
  )

  // Frame everything worth seeing, rather than trusting a hardcoded centre:
  // a route the user cannot see the end of is not a route.
  const view = useMemo(() => {
    const pts = [...pins, ...(route ?? []).map((p, i) => ({ id: `r${i}`, label: '', ...p }))]
    if (!pts.length) return { z: w.zoom ?? 13, cx: 0.5, cy: 0.5, lat: 0, lon: 0 }
    const lats = pts.map((p) => p.lat)
    const lons = pts.map((p) => p.lon)
    const lat = (Math.min(...lats) + Math.max(...lats)) / 2
    const lon = (Math.min(...lons) + Math.max(...lons)) / 2
    let z = w.zoom ?? 13
    if (pts.length > 1) {
      const spanLon = Math.max(...lons) - Math.min(...lons) || 1e-4
      const spanLat = Math.max(...lats) - Math.min(...lats) || 1e-4
      // Fit the wider of the two spans, then back off one level for margin.
      const zx = Math.log2((360 * W) / (TILE * spanLon))
      const zy = Math.log2((180 * H) / (TILE * spanLat))
      z = Math.max(2, Math.min(17, Math.floor(Math.min(zx, zy)) - 1))
    }
    return { z, lat, lon }
  }, [pins, route, w.zoom])

  const z = view.z
  const centreX = lonToX(view.lon, z)
  const centreY = latToY(view.lat, z)
  const originX = centreX * TILE - W / 2
  const originY = centreY * TILE - H / 2
  const toPx = (lat: number, lon: number) => ({
    x: lonToX(lon, z) * TILE - originX,
    y: latToY(lat, z) * TILE - originY,
  })

  const tiles = useMemo(() => {
    const out: { key: string; url: string; left: number; top: number }[] = []
    const n = Math.pow(2, z)
    const x0 = Math.floor(originX / TILE)
    const y0 = Math.floor(originY / TILE)
    for (let x = x0; x <= Math.floor((originX + W) / TILE); x++) {
      for (let y = y0; y <= Math.floor((originY + H) / TILE); y++) {
        if (y < 0 || y >= n) continue
        const wx = ((x % n) + n) % n
        out.push({
          key: `${z}/${wx}/${y}`,
          url: `https://tile.openstreetmap.org/${z}/${wx}/${y}.png`,
          left: x * TILE - originX,
          top: y * TILE - originY,
        })
      }
    }
    return out
  }, [z, originX, originY])

  const search = async () => {
    if (!query.trim() || busy) return
    setBusy('Searching…')
    setFailed(null)
    try {
      const r = await fetch(`/api/map/search?q=${encodeURIComponent(query)}`)
      const b = await r.json()
      if (!r.ok) throw new Error(b?.error ?? 'Search failed')
      if (!b.places?.length) { setFailed(`Nothing found for "${query}".`); return }
      setPlaces(b.places)
      setRoute(null)
      setSummary(null)
    } catch (e) {
      setFailed((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const draw = async (mode: 'walk' | 'drive' | 'cycle') => {
    const from = me ?? places[0]
    const to = places[places.length - 1]
    if (!from || !to || from === to) { setFailed('I need two places to draw a route between.'); return }
    setBusy('Routing…')
    setFailed(null)
    try {
      const r = await fetch(`/api/map/route?from=${from.lat},${from.lon}&to=${to.lat},${to.lon}&mode=${mode}`)
      const b = await r.json()
      if (!r.ok) throw new Error(b?.error ?? 'Routing failed')
      setRoute(b.points ?? [])
      setSummary(b.summary ?? null)
    } catch (e) {
      setFailed((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={css('display:flex; flex-direction:column; gap:9px;')}>
      {w.searchable && (
        <div style={cssv`display:flex; align-items:center; gap:8px; padding:8px 12px; border-radius:999px; ${CARD}`}>
          <input
            value={query}
            placeholder="Search for a place…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void search() }}
            style={css('flex:1; min-width:0; background:transparent; border:0; outline:0; font-family:inherit; font-size:13px; color:rgba(237,238,241,.9);')}
          />
          <div onClick={() => void search()} style={css('flex:none; font-size:12px; color:rgba(237,238,241,.55); cursor:pointer;')}>
            {busy === 'Searching…' ? '…' : 'Go'}
          </div>
        </div>
      )}

      <div style={cssv`position:relative; height:${H}px; border-radius:15px; overflow:hidden; background:#1b1d22; box-shadow:inset 0 0 0 1px rgba(255,255,255,.07);`}>
        {tiles.map((t) => (
          <img
            key={t.key}
            src={t.url}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            style={cssv`position:absolute; width:${TILE}px; height:${TILE}px; left:${t.left}px; top:${t.top}px; filter:grayscale(.82) brightness(.44) contrast(1.12) saturate(.7);`}
          />
        ))}

        {/* The route, drawn over the tiles as one SVG path. */}
        {route && route.length > 1 && (
          <svg width={W} height={H} style={css('position:absolute; left:0; top:0; pointer-events:none;')}>
            <path
              d={route.map((p, i) => { const q = toPx(p.lat, p.lon); return `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}` }).join(' ')}
              fill="none"
              stroke={accentOf('teal', heat)}
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.95"
            />
          </svg>
        )}

        {pins.map((p) => {
          const q = toPx(p.lat, p.lon)
          if (q.x < -20 || q.x > W + 20 || q.y < -20 || q.y > H + 20) return null
          return (
            <div key={p.id} style={cssv`position:absolute; left:${q.x}px; top:${q.y}px; transform:translate(-50%,-50%); display:flex; flex-direction:column; align-items:center; gap:3px; pointer-events:none;`}>
              <div style={cssv`width:${p.self ? '13' : '11'}px; height:${p.self ? '13' : '11'}px; border-radius:999px; background:${p.self ? '#7CD9C0' : accentOf('rose', heat)}; box-shadow:0 0 0 3px rgba(11,11,13,.65), 0 1px 5px rgba(0,0,0,.5);`} />
              {!p.self && (
                <div style={css('max-width:96px; padding:2px 6px; border-radius:6px; background:rgba(11,11,13,.78); font-size:9.5px; line-height:1.3; color:rgba(237,238,241,.9); text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;')}>
                  {p.label}
                </div>
              )}
            </div>
          )
        })}

        {/* OpenStreetMap's licence requires attribution wherever its tiles are shown. */}
        <div style={css('position:absolute; right:5px; bottom:4px; font-size:8.5px; color:rgba(237,238,241,.42); background:rgba(11,11,13,.5); padding:1px 5px; border-radius:4px;')}>
          © OpenStreetMap
        </div>
      </div>

      {summary && (
        <div style={css('font-size:12px; color:rgba(237,238,241,.6);')}>{summary}</div>
      )}

      <div style={css('display:flex; gap:7px; flex-wrap:wrap;')}>
        {(['walk', 'cycle', 'drive'] as const).map((m) => (
          <div
            key={m}
            onClick={() => void draw(m)}
            style={cssv`padding:7px 13px; border-radius:999px; background:rgba(255,255,255,${w.route === m ? '.14' : '.05'}); box-shadow:inset 0 0 0 1px rgba(255,255,255,.1); font-size:12px; color:rgba(237,238,241,${busy ? '.4' : '.78'}); cursor:pointer;`}
          >
            {busy === 'Routing…' ? '…' : m === 'walk' ? 'Walk' : m === 'cycle' ? 'Cycle' : 'Drive'}
          </div>
        ))}
      </div>

      {failed && <div style={css('font-size:11.5px; color:rgba(255,170,170,.8); line-height:1.45;')}>{failed}</div>}
    </div>
  )
}
