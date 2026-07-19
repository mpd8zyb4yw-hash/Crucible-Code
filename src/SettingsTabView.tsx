// Full-page Settings tab (Crucible v3 left-rail design) — the BYOK API-key management
// surface promoted out of the composer-pill modal (EnsembleKeyModal) into its own tab,
// matching the reference SettingsView.tsx layout. Same blank-slate, freely-named key list
// and provider auto-detection as the modal (src/ensemble.tsx) — this is just the full-page
// home for it now that the tab shell exists.

import { useRef, useEffect, useState } from 'react'
import { detectKeyProvider, type EnsembleState } from './ensemble'
import LocalModelsPanel from './LocalModelsPanel'

// ── Voice setup — surfaces whether the local whisper.cpp STT stack is installed, so the
// composer's mic button has a home to point to. On-device by design (no cloud STT). ──
function VoiceSetupSection() {
  const [st, setSt] = useState<{ ready: boolean; hasWhisper: boolean; hasFfmpeg: boolean; hasModel: boolean; modelPath: string } | null>(null)
  const refresh = () => fetch('/api/voice/status', { credentials: 'include' }).then(r => r.json()).then(setSt).catch(() => {})
  useEffect(() => { refresh() }, [])
  const Row = ({ label, ok, hint }: { label: string; ok: boolean; hint: string }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5 }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: ok ? '#4db89e' : '#c98a4a', flexShrink: 0 }} />
      <span style={{ color: '#d0d0e0', minWidth: 96 }}>{label}</span>
      <span style={{ color: ok ? '#4db89e' : '#77778c' }}>{ok ? 'installed' : hint}</span>
    </div>
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', color: '#b8b8cc', textTransform: 'uppercase' }}>Voice</span>
        <span style={{ fontSize: 11.5, lineHeight: 1.55, color: '#77778c' }}>
          Dictate into the composer and hear replies spoken back — fully on-device via whisper.cpp,
          no audio ever leaves this Mac. The mic button appears in the composer; right-click it to
          toggle the full voice loop (spoken replies).
        </span>
      </div>
      <div style={{ padding: '12px 14px', borderRadius: 14, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {st ? (
          st.ready ? (
            <span style={{ fontSize: 12, fontWeight: 600, color: '#4db89e' }}>Voice stack ready — the mic button will dictate.</span>
          ) : (
            <>
              <Row label="whisper-cli" ok={st.hasWhisper} hint="not found on PATH / ./bin" />
              <Row label="ffmpeg" ok={st.hasFfmpeg} hint="not found on PATH / ./bin" />
              <Row label="speech model" ok={st.hasModel} hint="ggml-base.en.bin missing" />
              <div style={{ fontSize: 11, lineHeight: 1.6, color: '#77778c', marginTop: 4, fontFamily: "'SF Mono','Fira Code',monospace", background: 'rgba(0,0,0,0.25)', padding: '8px 10px', borderRadius: 8, whiteSpace: 'pre-wrap' }}>
{`brew install whisper-cpp ffmpeg
mkdir -p .crucible/whisper && curl -L -o .crucible/whisper/ggml-base.en.bin \\
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`}
              </div>
              <span style={{ fontSize: 10.5, color: '#4a4a5e' }}>Or set WHISPER_BIN / FFMPEG_BIN / WHISPER_MODEL to existing installs. Model path: {st.modelPath}</span>
            </>
          )
        ) : <span style={{ fontSize: 11.5, color: '#55556a' }}>Checking voice stack…</span>}
        <button onClick={refresh} style={{ alignSelf: 'flex-start', padding: '5px 12px', borderRadius: 999, border: '1px solid rgba(124,124,248,0.35)', background: 'rgba(124,124,248,0.12)', color: '#b0b0ff', fontSize: 11, fontWeight: 600, cursor: 'pointer', marginTop: 2 }}>Re-check</button>
      </div>
    </div>
  )
}

/** Labeled wrapper for a system drawer trigger — replaces the old cryptic icon cluster:
 *  each binder now sits in a plain-language row (what it is, why you'd open it) with the
 *  actual trigger control on the right. */
export function SystemRow({ label, desc, children }: { label: string; desc: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderRadius: 12,
      background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: '#d8d8e8' }}>{label}</span>
        <span style={{ fontSize: 11, color: '#66667a', lineHeight: 1.45 }}>{desc}</span>
      </div>
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>{children}</div>
    </div>
  )
}

const SETTINGS_SECTIONS = [
  { id: 'keys', label: 'API keys' },
  { id: 'ensemble', label: 'Ensemble' },
  { id: 'voice', label: 'Voice' },
  { id: 'models', label: 'Local models' },
  { id: 'system', label: 'System' },
] as const

