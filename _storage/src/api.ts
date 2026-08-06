// Backend base URL — resolved at runtime from the page's own hostname.
//
// On the Mac:        page is http://localhost:5173   → API = http://localhost:3001
// On a phone (LAN):  page is http://192.168.x.x:5173 → API = http://192.168.x.x:3001
// Through a tunnel:  page is https://foo.trycloudflare.com → API = same origin (see below)
//
// This means the device that loads the UI always talks to the backend at the SAME
// host it loaded the page from — never a bare "localhost", which on a phone would
// point at the phone itself.

function resolveApiBase(): string {
  const { protocol, hostname } = window.location

  // Allow an explicit override (e.g. a tunnel URL) via localStorage for advanced use.
  const override = (() => {
    try { return localStorage.getItem('crucible_api_base') } catch { return null }
  })()
  if (override) return override.replace(/\/$/, '')

  // Through a tunnel or any non-localhost host: API is same origin, proxied by Vite.
  if (hostname !== 'localhost' && hostname !== '127.0.0.1' && !hostname.match(/^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./)) {
    return `${protocol}//${hostname}`
  }

  // Standard local-network case: same host, backend on port 3001.
  return `${protocol}//${hostname}:3001`
}

export const API_BASE = resolveApiBase()

// Cloudflare Worker base (Session A proxy + Session B OAuth). When set, login goes
// through the Worker instead of the server's /api/auth/* routes — which is what lets
// Fly be shut down. Resolve order: localStorage override → build-time VITE_PROXY_URL →
// empty (fall back to the server's own auth routes, pre-migration behaviour).
function resolveProxyBase(): string {
  try {
    const override = localStorage.getItem('crucible_proxy_base')
    if (override) return override.replace(/\/$/, '')
  } catch { /* no storage */ }
  const envUrl = (import.meta as any).env?.VITE_PROXY_URL as string | undefined
  return envUrl ? envUrl.replace(/\/$/, '') : ''
}

export const PROXY_BASE = resolveProxyBase()

// URL that starts an OAuth login for the given provider. Prefers the Worker (post-
// migration); falls back to the server's own route when no proxy base is configured.
export function loginUrl(provider: 'google' | 'github'): string {
  return PROXY_BASE ? `${PROXY_BASE}/auth/login/${provider}` : `${API_BASE}/api/auth/${provider}`
}

// After a Worker login, the browser lands on `${FRONTEND_URL}/?token=<jwt>`. Promote the
// token to the `crucible_session` cookie the server reads, then scrub it from the URL.
// Runs at import time so the cookie exists before the first /api/auth/me check.
// (Non-httpOnly is fine — the server only reads the cookie's value, not its flags.)
;(function captureLoginToken() {
  if (typeof window === 'undefined') return
  try {
    const params = new URLSearchParams(window.location.search)
    const token = params.get('token')
    if (!token) return
    // Only accept a strict 3-segment base64url JWT — prevents a crafted ?token=...;attr
    // link from injecting extra cookie attributes (the value is written unencoded below).
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
      params.delete('token')
      const clean = params.toString()
      window.history.replaceState({}, '', window.location.pathname + (clean ? `?${clean}` : '') + window.location.hash)
      return
    }
    const secure = window.location.protocol === 'https:' ? '; Secure' : ''
    document.cookie = `crucible_session=${token}; path=/; max-age=${30 * 86400}; SameSite=Lax${secure}`
    params.delete('token')
    const qs = params.toString()
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash)
  } catch { /* no-op */ }
})()

// ── Paired-device token ─────────────────────────────────────────────────────
// Crucible refuses any request whose Host is a public hostname (server.ts's
// locality guard). A device paired from the Mac gets a token that opens that
// door from anywhere. It arrives once as `?device=<token>` on the pairing link
// and is kept in localStorage from then on.
//
// It is sent as a CUSTOM HEADER, never a cookie, and that is the point: a custom
// header forces a CORS preflight, so a hostile page cannot make the browser
// replay it the way it could with ambient cookie authority.
const DEVICE_KEY = 'crucible_device_token'

export function deviceToken(): string {
  try { return localStorage.getItem(DEVICE_KEY) ?? '' } catch { return '' }
}

export function setDeviceToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(DEVICE_KEY, token)
    else localStorage.removeItem(DEVICE_KEY)
  } catch { /* no storage — the token simply will not persist */ }
}

// Capture a token off the pairing link and scrub it from the URL, so it does not
// sit in history, get screenshotted, or leak through a Referer header.
;(function captureDeviceToken() {
  if (typeof window === 'undefined') return
  try {
    const params = new URLSearchParams(window.location.search)
    const t = params.get('device')
    if (!t) return
    if (/^[A-Za-z0-9_-]{20,200}$/.test(t)) setDeviceToken(t)
    params.delete('device')
    const qs = params.toString()
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash)
  } catch { /* no-op */ }
})()

/** WebSocket URLs cannot carry custom headers — the token rides as a param there. */
export function withDeviceParam(url: string): string {
  const t = deviceToken()
  if (!t) return url
  return url + (url.includes('?') ? '&' : '?') + `device=${encodeURIComponent(t)}`
}

// Credentials-included fetch — used for all /api/* requests so httpOnly cookies
// are sent automatically. Keeps every call site clean.
export function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const token = deviceToken()
  if (!token) return fetch(url, { credentials: 'include', ...init })
  const headers = new Headers(init?.headers)
  headers.set('x-crucible-device', token)
  return fetch(url, { credentials: 'include', ...init, headers })
}
