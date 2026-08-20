import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dayIn, type Coverage, type Observation } from './world.js'
import { cleanSnippet } from './widgets.js'
import { fromSubscriptions, rememberChannels, rememberVideos } from './youtube.js'

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

/**
 * The UTC offset a zone is actually at on a given day, as "+02:00".
 *
 * Computed from the zone rather than assumed, because Rome is +01:00 in
 * February and +02:00 in August and a hardcoded either would be wrong for half
 * the year — silently, by an hour, at exactly the boundary that decides which
 * day a step belongs to.
 */
export function offsetOf(day: string, zone?: string): string {
  if (!zone) return 'Z'
  try {
    const at = new Date(`${day}T12:00:00Z`)
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value ?? ''
    const m = /GMT([+-]\d{2}:\d{2})/.exec(parts)
    return m ? m[1]! : 'Z'
  } catch {
    return 'Z'
  }
}

/**
 * WHERE A STEP WINDOW MUST BEGIN: local midnight, seven days back.
 *
 * Exported so `scripts/activity.mjs` can assert the property rather than trust
 * the comment, because the defect it prevents is invisible from every screen.
 *
 * Google's `period` bucketing anchors its buckets to the START OF THE RANGE, not
 * to true local midnight. Asking from `now - 7d` — an instant, mid-morning —
 * therefore produced seven 24-hour windows each beginning at whatever time of
 * day the sync happened to run, every one of them LABELLED with a calendar date
 * it only partly covered.
 *
 * Measured against his live account at 09:25 on 2026-08-12, the two windows
 * disagreed about completed days by a factor of three:
 *
 *              old (09:25 anchor)   aligned to midnight
 *   2026-08-09         12,972                6,307
 *   2026-08-10          3,795               10,356
 *   2026-08-12        (absent)                  16
 *
 * Neither figure was an error and nothing logged: the app has been storing
 * "the 24 hours after the sync fired" under the name of a day, which is also
 * why two syncs on the same afternoon disagreed about yesterday. The aligned
 * window additionally returns TODAY, which the old one silently dropped —
 * that is the "today hasn't synced yet" in the screenshots.
 */
export function fitWindowStart(now: Date, zone?: string): number | null {
  if (!zone) return null
  const day = dayIn(new Date(now.getTime() - 6 * 86_400_000), zone)
  // Parsed as a wall-clock time in HIS zone, via the offset that zone is
  // actually at on that date. `Date.parse('YYYY-MM-DDT00:00:00')` would use the
  // RUNTIME's zone, which on the Worker is UTC — the whole class of bug
  // clock.ts exists to prevent.
  return Date.parse(`${day}T00:00:00${offsetOf(day, zone)}`)
}

/**
 * FIT'S AGGREGATE RESPONSE → ONE NUMBER PER CALENDAR DAY, IN HIS ZONE.
 *
 * Pulled out of the sync so it can be RUN ON A CAPTURED PAYLOAD, which is the
 * whole of §40's first stage: the raw bytes, the parse, the day labelling and
 * the total have to be checkable without a live account and without a
 * screenshot. `scripts/activity.mjs` traces fixtures through this function, then
 * through `activityReport`, and asserts the number the surface would draw.
 *
 * Every rule this enforces was once a defect that showed up only as a figure
 * being too low — see the long note at the call site. Summing every point of
 * every dataset, honouring `fpVal` as well as `intVal`, keeping real zeros, and
 * labelling a bucket by the day it STARTS in his zone rather than in UTC.
 */
export function stepsFromAggregate(body: unknown, zone?: string): { date: string; steps: number }[] {
  const buckets = ((body as { bucket?: unknown[] } | null)?.bucket ?? []) as any[]
  return buckets.map((x) => {
    let steps = 0
    for (const ds of x.dataset ?? []) {
      for (const pt of ds.point ?? []) {
        for (const v of pt.value ?? []) {
          // Both representations, because a derived stream can report either
          // and reading one of them is how a day silently comes back as 0.
          if (typeof v?.intVal === 'number') steps += v.intVal
          else if (typeof v?.fpVal === 'number') steps += Math.round(v.fpVal)
        }
      }
    }
    /**
     * The label is the day the bucket STARTS in his zone. With `period`
     * bucketing Google has already aligned the boundary; taking the UTC date of
     * the start instant would put a Rome day beginning at 00:00 local onto the
     * previous UTC date for the two hours that matter.
     */
    return { date: dayIn(new Date(Number(x.startTimeMillis)), zone), steps }
  })
}

