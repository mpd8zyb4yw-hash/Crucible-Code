// Persistent left sidebar (desktop only) — Claude-Code-style shell that replaces
// the 56px icon rail + pop-out history drawer. Navigation rows up top, the
// conversation history as time-bucketed slivers below, status at the bottom.
// Mobile is untouched: phones keep the horizontal NavRail in the top bar and the
// full-screen history drawer (this component is never mounted when isMobile).

import { memo, useEffect, useMemo, useState } from 'react'
import { API_BASE, apiFetch } from './api'
import { ConfirmModal } from './ui'
import type { CrucibleTab } from './NavRail'

export type HistorySession = { id: string; title: string; mode: string; snippet: string; updatedAt: number; roundCount: number }

function dayBucket(ts: number, now: number): string {
  const d = new Date(ts), n = new Date(now)
  if (d.toDateString() === n.toDateString()) return 'Today'
  const yesterday = new Date(now - 86400000)
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  if (now - ts < 7 * 86400000) return 'This Week'
  return 'Earlier'
}
const BUCKET_ORDER = ['Today', 'Yesterday', 'This Week', 'Earlier']

const MODE_COLOR: Record<string, string> = { local: 'var(--c-on-device)', code: 'var(--c-on-device)', seeker: 'var(--c-warn)', quorum: 'var(--c-accent)', research: '#38bdf8' }

