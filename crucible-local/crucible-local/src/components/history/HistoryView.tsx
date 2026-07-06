import { useMemo, useState } from 'react'
import { useCrucibleStore } from '../../state/store'
import type { ChatSession, SessionMode } from '../../state/types'

type Filter = 'all' | 'ensemble' | 'agent' | 'pinned'

const MODE_COLOR: Record<SessionMode, string> = { local: '#4db89e', ensemble: '#7c7cf8', agent: '#c084fc' }

function dayBucket(ts: number, now: number): string {
  const d = new Date(ts)
  const n = new Date(now)
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (sameDay(d, n)) return 'Today'
  const yesterday = new Date(now - 86400000)
  if (sameDay(d, yesterday)) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

function timeLabel(ts: number, now: number): string {
  const d = new Date(ts)
  const sameDay = new Date(now).toDateString() === d.toDateString()
  return sameDay ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString(undefined, { weekday: 'short' })
}

export default function HistoryView() {
  const sessions = useCrucibleStore((s) => s.sessions)
  const loadSession = useCrucibleStore((s) => s.loadSession)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  const now = Date.now()

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return sessions
      .filter((s) => {
        if (filter === 'pinned' && !s.pinned) return false
        if (filter === 'ensemble' && s.mode !== 'ensemble') return false
        if (filter === 'agent' && s.mode !== 'agent') return false
        if (!q) return true
        const snippet = s.messages[s.messages.length - 1]?.text ?? ''
        return s.title.toLowerCase().includes(q) || snippet.toLowerCase().includes(q)
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [sessions, query, filter])

  const buckets = useMemo(() => {
    const map = new Map<string, ChatSession[]>()
    for (const s of filtered) {
      const b = dayBucket(s.updatedAt, now)
      if (!map.has(b)) map.set(b, [])
      map.get(b)!.push(s)
    }
    return Array.from(map.entries()).map(([label, items]) => ({ label, items }))
  }, [filtered, now])

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 1, overflowY: 'auto' }}>
      <div style={{ width: '100%', maxWidth: 720, margin: '0 auto', padding: '36px 32px 48px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', color: '#eef', flex: 1 }}>History</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations…"
            style={{
              background: 'rgba(255,255,255,0.045)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 12,
              padding: '8px 14px',
              fontSize: 12.5,
              color: '#d0d0e0',
              outline: 'none',
              fontFamily: 'inherit',
              width: 240,
            }}
          />
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          {(['all', 'ensemble', 'agent', 'pinned'] as Filter[]).map((f) => (
            <span
              key={f}
              onClick={() => setFilter(f)}
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                padding: '4px 12px',
                borderRadius: 999,
                background: filter === f ? 'rgba(124,124,248,0.12)' : 'transparent',
                border: `1px solid ${filter === f ? 'rgba(124,124,248,0.3)' : 'rgba(255,255,255,0.07)'}`,
                color: filter === f ? '#9d9dfa' : '#55556a',
                cursor: 'pointer',
                textTransform: 'capitalize',
              }}
            >
              {f === 'all' ? 'All' : f === 'agent' ? 'Agents' : f.charAt(0).toUpperCase() + f.slice(1)}
            </span>
          ))}
        </div>

        {buckets.length === 0 && <span style={{ fontSize: 12, color: '#55556a' }}>No conversations yet.</span>}

        {buckets.map((bucket) => (
          <div key={bucket.label} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: '#4a4a5e', textTransform: 'uppercase' }}>{bucket.label}</span>
            {bucket.items.map((s) => {
              const snippet = s.messages[s.messages.length - 1]?.text ?? ''
              return (
                <div
                  key={s.id}
                  onClick={() => loadSession(s.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '12px 14px',
                    borderRadius: 14,
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: MODE_COLOR[s.mode], flexShrink: 0 }} />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: '#d8d8e8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.title}
                    </span>
                    <span style={{ fontSize: 11, color: '#66667a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{snippet}</span>
                  </div>
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      letterSpacing: '0.06em',
                      padding: '2px 8px',
                      borderRadius: 999,
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.07)',
                      color: '#66667a',
                      flexShrink: 0,
                      textTransform: 'uppercase',
                    }}
                  >
                    {s.mode}
                  </span>
                  <span style={{ fontSize: 10.5, color: '#4a4a5e', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{timeLabel(s.updatedAt, now)}</span>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
