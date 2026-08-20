import { objectId, remember, type ObjectDraft } from './objects.js'
import { claim, historical, type Claim } from './provenance.js'

/**
 * Google Takeout import.
 *
 * The only route to watch history that exists. YouTube's API has never served
 * it, so without this file any statement about what he watches most is a guess
 * wearing the source's clothes — which is precisely the thing he asked never
 * to happen.
 *
 * Everything produced here is `historical`, stamped with the export's own
 * newest event rather than the moment of import. A Takeout taken in March and
 * loaded in August is five months out of date, and the label has to say so on
 * its own without anyone remembering to mention it.
 *
 * The parser is deliberately forgiving. Takeout's shape has drifted across
 * years and locales, entries for deleted videos carry no URL at all, and the
 * file routinely runs to hundreds of thousands of rows. A row it cannot read
 * is skipped and counted, never fatal.
 */

export interface WatchEvent {
  videoId: string
  title: string
  channel?: string
  channelId?: string
  /** ISO. When he watched it. */
  at: string
}

export interface WatchHistory {
  events: WatchEvent[]
  /** Newest event in the file — the best available proxy for the export date. */
  exportedAt: string
  /** Rows present but unreadable: deleted videos, ads, non-YouTube products. */
  skipped: number
}

const VIDEO_URL = /[?&]v=([A-Za-z0-9_-]{6,20})/
const CHANNEL_URL = /\/channel\/(UC[A-Za-z0-9_-]{10,})/

/**
 * Strip Takeout's verb prefix.
 *
 * Titles arrive as "Watched <name>", localised — "Ha visto", "A regardé". The
 * English prefix is removed when present and the raw title kept otherwise,
 * because a title that keeps one stray word is far better than a dropped row.
 */
function cleanTitle(raw: string): string {
  return raw.replace(/^Watched\s+/i, '').trim()
}

/**
 * Parse `watch-history.json` from Takeout > YouTube and YouTube Music.
 *
 * Accepts the parsed array or the raw text, since the file is large enough
 * that a caller may want to stream it in and hand over the result.
 */
export function parseWatchHistory(input: string | unknown[]): WatchHistory {
  let rows: unknown[]
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input)
      rows = Array.isArray(parsed) ? parsed : []
    } catch {
      throw new Error('That file is not JSON. Use watch-history.json from Takeout > YouTube and YouTube Music > history.')
    }
  } else {
    rows = input
  }

  if (!rows.length) throw new Error('That file has no entries in it.')

  const events: WatchEvent[] = []
  let skipped = 0
  let newest = 0

  for (const row of rows) {
    const r = (row ?? {}) as Record<string, any>
    const url = typeof r.titleUrl === 'string' ? r.titleUrl : ''
    const title = typeof r.title === 'string' ? r.title : ''
    const time = typeof r.time === 'string' ? r.time : ''

    // A removed or private video has a title and no URL. There is no id to
    // recover and nothing to render, so it is counted rather than invented.
    const videoId = VIDEO_URL.exec(url)?.[1]
    const at = Date.parse(time)
    if (!videoId || !title || !Number.isFinite(at)) {
      skipped++
      continue
    }

    const sub = Array.isArray(r.subtitles) ? r.subtitles[0] : undefined
    newest = Math.max(newest, at)
    events.push({
      videoId,
      title: cleanTitle(title),
      channel: typeof sub?.name === 'string' ? sub.name : undefined,
      channelId: typeof sub?.url === 'string' ? CHANNEL_URL.exec(sub.url)?.[1] : undefined,
      at: new Date(at).toISOString(),
    })
  }

  if (!events.length) {
    throw new Error(`Read ${rows.length} entries but none were watchable videos. Check this is watch-history.json and not search-history.json.`)
  }

  events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  return { events, exportedAt: new Date(newest).toISOString(), skipped }
}

/**
 * Which channels he actually watches, counted from real events.
 *
 * The ONLY thing in the codebase entitled to the phrase "most watched", and
 * only for the window the export covers — which is why `since` comes back with
 * it rather than being left for the caller to assume.
 */
