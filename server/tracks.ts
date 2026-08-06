import { readWorld, writeWorld, addObservations, type Track, type World } from './world.js'
import { researchGap, type SearchKeys } from './research.js'

/**
 * Standing interests.
 *
 * The point of this file is what it does NOT contain: no list of supported
 * subjects, no weather module, no flights module, no per-domain parsing. A
 * track is a question plus an intent plus a cadence, so "is my flight on time",
 * "what is the pollen count", "which nights does that place do the set menu"
 * and "when does my permit expire" are the same object and cost the same
 * nothing to add. The user names the subject; the app never does.
 *
 * Ephemeral curiosity already exists in research.ts — the model wonders
 * something, looks it up, moves on. A track is the durable version: it
 * survives the pass, so an interest he stated once keeps being served without
 * him having to restate it, and it stops the moment he says stop.
 */

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'track'

export function makeTrack(input: Partial<Track>, by: Track['by']): Track {
  const what = String(input.what ?? '').trim().slice(0, 120)
  return {
    id: `trk-${slug(what)}-${Date.now().toString(36).slice(-4)}`,
    what,
    why: String(input.why ?? '').trim().slice(0, 200),
    question: input.question ? String(input.question).trim().slice(0, 200) : null,
    // A cadence the caller did not think about is a daily one; anything faster
    // than hourly is a poll, not an interest, and would just burn quota.
    everyHours: Math.max(1, Math.min(24 * 30, Number(input.everyHours) || 24)),
    lastRunAt: null,
    active: true,
    by,
  }
}

export async function listTracks(): Promise<Track[]> {
  return (await readWorld()).tracks ?? []
}

/**
 * Words that make a watch unanswerable.
 *
 * A standing interest is resolved later, by a search, with none of the
 * conversation that produced it. "The weather where I walk" and "whether that
 * place is open" cannot be answered by anyone but him — armed anyway, they run
 * on a cadence forever and return nothing usable each time. A watch he proposed
 * himself is his business; one the AGENT proposes has to stand on its own.
 */
const VAGUE = /\b(there|here|that place|his usual|my usual|the usual|nearby|around here|where (i|he) walks?|local)\b/i

export async function addTrack(input: Partial<Track>, by: Track['by']): Promise<Track | null> {
  const t = makeTrack(input, by)
  if (!t.what) return null
  // The model is told to gather the specifics before offering; this is the
  // check that does not depend on it having listened.
  if (by === 'agent' && VAGUE.test(t.what)) return null
  const w = await readWorld()
  w.tracks = w.tracks ?? []
  // Same interest asked for twice is one interest.
  if (w.tracks.some((x) => x.what.toLowerCase() === t.what.toLowerCase())) return null
  w.tracks.push(t)
  await writeWorld(w)
  return t
}

export async function updateTrack(id: string, patch: Partial<Track>): Promise<Track | null> {
  const w = await readWorld()
  const t = (w.tracks ?? []).find((x) => x.id === id)
  if (!t) return null
  if (patch.what !== undefined) t.what = String(patch.what).trim().slice(0, 120)
  if (patch.why !== undefined) t.why = String(patch.why).trim().slice(0, 200)
  if (patch.question !== undefined) t.question = patch.question ? String(patch.question).slice(0, 200) : null
  if (patch.everyHours !== undefined) t.everyHours = Math.max(1, Math.min(24 * 30, Number(patch.everyHours) || 24))
  if (patch.active !== undefined) t.active = patch.active === true
  await writeWorld(w)
  return t
}

export async function removeTrack(id: string): Promise<boolean> {
  const w = await readWorld()
  const before = (w.tracks ?? []).length
  w.tracks = (w.tracks ?? []).filter((x) => x.id !== id)
  if (w.tracks.length === before) return false
  await writeWorld(w)
  return true
}

/** Active tracks whose cadence has elapsed and that the web can actually answer. */
export function dueTracks(w: World, now = new Date()): Track[] {
  return (w.tracks ?? []).filter((t) => {
    if (!t.active || !t.question) return false
    if (!t.lastRunAt) return true
    return now.getTime() - new Date(t.lastRunAt).getTime() >= t.everyHours * 3_600_000
  })
}

/**
 * Refresh what is due. Each track becomes an observation like any other, so a
 * tracked fact and an observed one are indistinguishable downstream — the
 * synthesis pass reasons across both without knowing which is which.
 */
export async function runDueTracks(searchKeys: SearchKeys = {}, now = new Date()): Promise<{ ran: string[]; learned: string[] }> {
  const w = await readWorld()
  const due = dueTracks(w, now)
  if (!due.length) return { ran: [], learned: [] }

  const results = await Promise.all(
    due.map(async (t) => {
      const obs = await researchGap(
        { question: t.question as string, who: 'world', why: t.why },
        w,
        undefined,
        searchKeys
      ).catch(() => null)
      return { t, obs }
    })
  )

  const found = results.map((r) => r.obs).filter((o): o is NonNullable<typeof o> => o !== null)
  if (found.length) await addObservations(found)

  // Stamp every track that ran, answered or not: a question the web could not
  // answer this hour should not be retried on the next tick.
  const after = await readWorld()
  for (const { t } of results) {
    const live = (after.tracks ?? []).find((x) => x.id === t.id)
    if (live) live.lastRunAt = now.toISOString()
  }
  await writeWorld(after)

  return { ran: due.map((t) => t.what), learned: found.map((o) => o.text) }
}
