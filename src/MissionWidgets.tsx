// ── Mission Control widget board ───────────────────────────────────────────────
// The customizable half of Mission Control (2026-07-21 direction): live, interactable
// widgets — inbox, calendar, open PRs, automation results, upcoming schedule — that the
// user can add, remove, and rearrange. The splash page stays clean; THIS is where the
// assistant's day lives.
//
// Mechanics:
//   · Layout = an ordered id list persisted in localStorage (crucible_mc_widgets) —
//     per-device, instant, no server round-trip for a pure view preference.
//   · Rearrange = explicit ◂ ▸ controls (keyboard-reachable, no drag physics to fight
//     on a glass grid); remove = X; add = chips listing whatever isn't on the board.
//   · Honest data: each widget renders its own real empty/not-connected state — a board
//     slot the user added is never silently blank, it says WHY it's empty.
//   · Interactable: Gmail rows open the in-app reader; PR rows open the PR; digest rows
//     open the full run; every widget has one "ask" action that drops a grounded prompt
//     into the chat composer (same prefill contract as the rest of the app).

import { useCallback, useEffect, useState } from 'react'
import { SectionLabel } from './ui'
import { API_BASE, apiFetch } from './api'
import { GmailWidget, CalendarWidget, GithubWidget, type GooglePreview, type GithubPreview } from './ConnectionWidgets'
import EmailReader, { type MessageStub } from './EmailReader'

interface DigestEntry { automationId: string; name: string; ts: number; status: 'ok' | 'failed'; summary: string; ms: number }
interface AutomationLite { id: string; name: string; enabled: boolean; nextRun: number | null }

export type WidgetId = 'inbox' | 'calendar' | 'github' | 'digest' | 'scheduled'

const WIDGET_META: Record<WidgetId, { label: string; color: string; ask?: { label: string; prompt: string } }> = {
  inbox: { label: 'Inbox', color: '#7c7cf8', ask: { label: 'Summarize', prompt: 'Summarize any inbox email from the last day that needs a reply.' } },
  calendar: { label: 'Calendar', color: '#4db89e', ask: { label: 'What’s ahead', prompt: 'Summarize today’s calendar and what’s coming up over the next few days.' } },
  github: { label: 'Open PRs', color: '#f59e0b', ask: { label: 'PR status', prompt: 'List my open GitHub PRs and flag any that look stalled or are waiting on review.' } },
  digest: { label: 'Automation results', color: '#38bdf8' },
  scheduled: { label: 'Scheduled', color: '#c084fc' },
}

const ALL_WIDGETS: WidgetId[] = ['inbox', 'calendar', 'github', 'digest', 'scheduled']
const LS_KEY = 'crucible_mc_widgets'

function loadLayout(): WidgetId[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return [...ALL_WIDGETS]
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [...ALL_WIDGETS]
    // Drop unknown ids (stale keys from older builds), keep the user's order.
    return parsed.filter((id: unknown): id is WidgetId => ALL_WIDGETS.includes(id as WidgetId))
  } catch { return [...ALL_WIDGETS] }
}

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

/** Tiny square icon button for the widget frame's header controls. */
function FrameButton({ label, onClick, danger, disabled, children }: {
  label: string; onClick: () => void; danger?: boolean; disabled?: boolean; children: React.ReactNode
}) {
  return (
    <button
      aria-label={label} title={label} onClick={onClick} disabled={disabled}
      style={{
        width: 22, height: 22, borderRadius: 7, flexShrink: 0, padding: 0,
        cursor: disabled ? 'default' : 'pointer', fontFamily: 'inherit',
        background: 'transparent', border: '1px solid transparent',
        color: disabled ? 'rgba(255,255,255,0.12)' : 'var(--c-dim-deep)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease)',
      }}
      onMouseEnter={e => {
        if (disabled) return
        e.currentTarget.style.color = danger ? '#f87171' : '#c8c8da'
        e.currentTarget.style.background = danger ? 'rgba(248,113,113,0.10)' : 'rgba(255,255,255,0.06)'
        e.currentTarget.style.borderColor = danger ? 'rgba(248,113,113,0.3)' : 'var(--c-hairline)'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.color = disabled ? 'rgba(255,255,255,0.12)' : 'var(--c-dim-deep)'
        e.currentTarget.style.background = 'transparent'
        e.currentTarget.style.borderColor = 'transparent'
      }}
    >{children}</button>
  )
}

