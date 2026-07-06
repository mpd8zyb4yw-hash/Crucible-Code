// SelfPatcherBinder — visibility + manual override for the pipeline prompt-patcher
// (Track B1, src/CrucibleEngine/selfPatcher.ts). The self-patcher already runs on its own
// schedule: it reads debug-bus history to find the pipeline stage most correlated with
// low-quality answers, drafts a prompt patch, and puts it through the triumvirate gate,
// which resolves it straight to 'active' or 'rejected' — there was previously NO frontend
// surface at all, so a live prompt patch could go into rotation with the user never
// knowing. This drawer makes every patch visible (what stage, what problem, what the new
// prompt text is, and the triumvirate's verdict) and lets the user pull an active patch
// back out, or reinstate one the triumvirate rejected, at any time.

import { useEffect, useState } from 'react'
import { apiFetch, API_BASE } from './api'

interface PipelinePatch {
  id: string; ts: number
  stage: string; promptType: string
  problem: string; patch: string
  status: 'pending' | 'approved' | 'rejected' | 'active'
  approvedAt?: number
}

const STATUS_LABEL: Record<PipelinePatch['status'], { text: string; color: string }> = {
  pending: { text: 'Awaiting review', color: 'rgba(245,158,11,0.85)' },
  approved: { text: 'Approved', color: 'rgba(124,124,248,0.8)' },
  active: { text: 'Live', color: 'rgba(77,184,158,0.85)' },
  rejected: { text: 'Not active', color: 'rgba(160,160,200,0.5)' },
}

