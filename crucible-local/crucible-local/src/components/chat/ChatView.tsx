import { useEffect, useRef, useState } from 'react'
import { useCrucibleStore } from '../../state/store'
import Composer from './Composer'
import MoltenPour from './MoltenPour'

function fmtElapsed(ms: number) {
  const total = Math.floor(ms / 1000)
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `${mm < 10 ? '0' + mm : mm}:${ss < 10 ? '0' + ss : ss}`
}

export default function ChatView() {
  const session = useCrucibleStore((s) => s.sessions.find((x) => x.id === s.currentSessionId) ?? null)
  const live = useCrucibleStore((s) => s.live)
  const newChat = useCrucibleStore((s) => s.newChat)

  const scrollRef = useRef<HTMLDivElement>(null)
  const liveWrapRef = useRef<HTMLDivElement>(null)
  const [, forceTick] = useState(0)

  const messages = session?.messages ?? []

  useEffect(() => {
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [messages.length, live?.text])

  useEffect(() => {
    if (!live) return
    const id = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [live?.startedAt])

  const isThinking = live?.phase === 'thinking'
  const isWorking = !!live
  const stageLabel = isThinking
    ? 'thinking…'
    : live?.phase === 'cooling'
      ? 'settling…'
      : live?.ensemble
        ? 'cross-examining…'
        : 'pouring…'

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 1 }}>
      {/* Topbar */}
      <div style={{ height: 48, flexShrink: 0, display: 'flex', alignItems: 'center', padding: '0 18px', gap: 12, zIndex: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '-0.01em', color: '#e4e4ee' }}>Crucible</span>
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.08em',
            color: '#66667a',
            background: 'rgba(255,255,255,0.035)',
            border: '1px solid rgba(255,255,255,0.07)',
            padding: '2px 8px',
            borderRadius: 999,
          }}
        >
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#4db89e' }} />
          ON-DEVICE
        </span>
        <div style={{ flex: 1 }} />
        {isWorking && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, animation: 'fadeIn 0.3s' }}>
            <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 10.5, color: '#55556a', fontWeight: 500 }}>
              {fmtElapsed(Date.now() - (live?.startedAt ?? Date.now()))}
            </span>
            <span style={{ fontSize: 10.5, color: '#77778c', letterSpacing: '0.05em' }}>{stageLabel}</span>
          </div>
        )}
        <button
          onClick={newChat}
          title="New chat"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            borderRadius: 10,
            border: '1px solid rgba(255,255,255,0.08)',
            background: 'rgba(255,255,255,0.04)',
            color: '#b8b8cc',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          New chat
        </button>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '24px 28px 170px',
          gap: 28,
          WebkitMaskImage:
            'linear-gradient(to bottom, black calc(100% - 130px), rgba(0,0,0,0.4) calc(100% - 70px), transparent 100%)',
          maskImage:
            'linear-gradient(to bottom, black calc(100% - 130px), rgba(0,0,0,0.4) calc(100% - 70px), transparent 100%)',
        }}
      >
        <div style={{ width: '100%', maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {messages.map((msg) =>
            msg.role === 'user' ? (
              <div key={msg.id} style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <div
                  style={{
                    maxWidth: '60%',
                    padding: '10px 16px',
                    borderRadius: '16px 16px 4px 16px',
                    fontSize: 13.5,
                    lineHeight: 1.6,
                    background: 'rgba(255,255,255,0.06)',
                    border: '1px solid rgba(255,255,255,0.09)',
                    color: '#d4d4e2',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {msg.text}
                </div>
              </div>
            ) : (
              <div key={msg.id} style={{ position: 'relative', borderRadius: 16, width: '100%', animation: 'slideUp 0.4s ease' }}>
                <div
                  style={{
                    position: 'relative',
                    borderRadius: 16,
                    padding: '18px 20px',
                    overflow: 'hidden',
                    background: 'rgba(255,255,255,0.035)',
                    backdropFilter: 'blur(28px)',
                    WebkitBackdropFilter: 'blur(28px)',
                    border: '1px solid rgba(255,255,255,0.09)',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
                  }}
                >
                  {msg.ensemble && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                      {(msg.models ?? []).map((m, i) => (
                        <span
                          key={i}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 5,
                            padding: '3px 9px',
                            borderRadius: 999,
                            background: m.chipBg,
                            border: `1px solid ${m.chipBorder}`,
                          }}
                        >
                          <span style={{ width: 5, height: 5, borderRadius: '50%', background: m.color }} />
                          <span style={{ fontSize: 10, fontWeight: 600, color: m.color }}>{m.label}</span>
                          <span style={{ fontSize: 9, color: '#55556a' }}>{m.role}</span>
                        </span>
                      ))}
                      <div style={{ flex: 1 }} />
                      <span
                        style={{
                          fontSize: 9,
                          fontWeight: 700,
                          letterSpacing: '0.12em',
                          color: 'rgba(157,157,250,0.7)',
                          textTransform: 'uppercase',
                        }}
                      >
                        ensemble
                      </span>
                    </div>
                  )}
                  <div style={{ fontSize: 13.5, lineHeight: 1.75, color: '#dcdcea', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
                    {msg.text}
                  </div>
                  {!msg.ensemble && (
                    <div style={{ marginTop: 10, fontSize: 9.5, fontWeight: 600, letterSpacing: '0.08em', color: '#4a4a5e' }}>
                      CRUCIBLE · ON-DEVICE
                    </div>
                  )}
                </div>
              </div>
            ),
          )}

          {live && (
            <div ref={liveWrapRef} style={{ position: 'relative', borderRadius: 16, width: '100%', marginTop: 46 }}>
              <MoltenPour wrapRef={liveWrapRef} />
              <div
                style={{
                  position: 'relative',
                  borderRadius: 16,
                  padding: '18px 20px',
                  minHeight: 54,
                  overflow: 'hidden',
                  background: 'rgba(255,255,255,0.035)',
                  backdropFilter: 'blur(28px)',
                  WebkitBackdropFilter: 'blur(28px)',
                  border: '1px solid rgba(255,255,255,0.045)',
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
                }}
              >
                <div style={{ fontSize: 13.5, lineHeight: 1.75, color: '#dcdcea', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', minHeight: 18 }}>
                  {live.text}
                  {live.phase === 'pouring' && (
                    <span
                      style={{
                        display: 'inline-block',
                        width: 7,
                        height: 15,
                        marginLeft: 2,
                        verticalAlign: 'text-bottom',
                        background: 'linear-gradient(180deg, #ffb45e, #ff6a1a)',
                        borderRadius: 2,
                        animation: 'caretBlink 0.9s step-end infinite',
                      }}
                    />
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <Composer />
    </div>
  )
}
