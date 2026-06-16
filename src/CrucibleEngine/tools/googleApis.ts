// Google API token store + authenticated fetch helpers.
// All user tokens live in .crucible/google-tokens-<userId>.json
// Access tokens auto-refresh on expiry using the stored refresh_token.

import fs from 'fs'
import path from 'path'

const CRUCIBLE_DIR = path.join(process.cwd(), '.crucible')

export interface GoogleTokens {
  access_token: string
  refresh_token: string
  expires_at: number  // epoch ms
  scope: string
}

export function tokenFile(userId: string): string {
  return path.join(CRUCIBLE_DIR, `google-tokens-${userId}.json`)
}

export function loadTokens(userId: string): GoogleTokens | null {
  try { return JSON.parse(fs.readFileSync(tokenFile(userId), 'utf8')) }
  catch { return null }
}

export function saveTokens(userId: string, tokens: GoogleTokens) {
  fs.mkdirSync(CRUCIBLE_DIR, { recursive: true })
  fs.writeFileSync(tokenFile(userId), JSON.stringify(tokens, null, 2))
}

export async function getValidAccessToken(userId: string): Promise<string | null> {
  const t = loadTokens(userId)
  if (!t) return null
  if (Date.now() < t.expires_at - 60_000) return t.access_token
  // Refresh
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
        client_id: process.env.GOOGLE_CLIENT_ID ?? '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      }),
    })
    if (!r.ok) return null
    const fresh = await r.json() as any
    const updated: GoogleTokens = {
      ...t,
      access_token: fresh.access_token,
      expires_at: Date.now() + (fresh.expires_in ?? 3600) * 1000,
    }
    saveTokens(userId, updated)
    return updated.access_token
  } catch { return null }
}

export async function gFetch(userId: string, url: string, init: RequestInit = {}): Promise<any> {
  const token = await getValidAccessToken(userId)
  if (!token) throw new Error('No Google access token — user must sign in with Google and grant permissions.')
  const r = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`Google API ${r.status}: ${body.slice(0, 300)}`)
  }
  const ct = r.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) return r.json()
  return r.text()
}

// Which Google scopes are present in the stored token
export function hasScope(userId: string, scope: string): boolean {
  const t = loadTokens(userId)
  return !!t?.scope?.includes(scope)
}

// Convenience: summarise which services are available for a user
export function googleServicesStatus(userId: string): Record<string, boolean> {
  const t = loadTokens(userId)
  if (!t) return {
    gmail: false, calendar: false, drive: false, contacts: false,
    youtube: false, fitness: false, analytics: false, maps: false,
    kgSearch: false, customSearch: false,
  }
  const s = t.scope
  return {
    gmail:        s.includes('gmail'),
    calendar:     s.includes('calendar'),
    drive:        s.includes('drive'),
    contacts:     s.includes('contacts') || s.includes('people'),
    youtube:      s.includes('youtube'),
    fitness:      s.includes('fitness'),
    analytics:    s.includes('analytics'),
    maps:         !!process.env.GOOGLE_MAPS_API_KEY,
    kgSearch:     !!process.env.GOOGLE_KG_API_KEY,
    customSearch: !!(process.env.GOOGLE_CSE_API_KEY && process.env.GOOGLE_CSE_CX),
  }
}

// All scopes requested during Google OAuth sign-in
export const GOOGLE_SCOPES = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/fitness.activity.read',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ')
