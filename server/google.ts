import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Observation } from './world.js'

/**
 * Google connector.
 *
 * Token handling follows `_storage/src/CrucibleEngine/tools/googleApis.ts`
 * (refresh-on-expiry, scope checks, authenticated fetch), rewritten against the
 * new world model instead of the old session store.
 *
 * The redirect URI is `<base>/api/auth/callback/google` because BOTH
 * `https://crucible.cam/...` and `http://localhost:3001/...` are already
 * registered on this client — verified against Google's authorize endpoint, so
 * neither local development nor production needs a console change.
 *
 * Everything here is deliberately CHEAP: fetching, filtering and shaping
 * Google's data into observations is ordinary code, not model work. Only the
 * synthesis that reads those observations costs a token.
 */

const DIR = join(homedir(), '.crucible')
const TOKENS = join(DIR, 'google-tokens.json')

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/fitness.activity.read',
].join(' ')

export interface Tokens {
  access_token: string
  refresh_token?: string
  expiry: number
  scope: string
}

export const callbackPath = '/api/auth/callback/google'

/** Same-origin base, so the callback matches whichever host is serving. */
export function serverBase(req: { headers: Record<string, any>; protocol?: string }): string {
  const envBase = process.env.OAUTH_BASE_URL
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost:3001')
  if (/^localhost|^127\.|^\[::1\]/.test(host)) return `http://${host}`
  return envBase ?? `https://${host}`
}

export async function loadTokens(): Promise<Tokens | null> {
  try {
    return JSON.parse(await readFile(TOKENS, 'utf8'))
  } catch {
    return null
  }
}

export async function saveTokens(t: Tokens): Promise<void> {
  await mkdir(DIR, { recursive: true })
  await writeFile(TOKENS, JSON.stringify(t, null, 2) + '\n')
}

export async function clearTokens(): Promise<void> {
  await writeFile(TOKENS, 'null\n').catch(() => {})
}

export function authUrl(clientId: string, redirectUri: string): string {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'offline',
    // Force a refresh_token even on re-consent; without it a re-auth silently
    // yields an access token that dies in an hour with no way to renew.
    prompt: 'consent',
    include_granted_scopes: 'true',
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`
}

export async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<Tokens> {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  })
  const b: any = await r.json()
  if (!r.ok) throw new Error(b?.error_description ?? b?.error ?? `HTTP ${r.status}`)
  return {
    access_token: b.access_token,
    refresh_token: b.refresh_token,
    expiry: Date.now() + (Number(b.expires_in) || 3600) * 1000,
    scope: b.scope ?? '',
  }
}

/** A live access token, refreshed if it has expired. Null if not connected. */
export async function accessToken(clientId: string, clientSecret: string): Promise<string | null> {
  const t = await loadTokens()
  if (!t?.access_token) return null
  // 60s of slack so a token cannot expire mid-request.
  if (t.expiry - 60_000 > Date.now()) return t.access_token
  if (!t.refresh_token) return null

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: t.refresh_token, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' }),
  })
  const b: any = await r.json()
  if (!r.ok) return null
  const next: Tokens = {
    access_token: b.access_token,
    // Google omits refresh_token on refresh; keep the original.
    refresh_token: b.refresh_token ?? t.refresh_token,
    expiry: Date.now() + (Number(b.expires_in) || 3600) * 1000,
    scope: b.scope ?? t.scope,
  }
  await saveTokens(next)
  return next.access_token
}

async function gFetch(token: string, url: string): Promise<any> {
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`)
  return r.json()
}

const iso = (d: Date) => d.toISOString().slice(0, 10)

/**
 * Pull a window of real life out of Google and shape it into observations.
 * Each source is independent: one failing (a scope not granted, an API off)
 * must never cost the others.
 */
export const GOOGLE_SOURCES = ['calendar', 'email', 'health', 'youtube'] as const
export type GoogleSource = (typeof GOOGLE_SOURCES)[number]

