// ── Home surface (empty-chat state) ────────────────────────────────────────────
// 2026-07-21 redesign: the splash is CLEAN. No inbox tiles, no digest cards, no
// schedule strips — those are widgets on Mission Control's Overview board now, where
// they're interactable and the user arranges them. An empty chat shows exactly three
// things: a greeting, one line when agents are working (the only live signal worth
// interrupting the calm for), and one quiet door to Mission Control. First-run keeps
// the full identity splash (App.tsx renders that instead via the `splash` prop).

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

      {/* One quiet door to the day — widgets, results, schedule live there now. */}
      {live.length === 0 && (
        <button
          onClick={onOpenAgents}
          style={{
            alignSelf: 'center', display: 'flex', alignItems: 'center', gap: 7,
            padding: '7px 14px', borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
            background: 'rgba(255,255,255,0.035)', border: '1px solid var(--c-hairline)',
            color: 'var(--c-dim)', fontSize: 'var(--t-small)', fontWeight: 600,
            transition: 'color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease)',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = '#b0b0f8'; e.currentTarget.style.borderColor = 'rgba(124,124,248,0.35)' }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--c-dim)'; e.currentTarget.style.borderColor = 'var(--c-hairline)' }}
        >
          Your day is on Mission Control
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
            <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>
  )
}
