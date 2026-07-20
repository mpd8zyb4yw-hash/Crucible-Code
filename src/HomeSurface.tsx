// ── Home surface (Assistant layer step 3 — ASSISTANT_SPEC.md §2.2) ─────────────
// What an empty chat shows AFTER first run: the assistant's day, not a blank page.
// Digest results, live agent runs, and what's scheduled next — above the composer.
// First-run keeps the full identity splash (App.tsx renders that instead).
// Honest-data rule carried over: sections render only when they have real content.

import { useEffect, useState } from 'react'
import { Card, SectionLabel, StatusChip } from './ui'
import { API_BASE, apiFetch } from './api'
import type { Round } from './chat/core'
import { GmailWidget, CalendarWidget, GithubWidget, type GooglePreview, type GithubPreview } from './ConnectionWidgets'

interface DigestEntry { automationId: string; name: string; ts: number; status: 'ok' | 'failed'; summary: string; ms: number }
interface AutomationLite { id: string; name: string; enabled: boolean; nextRun: number | null }

// Day-at-a-glance tap prompts — each tile is a door into a real agent turn, not a
// dead render. Wording matches the Connections page try-its so the two never diverge.
const ASK_INBOX = 'Summarize any inbox email from the last day that needs a reply.'
const ASK_CALENDAR = 'Summarize today\'s calendar and what\'s coming up over the next few days.'
const ASK_PRS = 'List my open GitHub PRs and flag any that look stalled or are waiting on review.'

