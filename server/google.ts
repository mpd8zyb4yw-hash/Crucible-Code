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
  /**
   * Read-write, deliberately.
   *
   * These were both `.readonly`, which made Crucible a mail room: it could sort
   * and summarise, and every actual action — reply, archive, RSVP — had to
   * happen in Google's app. The point of the widget layer is that it does not.
   *
   * `gmail.modify` covers archive, mark-read and labels but NOT sending, which
   * Google scopes separately; `gmail.send` is what makes a reply possible.
   * Nothing sends by itself — a message leaves only when he taps Send on a
   * composer he is looking at, and the endpoint has no path that sends without
   * one. Broadening these requires re-consenting once on localhost and once on
   * crucible.cam, since the grants are per-origin.
   */
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
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
 * The human part of a From header. `"Anna Rossi" <anna@x.it>` → `Anna Rossi`,
 * and a bare address falls back to the part before the @, so a mail row always
 * has something readable to lead with rather than a raw header.
 */
function displayName(from: string): string | undefined {
  const quoted = /^\s*"?([^"<]+?)"?\s*</.exec(from)
  if (quoted?.[1]?.trim()) return quoted[1].trim()
  const bare = /([^@<\s]+)@/.exec(from)
  return bare?.[1]
}

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
      const me = (e.attendees ?? []).find((a: any) => a.self)
      out.push({
        id: `gcal-${e.id}`.slice(0, 60),
        source: 'calendar',
        at: String(start).slice(0, 10),
        text: `${e.summary ?? 'Untitled'} — ${when}${e.location ? `, at ${e.location}` : ''}${e.attendees?.length ? `, with ${e.attendees.map((a: any) => a.displayName ?? a.email).slice(0, 4).join(', ')}` : ''}`,
        // The same event as fields, so the agenda can render a real event
        // rather than parsing the sentence above back apart.
        data: {
          kind: 'event',
          eventId: String(e.id),
          summary: String(e.summary ?? 'Untitled'),
          start: String(e.start?.dateTime ?? e.start?.date),
          end: e.end?.dateTime ?? e.end?.date,
          allDay: !e.start?.dateTime,
          location: e.location ? String(e.location) : undefined,
          description: e.description ? String(e.description).slice(0, 2000) : undefined,
          attendees: (e.attendees ?? []).slice(0, 20).map((a: any) => ({
            email: String(a.email ?? ''),
            name: a.displayName ? String(a.displayName) : undefined,
            response: a.responseStatus ? String(a.responseStatus) : undefined,
          })),
          response: me?.responseStatus ? String(me.responseStatus) : undefined,
          organizer: e.organizer?.email ? String(e.organizer.email) : undefined,
        },
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
      const msg = await gFetch(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`)
      const h = Object.fromEntries((msg.payload?.headers ?? []).map((x: any) => [x.name, x.value]))
      const from = String(h.From ?? 'unknown')
      out.push({
        id: `gmail-${m.id}`.slice(0, 60),
        source: 'email',
        at: h.Date ? iso(new Date(h.Date)) : iso(now),
        text: `Email from ${from} — "${h.Subject ?? '(no subject)'}"${msg.snippet ? `: ${String(msg.snippet).slice(0, 180)}` : ''}`,
        // Keeping the ids is what makes a message actionable later: without
        // messageId and threadId there is no way to open, reply to, archive or
        // mark anything, however good the summary sentence is.
        data: {
          kind: 'email',
          messageId: String(m.id),
          threadId: msg.threadId ? String(msg.threadId) : undefined,
          from,
          fromName: displayName(from),
          to: h.To ? String(h.To) : undefined,
          subject: String(h.Subject ?? '(no subject)'),
          snippet: msg.snippet ? String(msg.snippet).slice(0, 400) : undefined,
          unread: Array.isArray(msg.labelIds) && msg.labelIds.includes('UNREAD'),
          labels: Array.isArray(msg.labelIds) ? msg.labelIds.slice(0, 12).map(String) : undefined,
        },
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
    // Keep which day each count belongs to. The old version mapped straight to
    // a bare array of numbers, so "6,100 average" could be stated but no chart
    // could ever be drawn — a bar needs to know which day it stands on.
    const buckets: { date: string; steps: number }[] = (b.bucket ?? [])
      .map((x: any) => ({
        date: iso(new Date(Number(x.startTimeMillis))),
        steps: Number(x.dataset?.[0]?.point?.[0]?.value?.[0]?.intVal ?? 0),
      }))
      .filter((d: { date: string; steps: number }) => d.steps > 0)

    if (buckets.length) {
      const avg = Math.round(buckets.reduce((a, c) => a + c.steps, 0) / buckets.length)
      out.push({
        id: `gfit-${iso(now)}`,
        source: 'health',
        at: iso(now),
        text: `Steps over the last ${buckets.length} days: average ${avg}/day (daily: ${buckets.map((d) => d.steps).join(', ')}).`,
        data: { kind: 'steps', days: buckets, average: avg },
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

    /**
     * One observation per video, not one per sync.
     *
     * This used to concatenate ten titles into a single sentence. That is fine
     * for the model, which reads prose anyway, and useless for everything else:
     * a thumbnail grid needs ten items with ten ids and ten image URLs, and
     * none of that can be recovered from a semicolon-separated string. The
     * summary line is still produced, as its own observation, so the brain sees
     * exactly what it saw before.
     */
    for (const i of items.slice(0, 12)) {
      const videoId = i.contentDetails?.upload?.videoId ?? i.contentDetails?.playlistItem?.resourceId?.videoId
      const s = i.snippet ?? {}
      if (!videoId || !s.title) continue
      const thumb = s.thumbnails?.medium?.url ?? s.thumbnails?.default?.url
      out.push({
        id: `yt-v-${videoId}`.slice(0, 60),
        source: 'youtube',
        at: s.publishedAt ? iso(new Date(s.publishedAt)) : iso(now),
        text: `YouTube: "${s.title}"${s.channelTitle ? ` from ${s.channelTitle}` : ''}`,
        data: {
          kind: 'video',
          videoId: String(videoId),
          title: String(s.title),
          channel: s.channelTitle ? String(s.channelTitle) : undefined,
          thumbnail: thumb ? String(thumb) : undefined,
          publishedAt: s.publishedAt ? String(s.publishedAt) : undefined,
          description: s.description ? String(s.description).slice(0, 1000) : undefined,
        },
      })
    }
  } catch (e) {
    errors.push(`youtube: ${(e as Error).message}`)
  }

  return { observations: out, errors }
}

// ── Acting, not just reading ─────────────────────────────────────────────────

/**
 * A write against a Google API, with the same token handling as every read.
 *
 * Separate from `gFetch` only because it needs a method and a body; it shares
 * the refresh-on-expiry path, so an action taken an hour after the last sync
 * does not fail on a stale token.
 */
async function gWrite(token: string, url: string, method: 'POST' | 'PUT' | 'PATCH', body: unknown): Promise<any> {
  const r = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    /**
     * The most likely failure here is a token minted before the scopes were
     * broadened. Google reports that as a flat 403 with no hint that
     * re-consenting is the fix, which would read as "archiving is broken".
     */
    if (r.status === 403 || r.status === 401) {
      throw new Error('Google refused that — reconnect your account so Crucible can act on mail and calendar, not just read them.')
    }
    throw new Error(`Google: ${r.status} ${text.slice(0, 200)}`)
  }
  return r.status === 204 ? {} : r.json().catch(() => ({}))
}

/** Add or remove Gmail labels. Archiving is removing INBOX; there is no delete here. */
export async function gmailModify(
  token: string,
  messageId: string,
  change: { addLabelIds?: string[]; removeLabelIds?: string[] }
): Promise<void> {
  if (!messageId) throw new Error('No message given.')
  await gWrite(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/modify`, 'POST', change)
}

/** Answer an invitation without opening Google Calendar. */
export async function calendarRsvp(token: string, eventId: string, response: string): Promise<void> {
  if (!eventId) throw new Error('No event given.')
  const allowed = new Set(['accepted', 'declined', 'tentative'])
  if (!allowed.has(response)) throw new Error(`"${response}" is not an answer I can send.`)

  // Only OUR attendee row may be touched. Patching the attendee list wholesale
  // would let a malformed action rewrite everyone else's response, so the
  // current list is read first and exactly one entry is changed.
  const ev = await gFetch(token, `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`)
  const attendees = (ev.attendees ?? []).map((a: any) => (a.self ? { ...a, responseStatus: response } : a))
  if (!attendees.some((a: any) => a.self)) throw new Error('You are not on the invitation for that event.')
  await gWrite(
    token,
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
    'PATCH',
    { attendees }
  )
}

/**
 * Send a reply, from inside Crucible.
 *
 * Gmail wants a whole RFC 5322 message, base64url encoded. Threading is the
 * fiddly part and the part that matters: without In-Reply-To and References,
 * and a subject that keeps its "Re:", the reply arrives as a brand-new
 * conversation and the person on the other end has no idea what it answers.
 * So the original's Message-ID header is read first and quoted back.
 *
 * There is no path to this function that does not begin with him typing a
 * message and confirming it. Nothing in the app calls it on its own.
 */
export async function gmailReply(
  token: string,
  messageId: string,
  body: string
): Promise<void> {
  if (!messageId) throw new Error('No message to reply to.')
  if (!body.trim()) throw new Error('Nothing to send.')

  const orig = await gFetch(
    token,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Message-ID&metadataHeaders=References`
  )
  const h = Object.fromEntries((orig.payload?.headers ?? []).map((x: any) => [String(x.name).toLowerCase(), x.value]))
  const to = String(h.from ?? '')
  if (!to) throw new Error('I could not tell who that message was from.')

  const subject = String(h.subject ?? '')
  const re = /^re:/i.test(subject) ? subject : `Re: ${subject}`
  const parentId = String(h['message-id'] ?? '')
  const references = [String(h.references ?? ''), parentId].filter(Boolean).join(' ')

  // Non-ASCII subjects must be encoded or Gmail mangles them — "Domenica al
  // mercato?" is fine, but an accented Italian subject is not, and this app is
  // used in Italy.
  const encodedSubject = /^[\x20-\x7E]*$/.test(re)
    ? re
    : `=?UTF-8?B?${Buffer.from(re, 'utf8').toString('base64')}?=`

  const mime = [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    ...(parentId ? [`In-Reply-To: ${parentId}`] : []),
    ...(references ? [`References: ${references}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    body,
  ].join('\r\n')

  const raw = Buffer.from(mime, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  await gWrite(token, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', 'POST', {
    raw,
    threadId: orig.threadId,
  })
}

/** Put something on the calendar without leaving the app. */
export async function calendarCreate(
  token: string,
  event: { summary: string; start: string; end?: string; location?: string; description?: string }
): Promise<{ id: string }> {
  if (!event.summary?.trim()) throw new Error('An event needs a name.')
  if (!event.start) throw new Error('An event needs a time.')

  // All-day when given a bare date, timed when given a datetime — Google needs
  // different fields for the two and rejects the wrong one.
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(event.start)
  const startAt = allDay ? { date: event.start } : { dateTime: new Date(event.start).toISOString() }
  const endAt = event.end
    ? (allDay ? { date: event.end } : { dateTime: new Date(event.end).toISOString() })
    : allDay
      ? { date: event.start }
      : { dateTime: new Date(new Date(event.start).getTime() + 3_600_000).toISOString() }

  const made = await gWrite(token, 'https://www.googleapis.com/calendar/v3/calendars/primary/events', 'POST', {
    summary: event.summary.slice(0, 300),
    location: event.location?.slice(0, 300),
    description: event.description?.slice(0, 2000),
    start: startAt,
    end: endAt,
  })
  return { id: String(made.id ?? '') }
}
