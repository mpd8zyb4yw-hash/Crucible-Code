// Full-page History tab (Crucible v3 left-rail design). Same data source as the
// existing topbar HistoryBinder dropdown (GET /api/conversations) — this is a dedicated
// full-screen surface for it rather than a small anchored panel, per the v3 spec's tab shell.
//
// Deletion (2026-07-21 direction): every chat row carries a quiet X (delete just that
// chat — server endpoint existed for a while, the UI never exposed it), and the page
// ends with a single red "Delete all chats" bubble. Delete-all is a FORGET-ME: the
// server clears the learned user memories (world model, entity graph, episodes,
// preference weights, feedback) along with the chats, so the assistant doesn't keep
// "remembering" things the user explicitly erased. Confirmed via a centered modal —
// destructive, irreversible, so it always asks first.

import { useEffect, useMemo, useState } from 'react'
import { API_BASE, apiFetch } from './api'
import { ConfirmModal } from './ui'

type HistorySession = { id: string; title: string; mode: string; snippet: string; updatedAt: number; roundCount: number }

function dayBucket(ts: number, now: number): string {
  const d = new Date(ts), n = new Date(now)
  if (d.toDateString() === n.toDateString()) return 'Today'
  const yesterday = new Date(now - 86400000)
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  if (now - ts < 7 * 86400000) return 'This Week'
  return 'Earlier'
}
const BUCKET_ORDER = ['Today', 'Yesterday', 'This Week', 'Earlier']

const MODE_COLOR: Record<string, string> = { local: '#4db89e', code: '#4db89e', seeker: '#f59e0b', quorum: '#7c7cf8', research: '#38bdf8' }

export default function HistoryTabView({ onRestore, onDeleted, onDeletedAll }: {
  onRestore: (session: HistorySession) => void
  /** A single chat was deleted — App drops its rounds/panel if it's open. */
  onDeleted?: (id: string) => void
  /** Everything was deleted (chats + learned memories) — App resets to a fresh state. */
  onDeletedAll?: () => void
}) {
  const [sessions, setSessions] = useState<HistorySession[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [confirmAll, setConfirmAll] = useState(false)
  const [wiping, setWiping] = useState(false)

  useEffect(() => {
    apiFetch('/api/conversations')
      .then(r => r.json())
      .then(d => setSessions(d.conversations ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const deleteOne = (id: string) => {
    // Optimistic: the row disappears immediately; a failed delete restores nothing —
    // the list refetches next mount and the server is the source of truth.
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
    } catch { /* server logs the failure; the list refetches next mount */ }
    setWiping(false)
    setConfirmAll(false)
  }

  const now = Date.now()
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return sessions
      .filter(s => !q || (s.title ?? '').toLowerCase().includes(q) || (s.snippet ?? '').toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [sessions, query])

  const buckets = useMemo(() => {
    const map = new Map<string, HistorySession[]>()
    for (const s of filtered) {
      const b = dayBucket(s.updatedAt, now)
      if (!map.has(b)) map.set(b, [])
      map.get(b)!.push(s)
    }
    return BUCKET_ORDER.map(label => ({ label, items: map.get(label) ?? [] })).filter(b => b.items.length > 0)
  }, [filtered, now])

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 1, overflowY: 'auto' }}>
      <div style={{ width: '100%', maxWidth: 720, margin: '0 auto', padding: '36px 32px 48px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', color: '#eef', flex: 1 }}>History</span>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search conversations…"
            style={{
              background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 12, padding: '8px 14px', fontSize: 12.5, color: '#d0d0e0',
              outline: 'none', fontFamily: 'inherit', width: 240,
            }}
          />
        </div>

        {loading && <span style={{ fontSize: 12, color: '#55556a' }}>Loading…</span>}
        {!loading && buckets.length === 0 && <span style={{ fontSize: 12, color: '#55556a' }}>No conversations yet.</span>}

        {buckets.map(bucket => (
          <div key={bucket.label} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: '#4a4a5e', textTransform: 'uppercase' }}>{bucket.label}</span>
            {bucket.items.map(s => (
              <div
                key={s.id}
                onClick={() => onRestore(s)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14,
                  background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', cursor: 'pointer',
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: MODE_COLOR[s.mode] ?? '#66667a', flexShrink: 0 }} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: '#d8d8e8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
                  <span style={{ fontSize: 11, color: '#66667a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.snippet}</span>
                </div>
                <span style={{
                  fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', padding: '2px 8px', borderRadius: 999,
                  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', color: '#66667a',
                  flexShrink: 0, textTransform: 'uppercase',
                }}>{s.mode}</span>
                <span style={{ fontSize: 10.5, color: '#4a4a5e', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                  {new Date(s.updatedAt).toLocaleDateString() === new Date(now).toLocaleDateString()
                    ? new Date(s.updatedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
                    : new Date(s.updatedAt).toLocaleDateString(undefined, { weekday: 'short' })}
                </span>
                <button
                  aria-label={`Delete "${s.title}"`}
                  title="Delete this chat"
                  onClick={e => { e.stopPropagation(); deleteOne(s.id) }}
                  style={{
                    width: 24, height: 24, borderRadius: 8, flexShrink: 0, cursor: 'pointer',
                    background: 'transparent', border: '1px solid transparent', color: '#55556a',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
                    transition: 'color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease)',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.color = '#f87171'; e.currentTarget.style.background = 'rgba(248,113,113,0.10)'; e.currentTarget.style.borderColor = 'rgba(248,113,113,0.3)' }}
                  onMouseLeave={e => { e.currentTarget.style.color = '#55556a'; e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent' }}
                >
                  <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
                    <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        ))}

        {/* Delete-all — same bubble geometry as a chat row, unmistakably red. */}
        {!loading && sessions.length > 0 && (
          <button
            onClick={() => setConfirmAll(true)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              padding: '12px 14px', borderRadius: 14, cursor: 'pointer', fontFamily: 'inherit',
              background: 'rgba(248,113,113,0.10)', border: '1px solid rgba(248,113,113,0.35)',
              color: '#fca5a5', fontSize: 12.5, fontWeight: 700,
              transition: 'background var(--dur-fast) var(--ease)',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(248,113,113,0.16)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(248,113,113,0.10)' }}
          >
            Delete all chats
          </button>
        )}
      </div>

      {/* Centered are-you-sure — destructive and irreversible, so it always asks. */}
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
    </div>
  )
}
