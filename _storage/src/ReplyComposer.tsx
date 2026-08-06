// ── In-Crucible reply composer (Phase 2) ─────────────────────────────────────
// Opened from EmailReader. Prefills To (the original sender) and Subject ("Re: …"),
// lets the user write/edit the reply, and sends ONLY when the user clicks Send — that
// gesture is the consent gate. Crucible never fires the send on its own; the POST to
// /api/connections/google/send happens strictly inside the onClick handler below.
//
// Doctrine line held: the agent may PROPOSE a draft (dropped into `body` via initialDraft),
// but the user certifies and sends. No auto-send, ever.

import { useState } from 'react'
import { API_BASE, apiFetch } from './api'
import { PrimaryButton, GhostButton } from './ui'

/** Pull a bare address out of a "Name <addr@x>" From header; fall back to the raw string. */
export function extractAddress(from: string): string {
  const m = from.match(/<([^>]+)>/)
  return (m ? m[1] : from).trim()
}

type SendState = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent'; id: string } | { kind: 'error'; msg: string }

export default function ReplyComposer({ inReplyToId, from, subject, initialDraft, onDone, onCancel }: {
  inReplyToId: string
  from: string
  subject: string
  /** Optional agent-proposed draft to seed the body — the user still edits + sends. */
  initialDraft?: string
  /** Called after a successful send, with the new message id. */
  onDone: (id: string) => void
  onCancel: () => void
}) {
  const [to, setTo] = useState(extractAddress(from))
  const [subj, setSubj] = useState(/^re:/i.test(subject) ? subject : `Re: ${subject}`)
  const [body, setBody] = useState(initialDraft ?? '')
  const [state, setState] = useState<SendState>({ kind: 'idle' })

  const canSend = to.trim() !== '' && subj.trim() !== '' && body.trim() !== '' && state.kind !== 'sending'

  async function send() {
    if (!canSend) return
    setState({ kind: 'sending' })
    try {
      const r = await apiFetch(`${API_BASE}/api/connections/google/send`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: to.trim(), subject: subj.trim(), body, inReplyToId }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d?.error ?? `HTTP ${r.status}`)
      setState({ kind: 'sent', id: String(d.id ?? '') })
      onDone(String(d.id ?? ''))
    } catch (e: any) {
      setState({ kind: 'error', msg: String(e?.message ?? e) })
    }
  }

  const fieldStyle = {
    width: '100%', background: 'var(--c-glass)', border: '1px solid var(--c-hairline)',
    borderRadius: 8, color: 'var(--c-text)', fontSize: 13, padding: '8px 10px', outline: 'none',
    fontFamily: 'inherit',
  } as const

  return (
    <div style={{ borderTop: '1px solid var(--c-hairline)', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 9 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: 'var(--c-dim)', width: 42, flexShrink: 0 }}>To</span>
        <input value={to} onChange={e => setTo(e.target.value)} style={fieldStyle} spellCheck={false} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: 'var(--c-dim)', width: 42, flexShrink: 0 }}>Subject</span>
        <input value={subj} onChange={e => setSubj(e.target.value)} style={fieldStyle} />
      </div>
      <textarea
        value={body}
        onChange={e => setBody(e.target.value)}
        placeholder="Write your reply…"
        rows={6}
        style={{ ...fieldStyle, resize: 'vertical', lineHeight: 1.55, minHeight: 96 }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <PrimaryButton accent="#6fd08a" onClick={send} disabled={!canSend}
          title={canSend ? 'Send this reply' : 'Fill in recipient, subject, and body first'}>
          {state.kind === 'sending' ? 'Sending…' : state.kind === 'sent' ? 'Sent ✓' : 'Send reply'}
        </PrimaryButton>
        <GhostButton onClick={onCancel}>Cancel</GhostButton>
        <div style={{ flex: 1 }} />
        {state.kind === 'error' && (
          <span style={{ fontSize: 11.5, color: '#f0a5a5', overflowWrap: 'anywhere' }}>Couldn't send: {state.msg}</span>
        )}
        {state.kind === 'sent' && (
          <span style={{ fontSize: 11.5, color: '#6fd08a' }}>Reply sent.</span>
        )}
      </div>
    </div>
  )
}
