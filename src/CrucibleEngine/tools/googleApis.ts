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

// ── The signed-in user's own display name (cont.120) ──────────────────────────
//
// Needed so a drafted message can be SIGNED. The live report was a reply ending "[Your Name]",
// which the user had to edit before it could be sent — the assistant knew the account and still
// shipped a form to fill in.
//
// `userinfo.profile` is already in GOOGLE_SCOPES below, so this costs no new consent. Cached for
// the process lifetime because a display name does not change during a session and this sits on
// the path of every drafted reply.
//
// Returns null rather than throwing or guessing. A wrong name on outgoing mail is worse than no
// name, so every failure here — not connected, network down, profile without a name — must
// degrade to "unknown" and let the caller drop the placeholder instead.
const displayNameCache = new Map<string, string | null>()

export async function googleDisplayName(userId: string): Promise<string | null> {
  if (!userId) return null
  if (displayNameCache.has(userId)) return displayNameCache.get(userId) ?? null
  let name: string | null = null
  try {
    const info = await gFetch(userId, 'https://www.googleapis.com/oauth2/v2/userinfo')
    const raw = typeof info?.name === 'string' ? info.name.trim() : ''
    // An email address is not a name. Some profiles return the local part or the address itself,
    // and signing a letter "Best regards, justinfitz21@gmail.com" is its own kind of wrong.
    name = raw && !raw.includes('@') ? raw : null
  } catch { name = null }
  displayNameCache.set(userId, name)
  return name
}

/** Test/logout hook — a different account must not inherit the previous one's name. */
export function clearDisplayNameCache(userId?: string): void {
  if (userId) displayNameCache.delete(userId)
  else displayNameCache.clear()
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
