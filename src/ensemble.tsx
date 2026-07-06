// Ensemble opt-in + BYOK (bring-your-own-key) control surface.
//
// Product constraint (see the crucible-byok-ensemble-constraint memory): the external
// multi-model pipeline ("Ensemble") must be OPT-IN and must run on the END USER's own API
// keys — Crucible never fans out to a paid provider on a bundled/shared key. Crucible-local
// is the default, zero-external-call path.
//
// This module owns:
//   · useEnsemble()   — persistent per-session ensemble toggle + BYOK key store (localStorage)
//   · <ModeBar/>      — the composer's mode pills (Ensemble | Code | Search), replacing the
//                       old ModeSwitcher. Ensemble is visually gated on having ≥1 key.
//   · <EnsembleKeyModal/> — the "add your API key" affordance.
//
// The per-query confirmation ask is rendered by the app itself (it needs to sit in the send
// path); this module exports `shouldConfirmEnsemble()` + the pending-confirm plumbing helpers.

import { useCallback, useState } from 'react'

export type ChatMode = 'quorum' | 'code' | 'seeker' | 'research'

// Providers the pipeline can fan out to. Mirrors modelRegistry PROVIDER_KEY_ENV; BYOK keys
// are sent to the server per-request and used INSTEAD of any env key.
export const BYOK_PROVIDERS: Array<{ id: string; label: string; hint: string }> = [
  { id: 'openrouter', label: 'OpenRouter', hint: 'sk-or-…  (one key, many models — recommended)' },
  { id: 'groq', label: 'Groq', hint: 'gsk_…' },
  { id: 'openai', label: 'OpenAI', hint: 'sk-…' },
  { id: 'gemini', label: 'Google Gemini', hint: 'AIza…' },
  { id: 'mistral', label: 'Mistral', hint: '…' },
  { id: 'together', label: 'Together', hint: '…' },
]

const KEY_STORE = 'crucible_byok_keys'
const TOGGLE_STORE = 'crucible_ensemble_on'
const ASK_STORE = 'crucible_ensemble_ask' // 'always' | 'session' — per-query ask preference

function readKeys(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(KEY_STORE) || '{}') } catch { return {} }
}
function writeKeys(k: Record<string, string>) {
  try { localStorage.setItem(KEY_STORE, JSON.stringify(k)) } catch { /* ignore */ }
}

export interface EnsembleState {
  /** Persistent per-session ensemble toggle. */
  on: boolean
  setOn: (v: boolean) => void
  /** BYOK keys, provider → key (non-empty only). */
  keys: Record<string, string>
  setKey: (provider: string, key: string) => void
  hasAnyKey: boolean
  /** True when ensemble may actually fan out: toggled on AND at least one key present. */
  ensembleReady: boolean
  /** Keys payload to send to the server per-request (only when ensembleReady). */
  keyPayload: Record<string, string>
}

export function useEnsemble(): EnsembleState {
  const [on, setOnState] = useState<boolean>(() => {
    try { return localStorage.getItem(TOGGLE_STORE) === '1' } catch { return false }
  })
  const [keys, setKeys] = useState<Record<string, string>>(() => readKeys())

  const setOn = useCallback((v: boolean) => {
    setOnState(v)
    try { localStorage.setItem(TOGGLE_STORE, v ? '1' : '0') } catch { /* ignore */ }
  }, [])

  const setKey = useCallback((provider: string, key: string) => {
    setKeys(prev => {
      const next = { ...prev }
      const trimmed = key.trim()
      if (trimmed) next[provider] = trimmed
      else delete next[provider]
      writeKeys(next)
      return next
    })
  }, [])

  const hasAnyKey = Object.values(keys).some(v => !!v && v.trim().length > 0)
  const ensembleReady = on && hasAnyKey
  const keyPayload = ensembleReady ? keys : {}

  return { on, setOn, keys, setKey, hasAnyKey, ensembleReady, keyPayload }
}

/** Per-query confirmation preference: does the user want to be asked before each fan-out? */
export function ensembleAskPref(): 'always' | 'session' {
  try { return (localStorage.getItem(ASK_STORE) as 'always' | 'session') || 'always' } catch { return 'always' }
}
export function setEnsembleAskPref(v: 'always' | 'session') {
  try { localStorage.setItem(ASK_STORE, v) } catch { /* ignore */ }
}

// ── UI ────────────────────────────────────────────────────────────────────────

const ACCENT = { quorum: '124,124,248', code: '77,184,158', seeker: '245,158,11' }

function pillStyle(active: boolean, rgb: string): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 5,
    padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
    border: `1px solid ${active ? `rgba(${rgb},0.35)` : 'rgba(255,255,255,0.07)'}`,
    background: active ? `rgba(${rgb},0.1)` : 'transparent',
    transition: 'background 0.18s, border-color 0.18s',
    userSelect: 'none' as const,
    font: 'inherit',
  }
}

