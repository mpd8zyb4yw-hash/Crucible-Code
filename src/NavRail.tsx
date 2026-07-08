// Left-rail tab navigation — Crucible v3 design (ported from the reference
// implementation's NavRail.tsx). Chat/Agents/History/Settings replace the old
// topbar-drawer-only navigation; the drawers themselves (Library/SelfRepair/etc.)
// still live inside the Chat tab, untouched.

import { memo } from 'react'

export type CrucibleTab = 'chat' | 'history' | 'settings'

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
function NavRail({ tab, setTab, agentsOpen, onToggleAgents, orientation = 'vertical' }: {
  tab: CrucibleTab
  setTab: (t: CrucibleTab) => void
  agentsOpen: boolean
  onToggleAgents: () => void
  // 'vertical' = the desktop 56px left rail. 'horizontal' = a compact icon row
  // embedded in the mobile top bar (no full-height chrome, no logo/spacer), so
  // phones get edge-to-edge chat with navigation up top instead of a left bar.
  orientation?: 'vertical' | 'horizontal'
}) {
  const go = (t: CrucibleTab) => () => setTab(t)
  const horizontal = orientation === 'horizontal'
  const btn = horizontal ? 32 : 38

  // Item-8: in the Electron shell the window uses titleBarStyle 'hiddenInset', which draws
  // native macOS traffic-light controls at roughly x:10-70, y:10-30 — right on top of this
  // rail's logo mark at the default 14px top padding. Push the rail's contents down below
  // the traffic lights when running inside Electron (detected via the electronIPC preload
  // bridge); web-only usage is unaffected.
  const isElectron = typeof window !== 'undefined' && !!(window as any).electronIPC
  const topPad = isElectron ? 34 : 14

  return (
    <div style={horizontal ? {
      // Mobile top-bar mode: a compact icon row, no full-height chrome/logo/spacer.
      display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 0,
    } : {
      width: 56, flexShrink: 0, zIndex: 20,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: `${topPad}px 0 16px`, gap: 6,
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

      <NavButton size={btn} active={tab === 'chat'} title="Chat" onClick={go('chat')}>
        <svg width="17" height="17" viewBox="0 0 16 16" fill="none">
          <path d="M14 8a6 6 0 0 1-8.7 5.4L2 14l0.7-3A6 6 0 1 1 14 8Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      </NavButton>
      {/* Items 18/19: Agents no longer navigates away from chat — it toggles an inline
          overlay drawer anchored to the chat panel (see AgentsTabView.tsx / App.tsx),
          so the conversation underneath stays mounted and in place. */}
      <NavButton size={btn} active={agentsOpen} title="Agents & capabilities" onClick={onToggleAgents}>
        <svg width="17" height="17" viewBox="0 0 16 16" fill="none">
          <rect x="3" y="5" width="10" height="8" rx="2.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8 5V2.8M6 9h.01M10 9h.01" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <circle cx="8" cy="2.2" r="0.9" fill="currentColor" />
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
