import { useMemo, useState } from 'react'
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
    default: return null
  }
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
function Actions({ actions, onAction }: { actions: WidgetAction[]; onAction: Props['onAction'] }) {
  const [busy, setBusy] = useState<number | null>(null)
  const [confirming, setConfirming] = useState<number | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  const run = async (a: WidgetAction, i: number) => {
    if (busy !== null) return
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
