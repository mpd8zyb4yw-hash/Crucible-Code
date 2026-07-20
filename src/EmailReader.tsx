// ── In-Crucible email reader (clone-the-UI path) ──────────────────────────────
// Opened from a GmailWidget row. Fetches the FULL message from the REST door to the
// gmail_read tool (/api/connections/google/message/:id) and renders it inside Crucible
// — real headers + real body, never a fabricated one. A small "Open in Gmail" button is
// the escape hatch for the full app (the user's choice, per the 2026-07-20 ruling).
//
// Doctrine line held here: "Draft a reply" does NOT send. It hands a reply-context prompt
// to the chat, where the agent drafts and the USER reviews + sends. Crucible never fires
// gmail_send on its own — the agent draft is a PROPOSE step the user certifies.

import { useEffect, useState } from 'react'
import { API_BASE, apiFetch } from './api'
import { PrimaryButton, GhostButton } from './ui'
import ReplyComposer from './ReplyComposer'

export interface MessageStub { id: string; from: string; subject: string; date: string; unread: boolean }

interface FullMessage {
  id: string; threadId: string; from: string; to: string; date: string
  subject: string; snippet: string; body: string; gmailUrl: string
}

/** Backdrop + centered panel, matching RunDetailOverlay's fixed-overlay convention. */
export default function EmailReader({ stub, onClose, onDraftReply }: {
  stub: MessageStub
  onClose: () => void
  /** Hand a reply-context prompt to chat — agent drafts, user sends. Never auto-sends. */
  onDraftReply?: (prompt: string) => void
}) {
  const [msg, setMsg] = useState<FullMessage | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)   // in-reader reply composer (Phase 2)

  useEffect(() => {
    let dead = false
    setMsg(null); setErr(null)
    apiFetch(`${API_BASE}/api/connections/google/message/${encodeURIComponent(stub.id)}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(d => { if (!dead) setMsg(d) })
      .catch(e => { if (!dead) setErr(String(e?.message ?? e)) })
    return () => { dead = true }
  }, [stub.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Gmail deep link known up-front (doesn't need the fetch) so the escape works even on error.
  const gmailUrl = msg?.gmailUrl ?? `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(stub.id)}`
  const draftPrompt =
    `Draft a reply to the email from ${stub.from} with subject "${stub.subject}" ` +
    `(Gmail message id ${stub.id}). Read the full message first with gmail_read, then write a ` +
    `concise, appropriate reply. Show me the draft for review — do NOT send it until I say so.`

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(3px)', padding: 20,
        animation: 'crEmailFade 140ms ease-out',
      }}>
      <style>{`@keyframes crEmailFade{from{opacity:0}to{opacity:1}}
        @keyframes crEmailRise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`}</style>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(640px, 100%)', maxHeight: '82vh', display: 'flex', flexDirection: 'column',
          background: 'var(--c-panel, #14141b)', border: '1px solid var(--c-hairline)', borderRadius: 14,
          boxShadow: '0 24px 60px rgba(0,0,0,0.55)', overflow: 'hidden', animation: 'crEmailRise 160ms ease-out',
        }}>
        {/* Header — subject + from, mirrors an email client's message head */}
        <div style={{ padding: '16px 18px 13px', borderBottom: '1px solid var(--c-hairline)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15.5, fontWeight: 700, color: 'var(--c-text)', lineHeight: 1.3, overflowWrap: 'anywhere' }}>
                {msg?.subject ?? stub.subject}
              </div>
              <div style={{ marginTop: 5, fontSize: 'var(--t-small)', color: 'var(--c-dim)', overflowWrap: 'anywhere' }}>
                {msg?.from ?? stub.from}
              </div>
              {msg?.to && (
                <div style={{ marginTop: 2, fontSize: 11, color: 'var(--c-dim-deep)', overflowWrap: 'anywhere' }}>to {msg.to}</div>
              )}
            </div>
            <GhostButton onClick={onClose} title="Close (Esc)" style={{ flexShrink: 0 }}>Close</GhostButton>
          </div>
        </div>

        {/* Body — real message text, monospace-free, scrollable */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px' }}>
          {!msg && !err && (
            <div style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)' }}>Loading message…</div>
          )}
          {err && (
            <div style={{ fontSize: 'var(--t-small)', color: '#f0a5a5', lineHeight: 1.6 }}>
              Couldn't load this message ({err}). Open it in Gmail instead — the button below still works.
            </div>
          )}
          {msg && (
            <div style={{ fontSize: 13.5, color: 'var(--c-text)', lineHeight: 1.62, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {msg.body || msg.snippet || '(This message has no text body.)'}
            </div>
          )}
        </div>

        {/* In-reader reply composer — user writes + clicks Send (the consent gate). */}
        {composing && (
          <ReplyComposer
            inReplyToId={stub.id}
            from={msg?.from ?? stub.from}
            subject={msg?.subject ?? stub.subject}
            onCancel={() => setComposing(false)}
            onDone={() => { /* sent — keep the confirmation visible until the user closes */ }}
          />
        )}

        {/* Actions — reply-here (composer), draft-with-agent (chat handoff), open in Gmail. None auto-send. */}
        {!composing && (
          <div style={{ padding: '12px 18px', borderTop: '1px solid var(--c-hairline)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <PrimaryButton accent="#6fd08a" onClick={() => setComposing(true)} title="Write a reply and send it from here">
              Reply here
            </PrimaryButton>
            {onDraftReply && (
              <GhostButton onClick={() => { onDraftReply(draftPrompt); onClose() }} title="Have the agent draft a reply in chat for review">
                Draft with agent
              </GhostButton>
            )}
            <div style={{ flex: 1 }} />
            <a href={gmailUrl} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
              <GhostButton title="Open the full thread in Gmail">Open in Gmail</GhostButton>
            </a>
          </div>
        )}
      </div>
    </div>
  )
}
