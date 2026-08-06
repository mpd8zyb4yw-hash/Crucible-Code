import { objectId, remember, type RetrievedObject } from './objects.js'
import { DAY, HOUR, retrieved, unavailable, type Provenance } from './provenance.js'

/**
 * YouTube retrieval.
 *
 * This replaces a single call to `activities?mine=true`, which was wrong in a
 * way that reading it would never reveal: that endpoint returns HIS OWN
 * channel's activity — the things he has uploaded and posted — not the things
 * he watches. The pane built on it was answering a question nobody asked, and
 * would have gone on doing so accurately forever.
 *
 * The rule this file is built around: **a video's title and its thumbnail come
 * out of the same object or neither is used.** Every id from any route —
 * subscriptions, likes, a playlist, a search — is funnelled through
 * `hydrate()`, which asks `videos.list` for the authoritative record. Nothing
 * downstream can pair a title with someone else's picture, because nothing
 * downstream ever holds the two separately.
 *
 * What this API can and cannot do, since the difference decides what the app
 * is allowed to claim:
 *
 *   - subscriptions, likes, playlists, uploads, search: all available.
 *   - WATCH HISTORY: not available, at any scope, to anyone. The
 *     `watchHistory` playlist on `channels.list` has returned empty for years.
 *     It exists only in a Google Takeout export, which is why `takeout.ts`
 *     exists and why nothing here may be labelled "most watched".
 */

// ── Quota ────────────────────────────────────────────────────────────────────

/**
 * Published unit costs. A project gets 10,000 units a day by default, so the
 * asymmetry matters more than the absolute number: reading his subscriptions
 * is effectively free and open-ended search is not, and a model that searches
 * speculatively on every turn would exhaust a day in about a hundred turns.
 */
const COST = { list: 1, search: 100 } as const

let unitsSpent = 0
let unitsSince = new Date().toISOString()

/**
 * What we have spent, NOT what Google says remains.
 *
 * Google exposes quota only in the Cloud console; there is no API for it. So
 * this is a ledger of our own calls, and it is labelled `modelled` wherever it
 * surfaces. Reporting it as a reading of Google's counter would be a number
 * with no measurement behind it.
 */
export function quotaLedger(): { unitsSpent: number; since: string; basis: 'modelled' } {
  return { unitsSpent, since: unitsSince, basis: 'modelled' }
}

export function resetQuotaLedger(): void {
  unitsSpent = 0
  unitsSince = new Date().toISOString()
}

const API = 'https://www.googleapis.com/youtube/v3'

/**
 * Its own fetch rather than google.ts's, so this module does not import the
 * connector that imports it. A cycle would resolve here, but only because the
 * one shared function happens to be hoisted, and that is not a property worth
 * depending on for four lines.
 */
