import { useRef } from 'react'
import { useCrucibleStore } from '../../state/store'

export default function SettingsView() {
  const keys = useCrucibleStore((s) => s.keys)
  const addKey = useCrucibleStore((s) => s.addKey)
  const removeKey = useCrucibleStore((s) => s.removeKey)
  const nameRef = useRef<HTMLInputElement>(null)
  const valRef = useRef<HTMLInputElement>(null)

  const doAdd = () => {
    const n = nameRef.current?.value ?? ''
    const v = valRef.current?.value ?? ''
    if (!n.trim() || !v.trim()) return
    addKey(n, v)
    if (nameRef.current) nameRef.current.value = ''
    if (valRef.current) valRef.current.value = ''
  }

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 1, overflowY: 'auto' }}>
      <div style={{ width: '100%', maxWidth: 640, margin: '0 auto', padding: '36px 32px 48px', display: 'flex', flexDirection: 'column', gap: 26 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', color: '#eef' }}>Settings</span>
          <span style={{ fontSize: 12.5, color: '#77778c' }}>Crucible runs fully on-device. External calls only happen through keys you add here.</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', color: '#b8b8cc', textTransform: 'uppercase' }}>API keys</span>
            <span style={{ fontSize: 11.5, lineHeight: 1.55, color: '#77778c' }}>
              Bring your own endpoints. Name each key whatever you like — Crucible assumes nothing about providers. Keys unlock ensemble mode; without them, ensemble stays off.
            </span>
          </div>

          {keys.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {keys.map((k) => (
                <div
                  key={k.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '12px 14px',
                    borderRadius: 14,
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.07)',
                  }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#4db89e', flexShrink: 0 }} />
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: '#d8d8e8', minWidth: 120 }}>{k.name}</span>
                  <span
                    style={{
                      fontSize: 11.5,
                      color: '#55556a',
                      fontFamily: "'SF Mono', 'Fira Code', monospace",
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {k.masked}
                  </span>
                  <button
                    onClick={() => removeKey(k.id)}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 999,
                      border: '1px solid rgba(255,255,255,0.08)',
                      background: 'transparent',
                      color: '#66667a',
                      fontSize: 10,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ padding: 20, borderRadius: 14, border: '1px dashed rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontSize: 11.5, color: '#55556a' }}>No keys yet — a blank slate. Zero external calls until you add one.</span>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '12px 14px', borderRadius: 14, background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <input
              ref={nameRef}
              placeholder="Name (anything)"
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 10,
                padding: '7px 12px',
                fontSize: 12,
                color: '#d0d0e0',
                outline: 'none',
                fontFamily: 'inherit',
                width: 160,
              }}
            />
            <input
              ref={valRef}
              placeholder="Key or endpoint token"
              onKeyDown={(e) => e.key === 'Enter' && doAdd()}
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 10,
                padding: '7px 12px',
                fontSize: 12,
                color: '#d0d0e0',
                outline: 'none',
                fontFamily: "'SF Mono', 'Fira Code', monospace",
                flex: 1,
              }}
            />
            <button
              onClick={doAdd}
              style={{
                padding: '7px 16px',
                borderRadius: 999,
                border: '1px solid rgba(124,124,248,0.35)',
                background: 'rgba(124,124,248,0.12)',
                color: '#b0b0ff',
                fontSize: 11.5,
                fontWeight: 600,
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              Add key
            </button>
          </div>
          <span style={{ fontSize: 10.5, color: '#4a4a5e' }}>
            Stored locally, never synced. {keys.length > 0 ? `${keys.length} key${keys.length === 1 ? '' : 's'} configured.` : ''}
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', color: '#b8b8cc', textTransform: 'uppercase' }}>Ensemble</span>
            <span style={{ fontSize: 11.5, lineHeight: 1.55, color: '#77778c' }}>
              Off by default. When armed from the composer, Crucible asks before every fan-out — no query is escalated automatically.
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: '#d8d8e8' }}>Ask before every ensemble run</span>
              <span style={{ fontSize: 11, color: '#66667a' }}>Per-query confirmation, even while the toggle is armed</span>
            </div>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: '#4db89e' }}>ALWAYS ON</span>
          </div>
        </div>
      </div>
    </div>
  )
}