/** Wraps a live tile so the whole thing taps into a chat turn — result that OPENS. */
function AskTile({ onAsk, prompt, children }: { onAsk?: (p: string) => void; prompt: string; children: React.ReactNode }) {
  if (!onAsk) return <>{children}</>
  return (
    <div role="button" tabIndex={0}
      onClick={() => onAsk(prompt)}
      onKeyDown={e => { if (e.key === 'Enter') onAsk(prompt) }}
      style={{ cursor: 'pointer', borderRadius: 10 }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.filter = 'brightness(1.12)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.filter = 'none' }}
    >{children}</div>
  )
}

function fmtWhen(ts: number): string {
  const d = new Date(ts)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const day = new Date(ts); day.setHours(0, 0, 0, 0)
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (day.getTime() === today.getTime()) return hm
  if (day.getTime() === today.getTime() + 86400_000) return `tomorrow ${hm}`
  if (day.getTime() === today.getTime() - 86400_000) return `yesterday ${hm}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`
}

export default function HomeSurface({ allRounds, onOpenAgents, onOpenAutomations, onOpenRun, onAsk, splash }: {
  allRounds: Round[]
  onOpenAgents: () => void
  onOpenAutomations: () => void
  /** Open a run's full result (App renders the RunDetailOverlay above everything). */
  onOpenRun?: (r: { automationId: string; ts: number; name?: string }) => void
  /** Tap a live tile into a chat turn — prefills the composer, user presses send. */
  onAsk?: (prompt: string) => void
  /** First-run identity view — rendered when the assistant genuinely has nothing to show. */
  splash: React.ReactNode
}) {
  const [digest, setDigest] = useState<DigestEntry[]>([])
  const [upcoming, setUpcoming] = useState<AutomationLite[]>([])
  const [google, setGoogle] = useState<GooglePreview | null>(null)
  const [github, setGithub] = useState<GithubPreview | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let dead = false
    // Live account previews load best-effort alongside the digest: a null (not-connected
    // or failed) simply omits its tile — honest-absence, never a fabricated empty state.
    Promise.all([
      apiFetch(`${API_BASE}/api/automations/digest`, { credentials: 'include' }).then(r => r.ok ? r.json() : null),
      apiFetch(`${API_BASE}/api/automations`, { credentials: 'include' }).then(r => r.ok ? r.json() : null),
      apiFetch(`${API_BASE}/api/connections/google/preview`, { credentials: 'include' }).then(r => r.ok ? r.json() : null).catch(() => null),
      apiFetch(`${API_BASE}/api/connections/github/preview`, { credentials: 'include' }).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([d, a, g, gh]) => {
      if (dead) return
      if (d) setDigest((d.entries ?? []).slice(0, 4))
      if (a) setUpcoming((a.automations ?? [])
        .filter((x: AutomationLite) => x.enabled && x.nextRun != null)
        .sort((x: AutomationLite, y: AutomationLite) => x.nextRun! - y.nextRun!)
        .slice(0, 3))
      if (g) setGoogle(g)
      if (gh) setGithub(gh)
      setLoaded(true)
    }).catch(() => { if (!dead) setLoaded(true) })
    return () => { dead = true }
  }, [])

  const live = allRounds.filter(r => r.agent?.active)
  const hasGlance = !!(google?.calendar || google?.gmail || github?.prs)
  const hasContent = digest.length > 0 || upcoming.length > 0 || live.length > 0 || hasGlance

  // Until the day's data arrives, render nothing (a 200ms blank beats a splash
  // that flashes and is replaced). Genuinely-empty accounts get the identity splash.
  if (!loaded) return null
  if (!hasContent) return <>{splash}</>

  return (
    <div style={{ width: 'min(680px, calc(100% - 48px))', display: 'flex', flexDirection: 'column', gap: 14, margin: 'auto 0', minHeight: 0, pointerEvents: 'auto' }}>
      {/* Compact identity row — the mark earns a corner, the day gets the page. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <svg width="22" height="22" viewBox="0 0 48 48" fill="none">
          <path d="M10 14h28M10 14l6 22M38 14l-6 22M16 36q8 8 16 0"
            stroke="#ff9e5e" strokeOpacity="0.85" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--c-text)' }}>
          {new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 18 ? 'Good afternoon' : 'Good evening'}
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)' }}>
          {new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
        </span>
      </div>

      {live.length > 0 && (
        <Card accent="#7c7cf8" style={{ padding: '11px 14px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
          <div role="button" tabIndex={0} onClick={onOpenAgents}
            onKeyDown={e => { if (e.key === 'Enter') onOpenAgents() }}
            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
            <StatusChip color="#7c7cf8" pulse>{live.length} agent{live.length === 1 ? '' : 's'} working</StatusChip>
            <span style={{ fontSize: 'var(--t-ui)', color: 'var(--c-dim)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {live[live.length - 1].userMessage}
            </span>
            <span style={{ fontSize: 'var(--t-small)', color: '#9d9dfa', flexShrink: 0 }}>Mission Control</span>
          </div>
        </Card>
      )}

      {hasGlance && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <SectionLabel>Your day</SectionLabel>
          {google?.calendar && (
            <AskTile onAsk={onAsk} prompt={ASK_CALENDAR}><CalendarWidget items={google.calendar} /></AskTile>
          )}
          {google?.gmail && (
            <AskTile onAsk={onAsk} prompt={ASK_INBOX}><GmailWidget items={google.gmail} /></AskTile>
          )}
          {github?.prs && (
            <AskTile onAsk={onAsk} prompt={ASK_PRS}><GithubWidget items={github.prs} /></AskTile>
          )}
        </div>
      )}

      {digest.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <SectionLabel>Latest from your automations</SectionLabel>
          {digest.map((e, i) => (
            <Card
              key={`${e.automationId}:${e.ts}:${i}`} accent={e.status === 'ok' ? '#4db89e' : '#f87171'}
              onClick={onOpenRun ? () => onOpenRun({ automationId: e.automationId, ts: e.ts, name: e.name }) : undefined}
              style={{ padding: '11px 14px', display: 'flex', flexDirection: 'column', gap: 5, cursor: onOpenRun ? 'pointer' : 'default' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: e.status === 'ok' ? '#4db89e' : '#f87171', flexShrink: 0 }} />
                <span style={{ fontSize: 'var(--t-ui)', fontWeight: 600, color: 'var(--c-text)' }}>{e.name}</span>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)', fontVariantNumeric: 'tabular-nums' }}>{fmtWhen(e.ts)}</span>
              </div>
              <div style={{
                fontSize: 'var(--t-small)', color: 'var(--c-dim)', lineHeight: 1.55, overflowWrap: 'anywhere',
                display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                whiteSpace: 'pre-wrap',
              }}>{e.summary}</div>
            </Card>
          ))}
        </div>
      )}

      {upcoming.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <SectionLabel>Scheduled</SectionLabel>
          <Card style={{ padding: '4px 0' }}>
            {upcoming.map(a => (
              <div key={a.id} role="button" tabIndex={0} onClick={onOpenAutomations}
                onKeyDown={e => { if (e.key === 'Enter') onOpenAutomations() }}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px', cursor: 'pointer' }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#4db89e', flexShrink: 0 }} />
                <span style={{ fontSize: 'var(--t-ui)', color: 'var(--c-text)' }}>{a.name}</span>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim)', fontVariantNumeric: 'tabular-nums' }}>{fmtWhen(a.nextRun!)}</span>
              </div>
            ))}
          </Card>
        </div>
      )}

    </div>
  )
}