async function gFetch(token: string, url: string): Promise<any> {
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`)
  return r.json()
}

async function yt(token: string, path: string, params: Record<string, string>, cost: number): Promise<any> {
  unitsSpent += cost
  const qs = new URLSearchParams(params)
  return gFetch(token, `${API}/${path}?${qs}`)
}

// ── The authoritative record ─────────────────────────────────────────────────

export interface Video {
  videoId: string
  title: string
  channelId?: string
  channel?: string
  /** Highest resolution the API offered. Always an i.ytimg.com URL. */
  thumbnail?: string
  publishedAt?: string
  description?: string
  durationSec?: number
  views?: number
  likes?: number
}

export interface Channel {
  channelId: string
  title: string
  thumbnail?: string
  description?: string
  /** The playlist holding everything this channel has published. */
  uploadsPlaylist?: string
}

/**
 * Pick the largest thumbnail offered.
 *
 * Ordered largest-first rather than taking a fixed key, because the set varies
 * by video: an old upload may have no `maxres` at all, and asking for one by
 * name yields undefined where `medium` was sitting right there.
 */
function bestThumb(thumbs: any): string | undefined {
  for (const k of ['maxres', 'standard', 'high', 'medium', 'default']) {
    const u = thumbs?.[k]?.url
    if (typeof u === 'string' && u) return u
  }
  return undefined
}

/** `PT1H2M10S` → 3730. Returns undefined for live streams, which have none. */
export function parseDuration(iso: unknown): number | undefined {
  if (typeof iso !== 'string') return undefined
  const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso)
  if (!m) return undefined
  const [, d, h, min, s] = m
  const total = (+(d ?? 0) * 86400) + (+(h ?? 0) * 3600) + (+(min ?? 0) * 60) + +(s ?? 0)
  return total || undefined
}

const num = (v: unknown): number | undefined => {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Turn video ids into full records. The single choke point for video data.
 *
 * `videos.list` takes fifty ids per call at one unit each, so hydrating a whole
 * curated pane costs one unit — the expensive part of any of this is finding
 * the ids, never describing them.
 */
export async function hydrate(token: string, videoIds: string[]): Promise<Video[]> {
  const ids = [...new Set(videoIds.filter(Boolean))]
  if (!ids.length) return []

  const out: Video[] = []
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    const b = await yt(token, 'videos', { part: 'snippet,contentDetails,statistics', id: chunk.join(','), maxResults: '50' }, COST.list)
    for (const v of b.items ?? []) {
      const s = v.snippet ?? {}
      if (!v.id || !s.title) continue
      out.push({
        videoId: String(v.id),
        title: String(s.title),
        channelId: s.channelId ? String(s.channelId) : undefined,
        channel: s.channelTitle ? String(s.channelTitle) : undefined,
        thumbnail: bestThumb(s.thumbnails),
        publishedAt: s.publishedAt ? String(s.publishedAt) : undefined,
        description: s.description ? String(s.description).slice(0, 2000) : undefined,
        durationSec: parseDuration(v.contentDetails?.duration),
        views: num(v.statistics?.viewCount),
        likes: num(v.statistics?.likeCount),
      })
    }
  }

  /**
   * Preserve the caller's order.
   *
   * `videos.list` returns whatever order it likes, and the caller's order is
   * meaningful — a search ranked them, or a playlist did. Sorting by the
   * request restores that without the caller having to re-sort by hand.
   */
  const rank = new Map(ids.map((id, i) => [id, i]))
  return out.sort((a, b) => (rank.get(a.videoId) ?? 0) - (rank.get(b.videoId) ?? 0))
}

// ── Routes to ids ────────────────────────────────────────────────────────────

/** Every channel he subscribes to. One unit per fifty. */
export async function subscriptions(token: string, max = 200): Promise<Channel[]> {
  const out: Channel[] = []
  let pageToken: string | undefined
  do {
    const b = await yt(token, 'subscriptions', {
      part: 'snippet',
      mine: 'true',
      maxResults: '50',
      order: 'relevance',
      ...(pageToken ? { pageToken } : {}),
    }, COST.list)
    for (const s of b.items ?? []) {
      const id = s.snippet?.resourceId?.channelId
      if (!id) continue
      out.push({
        channelId: String(id),
        title: String(s.snippet?.title ?? 'Unknown channel'),
        thumbnail: bestThumb(s.snippet?.thumbnails),
        description: s.snippet?.description ? String(s.snippet.description).slice(0, 500) : undefined,
      })
    }
    pageToken = b.nextPageToken
  } while (pageToken && out.length < max)
  return out.slice(0, max)
}

/** Fill in each channel's uploads playlist so its recent videos can be read. */
export async function withUploadPlaylists(token: string, channels: Channel[]): Promise<Channel[]> {
  const byId = new Map(channels.map((c) => [c.channelId, { ...c }]))
  const ids = [...byId.keys()]
  for (let i = 0; i < ids.length; i += 50) {
    const b = await yt(token, 'channels', { part: 'contentDetails', id: ids.slice(i, i + 50).join(','), maxResults: '50' }, COST.list)
    for (const c of b.items ?? []) {
      const target = byId.get(String(c.id))
      const uploads = c.contentDetails?.relatedPlaylists?.uploads
      if (target && uploads) target.uploadsPlaylist = String(uploads)
    }
  }
  return [...byId.values()]
}

/** Ids in a playlist, newest first. One unit per fifty. */
export async function playlistVideoIds(token: string, playlistId: string, max = 10): Promise<string[]> {
  const out: string[] = []
  let pageToken: string | undefined
  do {
    const b = await yt(token, 'playlistItems', {
      part: 'contentDetails',
      playlistId,
      maxResults: String(Math.min(50, max)),
      ...(pageToken ? { pageToken } : {}),
    }, COST.list)
    for (const i of b.items ?? []) {
      const id = i.contentDetails?.videoId
      if (id) out.push(String(id))
    }
    pageToken = b.nextPageToken
  } while (pageToken && out.length < max)
  return out.slice(0, max)
}

/** The playlists YouTube keeps for him. `watchHistory` is always empty. */
export async function myPlaylists(token: string): Promise<{ likes?: string; uploads?: string }> {
  const b = await yt(token, 'channels', { part: 'contentDetails', mine: 'true' }, COST.list)
  const r = b.items?.[0]?.contentDetails?.relatedPlaylists ?? {}
  return { likes: r.likes ? String(r.likes) : undefined, uploads: r.uploads ? String(r.uploads) : undefined }
}

export async function likedVideos(token: string, max = 25): Promise<Video[]> {
  const { likes } = await myPlaylists(token)
  if (!likes) return []
  return hydrate(token, await playlistVideoIds(token, likes, max))
}

/** Recent uploads across the channels he follows, newest first. */
export async function fromSubscriptions(
  token: string,
  opts: { channels?: Channel[]; perChannel?: number; maxChannels?: number; limit?: number } = {}
): Promise<{ videos: Video[]; channels: Channel[] }> {
  const subs = opts.channels ?? (await subscriptions(token, opts.maxChannels ?? 50))
  const withPlaylists = await withUploadPlaylists(token, subs.slice(0, opts.maxChannels ?? 50))

  const ids: string[] = []
  for (const c of withPlaylists) {
    if (!c.uploadsPlaylist) continue
    ids.push(...(await playlistVideoIds(token, c.uploadsPlaylist, opts.perChannel ?? 3)))
  }

  const videos = await hydrate(token, ids)
  videos.sort((a, b) => Date.parse(b.publishedAt ?? '') - Date.parse(a.publishedAt ?? ''))
  return { videos: videos.slice(0, opts.limit ?? 40), channels: withPlaylists }
}

/**
 * Open search across YouTube, not only his subscriptions.
 *
 * A hundred units a call, so the caller decides when it is worth one. Results
 * are hydrated like everything else, which also upgrades search's own thin
 * snippet into a full record with duration and view count.
 */
export async function search(
  token: string,
  q: string,
  opts: { limit?: number; channelId?: string; order?: 'relevance' | 'date' | 'viewCount'; publishedAfter?: string } = {}
): Promise<Video[]> {
  const b = await yt(token, 'search', {
    part: 'id',
    type: 'video',
    q,
    maxResults: String(Math.min(50, opts.limit ?? 10)),
    order: opts.order ?? 'relevance',
    ...(opts.channelId ? { channelId: opts.channelId } : {}),
    ...(opts.publishedAfter ? { publishedAfter: opts.publishedAfter } : {}),
  }, COST.search)

  const ids = (b.items ?? []).flatMap((i: any) => (i.id?.videoId ? [String(i.id.videoId)] : []))
  return hydrate(token, ids)
}

/**
 * Watch history, which cannot be answered.
 *
 * Returned as a value rather than thrown so a caller can render the reason —
 * "YouTube does not expose this; import a Takeout export" — instead of a
 * missing pane or, worse, quietly falling back to something adjacent and
 * calling it history.
 */
export function watchHistoryUnavailable(): Provenance {
  return unavailable(
    'youtube',
    'YouTube’s API has never exposed watch history. Import a Google Takeout export to use it.'
  )
}

// ── Into objects ─────────────────────────────────────────────────────────────

/**
 * A title stays true for years; a view count is stale within the day. Ranking
 * on a number this old is fine, printing it as current is not, so the staleness
 * window is set by the fastest-moving field on the record.
 */
const VIDEO_STALE_AFTER = 12 * HOUR
const CHANNEL_STALE_AFTER = 7 * DAY

export function videoObject(v: Video, via: string, prov?: Provenance): RetrievedObject {
  const mins = v.durationSec ? Math.round(v.durationSec / 60) : undefined
  return {
    id: objectId('youtube', 'video', v.videoId),
    source: 'youtube',
    kind: 'video',
    nativeId: v.videoId,
    title: v.title,
    sub: v.channel,
    body: v.description,
    // Straight off the record that carried the title. These two fields are
    // never assembled from different places, which is the entire fix.
    image: v.thumbnail,
    at: v.publishedAt,
    fields: {
      channelId: v.channelId ?? null,
      durationSec: v.durationSec ?? null,
      durationLabel: mins ? `${mins} min` : null,
      views: v.views ?? null,
      likes: v.likes ?? null,
      url: `https://www.youtube.com/watch?v=${v.videoId}`,
    },
    prov: prov ?? retrieved('youtube', via, VIDEO_STALE_AFTER),
  }
}

export function channelObject(c: Channel, via: string): RetrievedObject {
  return {
    id: objectId('youtube', 'channel', c.channelId),
    source: 'youtube',
    kind: 'channel',
    nativeId: c.channelId,
    title: c.title,
    body: c.description,
    image: c.thumbnail,
    fields: { uploadsPlaylist: c.uploadsPlaylist ?? null, url: `https://www.youtube.com/channel/${c.channelId}` },
    prov: retrieved('youtube', via, CHANNEL_STALE_AFTER),
  }
}

/** Store what was fetched, so widgets can cite it and panes can outlive it. */
export async function rememberVideos(videos: Video[], via: string): Promise<RetrievedObject[]> {
  const objs = videos.map((v) => videoObject(v, via))
  await remember(objs)
  return objs
}

export async function rememberChannels(channels: Channel[], via: string): Promise<RetrievedObject[]> {
  const objs = channels.map((c) => channelObject(c, via))
  await remember(objs)
  return objs
}