/** Empty/not-connected body — honest absence with a pointer to the fix. */
function EmptyBody({ text, action, onAction }: { text: string; action?: string; onAction?: () => void }) {
  return (
    <div style={{
      padding: '14px 12px', fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)',
      background: 'rgba(0,0,0,0.32)', border: '1px solid var(--c-hairline)', borderRadius: 10,
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      <span style={{ flex: 1 }}>{text}</span>
      {action && onAction && (
        <button onClick={onAction} style={{
          fontSize: 10.5, fontWeight: 700, color: '#9d9dfa', background: 'none', border: 'none',
          cursor: 'pointer', padding: 0, fontFamily: 'inherit', flexShrink: 0,
        }}>{action}</button>
      )}
    </div>
  )
}

export default function MissionWidgets({ onAsk, onOpenRun, onOpenConnections }: {
  /** Drop a grounded prompt into the chat composer (prefill, never auto-send). */
  onAsk: (prompt: string) => void
  /** Open a digest run's full result (parent renders RunDetailOverlay). */
  onOpenRun: (r: { automationId: string; ts: number; name?: string }) => void
  /** Jump to the Connections page (empty-state pointer). */
  onOpenConnections: () => void
}) {
  const [layout, setLayout] = useState<WidgetId[]>(loadLayout)
  const [google, setGoogle] = useState<GooglePreview | null>(null)
  const [github, setGithub] = useState<GithubPreview | null>(null)
  const [digest, setDigest] = useState<DigestEntry[]>([])
  const [upcoming, setUpcoming] = useState<AutomationLite[]>([])
  const [loaded, setLoaded] = useState(false)
  const [reading, setReading] = useState<MessageStub | null>(null)

  const persist = (next: WidgetId[]) => {
    setLayout(next)
    try { localStorage.setItem(LS_KEY, JSON.stringify(next)) } catch { /* view pref only */ }
  }

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

  const refresh = useCallback(() => {
    // Best-effort per source — one failing connection never blanks the others.
    apiFetch(`${API_BASE}/api/connections/google/preview`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null).then(g => { if (g) setGoogle(g) }).catch(() => {})
    apiFetch(`${API_BASE}/api/connections/github/preview`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null).then(gh => { if (gh) setGithub(gh) }).catch(() => {})
    apiFetch(`${API_BASE}/api/automations/digest`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null).then(d => { if (d) setDigest((d.entries ?? []).slice(0, 6)) }).catch(() => {})
    apiFetch(`${API_BASE}/api/automations`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(a => {
        if (a) setUpcoming((a.automations ?? [])
          .filter((x: AutomationLite) => x.enabled && x.nextRun != null)
          .sort((x: AutomationLite, y: AutomationLite) => x.nextRun! - y.nextRun!)
          .slice(0, 5))
      }).catch(() => {})
  }, [])

  // Poll while mounted — a mission control that only loads once goes stale on the wall
  // (the Home surface had exactly that bug; 45s matches the data's real cadence).
  useEffect(() => {
    refresh()
    setLoaded(true)
    const iv = setInterval(refresh, 45_000)
    return () => clearInterval(iv)
  }, [refresh])

  const body = (id: WidgetId): React.ReactNode => {
    switch (id) {
      case 'inbox':
        return google?.gmail
          ? <GmailWidget items={google.gmail} onOpenMessage={setReading} />
          : <EmptyBody text="Gmail isn't connected." action="Open Connections" onAction={onOpenConnections} />
      case 'calendar':
        return google?.calendar
          ? <CalendarWidget items={google.calendar} />
          : <EmptyBody text="Google Calendar isn't connected." action="Open Connections" onAction={onOpenConnections} />
      case 'github':
        return github?.prs
          ? <GithubWidget items={github.prs} />
          : <EmptyBody text="GitHub isn't connected on this Mac." action="Open Connections" onAction={onOpenConnections} />
      case 'digest':
        return digest.length === 0
          ? <EmptyBody text="No automation runs yet." />
          : (
            <div style={{ background: 'rgba(0,0,0,0.32)', border: '1px solid var(--c-hairline)', borderRadius: 10, overflow: 'hidden' }}>
              {digest.map((e, i) => (
                <div
                  key={`${e.automationId}:${e.ts}:${i}`}
                  role="button" tabIndex={0}
                  onClick={() => onOpenRun({ automationId: e.automationId, ts: e.ts, name: e.name })}
                  onKeyDown={ev => { if (ev.key === 'Enter') onOpenRun({ automationId: e.automationId, ts: e.ts, name: e.name }) }}
                  style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '7px 12px', borderBottom: '1px solid rgba(255,255,255,0.03)', cursor: 'pointer' }}
                  onMouseEnter={ev => { (ev.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)' }}
                  onMouseLeave={ev => { (ev.currentTarget as HTMLElement).style.background = 'transparent' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: e.status === 'ok' ? '#4db89e' : '#f87171', flexShrink: 0 }} />
                    <span style={{ fontSize: 'var(--t-small)', fontWeight: 600, color: 'var(--c-text)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
                    <span style={{ fontSize: 10, color: 'var(--c-dim-deep)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{fmtWhen(e.ts)}</span>
                  </div>
                  <span style={{
                    fontSize: 'var(--t-small)', color: 'var(--c-dim)', lineHeight: 1.5,
                    overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflowWrap: 'anywhere',
                  }}>{e.status === 'failed' ? `failed — ${e.summary}` : e.summary}</span>
                </div>
              ))}
            </div>
          )
      case 'scheduled':
        return upcoming.length === 0
          ? <EmptyBody text="Nothing scheduled." />
          : (
            <div style={{ background: 'rgba(0,0,0,0.32)', border: '1px solid var(--c-hairline)', borderRadius: 10, overflow: 'hidden' }}>
              {upcoming.map(a => (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#c084fc', flexShrink: 0 }} />
                  <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-text)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                  <span style={{ fontSize: 10, color: 'var(--c-dim)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{fmtWhen(a.nextRun!)}</span>
                </div>
              ))}
            </div>
          )
    }
  }

  const missing = ALL_WIDGETS.filter(w => !layout.includes(w))

  if (!loaded) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Add chips — only whatever isn't on the board. */}
      {missing.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <SectionLabel>Add widget</SectionLabel>
          {missing.map(id => (
            <button
              key={id}
              onClick={() => add(id)}
              style={{
                fontSize: 10.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
                padding: '4px 10px', borderRadius: 999,
                background: 'rgba(255,255,255,0.04)', border: '1px dashed var(--c-hairline-strong)',
                color: 'var(--c-dim)', transition: 'color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease)',
              }}
              onMouseEnter={e => { e.currentTarget.style.color = WIDGET_META[id].color; e.currentTarget.style.borderColor = WIDGET_META[id].color }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--c-dim)'; e.currentTarget.style.borderColor = 'var(--c-hairline-strong)' }}
            >+ {WIDGET_META[id].label}</button>
          ))}
        </div>
      )}

      {layout.length === 0 && (
        <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)' }}>
          Board is empty — add a widget above.
        </span>
      )}

      {/* The board — order is the layout array; ◂ ▸ swap neighbors. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(310px, 1fr))', gap: 12 }}>
        {layout.map((id, i) => {
          const meta = WIDGET_META[id]
          return (
            <div key={id} style={{
              display: 'flex', flexDirection: 'column', gap: 8, padding: 12,
              borderRadius: 'var(--c-radius)', background: 'var(--c-glass)',
              border: '1px solid var(--c-hairline)', boxShadow: 'var(--c-inset-highlight)',
              minWidth: 0,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: meta.color, flexShrink: 0 }} />
                <span style={{ fontSize: 'var(--t-ui)', fontWeight: 700, color: 'var(--c-text)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {meta.label}
                </span>
                {meta.ask && (
                  <button
                    onClick={() => onAsk(meta.ask!.prompt)}
                    title="Ask about this in chat"
                    style={{
                      fontSize: 10, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
                      padding: '3px 9px', borderRadius: 999, flexShrink: 0,
                      background: 'rgba(255,255,255,0.04)', border: `1px solid ${meta.color}44`,
                      color: meta.color, transition: 'background var(--dur-fast) var(--ease)',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = `${meta.color}1f` }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
                  >{meta.ask.label}</button>
                )}
                <FrameButton label="Move earlier" onClick={() => move(id, -1)} disabled={i === 0}>
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </FrameButton>
                <FrameButton label="Move later" onClick={() => move(id, 1)} disabled={i === layout.length - 1}>
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </FrameButton>
                <FrameButton label={`Remove ${meta.label}`} onClick={() => remove(id)} danger>
                  <svg width="10" height="10" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                </FrameButton>
              </div>
              {body(id)}
            </div>
          )
        })}
      </div>

      {reading && (
        <EmailReader stub={reading} onClose={() => setReading(null)} onDraftReply={onAsk} />
      )}
    </div>
  )
}
