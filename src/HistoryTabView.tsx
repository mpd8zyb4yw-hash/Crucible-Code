// Full-page History tab (Crucible v3 left-rail design). Same data source as the
// existing topbar HistoryBinder dropdown (GET /api/conversations) — this is a dedicated
// full-screen surface for it rather than a small anchored panel, per the v3 spec's tab shell.

import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from './api'

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

export default function HistoryTabView({ onRestore }: { onRestore: (session: HistorySession) => void }) {
  const [sessions, setSessions] = useState<HistorySession[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => {
    apiFetch('/api/conversations')
      .then(r => r.json())
      .then(d => setSessions(d.conversations ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

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
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