export async function pullObservations(
  token: string,
  /** Which sources he has left switched on. Absent means all of them. */
  enabled?: Partial<Record<GoogleSource, boolean>>,
  /**
   * The zone his days begin in, when it is already known.
   *
   * Only the activity call uses it, and it is not optional in spirit: without
   * it, Fit is asked for buckets of exactly 86,400,000 ms anchored to the
   * instant of the sync, which is not a day. See the Fit block below.
   */
  zone?: string
): Promise<{ observations: Observation[]; errors: string[]; timeZone?: string; coverage: Coverage[]; synced: GoogleSource[] }> {
  const out: Observation[] = []
  const errors: string[] = []
  /**
   * WHICH SOURCES CAME BACK WITHOUT THROWING.
   *
   * Not derivable from `errors`, which is a list of prose, and not derivable
   * from `out` either — a successful read of an empty mailbox produces no
   * observations and is still a successful read. `sync.ts` stamps exactly these,
   * so a source that failed stays overdue and is retried on the next tick
   * instead of going quiet for its whole cadence.
   */
  const synced: GoogleSource[] = []
  /**
   * WHAT THIS SYNC IS COMPLETE FOR — see `Coverage` in `world.ts`.
   *
   * Populated only inside a successful, untruncated fetch. Everything about the
   * three rules stated there is enforced at the two push sites below rather than
   * by the fold, because the fold cannot know what was asked for.
   */
  const coverage: Coverage[] = []
  /**
   * His zone, which Google already knows and this call already returns.
   *
   * Free — it is a top-level field on the events response below, and it was
   * being parsed past and dropped. Everything that decides what day something
   * happens on needs it; see `World.timeZone` for what its absence cost.
   */
  let timeZone: string | undefined
  // One signing-in step, then he decides source by source what it may read.
  const on = (s: GoogleSource) => enabled?.[s] !== false
  const now = new Date()
  const weekAhead = new Date(now.getTime() + 7 * 86_400_000)
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000)

  // Calendar — the next week, which is where conflicts and commitments live.
  if (on('calendar')) try {
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now.toISOString()}&timeMax=${weekAhead.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=50`
    const b = await gFetch(token, url)
    if (typeof b.timeZone === 'string' && b.timeZone) timeZone = b.timeZone
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
    /*
      GOOGLE'S REPLY IS THE COMPLETE TRUTH FOR THE WINDOW IT WAS ASKED ABOUT.

      `singleEvents=true` expands recurrences and OMITS cancelled instances, and
      a deleted event is simply absent — so "in the window and not in the reply"
      is exactly "no longer on his calendar". Without this, the only way an event
      could ever leave the world document was for the document to be deleted.

      The membership test restates Google's own selection criterion (ends after
      timeMin, starts before timeMax) so the two cannot drift: anything the query
      WOULD have returned is covered, and anything it would not have returned —
      this morning's finished meeting, last week's dinner — is untouched, which is
      what keeps depth's history intact while Home stops being an archive.

      NOT declared when the page came back full: `maxResults=50` means there may
      be a second page, and retiring against a truncated reply would delete real
      events. A rare, silently-wrong deletion is worse than a rare stale row.
    */
    if ((b.items ?? []).length < 50) {
      const instant = (v: string): number =>
        /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : Date.parse(v)
      coverage.push({
        source: 'calendar',
        covers: (o) => {
          const d = o.data
          if (d?.kind !== 'event') return false
          const s = instant(String(d.start ?? ''))
          const e = instant(String(d.end ?? d.start ?? ''))
          if (!Number.isFinite(s) || !Number.isFinite(e)) return false
          return e > now.getTime() && s < weekAhead.getTime()
        },
      })
    }
    /* Reached only if nothing above threw: this source is now current. */
    synced.push('calendar')
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
        text: `Email from ${from} — "${h.Subject ?? '(no subject)'}"${msg.snippet ? `: ${cleanSnippet(String(msg.snippet)).slice(0, 180)}` : ''}`,
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
          snippet: msg.snippet ? cleanSnippet(String(msg.snippet)).slice(0, 400) || undefined : undefined,
          unread: Array.isArray(msg.labelIds) && msg.labelIds.includes('UNREAD'),
          labels: Array.isArray(msg.labelIds) ? msg.labelIds.slice(0, 12).map(String) : undefined,
        },
      })
    }
    /* Reached only if nothing above threw: this source is now current. */
    synced.push('email')
  } catch (e) {
    errors.push(`gmail: ${(e as Error).message}`)
  }

  /**
   * Fit — steps.
   *
   * THREE THINGS HERE WERE WRONG IN WAYS THAT ONLY SHOW UP AS A NUMBER BEING
   * TOO LOW, which is the hardest kind of bug to see: nothing errors, a chart
   * draws, and the figure is simply not his.
   *
   * 1. A DAY IS NOT 86,400,000 MILLISECONDS FROM WHENEVER THE SYNC RAN. The
   *    old call bucketed by a raw duration anchored at `now - 7d`, so each
   *    "day" was a rolling 24-hour window starting at the time of day the sync
   *    happened to fire, and each bucket was then LABELLED with the UTC date of
   *    its start. Two syncs at different hours produced different numbers for
   *    the same calendar day, and the label could be a day out. Fit's own
   *    `period` bucketing with a `timeZoneId` is the fix: Google aligns the
   *    buckets to midnight in his zone and the label means what it says.
   *
   * 2. ONLY THE FIRST POINT OF THE FIRST DATASET WAS READ. Fit returns a
   *    dataset per aggregation and a point per contiguous run; a day with more
   *    than one run silently reported only the first of them, and a float value
   *    reported nothing at all because only `intVal` was honoured. Both are
   *    undercounts with no error. Everything in the bucket is now summed.
   *
   * 3. `.filter(d => d.steps > 0)` DELETED REAL ZEROS. A day Fit reported as
   *    zero and a day Fit never delivered became the same absence, so the
   *    surface could not tell "you did not walk" from "the connector is not
   *    reporting" — and it guessed, printing a banner asserting "not zero"
   *    about days that genuinely were. Zeros are kept; a day that is absent
   *    from the response is absent from the series, and the two are now
   *    different things downstream.
   *
   * WHAT THIS STILL CANNOT DO, and no amount of care here will: if a step is
   * not inside Google Fit, this cannot see it. There is no HealthKit bridge in
   * a web app. An iPhone whose steps live in Apple Health and are not mirrored
   * into Fit will report far fewer steps than the phone shows, and that is a
   * property of the account, not of this code.
   */
  if (on('health')) try {
    /**
     * 4. THE OLDEST DAY OF EVERY SYNC WAS A PARTIAL DAY REPORTED AS A WHOLE ONE.
     *
     * `startTimeMillis: now - 7d` is an INSTANT, not a midnight. Bucketing by
     * period aligns the buckets that follow it, but the first bucket still
     * begins where the range does — so a sync at 09:25 asked for that day from
     * 09:25 onward and labelled the result with the whole date. Every sync
     * therefore wrote one day whose total was missing its own morning, and
     * because a later sync writes a DIFFERENT partial for a different day, the
     * stored series disagreed with itself between runs.
     *
     * Measured against his live account on 2026-08-12, three syncs reported
     * 2026-08-08 as 8, 6,307 and 12 — the same completed day, three answers.
     * The window is aligned to local midnight now, so no completed day is ever
     * asked for in part.
     */
    const from = fitWindowStart(now, zone) ?? weekAgo.getTime()

    const body: Record<string, unknown> = {
      aggregateBy: [{ dataTypeName: 'com.google.step_count.delta' }],
      startTimeMillis: from,
      endTimeMillis: now.getTime(),
    }
    body.bucketByTime = zone
      ? { period: { type: 'day', value: 1, timeZoneId: zone } }
      : { durationMillis: 86_400_000 }

    const b = await fetch('https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => (r.ok ? (r.json() as Promise<any>) : Promise.reject(new Error(`${r.status}`))))

    const days = stepsFromAggregate(b, zone)

    if (days.length) {
      const total = days.reduce((a, c) => a + c.steps, 0)
      /**
       * The average is over the days ACTUALLY RETURNED, and the sentence says
       * how many those are. The old one divided by the count of non-zero days,
       * which reads high and whose denominator moved silently as days dropped
       * in and out of the filter.
       */
      const avg = Math.round(total / days.length)
      const reported = days.filter((d) => d.steps > 0).length
      out.push({
        id: `gfit-${dayIn(now, zone)}`,
        source: 'health',
        at: now.toISOString(),
        text:
          `Steps over ${days.length} day(s) to ${days[days.length - 1]!.date}: average ${avg}/day ` +
          `across all days (${reported} of ${days.length} days had any activity recorded). ` +
          `Daily: ${days.map((d) => `${d.date} ${d.steps}`).join(', ')}. ` +
          `Source: Google Fit only — steps not written into Fit are not counted here.`,
        data: { kind: 'steps', days, average: avg },
      })
    }
    /* Reached only if nothing above threw: this source is now current. */
    synced.push('health')
  } catch (e) {
    errors.push(`fit: ${(e as Error).message}`)
  }

  /**
   * YouTube — what the channels he follows have just put out.
   *
   * This used to call `activities?mine=true`, which returns HIS OWN channel's
   * activity: his uploads, his posts. Not one thing he watches. The pane was
   * answering a question nobody had asked, correctly, and nothing about the
   * code said so.
   *
   * What it reads now is his subscriptions, and every video is hydrated through
   * `videos.list`, so the title, the channel and the thumbnail all come off one
   * record and cannot be paired wrongly. Watch history is deliberately absent:
   * the API does not have it, and `takeout.ts` is the only honest route to it.
   */
  if (on('youtube')) try {
    const { videos, channels } = await fromSubscriptions(token, { maxChannels: 20, perChannel: 2, limit: 12 })
    await rememberChannels(channels, 'subscriptions')
    const objs = await rememberVideos(videos, 'subscriptions')

    for (const [i, v] of videos.entries()) {
      const mins = v.durationSec ? `, ${Math.round(v.durationSec / 60)} min` : ''
      out.push({
        id: `yt-v-${v.videoId}`.slice(0, 60),
        source: 'youtube',
        at: v.publishedAt ? iso(new Date(v.publishedAt)) : iso(now),
        /**
         * The object id is in the sentence on purpose. It is the only way the
         * model learns a ref it is allowed to cite — everything it can put a
         * picture on has to have been read out of a real observation first.
         */
        text: `YouTube: "${v.title}"${v.channel ? ` from ${v.channel}` : ''}${mins} — posted by a channel he subscribes to [${objs[i]?.id}]`,
        data: {
          kind: 'video',
          videoId: v.videoId,
          title: v.title,
          channel: v.channel,
          thumbnail: v.thumbnail,
          publishedAt: v.publishedAt,
          durationSec: v.durationSec,
          description: v.description ? v.description.slice(0, 1000) : undefined,
        },
      })
    }
    /* Reached only if nothing above threw: this source is now current. */
    synced.push('youtube')
  } catch (e) {
    errors.push(`youtube: ${(e as Error).message}`)
  }

  return { observations: out, errors, timeZone, coverage, synced }
}

// ── Acting, not just reading ─────────────────────────────────────────────────

/**
 * A write against a Google API, with the same token handling as every read.
 *
 * Separate from `gFetch` only because it needs a method and a body; it shares
 * the refresh-on-expiry path, so an action taken an hour after the last sync
 * does not fail on a stale token.
 */
async function gWrite(
  token: string,
  url: string,
  // DELETE is here for `gmailDeleteDraft`, which is the undo half of drafting a
  // message. A verb that can only create is a verb with no inverse, and this
  // codebase's action table refuses those.
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body: unknown
): Promise<any> {
  const r = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
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

/**
 * PUT A MESSAGE IN HIS DRAFTS. NOT IN ANYONE'S INBOX.
 *
 * The distinction this function exists for. `gmailReply` above sends, is marked
 * irreversible, and cannot be reached without him confirming; this writes to
 * `users/me/drafts`, which is a folder in his own account. Nothing leaves it
 * without him opening it, reading it and pressing send in Gmail.
 *
 * That is the only honest way for this app to help with a message to a third
 * party. A draft is fully reversible — deleting it restores the world exactly —
 * so it can be offered from a card without a confirmation dialog, and the card
 * can say plainly what it did.
 *
 * `gmail.modify` covers drafts, so this needs no scope the app does not already
 * hold. Returns the draft id so the action can describe its own undo.
 */
export async function gmailDraft(
  token: string,
  msg: { to: string; subject: string; body: string }
): Promise<{ id: string }> {
  if (!msg.to.trim()) throw new Error('A draft needs someone to be addressed to.')
  if (!msg.body.trim()) throw new Error('There is nothing to draft.')

  // Same encoding rule as a reply: a non-ASCII subject must be encoded or Gmail
  // mangles it, and this app is used in Italy.
  const encodedSubject = /^[\x20-\x7E]*$/.test(msg.subject)
    ? msg.subject
    : `=?UTF-8?B?${Buffer.from(msg.subject, 'utf8').toString('base64')}?=`

  const mime = [
    `To: ${msg.to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    msg.body,
  ].join('\r\n')

  const raw = Buffer.from(mime, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const out = await gWrite(token, 'https://gmail.googleapis.com/gmail/v1/users/me/drafts', 'POST', {
    message: { raw },
  })
  return { id: String(out?.id ?? '') }
}

/** Remove a draft this app created. The exact inverse of `gmailDraft`. */
export async function gmailDeleteDraft(token: string, draftId: string): Promise<void> {
  if (!draftId) throw new Error('No draft to remove.')
  await gWrite(token, `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}`, 'DELETE', undefined)
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

/**
 * REMOVE AN EVENT. THE EXACT INVERSE OF `calendarCreate`.
 *
 * What makes `calendar.create` honestly reversible rather than reversible by
 * assertion. Without this the create action returned no undo at all, so the
 * action log recorded "ok" with nothing to take back — a claim of reversibility
 * that nothing could act on.
 *
 * Only ever called with an id this app minted, from the undo record written at
 * creation. It is not a general "delete anything" verb and is deliberately not
 * in the model-safe grammar.
 */
export async function calendarDelete(token: string, eventId: string): Promise<void> {
  if (!eventId) throw new Error('No event given.')
  await gWrite(
    token,
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
    'DELETE',
    undefined
  )
}

/**
 * CHANGE AN EVENT THAT ALREADY EXISTS.
 *
 * The gap this fills was not subtle. He told the assistant that "Comic concert
 * in avano" was the wrong name and asked for it to be "Cinzia's"; the reply was
 * "Pulling your calendar from Google now to rename the event", followed by
 * "Pulled 3 new things from Google just now", and the event kept its name. The
 * app could CREATE an event and it could RSVP to one, and those were the only
 * two things it could do to a calendar — so the only move available to a model
 * asked to rename something was to refresh and describe the result. It read as
 * the assistant lying about what it had done, which is worse than refusing.
 *
 * Only the fields actually named are sent. A PATCH with an undefined `summary`
 * would erase the name, and "rename this" must not be able to silently drop the
 * location, the guests or the description as a side effect.
 *
 * The previous values come back with the result so the caller can register a
 * real undo — every write in this app is reversible except sending mail, and a
 * rename is not the place to start making exceptions.
 */
export async function calendarUpdate(
  token: string,
  eventId: string,
  change: { summary?: string; start?: string; end?: string; location?: string; description?: string }
): Promise<{ before: { summary?: string; start?: string; end?: string; location?: string; description?: string } }> {
  if (!eventId) throw new Error('No event given.')

  const named = Object.entries(change).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
  if (!named.length) throw new Error('Nothing to change.')

  const ev = await gFetch(token, `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`)

  const body: Record<string, unknown> = {}
  if (change.summary !== undefined) body.summary = String(change.summary).slice(0, 300)
  if (change.location !== undefined) body.location = String(change.location).slice(0, 300)
  if (change.description !== undefined) body.description = String(change.description).slice(0, 2000)

  // A time change has to keep the event's own shape: an all-day event uses
  // `date` and a timed one uses `dateTime`, and Google rejects the wrong field
  // rather than converting. The existing event decides which it is.
  const wasAllDay = !!ev.start?.date
  const asWhen = (v: string) => {
    const bare = /^\d{4}-\d{2}-\d{2}$/.test(v)
    return bare || wasAllDay
      ? { date: bare ? v : new Date(v).toISOString().slice(0, 10) }
      : { dateTime: new Date(v).toISOString() }
  }
  if (change.start) body.start = asWhen(change.start)
  if (change.end) body.end = asWhen(change.end)
  // Moving the start without an end would leave Google with end <= start, which
  // it refuses. The original duration is preserved instead.
  if (change.start && !change.end && ev.start?.dateTime && ev.end?.dateTime) {
    const span = Date.parse(ev.end.dateTime) - Date.parse(ev.start.dateTime)
    body.end = { dateTime: new Date(Date.parse(new Date(change.start).toISOString()) + span).toISOString() }
  }

  await gWrite(
    token,
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
    'PATCH',
    body,
  )

  return {
    before: {
      summary: ev.summary,
      location: ev.location,
      description: ev.description,
      start: ev.start?.dateTime ?? ev.start?.date,
      end: ev.end?.dateTime ?? ev.end?.date,
    },
  }
}