// One history row. The reference primitive for the rail's visual language:
// 13px title, single-line ellipsis, hover lift via the shared .rail-sliver rule,
// active = filled bg + accent edge (see index.css). Hover swaps the timestamp for
// a quiet delete X — same slot, so rows never jump.
function Sliver({ session, active, onClick, onDelete }: { session: HistorySession; active: boolean; onClick: () => void; onDelete?: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <div
      className={`rail-sliver${active ? ' rail-sliver-active' : ''}`}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={session.snippet || session.title}
    >
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: MODE_COLOR[session.mode] ?? 'var(--c-dim-deep)', flexShrink: 0 }} />
      <span style={{
        flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 500,
        color: active ? 'var(--c-text)' : '#c2c2d4',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{session.title || 'Untitled'}</span>
      {hover && onDelete ? (
        <button
          aria-label={`Delete "${session.title || 'Untitled'}"`}
          title="Delete this chat"
          onClick={e => { e.stopPropagation(); onDelete() }}
          style={{
            width: 18, height: 18, borderRadius: 6, flexShrink: 0, cursor: 'pointer', padding: 0,
            background: 'rgba(248,113,113,0.10)', border: '1px solid rgba(248,113,113,0.3)', color: '#f87171',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <svg width="9" height="9" viewBox="0 0 14 14" fill="none">
            <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      ) : (
        <span style={{ fontSize: 10, color: 'var(--c-dim-deep)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
          {new Date(session.updatedAt).toDateString() === new Date().toDateString()
            ? new Date(session.updatedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
            : new Date(session.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
        </span>
      )}
    </div>
  )
}

function NavRow({ active, label, onClick, children, title, iconOnly }: {
  active: boolean; label: string; onClick: () => void; children: React.ReactNode; title?: string; iconOnly?: boolean
}) {
  return (
    <button
      className={`rail-nav-row${active ? ' rail-nav-row-active' : ''}`}
      onClick={onClick}
      title={title ?? label}
      style={iconOnly ? { width: 40, justifyContent: 'center', padding: 7 } : undefined}
    >
      <span style={{ width: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{children}</span>
      {!iconOnly && <span style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</span>}
    </button>
  )
}

function SidebarRail({ tab, setTab, agentsOpen, onToggleAgents, automationsOpen, onToggleAutomations, connectionsOpen, onToggleConnections, conversationId, onNewChat, onRestore, onDeleted, onDeletedAll, refreshKey, collapsed }: {
  tab: CrucibleTab
  setTab: (t: CrucibleTab) => void
  agentsOpen: boolean
  onToggleAgents: () => void
  automationsOpen: boolean
  onToggleAutomations: () => void
  connectionsOpen: boolean
  onToggleConnections: () => void
  conversationId: string
  onNewChat: () => void
  onRestore: (session: HistorySession) => void
  /** A single chat was deleted — App drops its rounds/panel if it's open. */
  onDeleted?: (id: string) => void
  /** Everything was deleted (chats + learned memories) — App resets to a fresh state. */
  onDeletedAll?: () => void
  // Bumped by App when a round finishes saving, so the list picks up new titles.
  refreshKey: number
  /** Slim icon-only mode — used while Mission Control is open, whose own run list makes
   *  the sidebar's history redundant; collapsing frees the screen for the workspace. */
  collapsed?: boolean
}) {
  const [sessions, setSessions] = useState<HistorySession[]>([])
  const [confirmAll, setConfirmAll] = useState(false)
  const [wiping, setWiping] = useState(false)

  useEffect(() => {
    let dead = false
    apiFetch('/api/conversations')
      .then(r => r.json())
      .then(d => { if (!dead) setSessions(d.conversations ?? []) })
      .catch(() => {})
    return () => { dead = true }
  }, [refreshKey])

  const deleteOne = (id: string) => {
    setSessions(prev => prev.filter(s => s.id !== id))
    apiFetch(`${API_BASE}/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' })
      .catch(() => {})
    onDeleted?.(id)
  }

  const deleteAll = async () => {
    setWiping(true)
    try {
      await apiFetch(`${API_BASE}/api/conversations`, { method: 'DELETE', credentials: 'include' })
      setSessions([])
      onDeletedAll?.()
    } catch { /* server logs the failure; the list refetches on next refreshKey bump */ }
    setWiping(false)
    setConfirmAll(false)
  }

  const now = Date.now()
  const buckets = useMemo(() => {
    const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
    const map = new Map<string, HistorySession[]>()
    for (const s of sorted) {
      const b = dayBucket(s.updatedAt, now)
      if (!map.has(b)) map.set(b, [])
      map.get(b)!.push(s)
    }
    return BUCKET_ORDER.map(label => ({ label, items: map.get(label) ?? [] })).filter(b => b.items.length > 0)
  }, [sessions, refreshKey])

  const iconOnly = !!collapsed

  return (
    <div style={{
      width: iconOnly ? 64 : 272, flexShrink: 0, zIndex: 20, height: '100%',
      display: 'flex', flexDirection: 'column',
      alignItems: iconOnly ? 'center' : 'stretch',
      // Traffic-light clearance comes from the shared shell token (0 on the web).
      padding: `calc(var(--titlebar-clearance) + 16px) ${iconOnly ? 8 : 10}px 12px`,
      background: 'rgba(255,255,255,0.025)',
      backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)',
      borderRight: '1px solid var(--c-hairline)',
      transition: 'width var(--dur) var(--ease)',
    }}>
      {/* Wordmark */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: iconOnly ? '2px 0 12px' : '2px 8px 12px' }}>
        <svg width="19" height="19" viewBox="0 0 48 48" fill="none">
          <path d="M10 14h28M10 14l6 22M38 14l-6 22M16 36q8 8 16 0" stroke="var(--c-text)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
        </svg>
        {!iconOnly && <span style={{ fontSize: 13.5, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--c-text)' }}>Crucible</span>}
      </div>

      {/* New chat */}
      <button className="rail-nav-row" onClick={onNewChat} title="New chat" style={{
        border: '1px solid var(--c-hairline)', background: 'rgba(255,255,255,0.04)', marginBottom: 10,
        ...(iconOnly ? { width: 40, justifyContent: 'center', padding: 7 } : {}),
      }}>
        <span style={{ width: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>
        {!iconOnly && <span style={{ fontSize: 12.5, fontWeight: 600 }}>New chat</span>}
      </button>

      {/* Mode rows */}
      <NavRow active={tab === 'chat' && !agentsOpen} label={iconOnly ? '' : 'Chat'} title="Chat" iconOnly={iconOnly} onClick={() => { if (agentsOpen) onToggleAgents(); setTab('chat') }}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
          <path d="M14 8a6 6 0 0 1-8.7 5.4L2 14l0.7-3A6 6 0 1 1 14 8Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      </NavRow>
      <NavRow active={agentsOpen} label={iconOnly ? '' : 'Agents'} title="Agents" iconOnly={iconOnly} onClick={onToggleAgents}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
          <rect x="3" y="5" width="10" height="8" rx="2.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8 5V2.8M6 9h.01M10 9h.01" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <circle cx="8" cy="2.2" r="0.9" fill="currentColor" />
        </svg>
      </NavRow>
      <NavRow active={automationsOpen} label={iconOnly ? '' : 'Automations'} title="Automations" iconOnly={iconOnly} onClick={onToggleAutomations}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8 4.8V8l2.3 1.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </NavRow>
      <NavRow active={connectionsOpen} label={iconOnly ? '' : 'Connections'} title="Connections" iconOnly={iconOnly} onClick={onToggleConnections}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
          <circle cx="4.5" cy="4.5" r="2.2" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="11.5" cy="11.5" r="2.2" stroke="currentColor" strokeWidth="1.4" />
          <path d="M6.2 6.2l3.6 3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </NavRow>

      {/* History slivers — hidden while collapsed (Mission Control has its own run list). */}
      {iconOnly ? (
        <div style={{ flex: 1 }} />
      ) : (
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', marginTop: 14, display: 'flex', flexDirection: 'column', gap: 2, paddingRight: 2 }}>
        {buckets.length === 0 && (
          <span style={{ fontSize: 11, color: 'var(--c-dim-deep)', padding: '4px 8px' }}>No conversations yet.</span>
        )}
        {buckets.map(bucket => (
          <div key={bucket.label} style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 8 }}>
            <span style={{
              fontSize: 9.5, fontWeight: 700, letterSpacing: '0.12em', color: '#4a4a5e',
              textTransform: 'uppercase', padding: '6px 8px 3px',
            }}>{bucket.label}</span>
            {bucket.items.map(s => (
              <Sliver key={s.id} session={s} active={s.id === conversationId} onClick={() => onRestore(s)} onDelete={() => deleteOne(s.id)} />
            ))}
          </div>
        ))}
        {/* Delete-all — quiet red row at the end of history; always confirms first. */}
        {sessions.length > 0 && (
          <button
            onClick={() => setConfirmAll(true)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
              margin: '2px 2px 6px', padding: '9px 0', borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit',
              background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.28)',
              color: '#f1a0a0', fontSize: 11.5, fontWeight: 700, flexShrink: 0,
              transition: 'background var(--dur-fast) var(--ease)',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(248,113,113,0.14)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(248,113,113,0.08)' }}
          >
            Delete all chats
          </button>
        )}
      </div>
      )}

      {confirmAll && (
        <ConfirmModal
          title="Delete all chats?"
          body="Every conversation is permanently deleted, and the assistant forgets what it learned about you from them — preferences, remembered facts, and feedback. This can't be undone."
          confirmLabel="Delete everything"
          busy={wiping}
          onConfirm={deleteAll}
          onCancel={() => setConfirmAll(false)}
        />
      )}

      {/* Bottom: settings */}
      <div style={{ borderTop: '1px solid var(--c-hairline)', paddingTop: 8, marginTop: 8, alignSelf: 'stretch', display: 'flex', flexDirection: 'column', alignItems: iconOnly ? 'center' : 'stretch' }}>
        <NavRow active={tab === 'settings'} label={iconOnly ? '' : 'Settings'} title="Settings" iconOnly={iconOnly} onClick={() => setTab('settings')}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </NavRow>
      </div>
    </div>
  )
}

export default memo(SidebarRail)
