// Ensemble opt-in + BYOK (bring-your-own-key) control surface.
//
// Product constraint (see the crucible-byok-ensemble-constraint memory): the external
// multi-model pipeline ("Ensemble") must be OPT-IN and must run on the END USER's own API
// keys — Crucible never fans out to a paid provider on a bundled/shared key. Crucible-local
// is the default, zero-external-call path.
//
// This module owns:
//   · useEnsemble()   — persistent per-session ensemble toggle + BYOK key store (localStorage)
//   · <EnsemblePill/> — the composer's sole toggle (v3: the Code/Search mode picker is gone).
//   · <EnsembleKeyModal/> — the "add your API key" affordance: a blank-slate, freely-named
//                       list (v3 spec — no pre-baked "Mistral key"/"Gemini key" fields). The
//                       provider each key dispatches to is auto-detected from the token's own
//                       prefix (the same prefixes the old per-provider hints showed), so the
//                       user never has to pick a provider — they just paste and name it.
//
// The per-query confirmation ask is rendered by the app itself (it needs to sit in the send
// path); this module exports `shouldConfirmEnsemble()` + the pending-confirm plumbing helpers.

import { useCallback, useState } from 'react'

export type ChatMode = 'quorum' | 'code' | 'seeker' | 'research'

// Token-prefix → provider id, mirrors modelRegistry PROVIDER_KEY_ENV. BYOK keys are sent to
// the server per-request and used INSTEAD of any env key. Order matters: more specific
// prefixes (sk-or-) must be checked before their looser supersets (sk-).
const PROVIDER_PREFIXES: Array<{ test: RegExp; id: string; label: string }> = [
  { test: /^sk-or-/, id: 'openrouter', label: 'OpenRouter' },
  { test: /^gsk_/, id: 'groq', label: 'Groq' },
  { test: /^AIza/, id: 'gemini', label: 'Google Gemini' },
  { test: /^sk-/, id: 'openai', label: 'OpenAI' },
]

/** Best-effort provider detection from a pasted key's own shape. Only OpenRouter is fully
 *  wired server-side today (see modelRegistry KNOWN LIMIT); others are recognized but a key
 *  that doesn't match any known prefix is still stored — just not dispatchable yet. */
export function detectKeyProvider(token: string): { id: string; label: string } | null {
  const t = token.trim()
  for (const p of PROVIDER_PREFIXES) if (p.test.test(t)) return { id: p.id, label: p.label }
  return null
}

export interface NamedKey { id: string; name: string; token: string }

const NAMED_STORE = 'crucible_byok_named_keys'
const TOGGLE_STORE = 'crucible_ensemble_on'
const ASK_STORE = 'crucible_ensemble_ask' // 'always' | 'session' — per-query ask preference

function readNamedKeys(): NamedKey[] {
  try {
    const raw = JSON.parse(localStorage.getItem(NAMED_STORE) || '[]')
    return Array.isArray(raw) ? raw : []
  } catch { return [] }
}
function writeNamedKeys(k: NamedKey[]) {
  try { localStorage.setItem(NAMED_STORE, JSON.stringify(k)) } catch { /* ignore */ }
}

export interface EnsembleState {
  /** Persistent per-session ensemble toggle. */
  on: boolean
  setOn: (v: boolean) => void
  /** The user's freely-named key list, in add order. */
  namedKeys: NamedKey[]
  addKey: (name: string, token: string) => void
  removeKey: (id: string) => void
  /** BYOK keys resolved to provider → token (derived from namedKeys via prefix detection). */
  keys: Record<string, string>
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
  const [namedKeys, setNamedKeys] = useState<NamedKey[]>(() => readNamedKeys())

  const setOn = useCallback((v: boolean) => {
    setOnState(v)
    try { localStorage.setItem(TOGGLE_STORE, v ? '1' : '0') } catch { /* ignore */ }
  }, [])

  const addKey = useCallback((name: string, token: string) => {
    const trimmed = token.trim()
    if (!trimmed) return
    setNamedKeys(prev => {
      const next = [...prev, { id: `${Date.now()}-${prev.length}`, name: name.trim() || 'Untitled key', token: trimmed }]
      writeNamedKeys(next)
      return next
    })
  }, [])

  const removeKey = useCallback((id: string) => {
    setNamedKeys(prev => {
      const next = prev.filter(k => k.id !== id)
      writeNamedKeys(next)
      return next
    })
  }, [])

  // Later entries win on a provider collision — lets a user replace a stale key by adding
  // a fresh one rather than having to find-and-remove the old row first.
  const keys: Record<string, string> = {}
  for (const k of namedKeys) {
    const detected = detectKeyProvider(k.token)
    if (detected) keys[detected.id] = k.token
  }

  const hasAnyKey = namedKeys.length > 0
  const ensembleReady = on && Object.keys(keys).length > 0
  const keyPayload = ensembleReady ? keys : {}

