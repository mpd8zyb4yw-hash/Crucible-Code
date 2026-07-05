// SelfRepairBinder — topbar trigger + frosted right-edge drawer for the RSI
// approval layer (FABLE5_HANDOFF Feature 7). The engine's self-improvement cycle
// is already never-regress mechanically; this surface adds the human step:
// Crucible proposes an improvement in plain language (what / why / how / risk),
// and the user approves or declines before anything runs. An opt-in toggle
// allows fully-automatic cycles for true walk-away operation.

import { useEffect, useState } from 'react'
import { apiFetch, API_BASE } from './api'

interface Proposal {
  id: string; createdAt: number
  status: 'pending' | 'approved' | 'rejected' | 'applied' | 'failed'
  title: string; summary: string; rationale: string; plan: string[]; risk: string
  verdict?: string; verdictDetail?: string; resolvedAt?: number
}
interface RepairStatus {
  rsi: { cycles: number; promotions: number; reverts: number; lastVerdict: string | null; lastCycleAt: number | null }
  enabled: boolean
  autoApprove: boolean
  proposals: Proposal[]
}

const STATUS_LABEL: Record<Proposal['status'], { text: string; color: string }> = {
  pending: { text: 'Awaiting your decision', color: 'rgba(245,158,11,0.8)' },
  approved: { text: 'Running…', color: 'rgba(124,124,248,0.8)' },
  rejected: { text: 'Declined', color: 'rgba(160,160,200,0.5)' },
  applied: { text: 'Applied', color: 'rgba(77,184,158,0.8)' },
  failed: { text: 'No change kept', color: 'rgba(224,122,122,0.8)' },
}

