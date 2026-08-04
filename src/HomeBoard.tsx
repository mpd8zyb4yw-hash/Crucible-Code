// ── HomeBoard — the leading surface ────────────────────────────────────────────
// Home is where Crucible opens. It is the agentic assistant surface: what is running,
// what needs you, what moved. Chat is a dock below it, not the main event.
//
// This REPLACES two things that had drifted into duplicating each other:
//   · Mission Control's "overview" board (MissionWidgets.tsx) — customizable widgets
//     with honest empty states, which was already most of what Home needed.
//   · The phase-1 HomeSurface (2026-08-03) — a second arrangement system with its own
//     localStorage key, its own fetcher, and an adaptive pinned/suggested ranking.
// One board, one layout store, one fetcher. See design/widgets.ts for the storage
// migration that carries a curated Mission Control board across.
//
// TWO LAWS, both from the user and both deliberate departures from DESIGN_HANDOFF §4.1:
//
//   1. CARDS ARE ALWAYS PRESENT. The handoff says "if there is nothing real to show,
//      show fewer cards — never filler." That is wrong for an assistant: hiding the
//      Calendar because today happens to be empty reads as a broken app, not an honest
//      one. Every widget on the board renders, always, with a truthful empty state —
//      an empty calendar shows an empty calendar. The ONE exception is below.
//   2. THE USER'S ORDER IS THE ORDER. Nothing re-ranks the board.
//
// The exception to law 1: a fresh install with no accounts linked would be six cards
// all saying "isn't connected", which reads as broken rather than honest. Consecutive
// not-connected widgets collapse into a single "Connect your accounts" card. Empty-BUT-
// CONNECTED always renders in full, which is the case law 1 exists to protect.

import { useCallback, useMemo, useState } from 'react'
import { CardLabel, glassSurface, type Domain } from './design/glass'
import { WIDGETS, ALL_WIDGETS, loadWidgetLayout, saveWidgetLayout, type WidgetId, type WidgetRoute } from './design/widgets'
import { useHomeFeeds } from './design/homeFeeds'
import { deriveCalendar, deriveMail, deriveWatch } from './design/homeData'
import { GmailWidget, CalendarWidget, GithubWidget } from './ConnectionWidgets'
import EmailReader, { type MessageStub } from './EmailReader'
import RunDetailOverlay, { type RunRef } from './RunDetailOverlay'
import CardDeck from './CardDeck'
import WidgetTaskPanel from './WidgetTaskPanel'
import type { Round } from './chat/core'

const DECK_MAX_WIDTH = 700   // below this the board becomes a deck

function fmtWhen(ts: number): string {
  const d = new Date(ts)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const day = new Date(ts); day.setHours(0, 0, 0, 0)
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (day.getTime() === today.getTime()) return hm
  if (day.getTime() === today.getTime() + 86400_000) return `tomorrow ${hm}`
  if (day.getTime() === today.getTime() - 86400_000) return `yesterday ${hm}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`
}

function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function untilLabel(ts: number, now: number): string {
  const mins = Math.max(0, Math.round((ts - now) / 60_000))
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  return mins % 60 === 0 ? `${h}h` : `${h}h ${mins % 60}m`
}