export async function pullObservations(
  token: string,
  /** Which sources he has left switched on. Absent means all of them. */
  enabled?: Partial<Record<GoogleSource, boolean>>
): Promise<{ observations: Observation[]; errors: string[] }> {
  const out: Observation[] = []
  const errors: string[] = []
  // One signing-in step, then he decides source by source what it may read.
  const on = (s: GoogleSource) => enabled?.[s] !== false
  const now = new Date()
  const weekAhead = new Date(now.getTime() + 7 * 86_400_000)
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000)

  // Calendar — the next week, which is where conflicts and commitments live.
  if (on('calendar')) try {
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now.toISOString()}&timeMax=${weekAhead.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=50`
    const b = await gFetch(token, url)
    for (const e of b.items ?? []) {
      const start = e.start?.dateTime ?? e.start?.date
      if (!start) continue
      const when = e.start?.dateTime ? new Date(e.start.dateTime).toString().replace(/ GMT.*$/, '') : `${start} (all day)`
      out.push({
        id: `gcal-${e.id}`.slice(0, 60),
        source: 'calendar',
        at: String(start).slice(0, 10),
        text: `${e.summary ?? 'Untitled'} — ${when}${e.location ? `, at ${e.location}` : ''}${e.attendees?.length ? `, with ${e.attendees.map((a: any) => a.displayName ?? a.email).slice(0, 4).join(', ')}` : ''}`,
      })
    }
  } catch (e) {
    errors.push(`calendar: ${(e as Error).message}`)
  }

  // Gmail — subjects and senders only. Enough to notice a deadline or a bill
  // without hoovering the body of every message he has ever received.
  if (on('email')) try {
    const list = await gFetch(token, 'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=15&q=newer_than:7d -category:promotions')
    for (const m of (list.messages ?? []).slice(0, 15)) {
      const msg = await gFetch(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`)
      const h = Object.fromEntries((msg.payload?.headers ?? []).map((x: any) => [x.name, x.value]))
      out.push({
        id: `gmail-${m.id}`.slice(0, 60),
        source: 'email',
        at: h.Date ? iso(new Date(h.Date)) : iso(now),
        text: `Email from ${h.From ?? 'unknown'} — "${h.Subject ?? '(no subject)'}"${msg.snippet ? `: ${String(msg.snippet).slice(0, 180)}` : ''}`,
      })
    }
  } catch (e) {
    errors.push(`gmail: ${(e as Error).message}`)
  }

  // Fit — steps. Device-independent, so it works from the phone with no
  // native app and no HealthKit.
  if (on('health')) try {
    const b = await fetch('https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        aggregateBy: [{ dataTypeName: 'com.google.step_count.delta' }],
        bucketByTime: { durationMillis: 86_400_000 },
        startTimeMillis: weekAgo.getTime(),
        endTimeMillis: now.getTime(),
      }),
    }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
    const days = (b.bucket ?? []).map((x: any) => x.dataset?.[0]?.point?.[0]?.value?.[0]?.intVal ?? 0).filter((n: number) => n > 0)
    if (days.length) {
      const avg = Math.round(days.reduce((a: number, c: number) => a + c, 0) / days.length)
      out.push({
        id: `gfit-${iso(now)}`,
        source: 'health',
        at: iso(now),
        text: `Steps over the last ${days.length} days: average ${avg}/day (daily: ${days.join(', ')}).`,
      })
    }
  } catch (e) {
    errors.push(`fit: ${(e as Error).message}`)
  }

  // YouTube — what he has been watching, with timestamps so day and night
  // viewing can be told apart.
  if (on('youtube')) try {
    const b = await gFetch(token, 'https://www.googleapis.com/youtube/v3/activities?part=snippet,contentDetails&mine=true&maxResults=20')
    const items = (b.items ?? []).filter((i: any) => i.snippet?.type === 'upload' || i.contentDetails)
    if (items.length) {
      const titles = items.slice(0, 10).map((i: any) => `"${i.snippet?.title}" (${String(i.snippet?.publishedAt ?? '').slice(11, 16)})`)
      out.push({
        id: `yt-${iso(now)}`,
        source: 'youtube',
        at: iso(now),
        text: `Recent YouTube activity: ${titles.join('; ')}`,
      })
    }
  } catch (e) {
    errors.push(`youtube: ${(e as Error).message}`)
  }

  return { observations: out, errors }
}
