// ── chat/binders — right-edge drawers: persistent task-graph goals + session history ──
import { useState, useRef, useEffect } from 'react'
import { API_BASE, apiFetch } from '../api'

// ── Persistent task-graph binder ────────────────────────────────────────────────
// Surfaces open multi-session goals (see src/CrucibleEngine/taskGraph.ts + the
// /api/task-graph endpoints). A small trigger in the topbar opens a right-edge
// drawer listing open graphs with per-node progress. Tapping one resumes its goal
// (sends it into the agent loop); the cross dismisses (abandons) it.
export type TaskGraphNode = { id: string; goal: string; status: string; assignedArchetype: string }
export type TaskGraphItem = { id: string; goal: string; created: number; status: string; total: number; done: number; nodes: TaskGraphNode[] }

export const ARCHETYPE_RGB: Record<string, string> = {
  researcher: '96,165,250', coder: '124,124,248', critic: '245,158,11', strategist: '77,184,158',
}

export function TasksBinder({ onResume }: { onResume: (goal: string) => void }) {
  const [open, setOpen]       = useState(false)
  const [graphs, setGraphs]   = useState<TaskGraphItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded]   = useState(false)
  const [draft, setDraft]     = useState('')
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef   = useRef<HTMLDivElement | null>(null)

  const fetchGraphs = () =>
    apiFetch(`${API_BASE}/api/task-graph`)
      .then(r => r.json())
      .then(d => { setGraphs(d.graphs ?? []); setLoading(false); setLoaded(true) })
      .catch(() => { setLoading(false); setLoaded(true) })

  useEffect(() => {
    if (!open || loaded) return
    setLoading(true)
    fetchGraphs()
  }, [open, loaded])

  // Poll while open so progress from a running agent stays current.
  useEffect(() => {
    if (!open) return
    const id = setInterval(() => fetchGraphs(), 20_000)
    return () => clearInterval(id)
  }, [open])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (triggerRef.current?.contains(e.target as Node) || panelRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Close on ESC
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const createGoal = () => {
    const goal = draft.trim()
    if (goal.length < 4) return
    apiFetch(`${API_BASE}/api/task-graph`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal }),
    })
      .then(r => r.json())
      .then(() => { setDraft(''); fetchGraphs() })
      .catch(() => {})
  }

  const dismissGoal = (id: string) => {
    setGraphs(prev => prev.filter(g => g.id !== id))   // optimistic
    apiFetch(`${API_BASE}/api/task-graph/${id}`, {
      method: 'DELETE', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'abandoned' }),
    }).catch(() => {})
  }

  return (
    <div className="crucible-tasks-binder" style={{ position: 'relative' }}>
      <style>{`
        @keyframes tasksSlideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }
        @keyframes tasksScrimIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes tasksPrism { 0% { background-position: 0% 50%; } 100% { background-position: 300% 50%; } }
      `}</style>

      {/* Trigger — checklist icon, matches topbar button style */}
      <button
        ref={triggerRef}
        onClick={() => setOpen(o => !o)}
        title="Open goals"
        style={{
          background: open ? 'rgba(77,184,158,0.1)' : 'none',
          border: 'none', cursor: 'pointer',
          color: open ? '#5fd0a8' : '#555',
          padding: '6px 7px', borderRadius: 8,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'color 0.18s, background 0.18s', position: 'relative',
        }}
      >
        {/* Checklist SVG */}
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.2 4.2l1.4 1.4 2.2-2.4"/>
          <path d="M2.2 10.4l1.4 1.4 2.2-2.4"/>
          <line x1="8.4" y1="4" x2="13.8" y2="4"/>
          <line x1="8.4" y1="11" x2="13.8" y2="11"/>
        </svg>
        {graphs.length > 0 && (
          <span style={{
            position: 'absolute', top: 2, right: 1,
            width: 6, height: 6, borderRadius: 3,
            background: 'rgba(77,184,158,0.9)',
            boxShadow: '0 0 4px rgba(77,184,158,0.7)',
          }} />
        )}
      </button>

      {/* Scrim */}
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 89, background: 'rgba(0,0,0,0.45)', animation: 'tasksScrimIn 0.28s ease' }}
        />
      )}

      {/* Drawer */}
      {open && (
        <div
          ref={panelRef}
          className="crucible-tasks-drawer"
          style={{
            position: 'fixed', top: 0, right: 0, bottom: 0,
            width: 'min(380px, 92vw)', zIndex: 90,
            display: 'flex', flexDirection: 'column',
            background: 'rgba(13,13,20,0.82)',
            backdropFilter: 'blur(40px) saturate(1.5)',
            WebkitBackdropFilter: 'blur(40px) saturate(1.5)',
            borderLeft: '1px solid rgba(255,255,255,0.08)',
            boxShadow: '-24px 0 80px rgba(0,0,0,0.5), inset 1px 0 0 rgba(255,255,255,0.05)',
            animation: 'tasksSlideIn 0.28s cubic-bezier(0.22,1,0.36,1)',
            overflow: 'hidden',
          }}
        >
          {/* Prismatic top edge */}
          <div style={{
            height: 2, flexShrink: 0,
            background: 'linear-gradient(90deg, #4db89e, #7c7cf8, #c084fc, #f59e0b, #4db89e)',
            backgroundSize: '300% 100%', animation: 'tasksPrism 8s linear infinite', opacity: 0.65,
          }} />

          {/* Header */}
          <div style={{
            padding: 'calc(14px + env(safe-area-inset-top, 0px)) 16px 10px', flexShrink: 0,
            borderBottom: '1px solid rgba(255,255,255,0.05)',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{
              fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
              color: 'rgba(160,200,180,0.6)', textTransform: 'uppercase', flex: 1,
            }}>Open goals{graphs.length > 0 ? ` · ${graphs.length}` : ''}</span>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close"
              style={{
                background: 'none', border: 'none', cursor: 'pointer', color: '#666',
                width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: 8, flexShrink: 0,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              </svg>
            </button>
          </div>

          {/* New-goal creator */}
          <div style={{ padding: '12px 16px', flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.04)', display: 'flex', gap: 8 }}>
            <input
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') createGoal() }}
              placeholder="Track a new goal…"
              style={{
                flex: 1, minWidth: 0,
                background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: 8, padding: '8px 11px',
                fontSize: 12.5, color: '#c8e8d8', outline: 'none', fontFamily: 'inherit',
              }}
            />
            <button
              onClick={createGoal}
              disabled={draft.trim().length < 4}
              style={{
                flexShrink: 0,
                background: draft.trim().length < 4 ? 'rgba(255,255,255,0.04)' : 'rgba(77,184,158,0.14)',
                border: `1px solid ${draft.trim().length < 4 ? 'rgba(255,255,255,0.06)' : 'rgba(77,184,158,0.3)'}`,
                color: draft.trim().length < 4 ? 'rgba(255,255,255,0.25)' : 'rgba(120,220,180,0.95)',
                borderRadius: 8, padding: '0 12px', fontSize: 12.5, fontWeight: 600,
                cursor: draft.trim().length < 4 ? 'default' : 'pointer',
                fontFamily: 'inherit', transition: 'background 0.15s, color 0.15s',
              }}
            >Add</button>
          </div>

          {/* List */}
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, WebkitOverflowScrolling: 'touch' }}>
            {loading && (
              <div style={{ textAlign: 'center', color: '#333', fontSize: 12, padding: '32px 0' }}>loading…</div>
            )}
            {!loading && graphs.length === 0 && (
              <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: 16, padding: '60px 24px', textAlign: 'center',
              }}>
                <svg width="56" height="56" viewBox="0 0 56 56" fill="none" style={{ opacity: 0.5 }}>
                  <rect x="11" y="9" width="34" height="38" rx="4" stroke="rgba(77,184,158,0.3)" strokeWidth="1.5"/>
                  <path d="M18 20l3 3 5-6" stroke="rgba(77,184,158,0.35)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <line x1="29" y1="20" x2="38" y2="20" stroke="rgba(124,124,248,0.3)" strokeWidth="1.5" strokeLinecap="round"/>
                  <line x1="18" y1="33" x2="38" y2="33" stroke="rgba(124,124,248,0.25)" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
                <span style={{ color: 'rgba(160,200,180,0.45)', fontSize: 12, lineHeight: 1.7 }}>
                  No open goals — add one to track work across sessions
                </span>
              </div>
            )}
            {graphs.map(g => {
              const pct = g.total > 0 ? Math.round((g.done / g.total) * 100) : 0
              return (
                <div
                  key={g.id}
                  style={{
                    padding: '13px 16px 14px',
                    borderBottom: '1px solid rgba(255,255,255,0.03)',
                    position: 'relative',
                  }}
                >
                  {/* Goal + dismiss */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 9 }}>
                    <button
                      onClick={() => { onResume(g.goal); setOpen(false) }}
                      title="Resume this goal"
                      style={{
                        flex: 1, minWidth: 0, textAlign: 'left' as const,
                        background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                        color: 'rgba(220,235,228,0.9)', fontSize: 13, fontWeight: 600,
                        lineHeight: 1.4, fontFamily: 'inherit',
                        overflowWrap: 'anywhere', wordBreak: 'break-word',
                      }}
                    >{g.goal}</button>
                    <button
                      onClick={() => dismissGoal(g.id)}
                      aria-label="Dismiss goal"
                      title="Dismiss"
                      style={{
                        flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer',
                        color: 'rgba(255,255,255,0.25)', width: 22, height: 22, borderRadius: 6,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'color 0.15s',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.color = 'rgba(255,140,140,0.8)' }}
                      onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.25)' }}
                    >
                      <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                        <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                      </svg>
                    </button>
                  </div>

                  {/* Progress bar */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <div style={{ flex: 1, height: 4, borderRadius: 3, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                      <div style={{
                        width: `${pct}%`, height: '100%', borderRadius: 3,
                        background: 'linear-gradient(90deg, rgba(77,184,158,0.8), rgba(124,124,248,0.8))',
                        transition: 'width 0.4s cubic-bezier(0.22,1,0.36,1)',
                      }} />
                    </div>
                    <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, color: 'rgba(160,200,180,0.6)', letterSpacing: '0.04em' }}>
                      {g.done}/{g.total}
                    </span>
                  </div>

                  {/* Node chips — archetype-colored, with done check */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                    {g.nodes.map(n => {
                      const rgb = ARCHETYPE_RGB[n.assignedArchetype] ?? '100,100,130'
                      const isDone = n.status === 'done'
                      return (
                        <span
                          key={n.id}
                          title={`${n.goal} — ${n.assignedArchetype} (${n.status})`}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            maxWidth: '100%',
                            fontSize: 10, padding: '2px 7px', borderRadius: 5,
                            background: isDone ? `rgba(${rgb},0.18)` : 'rgba(255,255,255,0.04)',
                            border: `1px solid rgba(${rgb},${isDone ? 0.4 : 0.18})`,
                            color: isDone ? `rgba(${rgb},0.95)` : 'rgba(200,200,220,0.55)',
                            overflow: 'hidden',
                          }}
                        >
                          {isDone && (
                            <svg width="8" height="8" viewBox="0 0 10 10" fill="none" style={{ flexShrink: 0 }}>
                              <path d="M1.5 5l2.2 2.5L8.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          )}
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {n.goal.length > 24 ? n.goal.slice(0, 24) + '…' : n.goal}
                          </span>
                        </span>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Session history binder ─────────────────────────────────────────────────────
// A conversation = one whole chat thread, grouped + searchable. Reopening loads the
// full thread and continues it (the parent's onRestore fetches the rounds).
export type HistorySession = { id: string; title: string; mode: string; snippet: string; updatedAt: number; roundCount: number }

export const PTYPE_COLOR: Record<string, string> = {
  code: '124,124,248', math: '192,132,252', creative: '77,184,158',
  logic: '245,158,11', factual: '96,165,250', general: '100,100,130',
}

export function ptypeRgb(pt: string) { return PTYPE_COLOR[pt] ?? PTYPE_COLOR.general }

// HistoryBinder — rendered inside the topbar button cluster.
// The trigger is just a small clock icon button that sits beside the hamburger.
// Clicking opens a floating frosted-glass card anchored below-right of the trigger.
// Hovering a row smoothly expands it to show the synthesis snippet.
export function HistoryBinder({ onRestore }: { onRestore: (session: HistorySession) => void }) {
  const [open, setOpen]           = useState(false)
  const [sessions, setSessions]   = useState<HistorySession[]>([])
  const [search, setSearch]       = useState('')
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)
  const [loading, setLoading]     = useState(false)
  const [loaded, setLoaded]       = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef   = useRef<HTMLDivElement | null>(null)

  const fetchHistory = () =>
    apiFetch('/api/conversations')
      .then(r => r.json())
      .then(d => { setSessions(d.conversations ?? []); setLoading(false); setLoaded(true) })
      .catch(() => { setLoading(false); setLoaded(true) })

  useEffect(() => {
    if (!open || loaded) return
    setLoading(true)
    fetchHistory()
  }, [open, loaded])

  // Poll every 30s while open
  useEffect(() => {
    if (!open) return
    const id = setInterval(() => fetchHistory(), 30_000)
    return () => clearInterval(id)
  }, [open])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        triggerRef.current?.contains(e.target as Node) ||
        panelRef.current?.contains(e.target as Node)
      ) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Close on ESC
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const filtered = sessions.filter(s =>
    !search ||
    (s.title ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (s.snippet ?? '').toLowerCase().includes(search.toLowerCase())
  )

  // Relative timestamp — "just now" / "2 hours ago" / "3 days ago" / a date.
  const relTime = (ts: number) => {
    const diff = Date.now() - ts
    const min = Math.floor(diff / 60000)
    if (min < 1) return 'just now'
    if (min < 60) return `${min} min ago`
    const hr = Math.floor(min / 60)
    if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`
    const day = Math.floor(hr / 24)
    if (day < 7) return `${day} day${day === 1 ? '' : 's'} ago`
    return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })
  }

  // Bucket a timestamp into Today / Yesterday / This Week / Earlier.
  const bucketOf = (ts: number): string => {
    const d = new Date(ts), now = new Date()
    if (d.toDateString() === now.toDateString()) return 'Today'
    const yest = new Date(now); yest.setDate(now.getDate() - 1)
    if (d.toDateString() === yest.toDateString()) return 'Yesterday'
    if (Date.now() - ts < 7 * 86400000) return 'This Week'
    return 'Earlier'
  }
  const BUCKET_ORDER = ['Today', 'Yesterday', 'This Week', 'Earlier']
  // Ordered [bucketLabel, sessions[]] pairs, preserving the filtered (recency) order within.
  const grouped = BUCKET_ORDER
    .map(b => [b, filtered.filter(s => bucketOf(s.updatedAt) === b)] as const)
    .filter(([, items]) => items.length > 0)

  return (
    <div className="crucible-history-binder" style={{ position: 'relative' }}>
      <style>{`
        @keyframes histSlideIn {
          from { transform: translateX(100%); }
          to   { transform: translateX(0); }
        }
        @keyframes histScrimIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes histPrism {
          0%   { background-position: 0%   50%; }
          100% { background-position: 300% 50%; }
        }
        .hrow-expand {
          display: grid;
          grid-template-rows: 0fr;
          transition: grid-template-rows 0.26s cubic-bezier(0.22,1,0.36,1);
        }
        .hrow-expand.open { grid-template-rows: 1fr; }
        .hrow-expand > div { overflow: hidden; }
      `}</style>

      {/* Trigger — clock icon, matches topbar button style */}
      <button
        ref={triggerRef}
        onClick={() => setOpen(o => !o)}
        title="Session history"
        style={{
          background: open ? 'rgba(124,124,248,0.1)' : 'none',
          border: 'none', cursor: 'pointer',
          color: open ? '#9090f8' : '#555',
          padding: '6px 7px', borderRadius: 8,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'color 0.18s, background 0.18s',
        }}
      >
        {/* Clock SVG */}
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.4"/>
          <path d="M8 5v3.2l2.2 1.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {/* Scrim — dims the app behind the drawer, click to close */}
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 89,
            background: 'rgba(0,0,0,0.45)',
            animation: 'histScrimIn 0.28s ease',
          }}
        />
      )}

      {/* Full-height drawer — slides in from the right edge */}
      {open && (
        <div
          ref={panelRef}
          className="crucible-history-drawer"
          style={{
            position: 'fixed',
            top: 0, right: 0, bottom: 0,
            width: 'min(380px, 92vw)',
            zIndex: 90,
            display: 'flex', flexDirection: 'column',
            // Frosted glass — same language as the rest of the app
            background: 'rgba(13,13,20,0.82)',
            backdropFilter: 'blur(40px) saturate(1.5)',
            WebkitBackdropFilter: 'blur(40px) saturate(1.5)',
            borderLeft: '1px solid rgba(255,255,255,0.08)',
            boxShadow: '-24px 0 80px rgba(0,0,0,0.5), inset 1px 0 0 rgba(255,255,255,0.05)',
            animation: 'histSlideIn 0.28s cubic-bezier(0.22,1,0.36,1)',
            overflow: 'hidden',
          }}
        >
          {/* Prismatic top edge */}
          <div style={{
            height: 2, flexShrink: 0,
            background: 'linear-gradient(90deg, #7c7cf8, #4db89e, #c084fc, #f59e0b, #7c7cf8)',
            backgroundSize: '300% 100%',
            animation: 'histPrism 8s linear infinite',
            opacity: 0.65,
          }} />

          {/* Header */}
          <div style={{
            padding: 'calc(14px + env(safe-area-inset-top, 0px)) 16px 10px', flexShrink: 0,
            borderBottom: '1px solid rgba(255,255,255,0.05)',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{
              fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
              color: 'rgba(160,160,200,0.6)', textTransform: 'uppercase', flex: 1,
            }}>Conversations{sessions.length > 0 ? ` · ${sessions.length}` : ''}</span>
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="search…"
              style={{
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: 8, padding: '6px 10px',
                fontSize: 12, color: '#c8c8e8', outline: 'none',
                fontFamily: 'inherit', width: 110,
              }}
            />
            <button
              onClick={() => setOpen(false)}
              aria-label="Close"
              style={{
                background: 'none', border: 'none', cursor: 'pointer', color: '#666',
                width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: 8, flexShrink: 0,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              </svg>
            </button>
          </div>

          {/* List */}
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, WebkitOverflowScrolling: 'touch' }}>
            {loading && (
              <div style={{ textAlign: 'center', color: '#333', fontSize: 12, padding: '32px 0' }}>loading…</div>
            )}
            {!loading && filtered.length === 0 && (
              <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: 16, padding: '60px 24px', textAlign: 'center',
              }}>
                <svg width="56" height="56" viewBox="0 0 56 56" fill="none" style={{ opacity: 0.5 }}>
                  <circle cx="28" cy="28" r="20" stroke="rgba(124,124,248,0.3)" strokeWidth="1.5"/>
                  <path d="M28 17v12l8 5" stroke="rgba(124,124,248,0.35)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M28 8a20 20 0 0 1 0 40" stroke="rgba(77,184,158,0.25)" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
                <span style={{ color: 'rgba(160,160,200,0.45)', fontSize: 12, lineHeight: 1.7 }}>
                  {search ? 'No matches' : 'Your conversations will appear here'}
                </span>
              </div>
            )}
            {grouped.map(([bucket, items]) => (
              <div key={bucket}>
                {/* Date-group header */}
                <div style={{
                  position: 'sticky', top: 0, zIndex: 1,
                  padding: '10px 16px 5px',
                  background: 'rgba(13,13,20,0.6)',
                  backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
                  fontSize: 9, fontWeight: 700, letterSpacing: '0.16em',
                  color: 'rgba(160,160,200,0.4)', textTransform: 'uppercase',
                }}>{bucket}</div>
                {items.map(s => {
                  const rgb = ptypeRgb(s.mode === 'code' ? 'code' : 'general')
                  const isHov = hoveredIdx === s.updatedAt
                  return (
                    <div
                      key={s.id}
                      onMouseEnter={() => setHoveredIdx(s.updatedAt)}
                      onMouseLeave={() => setHoveredIdx(null)}
                      onClick={() => { onRestore(s); setOpen(false) }}
                      style={{
                        minHeight: 48, padding: '11px 16px 11px 18px',
                        borderBottom: '1px solid rgba(255,255,255,0.03)',
                        background: isHov ? `rgba(${rgb},0.05)` : 'transparent',
                        transition: 'background 0.16s ease',
                        position: 'relative', cursor: 'pointer',
                      }}
                    >
                      {/* Type-color left stripe */}
                      <div style={{
                        position: 'absolute', left: 0, top: 10, bottom: 10, width: 2, borderRadius: 2,
                        background: `rgba(${rgb},${isHov ? 0.8 : 0.25})`,
                        transition: 'background 0.2s',
                      }} />

                      {/* Conversation title */}
                      <div style={{
                        fontSize: 12.5, lineHeight: 1.5, fontWeight: 500,
                        color: isHov ? '#e4e4f8' : 'rgba(170,170,210,0.8)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        transition: 'color 0.16s',
                      }}>
                        {s.title || 'New chat'}
                      </div>

                      {/* Message count + relative timestamp */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5 }}>
                        {s.roundCount > 0 && (
                          <span style={{ fontSize: 9, color: 'rgba(160,160,200,0.4)' }}>
                            {s.roundCount} message{s.roundCount === 1 ? '' : 's'}
                          </span>
                        )}
                        <span style={{ fontSize: 9, color: '#2f2f48', marginLeft: 'auto' }}>{relTime(s.updatedAt)}</span>
                      </div>

                      {/* Hover-expand: last-answer preview + actions */}
                      <div className={`hrow-expand${isHov ? ' open' : ''}`}>
                        <div>
                          <div style={{ paddingTop: 8 }}>
                            <div style={{
                              fontSize: 11, lineHeight: 1.65,
                              color: 'rgba(160,160,200,0.45)',
                              maxHeight: 110, overflowY: 'auto',
                              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                            }}>
                              {(s.snippet ?? '').length > 280 ? s.snippet.slice(0, 280) + '…' : s.snippet || '—'}
                            </div>
                            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
                              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.10em', color: `rgba(${rgb},0.5)`, textTransform: 'uppercase' }}>tap to open</span>
                              <button
                                onClick={e => {
                                  e.stopPropagation()
                                  apiFetch(`/api/conversations/${s.id}`, { method: 'DELETE', credentials: 'include' })
                                    .then(() => setSessions(prev => prev.filter(c => c.id !== s.id)))
                                    .catch(() => {})
                                }}
                                style={{
                                  background: 'none', border: `1px solid rgba(${rgb},0.2)`, borderRadius: 4,
                                  color: `rgba(${rgb},0.5)`, fontSize: 9, fontWeight: 700,
                                  letterSpacing: '0.08em', textTransform: 'uppercase', padding: '3px 8px',
                                  cursor: 'pointer', transition: 'border-color 0.15s, color 0.15s',
                                }}
                              >delete</button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