function greeting(h: number): string {
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

// ── Small shared pieces ────────────────────────────────────────────────────────

/** The big glanceable value. One answer at rest, not a dashboard. */
function HeroValue({ value, unit }: { value: string; unit: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
      <div style={{
        fontSize: 'var(--t-display)', fontWeight: 600, letterSpacing: '-0.03em',
        color: 'var(--glass-text)', lineHeight: 1,
      }}>{value}</div>
      {/* Wraps rather than clipping — survives a 3× longer string (house rule 3). */}
      <div style={{ fontSize: 15, color: 'var(--glass-text-2)', minWidth: 0, overflowWrap: 'anywhere' }}>{unit}</div>
    </div>
  )
}

function SupportLine({ children, quiet = false }: { children: React.ReactNode; quiet?: boolean }) {
  return (
    <div style={{
      fontSize: 13, lineHeight: 1.45,
      color: quiet ? 'var(--glass-text-2)' : 'var(--glass-text)',
      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const,
      overflow: 'hidden', overflowWrap: 'anywhere',
    }}>{children}</div>
  )
}

/**
 * Honest absence. The ONLY empty-state primitive on the board — when every widget
 * states its own absence the same way, "nothing to show" stops looking like a bug.
 */
function EmptyBody({ text, action, onAction }: { text: string; action?: string; onAction?: () => void }) {
  return (
    <div style={{
      padding: '12px 14px', fontSize: 13, lineHeight: 1.45, color: 'var(--glass-text-2)',
      background: 'var(--glass-fill-plate)', border: '1px solid var(--glass-edge)', borderRadius: 12,
      display: 'flex', alignItems: 'center', gap: 10,
    }}>
      <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{text}</span>
      {action && onAction && (
        <button onClick={onAction} style={{
          fontSize: 12, fontWeight: 600, color: '#A5B4FC', background: 'none', border: 'none',
          cursor: 'pointer', padding: 0, fontFamily: 'inherit', flexShrink: 0,
        }}>{action}</button>
      )}
    </div>
  )
}

/** Tiny square control in a widget header. */
function FrameButton({ label, onClick, danger, disabled, children }: {
  label: string; onClick: () => void; danger?: boolean; disabled?: boolean; children: React.ReactNode
}) {
  return (
    <button
      aria-label={label} title={label} onClick={onClick} disabled={disabled}
      style={{
        width: 24, height: 24, borderRadius: 7, flexShrink: 0, padding: 0,
        cursor: disabled ? 'default' : 'pointer', fontFamily: 'inherit',
        background: 'transparent', border: '1px solid transparent',
        color: disabled ? 'var(--glass-text-3)' : 'var(--glass-text-2)',
        opacity: disabled ? 0.4 : 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'color var(--dur-fast) var(--ease-standard), background var(--dur-fast) var(--ease-standard)',
      }}
      onMouseEnter={e => {
        if (disabled) return
        e.currentTarget.style.color = danger ? '#f87171' : 'var(--glass-text)'
        e.currentTarget.style.background = danger ? 'rgba(248,113,113,0.12)' : 'rgba(127,127,150,0.16)'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.color = disabled ? 'var(--glass-text-3)' : 'var(--glass-text-2)'
        e.currentTarget.style.background = 'transparent'
      }}
    >{children}</button>
  )
}

/** A row list on a plate, so rows hold contrast over the ambient field. */
function RowList({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--glass-fill-plate)', border: '1px solid var(--glass-edge)',
      borderRadius: 12, overflow: 'hidden',
    }}>{children}</div>
  )
}