export interface ChannelTally {
  channel: string
  channelId?: string
  watches: number
  lastWatched: string
}

export function channelsByWatchCount(h: WatchHistory, limit = 25): { tallies: ChannelTally[]; since: string; until: string } {
  const by = new Map<string, ChannelTally>()
  for (const e of h.events) {
    if (!e.channel) continue
    const key = e.channelId ?? e.channel
    const hit = by.get(key)
    if (hit) {
      hit.watches++
      if (e.at > hit.lastWatched) hit.lastWatched = e.at
    } else {
      by.set(key, { channel: e.channel, channelId: e.channelId, watches: 1, lastWatched: e.at })
    }
  }
  const tallies = [...by.values()].sort((a, b) => b.watches - a.watches).slice(0, limit)
  const oldest = h.events[h.events.length - 1]?.at ?? h.exportedAt
  return { tallies, since: oldest, until: h.exportedAt }
}

/**
 * Store the history as objects.
 *
 * Each watched video becomes one object with `via: 'takeout'`, so a pane built
 * from history is visibly a different kind of thing from one built from a live
 * subscription read even though both are YouTube videos.
 *
 * No thumbnail is set. Takeout does not carry one, and the image URL for a
 * video id is guessable — which is exactly the shortcut that produced wrong
 * thumbnails in the first place. A history object that wants a picture must be
 * hydrated through `youtube.hydrate()` like everything else, and then it is
 * `retrieved` rather than `historical` and says so.
 */
export async function rememberWatchHistory(h: WatchHistory, limit = 1500): Promise<ObjectDraft[]> {
  const prov = historical('youtube', h.exportedAt, 'takeout')
  const objs = h.events.slice(0, limit).map((e): ObjectDraft => ({
    id: objectId('youtube', 'video', e.videoId),
    source: 'youtube',
    kind: 'video',
    nativeId: e.videoId,
    title: e.title,
    sub: e.channel,
    at: e.at,
    fields: {
      channelId: e.channelId ?? null,
      watchedAt: e.at,
      url: `https://www.youtube.com/watch?v=${e.videoId}`,
    },
    prov,
  }))
  await remember(objs)
  return objs
}

/**
 * A ranking of channels, marked as what it is.
 *
 * Counting real events is not retrieval — YouTube never asserted "this is your
 * top channel" — so it comes back `inferred` with the events it rests on named
 * in `basis`. Breadth of basis is then a number rather than a feeling.
 */
export function tallyProvenance(h: WatchHistory, t: ChannelTally) {
  return channelClaim(h, t).prov
}

/**
 * The tally as a claim, with its evidence beside it rather than inside it.
 *
 * "He watches this channel most" is not a fact in the world and not something
 * YouTube ever said; it is what counting rows in one export implies, and the
 * rows are what make it checkable. Keeping the two apart is what lets a later
 * pass re-weigh it — or find that the export it rested on was replaced, and
 * drop the conclusion rather than carrying it forward as though it were an
 * observation.
 *
 * Confidence is a function of the EVIDENCE, not of the sentence: a channel
 * seen three times is a weak claim however confidently it can be phrased, and
 * the window the export covers bounds it regardless of how many events there
 * were.
 */
export function channelClaim(h: WatchHistory, t: ChannelTally): Claim<ChannelTally> {
  const basis = h.events
    .filter((e) => (e.channelId ?? e.channel) === (t.channelId ?? t.channel))
    .slice(0, 50)
    .map((e) => objectId('youtube', 'video', e.videoId))
  return claim(t, {
    source: 'youtube',
    method: `counted ${t.watches} watch events in a Takeout export covering up to ${h.exportedAt.slice(0, 10)}`,
    basis,
    // Ten events is enough to mean something; three is a coincidence with a
    // number attached. Never above 0.9: one export is one window of his life.
    confidence: Math.min(0.9, t.watches / 10),
  })
}
