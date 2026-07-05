// IntegrationsBinder — topbar trigger + frosted right-edge drawer listing external
// agentic tool integrations (GitHub CLI first). Everything here is a locally-
// executed open-source CLI; enabling one is always an explicit human action.
// When the composer holds a draft request, the drawer surfaces which tools the
// engine (deterministic matcher + local FM — zero external calls) recommends.

import { useEffect, useRef, useState } from 'react'
import { apiFetch, API_BASE } from './api'

interface Integration {
  id: string
  name: string
  description: string
  command: string
  builtin: boolean
  enabled: boolean
  detected: boolean
  version: string | null
  homepage?: string
}

interface Recommendation {
  id: string
  name: string
  detected: boolean
  enabled: boolean
  reason: string
  source: 'heuristic' | 'fm'
}

export function IntegrationsBinder({ draft }: { draft: string }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Integration[]>([])
  const [recs, setRecs] = useState<Recommendation[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)   // id being toggled
  const [showAdd, setShowAdd] = useState(false)
  const [addName, setAddName] = useState('')
  const [addCmd, setAddCmd] = useState('')
  const [addDesc, setAddDesc] = useState('')
  const [addErr, setAddErr] = useState('')
  const draftRef = useRef(draft)
  draftRef.current = draft

  const refresh = () => {
    setLoading(true)
    apiFetch(`${API_BASE}/api/integrations`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => setItems(d.integrations ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
    const goal = draftRef.current.trim()
    if (goal.length >= 8) {
      apiFetch(`${API_BASE}/api/integrations/recommend`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal }),
      })
        .then(r => r.json())
        .then(d => setRecs(d.recommendations ?? []))
        .catch(() => setRecs([]))
    } else setRecs([])
  }

  useEffect(() => { if (open) refresh() }, [open])  // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: string, enabled: boolean) => {
    setBusy(id)
    apiFetch(`${API_BASE}/api/integrations/${id}/toggle`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
      .then(r => r.json())
      .then(() => {
        setItems(prev => prev.map(i => i.id === id ? { ...i, enabled } : i))
        setRecs(prev => prev.map(r => r.id === id ? { ...r, enabled } : r))
      })
      .catch(() => {})
      .finally(() => setBusy(null))
  }

  const add = () => {
    setAddErr('')
    apiFetch(`${API_BASE}/api/integrations`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: addName, command: addCmd, description: addDesc }),
    })
      .then(async r => {
        const d = await r.json()
        if (!r.ok) { setAddErr(d.error ?? 'add failed'); return }
        setItems(prev => [...prev, d.integration])
        setAddName(''); setAddCmd(''); setAddDesc(''); setShowAdd(false)
      })
      .catch(() => setAddErr('network error'))
  }

  const remove = (id: string) => {
    apiFetch(`${API_BASE}/api/integrations/${id}`, { method: 'DELETE', credentials: 'include' })
      .then(r => { if (r.ok) setItems(prev => prev.filter(i => i.id !== id)) })
      .catch(() => {})
  }

  const enabledCount = items.filter(i => i.enabled).length

  return (
    <>
      <style>{`
        @keyframes intgSlideIn { from { transform: translateX(24px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes intgScrimIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes intgPrism { 0% { background-position: 0% 50%; } 100% { background-position: 300% 50%; } }
      `}</style>

      {/* Trigger — plug icon, matches topbar button style */}
      <button
        onClick={() => setOpen(o => !o)}
        title="Tool integrations"
        style={{
          background: open ? 'rgba(124,124,248,0.1)' : 'none',
          border: 'none', cursor: 'pointer',
          color: open ? '#9090f8' : (enabledCount > 0 ? '#6a6a9a' : '#555'),
          padding: '6px 7px', borderRadius: 8,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'color 0.18s, background 0.18s',
        }}
      >
        {/* Plug / node SVG */}
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
          <rect x="2" y="2" width="5" height="5" rx="1.4" stroke="currentColor" strokeWidth="1.3"/>
          <rect x="9" y="9" width="5" height="5" rx="1.4" stroke="currentColor" strokeWidth="1.3"/>
          <path d="M7 4.5h3.5a1 1 0 0 1 1 1V9M9 11.5H5.5a1 1 0 0 1-1-1V7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        </svg>
      </button>

      {open && (
        <div onClick={() => setOpen(false)} style={{
          position: 'fixed', inset: 0, zIndex: 89,
          background: 'rgba(0,0,0,0.45)', animation: 'intgScrimIn 0.28s ease',
        }} />
      )}

      {open && (
        <div style={{
          position: 'fixed', top: 0, right: 0, bottom: 0,
          width: 'min(400px, 92vw)', zIndex: 90,
          display: 'flex', flexDirection: 'column',
          background: 'rgba(13,13,20,0.82)',
          backdropFilter: 'blur(40px) saturate(1.5)',
          WebkitBackdropFilter: 'blur(40px) saturate(1.5)',
          borderLeft: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '-24px 0 80px rgba(0,0,0,0.5), inset 1px 0 0 rgba(255,255,255,0.05)',
          animation: 'intgSlideIn 0.28s cubic-bezier(0.22,1,0.36,1)',
          overflow: 'hidden',
        }}>
          {/* Prismatic top edge — same language as the other drawers */}
          <div style={{
            height: 2, flexShrink: 0,
            background: 'linear-gradient(90deg, #7c7cf8, #4db89e, #c084fc, #f59e0b, #7c7cf8)',
            backgroundSize: '300% 100%', animation: 'intgPrism 8s linear infinite', opacity: 0.65,
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
            }}>Integrations{enabledCount > 0 ? ` · ${enabledCount} on` : ''}</span>
            <button onClick={() => setShowAdd(s => !s)} style={{
              background: showAdd ? 'rgba(124,124,248,0.12)' : 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8,
              padding: '5px 10px', fontSize: 11, color: '#a0a0d0', cursor: 'pointer',
              fontFamily: 'inherit', transition: 'background 0.18s',
            }}>Add tool</button>
            <button onClick={() => setOpen(false)} aria-label="Close" style={{
              background: 'none', border: 'none', cursor: 'pointer', color: '#666',
              width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: 8, flexShrink: 0,
            }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              </svg>
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, WebkitOverflowScrolling: 'touch', padding: '10px 12px 24px' }}>

            {/* Manual add form */}
            {showAdd && (
              <div style={{
                background: 'rgba(124,124,248,0.05)', border: '1px solid rgba(124,124,248,0.14)',
                borderRadius: 12, padding: 12, marginBottom: 14,
                display: 'flex', flexDirection: 'column', gap: 8,
              }}>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', color: 'rgba(160,160,200,0.55)', textTransform: 'uppercase' }}>
                  Add a local CLI tool
                </span>
                {[
                  { v: addName, set: setAddName, ph: 'Name (e.g. Docker)' },
                  { v: addCmd, set: setAddCmd, ph: 'Command (bare binary, e.g. docker)' },
                  { v: addDesc, set: setAddDesc, ph: 'What should the agent use it for?' },
                ].map((f, i) => (
                  <input key={i} value={f.v} onChange={e => f.set(e.target.value)} placeholder={f.ph} style={{
                    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.07)',
                    borderRadius: 8, padding: '7px 10px', fontSize: 12, color: '#c8c8e8',
                    outline: 'none', fontFamily: 'inherit',
                  }} />
                ))}
                {addErr && <span style={{ fontSize: 11, color: '#e07a7a' }}>{addErr}</span>}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button onClick={add} disabled={!addName.trim() || !addCmd.trim()} style={{
                    background: 'rgba(124,124,248,0.16)', border: '1px solid rgba(124,124,248,0.3)',
                    borderRadius: 8, padding: '6px 14px', fontSize: 11, fontWeight: 600,
                    color: '#b0b0f0', cursor: 'pointer', fontFamily: 'inherit',
                    opacity: (!addName.trim() || !addCmd.trim()) ? 0.45 : 1,
                  }}>Add</button>
                </div>
                <span style={{ fontSize: 10, color: 'rgba(160,160,200,0.4)', lineHeight: 1.5 }}>
                  Locally-installed open-source CLIs only — no hosted APIs. Added tools stay off until you enable them.
                </span>
              </div>
            )}

            {/* Recommended for this request */}
            {recs.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <span style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
                  color: 'rgba(77,184,158,0.7)', textTransform: 'uppercase',
                  display: 'block', padding: '2px 4px 8px',
                }}>Recommended for this request</span>
                {recs.map(r => (
                  <div key={r.id} style={{
                    background: 'rgba(77,184,158,0.05)', border: '1px solid rgba(77,184,158,0.14)',
                    borderRadius: 10, padding: '9px 11px', marginBottom: 6,
                    display: 'flex', alignItems: 'center', gap: 10,
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#c8c8e8' }}>{r.name}</div>
                      <div style={{ fontSize: 10.5, color: 'rgba(160,160,200,0.55)', lineHeight: 1.45, marginTop: 2 }}>{r.reason}</div>
                    </div>
                    {r.enabled ? (
                      <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.08em', color: 'rgba(77,184,158,0.75)', textTransform: 'uppercase', flexShrink: 0 }}>On</span>
                    ) : r.detected ? (
                      <button onClick={() => toggle(r.id, true)} disabled={busy === r.id} style={{
                        background: 'rgba(77,184,158,0.14)', border: '1px solid rgba(77,184,158,0.3)',
                        borderRadius: 7, padding: '5px 11px', fontSize: 10.5, fontWeight: 600,
                        color: '#4db89e', cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
                      }}>Enable</button>
                    ) : (
                      <span style={{ fontSize: 9.5, color: 'rgba(160,160,200,0.4)', flexShrink: 0 }}>not installed</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* All integrations */}
            {loading && items.length === 0 && (
              <div style={{ textAlign: 'center', color: '#333', fontSize: 12, padding: '32px 0' }}>loading…</div>
            )}
            {items.map(i => (
              <div key={i.id} style={{
                borderBottom: '1px solid rgba(255,255,255,0.04)',
                padding: '11px 4px', display: 'flex', alignItems: 'flex-start', gap: 10,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: i.detected ? '#c8c8e8' : '#55556a' }}>{i.name}</span>
                    <span style={{ fontSize: 10, color: 'rgba(160,160,200,0.4)', fontFamily: 'ui-monospace, monospace' }}>
                      {i.detected ? (i.version ?? i.command) : `${i.command} — not installed`}
                    </span>
                    {!i.builtin && (
                      <button onClick={() => remove(i.id)} title="Remove" style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: '#55556a', fontSize: 10, padding: 0, fontFamily: 'inherit',
                        textDecoration: 'underline', textUnderlineOffset: 2,
                      }}>remove</button>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: 'rgba(160,160,200,0.5)', lineHeight: 1.5, marginTop: 3 }}>
                    {i.description}
                  </div>
                </div>
                {/* Toggle */}
                <button
                  onClick={() => i.detected && toggle(i.id, !i.enabled)}
                  disabled={!i.detected || busy === i.id}
                  aria-label={i.enabled ? 'Disable' : 'Enable'}
                  style={{
                    width: 36, height: 20, borderRadius: 10, flexShrink: 0, marginTop: 2,
                    border: '1px solid ' + (i.enabled ? 'rgba(77,184,158,0.5)' : 'rgba(255,255,255,0.12)'),
                    background: i.enabled ? 'rgba(77,184,158,0.25)' : 'rgba(255,255,255,0.05)',
                    cursor: i.detected ? 'pointer' : 'not-allowed',
                    opacity: i.detected ? 1 : 0.35,
                    position: 'relative', padding: 0,
                    transition: 'background 0.2s ease, border-color 0.2s ease',
                  }}
                >
                  <span style={{
                    position: 'absolute', top: 2, left: i.enabled ? 18 : 2,
                    width: 14, height: 14, borderRadius: 7,
                    background: i.enabled ? '#4db89e' : '#6a6a8a',
                    transition: 'left 0.2s cubic-bezier(0.22,1,0.36,1), background 0.2s ease',
                  }} />
                </button>
              </div>
            ))}

            <div style={{ fontSize: 10, color: 'rgba(160,160,200,0.35)', lineHeight: 1.6, padding: '14px 4px 0' }}>
              Enabled tools appear in the agent's toolkit. Read-only queries run on their own;
              anything that writes to an outside service (for example a GitHub PR merge) asks
              you first, every time.
            </div>
          </div>
        </div>
      )}
    </>
  )
}