export function SelfPatcherBinder() {
  const [open, setOpen] = useState(false)
  const [patches, setPatches] = useState<PipelinePatch[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const refresh = () => {
    apiFetch(`${API_BASE}/api/self-patcher/patches`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => setPatches(Array.isArray(d.patches) ? d.patches : []))
      .catch(() => {})
  }
  useEffect(() => {
    if (!open) return
    refresh()
    const t = setInterval(refresh, 8000)
    return () => clearInterval(t)
  }, [open])  // eslint-disable-line react-hooks/exhaustive-deps

  const act = (path: string, id: string) => {
    setBusy(true); setErr('')
    apiFetch(`${API_BASE}${path}`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
      .then(async r => { const d = await r.json(); if (!r.ok || d.ok === false) setErr(d.error ?? 'request failed') })
      .catch(() => setErr('network error'))
      .finally(() => { setBusy(false); refresh() })
  }

  const sorted = [...patches].sort((a, b) => b.ts - a.ts)
  const pendingCount = patches.filter(p => p.status === 'pending').length
  const activeCount = patches.filter(p => p.status === 'active').length

  return (
    <>
      <style>{`
        @keyframes spSlideIn { from { transform: translateX(24px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes spScrimIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes spPrism { 0% { background-position: 0% 50%; } 100% { background-position: 300% 50%; } }
      `}</style>

      {/* Trigger — a small "patch" glyph; amber dot when something awaits review */}
      <button
        onClick={() => setOpen(o => !o)}
        title="Pipeline prompt patches"
        style={{
          background: open ? 'rgba(124,124,248,0.1)' : 'none',
          border: 'none', cursor: 'pointer',
          color: open ? '#9090f8' : '#555',
          padding: '6px 7px', borderRadius: 8, position: 'relative',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'color 0.18s, background 0.18s',
        }}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
          <path d="M3 9.5L6.5 6l3.5 3.5L13.5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M10.5 5h3v3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
          <rect x="2.5" y="10.5" width="11" height="3" rx="1" stroke="currentColor" strokeWidth="1.1"/>
        </svg>
        {pendingCount > 0 && (
          <span style={{
            position: 'absolute', top: 3, right: 3, width: 6, height: 6, borderRadius: 3,
            background: '#f59e0b',
          }} />
        )}
      </button>

      {open && (
        <div onClick={() => setOpen(false)} style={{
          position: 'fixed', inset: 0, zIndex: 89,
          background: 'rgba(0,0,0,0.45)', animation: 'spScrimIn 0.28s ease',
        }} />
      )}

      {open && (
        <div style={{
          position: 'fixed', top: 0, right: 0, bottom: 0,
          width: 'min(420px, 92vw)', zIndex: 90,
          display: 'flex', flexDirection: 'column',
          background: 'rgba(13,13,20,0.82)',
          backdropFilter: 'blur(40px) saturate(1.5)',
          WebkitBackdropFilter: 'blur(40px) saturate(1.5)',
          borderLeft: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '-24px 0 80px rgba(0,0,0,0.5), inset 1px 0 0 rgba(255,255,255,0.05)',
          animation: 'spSlideIn 0.28s cubic-bezier(0.22,1,0.36,1)',
          overflow: 'hidden',
        }}>
          <div style={{
            height: 2, flexShrink: 0,
            background: 'linear-gradient(90deg, #7c7cf8, #4db89e, #c084fc, #f59e0b, #7c7cf8)',
            backgroundSize: '300% 100%', animation: 'spPrism 8s linear infinite', opacity: 0.65,
          }} />

          <div style={{
            padding: 'calc(14px + env(safe-area-inset-top, 0px)) 16px 10px', flexShrink: 0,
            borderBottom: '1px solid rgba(255,255,255,0.05)',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{
              fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
              color: 'rgba(160,160,200,0.6)', textTransform: 'uppercase', flex: 1,
            }}>Prompt patches</span>
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

          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, WebkitOverflowScrolling: 'touch', padding: '12px 14px 24px' }}>
            <div style={{ display: 'flex', gap: 14, padding: '2px 4px 12px', fontSize: 11, color: 'rgba(160,160,200,0.55)' }}>
              <span><strong style={{ color: '#c8c8e8' }}>{patches.length}</strong> total</span>
              <span><strong style={{ color: '#4db89e' }}>{activeCount}</strong> live</span>
              {pendingCount > 0 && <span><strong style={{ color: '#e0a860' }}>{pendingCount}</strong> awaiting review</span>}
            </div>

            {err && <div style={{ fontSize: 11, color: '#e07a7a', padding: '0 4px 10px' }}>{err}</div>}

            {sorted.length === 0 && (
              <div style={{ fontSize: 11.5, color: 'rgba(160,160,200,0.45)', padding: '10px 4px', lineHeight: 1.6 }}>
                No prompt patches proposed yet. The self-patcher watches for pipeline stages
                that correlate with low-quality answers and drafts a fix automatically — check
                back after more traffic.
              </div>
            )}

            {sorted.map(p => (
              <div key={p.id} style={{
                background: p.status === 'active' ? 'rgba(77,184,158,0.05)' : p.status === 'pending' ? 'rgba(245,158,11,0.05)' : 'rgba(255,255,255,0.02)',
                border: `1px solid ${p.status === 'active' ? 'rgba(77,184,158,0.18)' : p.status === 'pending' ? 'rgba(245,158,11,0.2)' : 'rgba(255,255,255,0.06)'}`,
                borderRadius: 12, padding: 13, marginBottom: 10,
              }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: '#c8c8e8', fontFamily: 'ui-monospace, monospace' }}>{p.stage}</span>
                  <span style={{ fontSize: 10, color: 'rgba(160,160,200,0.5)' }}>{p.promptType}</span>
                  <div style={{ flex: 1 }} />
                  <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: STATUS_LABEL[p.status].color }}>
                    {STATUS_LABEL[p.status].text}
                  </span>
                </div>
                <div style={{ fontSize: 11.5, color: 'rgba(200,200,232,0.7)', lineHeight: 1.55, marginTop: 7 }}>{p.problem}</div>
                <details style={{ marginTop: 8 }}>
                  <summary style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: 'rgba(160,160,200,0.5)', textTransform: 'uppercase', cursor: 'pointer' }}>
                    Proposed prompt text
                  </summary>
                  <div style={{ fontSize: 11, color: 'rgba(200,200,232,0.6)', lineHeight: 1.55, marginTop: 6, whiteSpace: 'pre-wrap' as const }}>{p.patch}</div>
                </details>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
                  {p.status !== 'rejected' && (
                    <button onClick={() => act('/api/self-patcher/reject', p.id)} disabled={busy} style={{
                      background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: 8, padding: '6px 12px', fontSize: 11, fontWeight: 600,
                      color: '#a0a0c0', cursor: 'pointer', fontFamily: 'inherit',
                    }}>{p.status === 'active' ? 'Pull from rotation' : 'Reject'}</button>
                  )}
                  {p.status !== 'active' && (
                    <button onClick={() => act('/api/self-patcher/approve', p.id)} disabled={busy} style={{
                      background: 'rgba(77,184,158,0.16)', border: '1px solid rgba(77,184,158,0.35)',
                      borderRadius: 8, padding: '6px 14px', fontSize: 11, fontWeight: 600,
                      color: '#4db89e', cursor: 'pointer', fontFamily: 'inherit',
                    }}>{p.status === 'rejected' ? 'Reinstate' : 'Make live'}</button>
                  )}
                </div>
              </div>
            ))}

            <div style={{ fontSize: 10, color: 'rgba(160,160,200,0.35)', lineHeight: 1.6, padding: '14px 4px 0' }}>
              Prompt patches only change stage instructions, never source code. Each is
              proposed from real debug-bus signal and vetted by the triumvirate before it
              would ever go live — this panel is your manual override on top of that gate.
            </div>
          </div>
        </div>
      )}
    </>
  )
}
