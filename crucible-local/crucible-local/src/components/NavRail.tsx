import { useCrucibleStore } from '../state/store'
import type { Tab } from '../state/types'

function NavButton({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 38,
        height: 38,
        borderRadius: 11,
        border: 'none',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: active ? 'rgba(124,124,248,0.13)' : 'transparent',
        color: active ? '#9d9dfa' : '#55556a',
        outline: active ? '1px solid rgba(124,124,248,0.28)' : 'none',
        transition: 'background 0.2s, color 0.2s',
      }}
    >
      {children}
    </button>
  )
}

export default function NavRail() {
  const tab = useCrucibleStore((s) => s.tab)
  const setTab = useCrucibleStore((s) => s.setTab)
  const go = (t: Tab) => () => setTab(t)

  return (
    <div
      style={{
        width: 56,
        flexShrink: 0,
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '14px 0 16px',
        gap: 6,
        background: 'rgba(255,255,255,0.025)',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        borderRight: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <div style={{ width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
        <svg width="22" height="22" viewBox="0 0 48 48" fill="none">
          <path
            d="M10 14h28M10 14l6 22M38 14l-6 22M16 36q8 8 16 0"
            stroke="#e4e4ee"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.85"
          />
        </svg>
      </div>

      <NavButton active={tab === 'chat'} title="Chat" onClick={go('chat')}>
        <svg width="17" height="17" viewBox="0 0 16 16" fill="none">
          <path d="M14 8a6 6 0 0 1-8.7 5.4L2 14l0.7-3A6 6 0 1 1 14 8Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      </NavButton>
      <NavButton active={tab === 'agents'} title="Agents" onClick={go('agents')}>
        <svg width="17" height="17" viewBox="0 0 16 16" fill="none">
          <rect x="3" y="5" width="10" height="8" rx="2.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8 5V2.8M6 9h.01M10 9h.01" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <circle cx="8" cy="2.2" r="0.9" fill="currentColor" />
        </svg>
      </NavButton>
      <NavButton active={tab === 'history'} title="History" onClick={go('history')}>
        <svg width="17" height="17" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8 5v3.2l2.2 1.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </NavButton>

      <div style={{ flex: 1 }} />

      <NavButton active={tab === 'settings'} title="Settings" onClick={go('settings')}>
        <svg width="17" height="17" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.4" />
          <path
            d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </NavButton>
      <div
        style={{
          width: 26,
          height: 26,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, #7c7cf8, #4db89e)',
          opacity: 0.85,
          marginTop: 4,
        }}
      />
    </div>
  )
}
