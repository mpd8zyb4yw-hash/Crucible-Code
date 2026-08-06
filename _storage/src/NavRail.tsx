// Mobile top-bar navigation. Consolidated 2026-08-04: the rail used to carry five
// peers (Chat, Agents, Automations, Connections, Settings), three of which were
// overlays rather than tabs. Home now leads and absorbs the agent board; Automations
// is reached from the Watch widget and Connections from Settings, so this is
// Home / Chat / History / Settings.

import { memo } from 'react'

export type CrucibleTab = 'home' | 'chat' | 'history' | 'settings'

function NavButton({ active, title, onClick, size = 38, children }: {
  active: boolean
  title: string
  onClick: () => void
  size?: number
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: size, height: size, borderRadius: size >= 38 ? 11 : 9, border: 'none', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        background: active ? 'rgba(124,124,248,0.13)' : 'transparent',
        color: active ? '#9d9dfa' : '#55556a',
        outline: active ? '1px solid rgba(124,124,248,0.28)' : 'none',
        transition: 'background 0.2s, color 0.2s',
        WebkitAppRegion: 'no-drag',
      } as any}
    >
      {children}
    </button>
  )
}

// Item-5: NavRail has no dependency on chat-input state, but before this it re-rendered on
// every keystroke anyway because it's a child of the same App component tree that owns
// `input`. React.memo keeps it from re-rendering unless `tab`/`setTab` actually change —
// a small, safe piece of the "typing latency" fix without touching the input wiring itself.
function NavRail({ tab, setTab, orientation = 'vertical' }: {
  tab: CrucibleTab
  setTab: (t: CrucibleTab) => void
  // 'vertical' = the desktop 56px left rail. 'horizontal' = a compact icon row
  // embedded in the mobile top bar (no full-height chrome, no logo/spacer), so
  // phones get edge-to-edge chat with navigation up top instead of a left bar.
  orientation?: 'vertical' | 'horizontal'
}) {
  const go = (t: CrucibleTab) => () => setTab(t)
  const horizontal = orientation === 'horizontal'
  const btn = horizontal ? 32 : 38

  return (
    <div style={horizontal ? {
      // Mobile top-bar mode: a compact icon row, no full-height chrome/logo/spacer.
      display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 0,
    } : {
      width: 56, flexShrink: 0, zIndex: 20,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      // Traffic-light clearance from the shared shell token (0 on the web).
      padding: `calc(var(--titlebar-clearance) + 14px) 0 16px`, gap: 6,
      background: 'rgba(255,255,255,0.025)',
      backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)',
      borderRight: '1px solid rgba(255,255,255,0.06)',
    }}>
      {!horizontal && (
        <div style={{ width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
          <svg width="22" height="22" viewBox="0 0 48 48" fill="none">
            <path d="M10 14h28M10 14l6 22M38 14l-6 22M16 36q8 8 16 0" stroke="#e4e4ee" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
          </svg>
        </div>
      )}

      {/* Home leads: the card board is the assistant surface, not a chat splash. */}
      <NavButton size={btn} active={tab === 'home'} title="Home" onClick={go('home')}>
        <svg width="17" height="17" viewBox="0 0 16 16" fill="none">
          <rect x="2.2" y="2.2" width="5" height="5" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
          <rect x="8.8" y="2.2" width="5" height="5" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
          <rect x="2.2" y="8.8" width="5" height="5" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
          <rect x="8.8" y="8.8" width="5" height="5" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </NavButton>
      <NavButton size={btn} active={tab === 'chat'} title="Chat" onClick={go('chat')}>
        <svg width="17" height="17" viewBox="0 0 16 16" fill="none">
          <path d="M14 8a6 6 0 0 1-8.7 5.4L2 14l0.7-3A6 6 0 1 1 14 8Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      </NavButton>
      <NavButton size={btn} active={tab === 'history'} title="History" onClick={go('history')}>
        <svg width="17" height="17" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8 5v3.2l2.2 1.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </NavButton>

      {!horizontal && <div style={{ flex: 1 }} />}

      <NavButton size={btn} active={tab === 'settings'} title="Settings" onClick={go('settings')}>
        {/* Item-15: was a sun/brightness-slider glyph (small circle + 8 straight rays);
            replaced with a proper gear/cog so it reads as "Settings" at a glance. */}
        {/* Canonical Feather "settings" gear — the previous hand-edited path had broken
            arc segments and rendered visibly asymmetric. */}
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </NavButton>
    </div>
  )
}

export default memo(NavRail)
