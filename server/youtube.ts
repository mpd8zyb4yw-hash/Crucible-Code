import { objectId, remember, type ObjectDraft } from './objects.js'
import { registerSource, type SourceContext } from './execute.js'
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

/**
 * A YouTube video id, as YouTube actually mints them: eleven characters of
 * base64url. Not a guess at the format — it is the documented one, and every id
 * this app has ever received from the API matches it.
 *
 * This exists because an id is the ONE field that cannot be approximately
 * right. A wrong title is a wrong title; a wrong id is a link to nothing, and
 * it looks identical to a working one until it is tapped.
 */
export const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/

export const isVideoId = (id: unknown): id is string =>
  typeof id === 'string' && YOUTUBE_ID.test(id)

/**
 * The shape a renderer can actually use, with the canonical URL attached.
 *
 * THIS FUNCTION EXISTS BECAUSE OF A ONE-WORD MISMATCH THAT PRODUCED DEAD LINKS.
 * `/api/youtube/search` returned this module's `Video` records unmapped, and the
 * client cast them to its own `VideoObject`. Every field name happened to
 * agree — title, channel, thumbnail, publishedAt, description — except two:
 * `videoId` vs `id`, and `durationSec` vs `seconds`. So the cards rendered
 * perfectly, with a real picture and a real title, and the identity was
 * `undefined`. The Watch control interpolated it into
 * `youtube.com/watch?v=undefined`, which is a real page that says the video is
 * unavailable. Nothing errored anywhere.
 *
 * The URL is built HERE, once, from a verified id, and travels with the record.
 * No renderer constructs a YouTube URL from a field it hopes is an id.
 */
export interface PresentableVideo {
  id: string
  title: string
  channel?: string
  channelId?: string
  thumbnail?: string
  publishedAt?: string
  seconds?: number
  description?: string
  /** Canonical watch URL. Present only when `id` is a real provider id. */
  url: string
}

/**
 * Map provider records to presentable ones, DROPPING anything whose id is not a
 * real YouTube id, and saying how many were dropped.
 *
 * Dropping rather than rendering-without-a-link is the right severity: a video
 * this app cannot identify is a video it cannot honestly claim exists. The
 * count is returned so the caller can report it instead of quietly showing a
 * shorter list.
 */
export function presentable(videos: Video[]): { videos: PresentableVideo[]; rejected: number } {
  const out: PresentableVideo[] = []
  let rejected = 0
  for (const v of videos) {
    if (!isVideoId(v.videoId)) {
      rejected++
      continue
    }
    out.push({
      id: v.videoId,
      title: v.title,
      channel: v.channel,
      channelId: v.channelId,
      thumbnail: v.thumbnail,
      publishedAt: v.publishedAt,
      seconds: v.durationSec,
      description: v.description,
      url: `https://www.youtube.com/watch?v=${v.videoId}`,
    })
  }
  return { videos: out, rejected }
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
 * A title stays true for years; a view count is stale within the day.
 *
 * The record-level window used to be set by the fastest-moving field, which
 * meant a video's TITLE went stale because its view count had — and a pane
 * twenty hours old described itself as possibly-changed when nothing on screen
 * had changed at all. The identity never ages, the title effectively never
 * does, and only the statistics move quickly, so each says so for itself and
 * `staleAfterMs` is left as the fallback for anything not named.
 */
const VIDEO_STALE_AFTER = 12 * HOUR
const VIDEO_FIELD_STALENESS = {
  title: 30 * DAY,
  sub: 30 * DAY,
  image: 30 * DAY,
  at: 365 * DAY,
  durationSec: 365 * DAY,
  durationLabel: 365 * DAY,
  channelId: 365 * DAY,
  url: 365 * DAY,
  // What the app is actually allowed to print as current.
  views: HOUR,
  likes: HOUR,
}
const CHANNEL_STALE_AFTER = 7 * DAY

export function videoObject(v: Video, via: string, prov?: Provenance): ObjectDraft {
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
    prov: prov ?? retrieved('youtube', via, VIDEO_STALE_AFTER, VIDEO_FIELD_STALENESS),
  }
}