  return { on, setOn, namedKeys, addKey, removeKey, keys, hasAnyKey, ensembleReady, keyPayload }
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

// Sole composer toggle (v3: the Code/Search mode picker UI is gone — 'code' is the
// permanent local default; this pill is the only way to arm Ensemble). `armed` reflects
// the caller's own mode==='quorum' check; `onToggle` does the actual mode+ensemble.on flip
// (and the caller opens the BYOK modal itself when there's no key yet).
export function EnsemblePill({ armed, onToggle, ensemble }: {
  armed: boolean
  onToggle: () => void
  ensemble: EnsembleState
}) {
  return (
    <button
      title={ensemble.hasAnyKey
        ? 'Ensemble — external multi-model pipeline (uses your own API keys)'
        : 'Ensemble needs your own API key — click to add one'}
      onClick={onToggle}
      style={pillStyle(armed, ACCENT.quorum)}
    >
      <span style={{
        width: 5, height: 5, borderRadius: '50%',
        background: armed ? '#7c7cf8' : '#55556a',
        boxShadow: armed ? '0 0 6px #7c7cf899' : 'none',
      }} />
      <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', color: armed ? '#9d9dfa' : '#55556a' }}>
        Ensemble
      </span>
      {!ensemble.hasAnyKey && (
        <span style={{ fontSize: 8.5, fontWeight: 700, color: 'rgba(245,158,11,0.8)', letterSpacing: '0.06em' }}>
          + KEY
        </span>
      )}
    </button>
  )
}

export function EnsembleKeyModal({ ensemble, onClose }: { ensemble: EnsembleState; onClose: () => void }) {
  const [draftName, setDraftName] = useState('')
  const [draftToken, setDraftToken] = useState('')

  const add = () => {
    if (!draftToken.trim()) return
    ensemble.addKey(draftName, draftToken)
    ensemble.setOn(true)
    setDraftName('')
    setDraftToken('')
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
            Ensemble — bring your own API keys
          </span>
          <span style={{ fontSize: 11.5, lineHeight: 1.5, color: '#8a8a9e' }}>
            Crucible runs locally by default with zero external calls. Ensemble mode fans a
            query out to external models — on <b style={{ color: '#b0b0c8' }}>your own</b> API
            keys. Name each key however you like; Crucible figures out which model it talks to
            from the key itself. Keys stay in this browser and are sent only when you run an
            ensemble query.
          </span>
        </div>

        {ensemble.namedKeys.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {ensemble.namedKeys.map(k => {
              const detected = detectKeyProvider(k.token)
              return (
                <div key={k.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                  borderRadius: 9, background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.07)',
                }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#d8d8e8' }}>{k.name}</span>
                    <span style={{ fontSize: 10.5, color: detected ? '#7fd8bf' : '#c98a4a', fontFamily: 'ui-monospace, monospace' }}>
                      {detected ? detected.label : 'unrecognized key format — not dispatchable yet'}
                      {'  ·  '}{k.token.slice(0, 4)}••••{k.token.slice(-3)}
                    </span>
                  </div>
                  <button onClick={() => ensemble.removeKey(k.id)} style={{
                    padding: '4px 9px', borderRadius: 7, border: '1px solid rgba(255,255,255,0.08)',
                    background: 'transparent', color: '#8a8a9e', fontSize: 10.5, fontWeight: 600, cursor: 'pointer',
                  }}>Remove</button>
                </div>
              )
            })}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: ensemble.namedKeys.length > 0 ? 2 : 0 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#b8b8cc' }}>Add a key</span>
          <input
            type="text"
            value={draftName}
            onChange={e => setDraftName(e.target.value)}
            placeholder="Name it anything — e.g. 'my key'"
            style={{
              background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)',
              borderRadius: 9, padding: '8px 11px', fontSize: 12, color: '#d8d8e8', outline: 'none',
            }}
          />
          <input
            type="password"
            value={draftToken}
            onChange={e => setDraftToken(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') add() }}
            placeholder="Paste the API key"
            style={{
              background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)',
              borderRadius: 9, padding: '8px 11px', fontSize: 12, color: '#d8d8e8',
              outline: 'none', fontFamily: 'ui-monospace, monospace',
            }}
          />
          <button onClick={add} disabled={!draftToken.trim()} style={{
            alignSelf: 'flex-start', padding: '6px 13px', borderRadius: 9,
            border: '1px solid rgba(124,124,248,0.35)', background: 'rgba(124,124,248,0.14)',
            color: '#b0b0ff', fontSize: 11.5, fontWeight: 700, cursor: draftToken.trim() ? 'pointer' : 'default',
            opacity: draftToken.trim() ? 1 : 0.5,
          }}>+ Add key</button>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button onClick={onClose} style={{
            padding: '7px 14px', borderRadius: 9, border: '1px solid rgba(124,124,248,0.35)',
            background: 'rgba(124,124,248,0.14)', color: '#b0b0ff', fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
          }}>Done</button>
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
