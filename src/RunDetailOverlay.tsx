// ── Run detail overlay ─────────────────────────────────────────────────────────
// The full result of one automation run, openable from ANY surface that shows a run
// (Digest, Automations roster, Mission Control, Home). Before this existed, every run
// card was a 4–6 line clamped blurb with no click target — the entire output of the
// assistant's unattended work was unreadable and un-actionable (2026-07-20 finding).
//
// Actions are the point: read the whole answer, continue it in chat (prefills the
// composer so the user stays in control of sending), or run the brief again now.

import { useEffect, useState } from 'react'
import { Card, SectionLabel, GhostButton, PrimaryButton, StatusChip } from './ui'
import { API_BASE, apiFetch } from './api'

export interface RunRef { automationId: string; ts: number; name?: string }

interface RunDetail {
  automationId: string
  name: string
  brief: string
  run: { ts: number; status: 'ok' | 'failed'; summary: string; answer?: string; ms: number }
}

function fmtFull(ts: number): string {
  return new Date(ts).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function RunDetailOverlay({ runRef, onClose, onFollowUp }: {
  runRef: RunRef
  onClose: () => void
  /** Prefill the chat composer with a follow-up grounded in this run and close every
   *  overlay above the chat — wired by App. Send stays a user decision. */
  onFollowUp?: (text: string) => void
}) {
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rerunState, setRerunState] = useState<'idle' | 'starting' | 'started' | 'busy'>('idle')

  useEffect(() => {
    let dead = false
    setDetail(null); setError(null)
    apiFetch(`${API_BASE}/api/automations/${runRef.automationId}/runs/${runRef.ts}`, { credentials: 'include' })
      .then(async r => {
        if (dead) return
        if (r.ok) setDetail(await r.json())
        else setError((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`)
      })
      .catch(e => { if (!dead) setError(String(e?.message ?? e)) })
    return () => { dead = true }
  }, [runRef.automationId, runRef.ts])

  const rerun = async () => {
    if (rerunState !== 'idle') return
    setRerunState('starting')
    try {
      const r = await apiFetch(`${API_BASE}/api/automations/${runRef.automationId}/run`, { method: 'POST', credentials: 'include' })
      setRerunState(r.ok ? 'started' : 'busy')
    } catch { setRerunState('busy') }
  }

  const run = detail?.run
  const body = run ? (run.answer || run.summary) : ''

  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute', inset: 0, zIndex: 60, background: 'rgba(8,8,14,0.72)',
        backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        animation: 'fadeIn 0.16s ease',
      }}
    >
      <Card
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(720px, 100%)', maxHeight: 'min(82vh, 720px)', display: 'flex', flexDirection: 'column',
          padding: 0, overflow: 'hidden', boxShadow: '0 24px 80px rgba(0,0,0,0.5)',
        }}
      >
        {/* Header — title owns the row's free space (minWidth 0) so it never collapses to a
            per-character vertical stack on narrow viewports; meta wraps under it if needed. */}
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, rowGap: 6, padding: '14px 18px', borderBottom: '1px solid var(--c-hairline)', flexWrap: 'wrap' }}>
          <span style={{ flex: '1 1 auto', minWidth: 0, fontSize: 'var(--t-body)', fontWeight: 700, color: 'var(--c-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {detail?.name ?? runRef.name ?? 'Run'}
          </span>
          {run && (
            <StatusChip color={run.status === 'ok' ? '#4db89e' : '#f87171'}>
              {run.status === 'ok' ? 'completed' : 'failed'}
            </StatusChip>
          )}
          {run && (
            <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
              {fmtFull(run.ts)} · {(run.ms / 1000).toFixed(0)}s
            </span>
          )}
          <GhostButton onClick={onClose} title="Close">✕</GhostButton>
        </div>

        {/* Body — the full answer, scrollable */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {error && <span style={{ fontSize: 'var(--t-ui)', color: '#fca5a5' }}>{error}</span>}
          {!error && !detail && <span style={{ fontSize: 'var(--t-ui)', color: 'var(--c-dim)' }}>Loading…</span>}
          {run && (
            <>
              <div style={{
                fontSize: 'var(--t-body)', lineHeight: 1.65, color: 'var(--c-text)',
                whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
              }}>{body}</div>
              <div style={{ marginTop: 4 }}>
                <SectionLabel style={{ marginBottom: 6 }}>The brief that produced this</SectionLabel>
                <div style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim)', lineHeight: 1.6, overflowWrap: 'anywhere' }}>
                  {detail!.brief}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Actions */}
        <div style={{ flexShrink: 0, display: 'flex', gap: 8, alignItems: 'center', padding: '12px 18px', borderTop: '1px solid var(--c-hairline)', flexWrap: 'wrap' }}>
          {onFollowUp && run && (
            <PrimaryButton
              onClick={() => onFollowUp(
                `About the "${detail!.name}" run from ${fmtFull(run.ts)} — here is its result:\n\n${body.slice(0, 1500)}\n\nFollow-up: `,
              )}
              title="Prefill the chat composer with this result so you can ask about it or act on it"
            >Continue in chat</PrimaryButton>
          )}
          <GhostButton onClick={rerun} title="Run this automation's brief through the agent loop again now">
            {rerunState === 'idle' ? 'Run again' : rerunState === 'starting' ? 'Starting…' : rerunState === 'started' ? 'Started — check the Digest shortly' : 'Busy — another automation is running'}
          </GhostButton>
          <div style={{ flex: 1 }} />
          {run?.answer && (
            <GhostButton
              onClick={() => { void navigator.clipboard?.writeText(body).catch(() => {}) }}
              title="Copy the full result"
            >Copy</GhostButton>
          )}
        </div>
      </Card>
    </div>
  )
}