export function channelObject(c: Channel, via: string): ObjectDraft {
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
export async function rememberVideos(videos: Video[], via: string): Promise<ObjectDraft[]> {
  const objs = videos.map((v) => videoObject(v, via))
  await remember(objs)
  return objs
}

export async function rememberChannels(channels: Channel[], via: string): Promise<ObjectDraft[]> {
  const objs = channels.map((c) => channelObject(c, via))
  await remember(objs)
  return objs
}

// ── As a source the plan layer can name ──────────────────────────────────────

/**
 * The adapter, which is the whole of what the general layer learns about
 * YouTube.
 *
 * Every route ends in `hydrate`, so the invariant this file exists for holds
 * for plans as well as for panes: a title and a thumbnail come off one
 * `videos.list` record or neither is used. The executor cannot enforce that —
 * only this file knows what "the same record" means here — which is precisely
 * why the adapter, and not the executor, is where a connector's rules live.
 *
 * The access token arrives in `params` because credentials are the caller's
 * business; nothing in `execute.ts` knows this source needs one.
 */
export function installYouTubeSource(): void {
  const token = (ctx: SourceContext): string => {
    const t = ctx.params.youtubeToken ?? ctx.params.googleToken
    if (typeof t !== 'string' || !t) throw new Error('YouTube is not connected.')
    return t
  }
  const str = (ctx: SourceContext, k: string): string | undefined =>
    typeof ctx.params[k] === 'string' ? (ctx.params[k] as string) : undefined
  const int = (ctx: SourceContext, k: string, d: number): number =>
    typeof ctx.params[k] === 'number' ? (ctx.params[k] as number) : d

  registerSource('youtube', {
    routes: ['subscriptions', 'likes', 'search', 'channel', 'videos'],
    // Published units. Search is a hundred times a list read, and a refresh
    // policy that re-searches hourly should be a visible decision.
    cost: (route) => (route === 'search' ? COST.search : COST.list),
    describe: {
      what: 'his YouTube account',
      kinds: ['video'],
      routes: {
        subscriptions: 'recent uploads from channels he subscribes to. params: perChannel, maxChannels, limit',
        likes: 'videos he has liked. params: limit',
        search: 'a YouTube search. params: q (required), limit, channelId, publishedAfter (ISO). Expensive — prefer subscriptions where it will do',
        channel: 'recent uploads from one channel. params: channelId (required), limit',
        videos: 'full records for videos already known. Use as `enrich`, not `source`',
      },
    },
    async fetch(route, ctx) {
      const t = token(ctx)
      switch (route) {
        case 'subscriptions': {
          const { videos } = await fromSubscriptions(t, {
            perChannel: int(ctx, 'perChannel', 3),
            maxChannels: int(ctx, 'maxChannels', 25),
            limit: int(ctx, 'limit', 40),
          })
          return videos.map((v) => videoObject(v, 'subscriptions'))
        }
        case 'likes':
          return (await likedVideos(t, int(ctx, 'limit', 25))).map((v) => videoObject(v, 'likes'))
        case 'search': {
          const q = str(ctx, 'q')
          if (!q) throw new Error('A search needs something to search for.')
          const found = await search(t, q, {
            limit: int(ctx, 'limit', 10),
            channelId: str(ctx, 'channelId'),
            publishedAfter: str(ctx, 'publishedAfter'),
          })
          return found.map((v) => videoObject(v, 'search'))
        }
        case 'channel': {
          const channelId = str(ctx, 'channelId')
          if (!channelId) throw new Error('Which channel?')
          const [withPlaylist] = await withUploadPlaylists(t, [{ channelId, title: '' }])
          if (!withPlaylist?.uploadsPlaylist) return []
          const ids = await playlistVideoIds(t, withPlaylist.uploadsPlaylist, int(ctx, 'limit', 10))
          return (await hydrate(t, ids)).map((v) => videoObject(v, 'channel'))
        }
        /**
         * The enrichment route: turn ids we already hold into full records.
         *
         * This is what makes a Takeout-imported pane able to grow thumbnails
         * without Takeout ever having claimed to have one — the ids come from
         * the export, the pictures come from `videos.list`, and each is filed
         * as its own reading of the same identity.
         */
        case 'videos': {
          const ids = ctx.input.length
            ? ctx.input.map((o) => (ctx.by ? String(o.fields?.[ctx.by] ?? '') : o.nativeId)).filter(Boolean)
            : String(ctx.params.ids ?? '').split(',').filter(Boolean)
          return (await hydrate(t, ids)).map((v) => videoObject(v, 'videos'))
        }
        default:
          return []
      }
    },
  })
}
