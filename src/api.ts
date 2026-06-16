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

// Credentials-included fetch — used for all /api/* requests so httpOnly cookies
// are sent automatically. Keeps every call site clean.
export function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { credentials: 'include', ...init })
}
