// ── Connections page (Assistant layer step 2 — ASSISTANT_SPEC.md §2.4) ─────────
// Card grid over every external capability: Google (OAuth), CLI integrations,
// built-in Mac control. States are verified claims — "Test" fires real API calls
// server-side and shows the result; nothing here asserts health it hasn't checked.

import { useCallback, useEffect, useState } from 'react'
import { Card, SectionLabel, GhostButton, PrimaryButton, StatusChip } from './ui'
import { API_BASE, apiFetch, loginUrl } from './api'
import { GmailWidget, CalendarWidget, GithubWidget, type GooglePreview, type GithubPreview } from './ConnectionWidgets'
import EmailReader, { type MessageStub } from './EmailReader'

interface Connection {
  id: string
  name: string
  kind: 'oauth' | 'cli' | 'builtin'
  authState: 'connected' | 'expired' | 'available' | 'disconnected'
  detail: string
  tools: string[]
  services?: Record<string, boolean>
}

const STATE_META: Record<Connection['authState'], { label: string; color: string }> = {
  connected: { label: 'connected', color: '#4db89e' },
  expired: { label: 'expired', color: '#f59e0b' },
  available: { label: 'available', color: '#7c7cf8' },
  disconnected: { label: 'not connected', color: '#55556a' },
}

// One-tap real value per connection — sends a genuine task through chat so the page
// DOES something instead of only describing auth state. Prefill-only; user presses send.
const TRY_PROMPTS: Record<string, { label: string; prompt: string }> = {
  'google': { label: 'Brief me', prompt: 'Summarize today\'s calendar and any inbox email from the last day that needs a reply.' },
  'cli-github': { label: 'Check my PRs', prompt: 'List my open GitHub PRs and flag any that look stalled or are waiting on review.' },
  'mac': { label: 'Check this Mac', prompt: 'How much free disk space and memory does this Mac have right now? Anything worth cleaning up?' },
}

function ConnectionCard({ c, onChanged, onTry, onOpenMessage }: { c: Connection; onChanged: () => void; onTry?: (prompt: string) => void; onOpenMessage?: (m: NonNullable<GooglePreview['gmail']>[number]) => void }) {
  const st = STATE_META[c.authState]
  const [testing, setTesting] = useState(false)
  const [checks, setChecks] = useState<Record<string, { ok: boolean; detail: string }> | null>(null)
  const [preview, setPreview] = useState<GooglePreview | null>(null)
  const [ghPreview, setGhPreview] = useState<GithubPreview | null>(null)

  // Live widgets: real inbox/calendar data the moment the card mounts connected.
  useEffect(() => {
    if (c.id !== 'google' || c.authState !== 'connected') return
    let dead = false
    apiFetch(`${API_BASE}/api/connections/google/preview`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(p => { if (!dead && p) setPreview(p) })
      .catch(() => {})
    return () => { dead = true }
  }, [c.id, c.authState])

  // Live GitHub widget: the user's own open PRs via `gh` (honest-absence — absent on any failure).
  useEffect(() => {
    if (c.id !== 'cli-github' || c.authState !== 'connected') return
    let dead = false
    apiFetch(`${API_BASE}/api/connections/github/preview`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(p => { if (!dead && p) setGhPreview(p) })
      .catch(() => {})
    return () => { dead = true }
  }, [c.id, c.authState])

  const test = async () => {
    setTesting(true); setChecks(null)
    try {
      const r = await apiFetch(`${API_BASE}/api/connections/google/test`, { method: 'POST', credentials: 'include' })
      if (r.ok) setChecks((await r.json()).checks)
    } catch { /* surfaced by empty checks */ }
    setTesting(false)
  }
  const disconnect = async () => {
    await apiFetch(`${API_BASE}/api/connections/google/disconnect`, { method: 'POST', credentials: 'include' }).catch(() => {})
    setChecks(null); onChanged()
  }

  return (
    <Card accent={c.authState === 'connected' ? st.color : undefined} style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 9 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: st.color, flexShrink: 0 }} />
        <span style={{ fontSize: 'var(--t-body)', fontWeight: 600, color: 'var(--c-text)' }}>{c.name}</span>
        <StatusChip color={st.color}>{st.label}</StatusChip>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{c.kind}</span>
      </div>
      <div style={{ fontSize: 'var(--t-ui)', color: 'var(--c-dim)', lineHeight: 1.55, overflowWrap: 'anywhere' }}>{c.detail}</div>
      {c.tools.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {c.tools.map(t => (
            <span key={t} style={{
              fontSize: 'var(--t-small)', fontFamily: 'var(--mono)', color: 'var(--c-dim)',
              background: 'rgba(0,0,0,0.35)', border: '1px solid var(--c-hairline)',
              borderRadius: 6, padding: '2px 7px',
            }}>{t}</span>
          ))}
        </div>
      )}
      {checks && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {Object.entries(checks).map(([svc, r]) => (
            <div key={svc} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 'var(--t-small)' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: r.ok ? '#4db89e' : '#f87171', flexShrink: 0, alignSelf: 'center' }} />
              <span style={{ color: 'var(--c-text)', fontWeight: 600 }}>{svc}</span>
              <span style={{ color: 'var(--c-dim)', overflowWrap: 'anywhere' }}>{r.detail}</span>
            </div>
          ))}
        </div>
      )}
      {/* Rows open the in-app reader here too — they were inert on this page while the
          same widget opened messages on Home (now Mission Control); no silent dead rows. */}
      {preview?.gmail && <GmailWidget items={preview.gmail} onOpenMessage={onOpenMessage} />}
      {preview?.calendar && <CalendarWidget items={preview.calendar} />}
      {ghPreview?.prs && <GithubWidget items={ghPreview.prs} />}
      {onTry && c.authState === 'connected' && TRY_PROMPTS[c.id] && (
        <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
          <PrimaryButton
            onClick={() => onTry(TRY_PROMPTS[c.id].prompt)}
            title="Send this through chat — you review before it runs"
          >{TRY_PROMPTS[c.id].label}</PrimaryButton>
        </div>
      )}
      {c.id === 'google' && (
        <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
          {(c.authState === 'disconnected' || c.authState === 'expired') && (
            <PrimaryButton onClick={() => { window.location.href = loginUrl('google') }}>
              {c.authState === 'expired' ? 'Reconnect' : 'Connect Google'}
            </PrimaryButton>
          )}
          {c.authState === 'connected' && (
            <>
              <GhostButton onClick={test} title="Fire a real Gmail + Calendar call to verify access">{testing ? 'Testing…' : 'Test'}</GhostButton>
              <GhostButton onClick={disconnect} title="Forget stored Google tokens (reconnect any time)">Disconnect</GhostButton>
            </>
          )}
        </div>
      )}
    </Card>
  )
}