export default function HomeBoard({
  allRounds, greetingName, onAsk, onRoute, onNewChat,
}: {
  allRounds: Round[]
  greetingName?: string
  /** Prefill the composer. NEVER auto-send — the confirm contract is the whole point. */
  onAsk: (prompt: string) => void
  onRoute: (r: WidgetRoute) => void
  onNewChat: () => void
}) {
  const { feeds } = useHomeFeeds()
  const [layout, setLayout] = useState<WidgetId[]>(loadWidgetLayout)
  const [reading, setReading] = useState<MessageStub | null>(null)
  const [openRun, setOpenRun] = useState<RunRef | null>(null)
  const [editing, setEditing] = useState(false)
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 1200 : window.innerWidth))

  const now = Date.now()
  const live = allRounds.filter(r => r.agent?.active)

  // Layout policy is decided by CONTAINER WIDTH, not by `isMobile`. App's `isMobile` is
  // a pointer-coarse test, so it would hand an iPad in landscape the deck and a narrow
  // desktop window the board — both wrong.
  const measure = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    setWidth(el.offsetWidth)
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setWidth(e.contentRect.width)
    })
    ro.observe(el)
  }, [])
  const deck = width > 0 && width < DECK_MAX_WIDTH

  const persist = (next: WidgetId[]) => { setLayout(next); saveWidgetLayout(next) }
  const move = (id: WidgetId, dir: -1 | 1) => {
    const i = layout.indexOf(id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= layout.length) return
    const next = [...layout]
    ;[next[i], next[j]] = [next[j], next[i]]
    persist(next)
  }
  const remove = (id: WidgetId) => persist(layout.filter(w => w !== id))
  const add = (id: WidgetId) => persist([...layout, id])

  const mail = useMemo(() => deriveMail(feeds.google), [feeds.google])
  const cal = useMemo(() => deriveCalendar(feeds.google, now), [feeds.google, now])
  const watch = useMemo(() => deriveWatch(feeds.automations, feeds.digest, now), [feeds.automations, feeds.digest, now])

  /** True when the widget's ACCOUNT is missing, as opposed to its data being empty. */
  const notConnected = (id: WidgetId): boolean => {
    if (id === 'inbox') return !feeds.google?.gmail
    if (id === 'calendar') return !feeds.google?.calendar
    if (id === 'github') return !feeds.github?.prs
    return false
  }

  // ── Widget bodies. Pure functions of `feeds`; they never learn which layout they
  // are in, which is what makes deck-vs-board a policy rather than a fork. ──
  const body = (id: WidgetId): React.ReactNode => {
    switch (id) {
      case 'runs':
        return live.length === 0
          ? <EmptyBody text="No agents working right now." action="New task" onAction={onNewChat} />
          : (
            <RowList>
              {live.slice(0, 4).map(r => (
                <div key={r.id} style={{
                  display: 'flex', alignItems: 'center', gap: 9, padding: '9px 12px',
                  borderBottom: '1px solid rgba(255,255,255,0.04)',
                }}>
                  <span className="cru-pulse" style={{
                    width: 6, height: 6, borderRadius: '50%', background: '#A5B4FC', flexShrink: 0,
                  }} />
                  <span style={{
                    fontSize: 13, color: 'var(--glass-text)', flex: 1, minWidth: 0,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{r.userMessage}</span>
                </div>
              ))}
            </RowList>
          )

      case 'inbox': {
        if (!feeds.google?.gmail) return <EmptyBody text="Gmail isn't connected." action="Connect" onAction={() => onRoute('connections')} />
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* The headline is the deterministic verdict, not an unread count — unread
                count is anxiety, not information. */}
            {mail && mail.needYou > 0
              ? <HeroValue value={String(mail.needYou)} unit="need you" />
              : <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--glass-text)' }}>Nothing needs a reply</div>}
            {mail?.topReasons.length ? <SupportLine quiet>{mail.topReasons.join(' · ')}</SupportLine> : null}
            <GmailWidget items={feeds.google.gmail} onOpenMessage={setReading} />
          </div>
        )
      }

      case 'calendar': {
        if (!feeds.google?.calendar) return <EmptyBody text="Google Calendar isn't connected." action="Connect" onAction={() => onRoute('connections')} />
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {cal?.nextStart != null && cal.nextTitle
              ? <HeroValue value={untilLabel(cal.nextStart, now)} unit={`until ${cal.nextTitle}`} />
              : <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--glass-text)' }}>Nothing else today</div>}
            {/* Exact interval arithmetic over the real event list — a deterministic
                solver computed this, so the card states it flatly. */}
            {cal?.longestFree && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'rgba(253,230,138,0.9)', flexShrink: 0 }} />
                <span style={{ fontSize: 13, color: 'var(--glass-text-2)', minWidth: 0, overflowWrap: 'anywhere' }}>
                  Longest free block: {fmtClock(cal.longestFree.start)}–{fmtClock(cal.longestFree.end)}
                </span>
              </div>
            )}
            {/* An empty calendar still shows a calendar (law 1). */}
            <CalendarWidget items={feeds.google.calendar} />
          </div>
        )
      }

      case 'github':
        return feeds.github?.prs
          ? <GithubWidget items={feeds.github.prs} />
          : <EmptyBody text="GitHub isn't connected." action="Connect" onAction={() => onRoute('connections')} />

      case 'watch':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* A self-disabled watch is NOT silence, and is styled as loudly as a change:
                silence must never be mistakable for "nothing changed". */}
            {watch.selfDisabled.length > 0 && (
              <div style={{
                padding: '10px 12px', borderRadius: 12,
                background: 'var(--alarm-fill)', border: '1px solid var(--alarm-edge)',
              }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--alarm-ink)' }}>
                  {watch.selfDisabled.length} stopped after 3 failures
                </div>
                <div style={{ marginTop: 4, fontSize: 12.5, lineHeight: 1.45, color: 'var(--glass-text-2)', overflowWrap: 'anywhere' }}>
                  {watch.selfDisabled.map(s => s.name).join(', ')} — silence here does not mean nothing changed.
                </div>
              </div>
            )}
            {watch.total === 0 ? (
              <EmptyBody text="Nothing being watched. Any answer can become a standing question." action="Add a watch" onAction={() => onRoute('automations')} />
            ) : watch.moved.length > 0 ? (
              <RowList>
                {watch.moved.map(m => (
                  <div key={`${m.name}-${m.at}`} style={{ padding: '9px 12px', borderBottom: '1px solid rgba(255,255,255,0.04)', minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{
                        fontSize: 13, fontWeight: 600, color: 'var(--glass-text)', flex: 1, minWidth: 0,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{m.name}</span>
                      <span style={{ fontSize: 10.5, color: 'var(--glass-text-2)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{fmtWhen(m.at)}</span>
                    </div>
                    <div style={{
                      marginTop: 3, fontSize: 12.5, lineHeight: 1.45, color: 'var(--glass-text-2)',
                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const,
                      overflow: 'hidden', overflowWrap: 'anywhere',
                    }}>{m.summary}</div>
                  </div>
                ))}
              </RowList>
            ) : (
              <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--glass-text)' }}>
                All {watch.total} quiet
              </div>
            )}
            {watch.total > 0 && (
              <div style={{ fontSize: 12.5, color: 'var(--glass-text-2)' }}>
                {watch.quiet} of {watch.total} quiet
                {feeds.upcoming[0]?.nextRun ? ` · next ${fmtWhen(feeds.upcoming[0].nextRun)}` : ''}
              </div>
            )}
          </div>
        )

      case 'digest':
        return feeds.digest.length === 0
          ? <EmptyBody text="No automation runs yet." />
          : (
            <RowList>
              {feeds.digest.map((e, i) => (
                <div
                  key={`${e.automationId}:${e.ts}:${i}`}
                  role="button" tabIndex={0}
                  onClick={() => setOpenRun({ automationId: e.automationId, ts: e.ts, name: e.name })}
                  onKeyDown={ev => { if (ev.key === 'Enter') setOpenRun({ automationId: e.automationId, ts: e.ts, name: e.name }) }}
                  style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.04)', cursor: 'pointer' }}
                  onMouseEnter={ev => { (ev.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)' }}
                  onMouseLeave={ev => { (ev.currentTarget as HTMLElement).style.background = 'transparent' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: e.status === 'ok' ? '#4db89e' : '#f87171', flexShrink: 0 }} />
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--glass-text)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
                    <span style={{ fontSize: 10.5, color: 'var(--glass-text-2)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{fmtWhen(e.ts)}</span>
                  </div>
                  <span style={{
                    fontSize: 12.5, color: 'var(--glass-text-2)', lineHeight: 1.5,
                    overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflowWrap: 'anywhere',
                  }}>{e.status === 'failed' ? `failed — ${e.summary}` : e.summary}</span>
                </div>
              ))}
            </RowList>
          )
    }
  }

  // ── The frame around every widget ──
  const frame = (id: WidgetId, i: number) => {
    const def = WIDGETS[id]
    return (
      <div style={{
        ...glassSurface(1, def.domain as Domain),
        // overflow:hidden is house rule 3's backstop — the Watch header (label + ask +
        // action) overran the card by 108px under a 3× string test without it.
        padding: 16, minWidth: 0, overflow: 'hidden',
        display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        {/* Wraps rather than overflowing: a widget with both an ask and an action has
            three header items, which cannot fit on one line at long label lengths. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' }}>
          <CardLabel domain={def.domain}>{def.title}</CardLabel>
          <div style={{ flex: 1, minWidth: 0 }} />
          {/* The action runs IN THE CARD (see the panel below the body). No prefill,
              no navigation, nothing to press Enter on. */}
          {def.action && (
            <button
              onClick={() => onRoute(def.action!.route)}
              style={{
                fontSize: 11, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
                padding: '4px 10px', borderRadius: 999, flexShrink: 0,
                background: 'transparent', border: '1px solid var(--glass-edge)',
                color: 'var(--glass-text-2)',
              }}
            >{def.action.label}</button>
          )}
          {editing && (
            <>
              <FrameButton label="Move earlier" onClick={() => move(id, -1)} disabled={i === 0}>
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </FrameButton>
              <FrameButton label="Move later" onClick={() => move(id, 1)} disabled={i === layout.length - 1}>
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </FrameButton>
              <FrameButton label={`Remove ${def.title}`} onClick={() => remove(id)} danger>
                <svg width="10" height="10" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              </FrameButton>
            </>
          )}
        </div>
        {body(id)}
        {def.ask && (
          <WidgetTaskPanel
            action={def.ask.label}
            prompt={def.ask.prompt}
            resultLabel={def.title}
            onOpenInChat={onAsk}
          />
        )}
      </div>
    )
  }

  // The exception to law 1: fold consecutive not-connected widgets into one card, so a
  // fresh install is an invitation rather than six identical apologies.
  const visible = layout.filter(id => !notConnected(id))
  const disconnected = layout.filter(notConnected)

  const cards: React.ReactNode[] = visible.map(id => <div key={id}>{frame(id, layout.indexOf(id))}</div>)
  const cardLabels: string[] = visible.map(id => WIDGETS[id].title)
  if (disconnected.length > 0 && feeds.loaded) {
    cards.push(
      <div key="__connect" style={{ ...glassSurface(1), padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <CardLabel>Connect</CardLabel>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--glass-text)' }}>
          {disconnected.map(id => WIDGETS[id].title).join(', ')}
        </div>
        <SupportLine quiet>Link an account and these fill in with your real data.</SupportLine>
        <button onClick={() => onRoute('connections')} style={{
          alignSelf: 'flex-start', fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
          padding: '8px 14px', borderRadius: 11,
          background: 'rgba(165,180,252,0.92)', color: '#101322', border: 'none',
        }}>Open Connections</button>
      </div>,
    )
    cardLabels.push('Connect your accounts')
  }

  const missing = ALL_WIDGETS.filter(w => !layout.includes(w))
  const obligations = mail?.needYou ?? 0
  const stateLine = [
    live.length > 0 ? `${live.length} agent${live.length === 1 ? '' : 's'} working.` : null,
    cal?.nextStart != null && cal.nextTitle ? `${cal.nextTitle} in ${untilLabel(cal.nextStart, now)}.` : null,
    obligations > 0 ? `${obligations} message${obligations === 1 ? '' : 's'} need you.` : null,
    watch.moved.length > 0 ? `${watch.moved.length} watch${watch.moved.length === 1 ? '' : 'es'} moved.` : null,
  ].filter(Boolean).join(' ')

  return (
    <div
      ref={measure}
      style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', position: 'relative' }}
    >
      <div style={{
        width: deck ? 'min(560px, 100% - 32px)' : 'min(1180px, 100% - 64px)',
        margin: '0 auto', padding: '20px 0 40px',
        display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        {/* Greeting + one line of real state. Never a slogan. */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '0 2px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 26, fontWeight: 600, letterSpacing: '-0.025em',
              color: 'var(--glass-text)', overflowWrap: 'anywhere',
            }}>{greeting(new Date(now).getHours())}{greetingName ? `, ${greetingName}` : ''}</div>
            <div style={{
              marginTop: 6, fontSize: 14.5, lineHeight: 1.5, color: 'var(--glass-text-2)',
              overflowWrap: 'anywhere',
            }}>{stateLine || (feeds.loaded ? 'Nothing needs you right now.' : 'Checking what needs you…')}</div>
          </div>
          <button
            onClick={() => setEditing(v => !v)}
            aria-pressed={editing}
            style={{
              flexShrink: 0, marginTop: 4, padding: '7px 13px', borderRadius: 10, cursor: 'pointer',
              background: editing ? 'rgba(165,180,252,0.22)' : 'rgba(127,127,150,0.14)',
              border: `1px solid ${editing ? 'rgba(165,180,252,0.4)' : 'var(--glass-edge)'}`,
              color: 'var(--glass-text)', fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
              transition: 'background var(--dur-fast) var(--ease-standard)',
            }}
          >{editing ? 'Done' : 'Arrange'}</button>
        </div>

        {editing && missing.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{
              font: '600 10px/1 var(--mono)', letterSpacing: '0.14em', textTransform: 'uppercase',
              color: 'var(--glass-text-2)',
            }}>Add</span>
            {missing.map(id => (
              <button key={id} onClick={() => add(id)} style={{
                fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
                padding: '5px 12px', borderRadius: 999,
                background: 'transparent', border: '1px dashed var(--glass-edge)',
                color: 'var(--glass-text-2)',
              }}>+ {WIDGETS[id].title}</button>
            ))}
          </div>
        )}

        {cards.length === 0 ? (
          <EmptyBody text="Your board is empty. Add a widget to get started." action={missing.length ? 'Arrange' : undefined} onAction={() => setEditing(true)} />
        ) : deck ? (
          <CardDeck items={cards} labels={cardLabels} />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16, alignItems: 'start' }}>
            {cards}
          </div>
        )}
      </div>

      {reading && (
        <EmailReader stub={reading} onClose={() => setReading(null)} onDraftReply={onAsk} />
      )}
      {openRun && (
        <RunDetailOverlay runRef={openRun} onClose={() => setOpenRun(null)} onFollowUp={onAsk} />
      )}
    </div>
  )
}
