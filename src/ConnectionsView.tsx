// ── Connections page (Assistant layer step 2 — ASSISTANT_SPEC.md §2.4) ─────────
// Card grid over every external capability: Google (OAuth), CLI integrations,
// built-in Mac control. States are verified claims — "Test" fires real API calls
// server-side and shows the result; nothing here asserts health it hasn't checked.

import { useCallback, useEffect, useState } from 'react'
import { Card, SectionLabel, GhostButton, PrimaryButton, StatusChip } from './ui'
import { API_BASE, apiFetch, loginUrl } from './api'

interface Connection {
  id: string
  name: string
  kind: 'oauth' | 'cli' | 'builtin'
  authState: 'connected' | 'expired' | 'available' | 'disconnected'
  detail: string
  tools: string[]
  services?: Record<string, boolean>
}

interface GooglePreview {
  gmail: Array<{ id: string; from: string; subject: string; date: string; unread: boolean }> | null
  calendar: Array<{ title: string; start: string; end: string; allDay: boolean }> | null
}

function relTime(dateStr: string): string {
  const t = new Date(dateStr).getTime()
  if (!Number.isFinite(t)) return ''
  const mins = Math.round((Date.now() - t) / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h`
  return `${Math.round(mins / (24 * 60))}d`
}

/** Inbox glimpse — real messages, unread-weighted rows, no imagery. */
function GmailWidget({ items }: { items: NonNullable<GooglePreview['gmail']> }) {
  return (
    <div style={{ background: 'rgba(0,0,0,0.32)', border: '1px solid var(--c-hairline)', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '7px 12px 6px', borderBottom: '1px solid var(--c-hairline)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <SectionLabel style={{ fontSize: 9.5 }}>Inbox</SectionLabel>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)', fontVariantNumeric: 'tabular-nums' }}>
          {items.filter(m => m.unread).length} unread
        </span>
      </div>
      {items.length === 0 && (
        <div style={{ padding: '10px 12px', fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)' }}>Inbox is empty.</div>
      )}
      {items.map(m => (
        <div key={m.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 12px', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', flexShrink: 0, alignSelf: 'center', background: m.unread ? '#7c7cf8' : 'transparent', border: m.unread ? 'none' : '1px solid var(--c-hairline)' }} />
          <span style={{ fontSize: 'var(--t-small)', fontWeight: m.unread ? 650 : 400, color: m.unread ? 'var(--c-text)' : 'var(--c-dim)', width: 108, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.from}</span>
          <span style={{ fontSize: 'var(--t-small)', color: m.unread ? '#c9c9da' : 'var(--c-dim)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.subject}</span>
          <span style={{ fontSize: 10.5, color: 'var(--c-dim-deep)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{relTime(m.date)}</span>
        </div>
      ))}
    </div>
  )
}

/** Upcoming-calendar strip — date chip + title + time, next 7 days. */
function CalendarWidget({ items }: { items: NonNullable<GooglePreview['calendar']> }) {
  const fmtDay = (s: string) => {
    const d = new Date(s)
    return { dow: d.toLocaleDateString([], { weekday: 'short' }), day: d.getDate() }
  }
  const fmtTime = (e: { start: string; end: string; allDay: boolean }) => e.allDay
    ? 'all day'
    : `${new Date(e.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–${new Date(e.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  return (
    <div style={{ background: 'rgba(0,0,0,0.32)', border: '1px solid var(--c-hairline)', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '7px 12px 6px', borderBottom: '1px solid var(--c-hairline)' }}>
        <SectionLabel style={{ fontSize: 9.5 }}>Next 7 days</SectionLabel>
      </div>
      {items.length === 0 && (
        <div style={{ padding: '10px 12px', fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)' }}>Nothing scheduled.</div>
      )}
      {items.map((e, i) => {
        const d = fmtDay(e.start)
        return (
          <div key={`${e.start}:${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
            <div style={{
              width: 34, flexShrink: 0, textAlign: 'center', borderRadius: 7, padding: '3px 0',
              background: 'rgba(124,124,248,0.10)', border: '1px solid rgba(124,124,248,0.22)',
            }}>
              <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#9d9dfa' }}>{d.dow}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-text)', fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{d.day}</div>
            </div>
            <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-text)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.title}</span>
            <span style={{ fontSize: 10.5, color: 'var(--c-dim)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{fmtTime(e)}</span>
          </div>
        )
      })}
    </div>
  )
}

const STATE_META: Record<Connection['authState'], { label: string; color: string }> = {
  connected: { label: 'connected', color: '#4db89e' },
  expired: { label: 'expired', color: '#f59e0b' },
  available: { label: 'available', color: '#7c7cf8' },
  disconnected: { label: 'not connected', color: '#55556a' },
}

type GithubPreview = { prs: Array<{ title: string; repo: string; url: string; updatedAt: string; state: string }> | null }

/** Open PRs the signed-in user authored — repo · title · relative age. Read-only via `gh`. */
function GithubWidget({ items }: { items: NonNullable<GithubPreview['prs']> }) {
  return (
    <div style={{ background: 'rgba(0,0,0,0.32)', border: '1px solid var(--c-hairline)', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '7px 12px 6px', borderBottom: '1px solid var(--c-hairline)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <SectionLabel style={{ fontSize: 9.5 }}>Your open PRs</SectionLabel>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)', fontVariantNumeric: 'tabular-nums' }}>{items.length}</span>
      </div>
      {items.length === 0 && (
        <div style={{ padding: '10px 12px', fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)' }}>No open PRs.</div>
      )}
      {items.map((p, i) => (
        <div key={`${p.url}:${i}`} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 12px', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
          <span style={{ fontSize: 'var(--t-small)', fontFamily: 'var(--mono)', color: 'var(--c-dim)', flexShrink: 0, maxWidth: 118, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.repo.split('/').pop()}</span>
          <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-text)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</span>
          <span style={{ fontSize: 10.5, color: 'var(--c-dim-deep)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{p.updatedAt ? relTime(p.updatedAt) : ''}</span>
        </div>
      ))}
    </div>
  )
}

function ConnectionCard({ c, onChanged }: { c: Connection; onChanged: () => void }) {
  const st = STATE_META[c.authState]
  const [testing, setTesting] = useState(false)
  const [checks, setChecks] = useState<Record<string, { ok: boolean; detail: string }> | null>(null)
  const [preview, setPreview] = useState<GooglePreview | null>(null)
  const [ghPreview, setGhPreview] = useState<GithubPreview | null>(null)

  // Live widgets: real inbox/calendar data the moment the card mounts connected.
  useEffect(() => {
    if (c.id !== 'google' || c.authState !== 'connected') return
    let dead = false
    apiFetch(`${API_BASE}/api/connections/google/preview`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(p => { if (!dead && p) setPreview(p) })
      .catch(() => {})
    return () => { dead = true }
  }, [c.id, c.authState])

  // Live GitHub widget: the user's own open PRs via `gh` (honest-absence — absent on any failure).
  useEffect(() => {
    if (c.id !== 'cli-github' || c.authState !== 'connected') return
    let dead = false
    apiFetch(`${API_BASE}/api/connections/github/preview`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(p => { if (!dead && p) setGhPreview(p) })
      .catch(() => {})
    return () => { dead = true }
  }, [c.id, c.authState])

  const test = async () => {
    setTesting(true); setChecks(null)
    try {
      const r = await apiFetch(`${API_BASE}/api/connections/google/test`, { method: 'POST', credentials: 'include' })
      if (r.ok) setChecks((await r.json()).checks)
    } catch { /* surfaced by empty checks */ }
    setTesting(false)
  }
  const disconnect = async () => {
    await apiFetch(`${API_BASE}/api/connections/google/disconnect`, { method: 'POST', credentials: 'include' }).catch(() => {})
    setChecks(null); onChanged()
  }

  return (
    <Card accent={c.authState === 'connected' ? st.color : undefined} style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 9 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: st.color, flexShrink: 0 }} />
        <span style={{ fontSize: 'var(--t-body)', fontWeight: 600, color: 'var(--c-text)' }}>{c.name}</span>
        <StatusChip color={st.color}>{st.label}</StatusChip>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{c.kind}</span>
      </div>
      <div style={{ fontSize: 'var(--t-ui)', color: 'var(--c-dim)', lineHeight: 1.55, overflowWrap: 'anywhere' }}>{c.detail}</div>
      {c.tools.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {c.tools.map(t => (
            <span key={t} style={{
              fontSize: 'var(--t-small)', fontFamily: 'var(--mono)', color: 'var(--c-dim)',
              background: 'rgba(0,0,0,0.35)', border: '1px solid var(--c-hairline)',
              borderRadius: 6, padding: '2px 7px',
            }}>{t}</span>
          ))}
        </div>
      )}
      {checks && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {Object.entries(checks).map(([svc, r]) => (
            <div key={svc} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 'var(--t-small)' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: r.ok ? '#4db89e' : '#f87171', flexShrink: 0, alignSelf: 'center' }} />
              <span style={{ color: 'var(--c-text)', fontWeight: 600 }}>{svc}</span>
              <span style={{ color: 'var(--c-dim)', overflowWrap: 'anywhere' }}>{r.detail}</span>
            </div>
          ))}
        </div>
      )}
      {preview?.gmail && <GmailWidget items={preview.gmail} />}
      {preview?.calendar && <CalendarWidget items={preview.calendar} />}
      {ghPreview?.prs && <GithubWidget items={ghPreview.prs} />}
      {c.id === 'google' && (
        <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
          {(c.authState === 'disconnected' || c.authState === 'expired') && (
            <PrimaryButton onClick={() => { window.location.href = loginUrl('google') }}>
              {c.authState === 'expired' ? 'Reconnect' : 'Connect Google'}
            </PrimaryButton>
          )}
          {c.authState === 'connected' && (
            <>
              <GhostButton onClick={test} title="Fire a real Gmail + Calendar call to verify access">{testing ? 'Testing…' : 'Test'}</GhostButton>
              <GhostButton onClick={disconnect} title="Forget stored Google tokens (reconnect any time)">Disconnect</GhostButton>
            </>
          )}
        </div>
      )}
    </Card>
  )
}

export default function ConnectionsView({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<Connection[]>([])
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const r = await apiFetch(`${API_BASE}/api/connections`, { credentials: 'include' })
      if (r.ok) setList((await r.json()).connections ?? [])
    } catch { /* transient — next open retries */ }
    setLoaded(true)
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const groups: Array<{ label: string; kinds: Connection['kind'][] }> = [
    { label: 'Accounts', kinds: ['oauth'] },
    { label: 'Local tools', kinds: ['cli', 'builtin'] },
  ]

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 30, background: 'var(--c-bg)',
      display: 'flex', flexDirection: 'column', animation: 'panelUp 0.22s var(--ease)',
    }}>
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12,
        padding: `calc(var(--titlebar-clearance) + 14px) 20px 14px`,
        borderBottom: '1px solid var(--c-hairline)',
      }}>
        <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--c-text)' }}>Connections</span>
        {loaded && (
          <StatusChip color="#4db89e">{list.filter(c => c.authState === 'connected').length} active</StatusChip>
        )}
        <div style={{ flex: 1 }} />
        <GhostButton onClick={onClose} title="Back to chat">Close</GhostButton>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '18px 22px 24px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 860 }}>
          <div style={{ fontSize: 'var(--t-ui)', color: 'var(--c-dim)', lineHeight: 1.6, maxWidth: 620 }}>
            Everything the agent can reach beyond this app. Each connection powers specific agent
            tools — automations and Mission Control runs use them under your account.
          </div>
          {groups.map(g => {
            const items = list.filter(c => g.kinds.includes(c.kind))
            if (!items.length) return null
            return (
              <div key={g.label} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <SectionLabel>{g.label}</SectionLabel>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
                  {items.map(c => <ConnectionCard key={c.id} c={c} onChanged={() => void refresh()} />)}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