export function ModeBar({ mode, setMode, ensemble, onManageKeys }: {
  mode: ChatMode
  setMode: (m: ChatMode) => void
  ensemble: EnsembleState
  onManageKeys: () => void
}) {
  const ensembleActive = mode === 'quorum'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
      {/* Ensemble pill — opt-in; if no key yet, clicking opens the BYOK modal instead. */}
      <button
        title={ensemble.hasAnyKey
          ? 'Ensemble — external multi-model pipeline (uses your API keys)'
          : 'Ensemble needs your own API key — click to add one'}
        onClick={() => {
          if (!ensemble.hasAnyKey) { onManageKeys(); return }
          if (ensembleActive) { setMode('code'); ensemble.setOn(false) }
          else { setMode('quorum'); ensemble.setOn(true) }
        }}
        style={pillStyle(ensembleActive, ACCENT.quorum)}
      >
        <span style={{
          width: 5, height: 5, borderRadius: '50%',
          background: ensembleActive ? '#7c7cf8' : '#55556a',
          boxShadow: ensembleActive ? '0 0 6px #7c7cf899' : 'none',
        }} />
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', color: ensembleActive ? '#9d9dfa' : '#55556a' }}>
          Ensemble
        </span>
        {!ensemble.hasAnyKey && (
          <span style={{ fontSize: 8.5, fontWeight: 700, color: 'rgba(245,158,11,0.8)', letterSpacing: '0.06em' }}>
            + KEY
          </span>
        )}
      </button>

      <button onClick={() => setMode('code')} style={pillStyle(mode === 'code', ACCENT.code)}>
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', color: mode === 'code' ? '#7fd8bf' : '#55556a' }}>Code</span>
      </button>
      <button onClick={() => setMode('seeker')} style={pillStyle(mode === 'seeker', ACCENT.seeker)}>
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', color: mode === 'seeker' ? '#f5c06a' : '#55556a' }}>Search</span>
      </button>

      <div style={{ flex: 1 }} />
      <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: '0.12em', color: '#3a3a4c' }}>
        {ensemble.ensembleReady ? 'ENSEMBLE · YOUR KEYS' : 'CRUCIBLE · LOCAL'}
      </span>
    </div>
  )
}

export function EnsembleKeyModal({ ensemble, onClose }: { ensemble: EnsembleState; onClose: () => void }) {
  const [draft, setDraft] = useState<Record<string, string>>(() => ({ ...ensemble.keys }))
  const save = () => {
    for (const p of BYOK_PROVIDERS) ensemble.setKey(p.id, draft[p.id] ?? '')
    const anyNow = Object.values(draft).some(v => v && v.trim())
    if (anyNow) ensemble.setOn(true)
    onClose()
  }
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'fadeIn 0.2s ease',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 'min(460px, 92vw)', maxHeight: '86vh', overflowY: 'auto',
        background: 'rgba(16,16,22,0.96)', backdropFilter: 'blur(40px)',
        border: '1px solid rgba(255,255,255,0.09)', borderRadius: 18,
        boxShadow: '0 30px 90px rgba(0,0,0,0.6)', padding: '20px 20px 16px',
        display: 'flex', flexDirection: 'column', gap: 14,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em', color: '#e8e8f4' }}>
            Ensemble — bring your own API key
          </span>
          <span style={{ fontSize: 11.5, lineHeight: 1.5, color: '#8a8a9e' }}>
            Crucible runs locally by default with zero external calls. Ensemble mode fans a
            query out to external models — on <b style={{ color: '#b0b0c8' }}>your own</b> API
            keys. Keys stay in this browser and are sent only when you run an ensemble query.
          </span>
        </div>
        {BYOK_PROVIDERS.map(p => (
          <label key={p.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: '#b8b8cc' }}>{p.label}</span>
            <input
              type="password"
              value={draft[p.id] ?? ''}
              onChange={e => setDraft(d => ({ ...d, [p.id]: e.target.value }))}
              placeholder={p.hint}
              style={{
                background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)',
                borderRadius: 9, padding: '8px 11px', fontSize: 12, color: '#d8d8e8',
                outline: 'none', fontFamily: 'ui-monospace, monospace',
              }}
            />
          </label>
        ))}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button onClick={onClose} style={{
            padding: '7px 14px', borderRadius: 9, border: '1px solid rgba(255,255,255,0.08)',
            background: 'transparent', color: '#8a8a9e', fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
          }}>Cancel</button>
          <button onClick={save} style={{
            padding: '7px 16px', borderRadius: 9, border: '1px solid rgba(124,124,248,0.35)',
            background: 'rgba(124,124,248,0.14)', color: '#b0b0ff', fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
          }}>Save keys</button>
        </div>
      </div>
    </div>
  )
}

// Per-query confirmation card — shown before a fan-out when the ask preference is 'always'.
export function EnsembleConfirm({ onConfirm, onCancel }: {
  onConfirm: (remember: boolean) => void
  onCancel: () => void
}) {
  const [remember, setRemember] = useState(false)
  return (
    <div onClick={onCancel} style={{
      position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'fadeIn 0.2s ease',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 'min(400px, 92vw)', background: 'rgba(16,16,22,0.96)', backdropFilter: 'blur(40px)',
        border: '1px solid rgba(255,255,255,0.09)', borderRadius: 18, padding: '20px',
        display: 'flex', flexDirection: 'column', gap: 14, boxShadow: '0 30px 90px rgba(0,0,0,0.6)',
      }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#e8e8f4' }}>Use Ensemble for this query?</span>
        <span style={{ fontSize: 11.5, lineHeight: 1.55, color: '#8a8a9e' }}>
          This sends your message to external models using your own API keys, instead of
          running locally on Crucible. Local is free and private; ensemble may cost you money
          on your provider account.
        </span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: '#9a9ab0', cursor: 'pointer' }}>
          <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
          Don't ask again this session
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{
            padding: '7px 14px', borderRadius: 9, border: '1px solid rgba(255,255,255,0.08)',
            background: 'transparent', color: '#8a8a9e', fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
          }}>Run locally</button>
          <button onClick={() => onConfirm(remember)} style={{
            padding: '7px 16px', borderRadius: 9, border: '1px solid rgba(124,124,248,0.35)',
            background: 'rgba(124,124,248,0.14)', color: '#b0b0ff', fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
          }}>Use Ensemble</button>
        </div>
      </div>
    </div>
  )
}
