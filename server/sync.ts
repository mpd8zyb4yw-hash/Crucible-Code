/**
 * HOW OFTEN EACH SOURCE IS WORTH ASKING ABOUT, AND WHO DECIDES.
 *
 * ── WHAT THIS REPLACES ───────────────────────────────────────────────────────
 *
 * There were two crons and one rule between them:
 *
 *     every quarter hour   freshen panes, rebuild the feed from the world
 *                          already stored — no connector call at all
 *     every three hours    actually pull Google
 *
 * with the comment "those sources do not change faster than that". For YouTube
 * that is true. For a calendar and a mailbox it is plainly false, and it is
 * false in the direction that costs the most: an event moved at 09:05 was
 * invisible until noon, while the quarter-hourly sweep dutifully re-rendered
 * the stale copy four times an hour and left a timestamp on it that said the
 * feed was current. It was — the FEED was current. Its sources were three hours
 * old, which is not a distinction he can see and not one he should have to.
 *
 * The observable symptom is the one that made the app feel dead: opening
 * Calendar was what made Calendar true. The domain fetched on arrival, so the
 * only way to see today's schedule was to go and look at it — which is the
 * whole job the product claims to do for him.
 *
 * ── THE RULE NOW ─────────────────────────────────────────────────────────────
 *
 * One cadence per source, chosen from how fast the thing behind it actually
 * changes, and a stamp per source recording when it was last successfully read.
 * Every entry point asks the same question — "what is overdue?" — and pulls only
 * that. A tick with nothing due costs one clock comparison.
 *
 * THE SERVER OWNS THIS, and that is a boundary rather than a convenience. The
 * client may say "I have arrived" or "I am back"; it may not say "fetch Gmail".
 * Provider quota is a property of the account, not of the tab, and a phone that
 * decides its own refresh policy is one backgrounded reload away from spending
 * the day's allowance — with two devices open, twice.
 */

import { GOOGLE_SOURCES, pullObservations, type GoogleSource } from './google.js'
import { addObservations, type World } from './world.js'

/**
 * HOW STALE EACH SOURCE IS ALLOWED TO GET.
 *
 * Chosen from what the source is FOR, not from what is cheap:
 *
 *   calendar  5m   the thing most likely to change under him, and the one where
 *                  being wrong has a cost measured in missed appointments.
 *   email     5m   same argument. A message that arrived twenty minutes ago and
 *                  is not on the screen is the app failing at its one job.
 *   health    20m  step counts accumulate; nothing is decided by the difference
 *                  between a five- and a twenty-minute-old figure, and the Fit
 *                  API is the most expensive call of the four.
 *   youtube   2h   a subscription feed. The original three-hour comment was
 *                  written about this source and is correct about it.
 *
 * These are ceilings on staleness, not schedules. Nothing is fetched because a
 * timer fired; things are fetched because they are older than the number here.
 */
export const SOURCE_CADENCE_MS: Record<GoogleSource, number> = {
  calendar: 5 * 60_000,
  email: 5 * 60_000,
  health: 20 * 60_000,
  youtube: 2 * 60 * 60_000,
}

/** When each source was last read successfully. Absent means never — always due. */
export const lastSyncedAt = (world: World, source: GoogleSource): number | null => {
  const raw = world.synced?.[source]
  if (!raw) return null
  const t = Date.parse(raw)
  return Number.isFinite(t) ? t : null
}

/**
 * The sources he has switched ON and which are older than their own ceiling.
 *
 * A source he switched off is never due, whatever the clock says — consent
 * outranks freshness, and asking a disabled source how stale it is would be a
 * quota spend on data he told us not to read.
 */
export function dueSources(world: World, now: Date): GoogleSource[] {
  return GOOGLE_SOURCES.filter((s) => {
    if (world.sources?.[s] === false) return false
    const at = lastSyncedAt(world, s)
    return at === null || now.getTime() - at >= SOURCE_CADENCE_MS[s]
  })
}

/** What one pass actually did. Every field is observable; nothing is inferred. */
export interface SyncOutcome {
  /** What was overdue when the pass began. */
  due: GoogleSource[]
  /** What came back without throwing, and therefore got a fresh stamp. */
  synced: GoogleSource[]
  /** Per-source failures, already prefixed with the source that produced them. */
  errors: string[]
  /** How many observations the fold accepted. */
  observations: number
}

const NOTHING: SyncOutcome = { due: [], synced: [], errors: [], observations: 0 }

/**
 * PULL WHAT IS OVERDUE, FOLD IT, AND STAMP ONLY WHAT SUCCEEDED.
 *
 * The stamp is the subtle half. It is written per source and only for sources
 * whose fetch completed, so a Gmail outage does not push email's next attempt
 * out by its whole cadence — it stays overdue and is retried on the next tick,
 * while calendar, which did work, is left alone. Stamping the whole batch on
 * "the pass ran" would turn one failed call into a source that is quietly hours
 * stale with nothing anywhere saying so.
 *
 * A pass with nothing due does no work and no write. That is the common case
 * and it is meant to be nearly free, because every arrival and every foreground
 * calls this.
 */
export async function syncDue(
  token: string,
  world: World,
  now = new Date(),
  opts: { force?: GoogleSource[] } = {}
): Promise<SyncOutcome> {
  const due = opts.force?.length ? opts.force : dueSources(world, now)
  if (!due.length) return NOTHING

  /*
    ONLY THE DUE ONES. `pullObservations` reads `enabled` as "anything not
    explicitly false", so every source not in `due` is switched off for this
    call. Passing the whole set and discarding what we did not want would spend
    the quota anyway, which is the entire thing this file exists to stop.
  */
  const enabled = Object.fromEntries(GOOGLE_SOURCES.map((s) => [s, due.includes(s)])) as Record<GoogleSource, boolean>

  const { observations, errors, timeZone, coverage, synced } = await pullObservations(token, enabled, world.timeZone)

  /*
    ALWAYS FOLDED, even when the pull produced nothing.

    A successful but empty read is information — the mailbox really is empty,
    the week really has no events — and it has to move the stamp, or an account
    with a quiet calendar would be considered permanently overdue and re-fetched
    on every single tick forever. The fold also carries `coverage`, which is what
    lets an emptied source retire the records it used to hold.
  */
  await addObservations(observations, now, { timeZone, coverage, synced })

  return { due, synced, errors, observations: observations.length }
}

/**
 * The freshness of every source, for a client that wants to say so.
 *
 * Deliberately reports AGE rather than a boolean: "when did you last look" is a
 * question the UI can render honestly, and "is it due" is a decision that stays
 * on this side of the wire.
 */
export function sourceFreshness(world: World, now = new Date()): Record<string, { at: string | null; ageMs: number | null; cadenceMs: number }> {
  const out: Record<string, { at: string | null; ageMs: number | null; cadenceMs: number }> = {}
  for (const s of GOOGLE_SOURCES) {
    const at = lastSyncedAt(world, s)
    out[s] = {
      at: at === null ? null : new Date(at).toISOString(),
      ageMs: at === null ? null : now.getTime() - at,
      cadenceMs: SOURCE_CADENCE_MS[s],
    }
  }
  return out
}