export function SelfRepairBinder() {
  const [open, setOpen] = useState(false)
  const [st, setSt] = useState<RepairStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const refresh = () => {
    apiFetch(`${API_BASE}/api/rsi/proposals`, { credentials: 'include' })
      .then(r => r.json()).then(setSt).catch(() => {})
  }
  useEffect(() => {
    if (!open) return
    refresh()
    // An approved proposal resolves asynchronously (the cycle re-measures twice) —
    // poll while the drawer is open so the outcome appears without a manual reopen.
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [open])  // eslint-disable-line react-hooks/exhaustive-deps

  const act = (path: string, body?: Record<string, unknown>) => {
    setBusy(true); setErr('')
    apiFetch(`${API_BASE}${path}`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
      .then(async r => { const d = await r.json(); if (!r.ok) setErr(d.error ?? 'request failed') })
      .catch(() => setErr('network error'))
      .finally(() => { setBusy(false); refresh() })
  }

  const pending = st?.proposals.find(p => p.status === 'pending')
  const running = st?.proposals.find(p => p.status === 'approved')
  const history = st?.proposals.filter(p => p !== pending && p !== running) ?? []
  const hasPending = !!pending

  return (
    <>
      <style>{`
        @keyframes repSlideIn { from { transform: translateX(24px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes repScrimIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes repPrism { 0% { background-position: 0% 50%; } 100% { background-position: 300% 50%; } }
      `}</style>

      {/* Trigger — wrench-in-circle icon; amber dot when a proposal awaits a decision */}
      <button
        onClick={() => setOpen(o => !o)}
        title="Self-repair"
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
          <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.3"/>
          <path d="M8 4.8v3.2l2 1.6M5.4 11.8l1.2-1.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        {hasPending && (
          <span style={{
            position: 'absolute', top: 3, right: 3, width: 6, height: 6, borderRadius: 3,
            background: '#f59e0b',
          }} />
        )}
      </button>

      {open && (
        <div onClick={() => setOpen(false)} style={{
          position: 'fixed', inset: 0, zIndex: 89,
          background: 'rgba(0,0,0,0.45)', animation: 'repScrimIn 0.28s ease',
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
          animation: 'repSlideIn 0.28s cubic-bezier(0.22,1,0.36,1)',
          overflow: 'hidden',
        }}>
          <div style={{
            height: 2, flexShrink: 0,
            background: 'linear-gradient(90deg, #7c7cf8, #4db89e, #c084fc, #f59e0b, #7c7cf8)',
            backgroundSize: '300% 100%', animation: 'repPrism 8s linear infinite', opacity: 0.65,
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
            }}>Self-repair</span>
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

            {/* Track record */}
            {st && (
              <div style={{
                display: 'flex', gap: 14, padding: '2px 4px 12px',
                fontSize: 11, color: 'rgba(160,160,200,0.55)',
              }}>
                <span><strong style={{ color: '#c8c8e8' }}>{st.rsi.cycles}</strong> runs</span>
                <span><strong style={{ color: '#4db89e' }}>{st.rsi.promotions}</strong> improvements kept</span>
                <span><strong style={{ color: '#e0a07a' }}>{st.rsi.reverts}</strong> auto-undone</span>
              </div>
            )}

            {/* Pending proposal — the decision card */}
            {pending && (
              <div style={{
                background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.2)',
                borderRadius: 12, padding: 14, marginBottom: 14,
              }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#e8d8b8', lineHeight: 1.45 }}>{pending.title}</div>
                <div style={{ fontSize: 11.5, color: 'rgba(200,200,232,0.75)', lineHeight: 1.6, marginTop: 8 }}>{pending.summary}</div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', color: 'rgba(160,160,200,0.5)', textTransform: 'uppercase', marginTop: 12 }}>Why now</div>
                <div style={{ fontSize: 11.5, color: 'rgba(200,200,232,0.65)', lineHeight: 1.6, marginTop: 4 }}>{pending.rationale}</div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', color: 'rgba(160,160,200,0.5)', textTransform: 'uppercase', marginTop: 12 }}>How</div>
                <ol style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {pending.plan.map((step, i) => (
                    <li key={i} style={{ fontSize: 11.5, color: 'rgba(200,200,232,0.65)', lineHeight: 1.6 }}>{step}</li>
                  ))}
                </ol>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', color: 'rgba(160,160,200,0.5)', textTransform: 'uppercase', marginTop: 12 }}>Risk</div>
                <div style={{ fontSize: 11.5, color: 'rgba(200,200,232,0.65)', lineHeight: 1.6, marginTop: 4 }}>{pending.risk}</div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
                  <button onClick={() => act(`/api/rsi/proposals/${pending.id}/reject`)} disabled={busy} style={{
                    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 8, padding: '7px 14px', fontSize: 11.5, fontWeight: 600,
                    color: '#a0a0c0', cursor: 'pointer', fontFamily: 'inherit',
                  }}>Not now</button>
                  <button onClick={() => act(`/api/rsi/proposals/${pending.id}/approve`)} disabled={busy} style={{
                    background: 'rgba(77,184,158,0.16)', border: '1px solid rgba(77,184,158,0.35)',
                    borderRadius: 8, padding: '7px 16px', fontSize: 11.5, fontWeight: 600,
                    color: '#4db89e', cursor: 'pointer', fontFamily: 'inherit',
                  }}>Apply</button>
                </div>
              </div>
            )}

            {/* Running */}
            {running && (
              <div style={{
                background: 'rgba(124,124,248,0.05)', border: '1px solid rgba(124,124,248,0.18)',
                borderRadius: 12, padding: 12, marginBottom: 14,
                fontSize: 11.5, color: 'rgba(200,200,232,0.7)', lineHeight: 1.6,
              }}>
                Running the improvement pass — measuring, tuning, re-measuring. This takes a few
                minutes; the outcome will appear here.
              </div>
            )}

            {/* Ask for a proposal */}
            {!pending && !running && (
              <button onClick={() => act('/api/rsi/propose')} disabled={busy} style={{
                width: '100%',
                background: 'rgba(124,124,248,0.08)', border: '1px solid rgba(124,124,248,0.22)',
                borderRadius: 12, padding: '12px 14px', fontSize: 12, fontWeight: 600,
                color: '#b0b0f0', cursor: 'pointer', fontFamily: 'inherit', marginBottom: 14,
                transition: 'background 0.18s',
              }}>Check for possible improvements</button>
            )}
            {err && <div style={{ fontSize: 11, color: '#e07a7a', padding: '0 4px 10px' }}>{err}</div>}

            {/* Auto-approve toggle */}
            {st && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 4px', borderTop: '1px solid rgba(255,255,255,0.05)',
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#c8c8e8' }}>Fully automatic</div>
                  <div style={{ fontSize: 10.5, color: 'rgba(160,160,200,0.5)', lineHeight: 1.5, marginTop: 2 }}>
                    Skip the approval step. Changes that measure worse are still undone automatically.
                  </div>
                </div>
                <button
                  onClick={() => act('/api/rsi/auto-approve', { enabled: !st.autoApprove })}
                  disabled={busy}
                  aria-label={st.autoApprove ? 'Disable automatic mode' : 'Enable automatic mode'}
                  style={{
                    width: 36, height: 20, borderRadius: 10, flexShrink: 0,
                    border: '1px solid ' + (st.autoApprove ? 'rgba(77,184,158,0.5)' : 'rgba(255,255,255,0.12)'),
                    background: st.autoApprove ? 'rgba(77,184,158,0.25)' : 'rgba(255,255,255,0.05)',
                    cursor: 'pointer', position: 'relative', padding: 0,
                    transition: 'background 0.2s ease, border-color 0.2s ease',
                  }}
                >
                  <span style={{
                    position: 'absolute', top: 2, left: st.autoApprove ? 18 : 2,
                    width: 14, height: 14, borderRadius: 7,
                    background: st.autoApprove ? '#4db89e' : '#6a6a8a',
                    transition: 'left 0.2s cubic-bezier(0.22,1,0.36,1), background 0.2s ease',
                  }} />
                </button>
              </div>
            )}

            {/* History */}
            {history.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <span style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
                  color: 'rgba(160,160,200,0.4)', textTransform: 'uppercase',
                  display: 'block', padding: '6px 4px',
                }}>History</span>
                {history.map(p => (
                  <div key={p.id} style={{
                    borderBottom: '1px solid rgba(255,255,255,0.04)', padding: '9px 4px',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <span style={{ fontSize: 11.5, color: 'rgba(200,200,232,0.7)', flex: 1, lineHeight: 1.4 }}>{p.title}</span>
                      <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: STATUS_LABEL[p.status].color, flexShrink: 0 }}>
                        {STATUS_LABEL[p.status].text}
                      </span>
                    </div>
                    {p.verdictDetail && (
                      <div style={{ fontSize: 10.5, color: 'rgba(160,160,200,0.5)', lineHeight: 1.5, marginTop: 3 }}>{p.verdictDetail}</div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div style={{ fontSize: 10, color: 'rgba(160,160,200,0.35)', lineHeight: 1.6, padding: '14px 4px 0' }}>
              Self-repair only adjusts learned settings — never source code. Every change is
              measured against a benchmark before and after, and anything that scores worse is
              rolled back on the spot.
            </div>
          </div>
        </div>
      )}
    </>
  )
}
