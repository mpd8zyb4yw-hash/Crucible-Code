// ── Home surface (empty-chat state) ────────────────────────────────────────────
// 2026-07-21 redesign: the splash is CLEAN. No inbox tiles, no digest cards, no
// schedule strips — those are widgets on Mission Control's Overview board now, where
// they're interactable and the user arranges them. An empty chat shows exactly three
// things: the mark, a greeting, the date — plus one line when agents are working (the only
// live signal worth interrupting the calm for). First-run keeps the full identity splash
// (App.tsx renders that instead via the `splash` prop). This exact layout is a standing
// user decision (2026-07-21): do not add anything back here.

import { Card, StatusChip } from './ui'
import type { Round } from './chat/core'

export default function HomeSurface({ allRounds, onOpenAgents, splash }: {
  allRounds: Round[]
  onOpenAgents: () => void
  /** First-run identity view — rendered when the user hasn't sent anything yet. */
  splash: React.ReactNode
}) {
  const live = allRounds.filter(r => r.agent?.active)

  // First-run (nothing ever sent): the identity splash owns the page.
  let hasSent = false
  try { hasSent = localStorage.getItem('crucible_has_sent') === '1' } catch { /* splash either way */ }
  if (!hasSent) return <>{splash}</>

  return (
    <div style={{ width: 'min(560px, calc(100% - 48px))', display: 'flex', flexDirection: 'column', gap: 14, margin: 'auto 0', minHeight: 0, pointerEvents: 'auto' }}>
      {/* Greeting — the mark, the moment, the date. Nothing else competes with the composer. */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center' }}>
        <svg width="30" height="30" viewBox="0 0 48 48" fill="none">
          <path d="M10 14h28M10 14l6 22M38 14l-6 22M16 36q8 8 16 0"
            stroke="#ff9e5e" strokeOpacity="0.85" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--c-text)' }}>
          {new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 18 ? 'Good afternoon' : 'Good evening'}
        </span>
        <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)' }}>
          {new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
        </span>
      </div>

      {/* The one live signal: agents working right now → straight to Mission Control. */}
      {live.length > 0 && (
        <Card accent="#7c7cf8" style={{ padding: '11px 14px', cursor: 'pointer' }}>
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

      {/* USER DECISION (2026-07-21, permanent): NOTHING else on the splash. The user asked
          for the "Your day is on Mission Control" pill to be removed and for the splash to
          stay exactly this — mark + greeting + date, plus the live-agents card only when
          agents are actually running. Do not add tiles, pills, links, or promos here. */}
    </div>
  )
}