export default function SettingsTabView({ ensemble, advanced }: {
  ensemble: EnsembleState
  /** System drawers (history/tasks/integrations/library/self-repair/…) relocated from the
   *  old chat topbar — rendered as labeled SystemRow entries in the System section. */
  advanced?: React.ReactNode
}) {
  const nameRef = useRef<HTMLInputElement>(null)
  const valRef = useRef<HTMLInputElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [section, setSection] = useState<string>('keys')

  const doAdd = () => {
    const n = nameRef.current?.value ?? ''
    const v = valRef.current?.value ?? ''
    if (!v.trim()) return
    ensemble.addKey(n, v)
    ensemble.setOn(true)
    if (nameRef.current) nameRef.current.value = ''
    if (valRef.current) valRef.current.value = ''
  }

  const jump = (id: string) => {
    setSection(id)
    scrollerRef.current?.querySelector(`#settings-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', position: 'relative', zIndex: 1, minHeight: 0 }}>
      {/* Section nav — sticky left column (hidden on narrow widths via flex-wrap of content). */}
      <div style={{
        width: 168, flexShrink: 0, padding: '36px 8px 24px 20px',
        display: 'flex', flexDirection: 'column', gap: 2,
        borderRight: '1px solid rgba(255,255,255,0.05)',
      }}>
        <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.02em', color: '#eef', padding: '0 8px 14px' }}>Settings</span>
        {SETTINGS_SECTIONS.map(s => (
          <button key={s.id} onClick={() => jump(s.id)}
            className={`rail-nav-row${section === s.id ? ' rail-nav-row-active' : ''}`}>
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>{s.label}</span>
          </button>
        ))}
      </div>

      <div ref={scrollerRef} style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
      <div style={{ width: '100%', maxWidth: 640, margin: '0 auto', padding: '36px 32px 48px', display: 'flex', flexDirection: 'column', gap: 26 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span id="settings-keys" style={{ fontSize: 12.5, color: '#77778c' }}>Crucible runs fully on-device. External calls only happen through keys you add here.</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', color: '#b8b8cc', textTransform: 'uppercase' }}>API keys</span>
            <span style={{ fontSize: 11.5, lineHeight: 1.55, color: '#77778c' }}>
              Bring your own keys. Name each one whatever you like — Crucible figures out which
              model it talks to from the key itself. Keys unlock ensemble mode; without them,
              ensemble stays off.
            </span>
          </div>

          {ensemble.namedKeys.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {ensemble.namedKeys.map(k => {
                const detected = detectKeyProvider(k.token)
                return (
                  <div key={k.id} style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14,
                    background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
                  }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: detected ? '#4db89e' : '#c98a4a', flexShrink: 0 }} />
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: '#d8d8e8', minWidth: 120 }}>{k.name}</span>
                    <span style={{ fontSize: 11.5, color: '#55556a', fontFamily: "'SF Mono', 'Fira Code', monospace", flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {detected ? detected.label : 'unrecognized format'} · {k.token.slice(0, 4)}••••{k.token.slice(-3)}
                    </span>
                    <button
                      onClick={() => ensemble.removeKey(k.id)}
                      style={{ padding: '4px 10px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.08)', background: 'transparent', color: '#66667a', fontSize: 10, fontWeight: 600, cursor: 'pointer' }}
                    >Remove</button>
                  </div>
                )
              })}
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
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: '7px 12px', fontSize: 12, color: '#d0d0e0', outline: 'none', fontFamily: 'inherit', width: 160 }}
            />
            <input
              ref={valRef}
              type="password"
              placeholder="Paste the API key"
              onKeyDown={e => e.key === 'Enter' && doAdd()}
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: '7px 12px', fontSize: 12, color: '#d0d0e0', outline: 'none', fontFamily: "'SF Mono', 'Fira Code', monospace", flex: 1 }}
            />
            <button
              onClick={doAdd}
              style={{ padding: '7px 16px', borderRadius: 999, border: '1px solid rgba(124,124,248,0.35)', background: 'rgba(124,124,248,0.12)', color: '#b0b0ff', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}
            >Add key</button>
          </div>
          <span style={{ fontSize: 10.5, color: '#4a4a5e' }}>
            Stored locally, never synced. {ensemble.namedKeys.length > 0 ? `${ensemble.namedKeys.length} key${ensemble.namedKeys.length === 1 ? '' : 's'} configured.` : ''}
          </span>
        </div>

        <div id="settings-ensemble" style={{ display: 'flex', flexDirection: 'column', gap: 12, scrollMarginTop: 24 }}>
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

        <div id="settings-voice" style={{ scrollMarginTop: 24 }}><VoiceSetupSection /></div>

        <div id="settings-models" style={{ scrollMarginTop: 24 }}><LocalModelsPanel /></div>

        {advanced && (
          <div id="settings-system" style={{ display: 'flex', flexDirection: 'column', gap: 12, scrollMarginTop: 24 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', color: '#b8b8cc', textTransform: 'uppercase' }}>System</span>
              <span style={{ fontSize: 11.5, lineHeight: 1.55, color: '#77778c' }}>
                History, open tasks, integrations, the skill library, and Crucible's self-repair proposals.
              </span>
            </div>
            {advanced}
          </div>
        )}
      </div>
      </div>
    </div>
  )
}
