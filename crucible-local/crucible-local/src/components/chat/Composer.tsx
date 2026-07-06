import { useRef, useState } from 'react'
import { useCrucibleStore } from '../../state/store'

export default function Composer() {
  const ta = useRef<HTMLTextAreaElement>(null)
  const [value, setValue] = useState('')

  const live = useCrucibleStore((s) => s.live)
  const confirm = useCrucibleStore((s) => s.confirm)
  const ensembleArmed = useCrucibleStore((s) => s.ensembleArmed)
  const keyCount = useCrucibleStore((s) => s.keys.length)
  const send = useCrucibleStore((s) => s.send)
  const toggleEnsemble = useCrucibleStore((s) => s.toggleEnsemble)
  const confirmEnsemble = useCrucibleStore((s) => s.confirmEnsemble)
  const declineEnsemble = useCrucibleStore((s) => s.declineEnsemble)
  const setTab = useCrucibleStore((s) => s.setTab)

  const isWorking = !!live

  const doSend = () => {
    const text = value.trim()
    if (!text) return
    send(text)
    setValue('')
  }

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        padding: '8px 20px 20px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        zIndex: 10,
      }}
    >
      {confirm?.type === 'ask' && (
        <div
          style={{
            width: '100%',
            maxWidth: 720,
            marginBottom: 10,
            padding: '14px 16px',
            borderRadius: 16,
            background: 'rgba(124,124,248,0.07)',
            border: '1px solid rgba(124,124,248,0.25)',
            backdropFilter: 'blur(28px)',
            WebkitBackdropFilter: 'blur(28px)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            animation: 'slideUp 0.25s ease',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: '#7c7cf8',
                boxShadow: '0 0 8px rgba(124,124,248,0.7)',
              }}
            />
            <span style={{ fontSize: 12, fontWeight: 700, color: '#c8c8f0' }}>Use ensemble for this?</span>
          </div>
          <span style={{ fontSize: 11.5, lineHeight: 1.55, color: '#8a8a9e' }}>
            This fans out to {keyCount} external endpoint{keyCount === 1 ? '' : 's'} using your API keys, then
            cross-examines the drafts. Nothing leaves this device otherwise.
          </span>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={declineEnsemble} style={pillGhostStyle}>
              Crucible only
            </button>
            <button onClick={confirmEnsemble} style={pillAccentStyle}>
              Run ensemble
            </button>
          </div>
        </div>
      )}

      {confirm?.type === 'nokeys' && (
        <div
          style={{
            width: '100%',
            maxWidth: 720,
            marginBottom: 10,
            padding: '14px 16px',
            borderRadius: 16,
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.1)',
            backdropFilter: 'blur(28px)',
            WebkitBackdropFilter: 'blur(28px)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            animation: 'slideUp 0.25s ease',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#d8d8e8' }}>Ensemble needs your own API keys</span>
            <span style={{ fontSize: 11.5, color: '#8a8a9e' }}>
              No endpoints configured. Add keys in Settings — Crucible ships with zero external calls.
            </span>
          </div>
          <button onClick={declineEnsemble} style={{ ...pillGhostStyle, flexShrink: 0 }}>
            Crucible only
          </button>
          <button onClick={() => setTab('settings')} style={{ ...pillAccentStyle, flexShrink: 0 }}>
            Add keys
          </button>
        </div>
      )}

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          background: 'rgba(255,255,255,0.045)',
          border: '1px solid rgba(255,255,255,0.09)',
          borderRadius: 20,
          padding: '12px 12px 10px 14px',
          width: '100%',
          maxWidth: 720,
          backdropFilter: 'blur(32px)',
          WebkitBackdropFilter: 'blur(32px)',
          boxShadow: '0 8px 40px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.06)',
        }}
      >
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <svg width="20" height="20" viewBox="0 0 48 48" fill="none" style={{ flexShrink: 0, opacity: 0.4 }}>
            <path
              d="M10 14h28M10 14l6 22M38 14l-6 22M16 36q8 8 16 0"
              stroke="#e4e4ee"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <textarea
            ref={ta}
            rows={1}
            placeholder="Message Crucible"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                doSend()
              }
            }}
            style={{
              flex: 1,
              background: 'none',
              border: 'none',
              color: '#e4e4ee',
              fontSize: 13.5,
              resize: 'none',
              outline: 'none',
              fontFamily: 'inherit',
              lineHeight: 1.5,
              maxHeight: 160,
            }}
          />
          <button
            onClick={doSend}
            title="Send"
            style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              border: 'none',
              background: isWorking ? 'rgba(255,110,26,0.12)' : 'transparent',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              cursor: 'pointer',
              outline: `1px solid ${isWorking ? 'rgba(255,110,26,0.4)' : 'rgba(255,255,255,0.09)'}`,
              transition: 'background 0.3s',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M7 11V3M3.5 6.5L7 3L10.5 6.5"
                stroke={isWorking ? '#ff8a3d' : '#55556a'}
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0 0 32px' }}>
          <button
            onClick={toggleEnsemble}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '4px 10px',
              borderRadius: 999,
              cursor: 'pointer',
              border: `1px solid ${ensembleArmed ? 'rgba(124,124,248,0.4)' : 'rgba(255,255,255,0.07)'}`,
              background: ensembleArmed ? 'rgba(124,124,248,0.12)' : 'transparent',
              transition: 'background 0.2s, border-color 0.2s',
            }}
          >
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: '50%',
                background: ensembleArmed ? '#7c7cf8' : '#3a3a4c',
                boxShadow: ensembleArmed ? '0 0 6px rgba(124,124,248,0.6)' : 'none',
              }}
            />
            <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', color: ensembleArmed ? '#9d9dfa' : '#55556a' }}>
              Ensemble
            </span>
          </button>
          <span style={{ fontSize: 10, color: '#4a4a5e', fontWeight: 500 }}>
            {ensembleArmed ? (keyCount === 0 ? 'armed — but no API keys added yet' : 'armed — will ask before any fan-out') : '0 external calls'}
          </span>
        </div>
      </div>
    </div>
  )
}

const pillGhostStyle: React.CSSProperties = {
  padding: '6px 14px',
  borderRadius: 999,
  border: '1px solid rgba(255,255,255,0.1)',
  background: 'transparent',
  color: '#b8b8cc',
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
}

const pillAccentStyle: React.CSSProperties = {
  padding: '6px 14px',
  borderRadius: 999,
  border: '1px solid rgba(124,124,248,0.4)',
  background: 'rgba(124,124,248,0.15)',
  color: '#b0b0ff',
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
}
