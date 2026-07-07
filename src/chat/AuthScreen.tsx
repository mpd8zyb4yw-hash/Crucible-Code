// ── chat/AuthScreen — OAuth sign-in wall ──
import { useState, useEffect } from 'react'
import { API_BASE, apiFetch, loginUrl } from '../api'
import CrucibleMark from '../CrucibleMark'

// ── Auth UI ────────────────────────────────────────────────────────────────────

export function AuthScreen({ onAuth }: { onAuth: (user: { id: string; email: string }) => void }) {
  // Check for ?auth_error= param from OAuth callback redirect
  const [error] = useState(() => {
    const p = new URLSearchParams(window.location.search)
    return p.get('auth_error') ?? ''
  })

  // After OAuth the server redirects back here — poll /api/auth/me once on mount
  // in case the cookie was just set by the callback redirect.
  useEffect(() => {
    apiFetch(`${API_BASE}/api/auth/me`)
      .then(r => r.ok ? r.json() : null)
      .then(user => { if (user) onAuth(user) })
      .catch(() => {})
  }, [])

  const oauthBtnStyle = (bg: string): React.CSSProperties => ({
    width: '100%', padding: '13px 16px', borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.08)',
    background: bg, color: '#fff',
    fontSize: 14, fontWeight: 600, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
    transition: 'opacity 0.18s, transform 0.12s',
    fontFamily: 'inherit', letterSpacing: '0.01em',
    minHeight: 48,
  })

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 999,
      background: '#0a0a0e',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      animation: 'authFadeIn 0.4s ease',
    }}>
      <style>{`
        @keyframes authFadeIn { from { opacity: 0 } to { opacity: 1 } }
        .oauth-btn:hover { opacity: 0.82 !important; transform: translateY(-1px); }
        .oauth-btn:active { transform: translateY(0); }
      `}</style>
      <div style={{ width: '100%', maxWidth: 340, padding: '0 24px', textAlign: 'center' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
          <CrucibleMark thinking={false} done={false} />
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, color: '#e4e4f8', letterSpacing: '-0.02em', marginBottom: 4 }}>
          Crucible
        </div>
        <div style={{ fontSize: 12, color: 'rgba(160,160,200,0.4)', marginBottom: 40 }}>
          Adversarial ensemble reasoning
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Sign in with Google */}
          <button
            className="oauth-btn"
            style={oauthBtnStyle('rgba(255,255,255,0.06)')}
            onClick={() => {
  const url = loginUrl('google');
  if (window.electronIPC) { window.electronIPC.send('oauth-open', url); }
  else { window.location.href = url; }
}}
          >
            {/* Google G logo */}
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z" fill="#4285F4"/>
              <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z" fill="#34A853"/>
              <path d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332Z" fill="#FBBC05"/>
              <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.163 6.656 3.58 9 3.58Z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </button>

          {/* Sign in with GitHub */}
          <button
            className="oauth-btn"
            style={oauthBtnStyle('rgba(255,255,255,0.06)')}
            onClick={() => {
  const url = loginUrl('github');
  if (window.electronIPC) { window.electronIPC.send('oauth-open', url); }
  else { window.location.href = url; }
}}
          >
            {/* GitHub mark */}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12Z"/>
            </svg>
            Continue with GitHub
          </button>
        </div>

        {error && (
          <div style={{ marginTop: 20, fontSize: 12, color: '#fca5a5' }}>
            {decodeURIComponent(error)}
          </div>
        )}

        <div style={{ marginTop: 28, fontSize: 11, color: 'rgba(160,160,200,0.3)', lineHeight: 1.6 }}>
          No passwords stored. Your identity is verified by Google or GitHub.
        </div>
      </div>
    </div>
  )
}