// Plain-language value lines for the agent toolbox — what each tool DOES FOR YOU,
// not what binary it is. Unknown ids fall back to the server-provided detail.
const TOOL_VALUE: Record<string, string> = {
  'cli-github': 'Lets the agent read your PRs, issues, and repos when you ask about them.',
  'cli-ripgrep': 'Fast code search — agents find things in big projects in milliseconds.',
  'cli-jq': 'Lets agents reshape JSON data cleanly instead of guessing with string edits.',
  'cli-semgrep': 'Code security scanning the agent can run over a project on request.',
}

export default function ConnectionsView({ onClose, onFollowUp }: {
  onClose: () => void
  /** Prefill the chat composer and return to chat — wired by App. */
  onFollowUp?: (text: string) => void
}) {
  const [list, setList] = useState<Connection[]>([])
  const [loaded, setLoaded] = useState(false)
  const [reading, setReading] = useState<MessageStub | null>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await apiFetch(`${API_BASE}/api/connections`, { credentials: 'include' })
      if (r.ok) setList((await r.json()).connections ?? [])
    } catch { /* transient — next open retries */ }
    setLoaded(true)
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  // Accounts + This Mac + GitHub are hero cards (they carry live widgets and try-it
  // actions); the remaining CLI binaries are plumbing — compact rows, not cards
  // competing for attention.
  const heroes = list.filter(c => c.kind === 'oauth' || c.kind === 'builtin' || c.id === 'cli-github')
  const toolbox = list.filter(c => c.kind === 'cli' && c.id !== 'cli-github')

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 30, background: 'var(--c-bg)',
      display: 'flex', flexDirection: 'column', animation: 'panelUp 0.22s var(--ease)',
    }}>
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12,
        padding: `calc(var(--titlebar-clearance) + 14px) 20px 14px`,
        borderBottom: '1px solid var(--c-hairline)',
      }}>
        <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--c-text)' }}>Connections</span>
        {loaded && (() => {
          // A green dot next to "0 active" reads as healthy when nothing is connected —
          // neutral gray until at least one connection is actually live.
          const n = list.filter(c => c.authState === 'connected').length
          return <StatusChip color={n > 0 ? '#4db89e' : '#55556a'}>{n} active</StatusChip>
        })()}
        <div style={{ flex: 1 }} />
        <GhostButton onClick={onClose} title="Back to chat">Close</GhostButton>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '18px 22px 24px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 860 }}>
          <div style={{ fontSize: 'var(--t-ui)', color: 'var(--c-dim)', lineHeight: 1.6, maxWidth: 620 }}>
            Everything the agent can reach beyond this app. Each connection powers specific agent
            tools — automations and Mission Control runs use them under your account.
          </div>
          {heroes.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <SectionLabel>Accounts & devices</SectionLabel>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(340px, 100%), 1fr))', gap: 12 }}>
                {heroes.map(c => <ConnectionCard key={c.id} c={c} onChanged={() => void refresh()} onTry={onFollowUp} onOpenMessage={setReading} />)}
              </div>
            </div>
          )}

          {toolbox.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <SectionLabel>Agent toolbox</SectionLabel>
              <div style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)', lineHeight: 1.5, marginTop: -4 }}>
                Local command-line tools agents can use during runs. Installed ones light up automatically.
              </div>
              <Card style={{ padding: '4px 0' }}>
                {toolbox.map(c => {
                  const connected = c.authState === 'connected'
                  return (
                    <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px' }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: connected ? '#4db89e' : '#55556a', flexShrink: 0 }} />
                      <span style={{ fontSize: 'var(--t-ui)', fontWeight: 600, color: connected ? 'var(--c-text)' : 'var(--c-dim)', flexShrink: 0 }}>{c.name}</span>
                      <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {TOOL_VALUE[c.id] ?? c.detail}
                      </span>
                      <span style={{ fontSize: 'var(--t-small)', color: connected ? '#4db89e' : 'var(--c-dim-deep)', flexShrink: 0 }}>
                        {connected ? 'ready' : 'not installed'}
                      </span>
                    </div>
                  )
                })}
              </Card>
            </div>
          )}
        </div>
      </div>

      {reading && (
        <EmailReader stub={reading} onClose={() => setReading(null)} onDraftReply={onFollowUp} />
      )}
    </div>
  )
}
