/**
 * WHEN TO SET OFF — as a computation with declared prerequisites.
 *
 * This exists because "What time should I leave for Avano?" was answered by the
 * chat model, which had no way to compute a departure and no way to refuse. It
 * replied with the nearest calendar fact it could see ("your events tomorrow are
 * all marked as all day"), which is true, unrelated, and indistinguishable from
 * an answer.
 *
 * A departure time is arithmetic on six inputs and it is WRONG, not merely
 * approximate, if any of them is invented:
 *
 *     destination      where he is going
 *     eventStart       when he has to be there
 *     origin           where he is setting off from
 *     transportMode    how he is travelling
 *     routeDuration    how long that takes  — computed here, never asked
 *     buffer           how early he wants to arrive — see BUFFER
 *
 * The first four are resolved on the client, against what is actually on his
 * screen, before this is ever called (see `src/task/resolve.ts`). This file
 * refuses rather than substitutes for the two it owns: if the destination cannot
 * be geocoded, or the router will not answer, there is no departure time and it
 * says which of those happened. Nothing here falls back to a straight-line
 * estimate, because a straight line over the Apennines is not a journey.
 */

import { routeBetween, searchPlaces } from './maps.js'

/**
 * THE ONE DECLARED DEFAULT, and the reason it is allowed to be one.
 *
 * §7's rule is that nothing may be substituted "unless that value is known or
 * explicitly defined as a safe product default". A buffer is the only input here
 * that qualifies: it is not a fact about the world that could be wrong, it is a
 * policy about how early to arrive, it errs in the safe direction, and it is
 * stated in the answer every time so he can disagree with it.
 */
export const BUFFER_MINUTES = 10

export interface LeaveByRequest {
  destination: string
  /** ISO timestamp. Never a date alone — see `eventStart` in resolve.ts. */
  eventStart: string
  origin: string
  /** 'walk' | 'cycle' | 'drive' | 'transit' */
  transportMode: string
  bufferMinutes?: number
}

export type LeaveByResult =
  | {
      ok: true
      leaveAt: string
      /** Minutes of travel, as the router reported it. */
      travelMinutes: number
      bufferMinutes: number
      /** How the travel time was arrived at, including its own hedge. */
      how: string
      destination: { label: string; lat: number; lon: number }
      origin: { label: string; lat: number; lon: number }
      /** The whole answer in one sentence, composed here so it cannot drift. */
      says: string
    }
  | {
      ok: false
      /** Which input could not be honoured. Never a bare "it failed". */
      failed: 'destination' | 'origin' | 'route' | 'mode'
      says: string
    }

/**
 * TRANSIT IS NOT SUPPORTED AND SAYS SO.
 *
 * OSRM has no timetable and no public-transport profile. The tempting move is to
 * return the walking figure and call it transit, which would understate a bus
 * journey by an hour or overstate it by twenty minutes depending on the day.
 * Nothing here knows which, so nothing here answers.
 */
const ROUTABLE = new Set(['walk', 'cycle', 'drive'])

const minutes = (s: number) => Math.max(1, Math.round(s / 60))

const clock = (iso: string, tz?: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: tz })

export async function leaveBy(req: LeaveByRequest, tz?: string): Promise<LeaveByResult> {
  const start = Date.parse(req.eventStart)
  if (!Number.isFinite(start)) {
    return { ok: false, failed: 'route', says: 'That start time isn’t a time I can work with.' }
  }

  if (!ROUTABLE.has(req.transportMode)) {
    return {
      ok: false,
      failed: 'mode',
      says:
        req.transportMode === 'transit'
          ? 'I can’t work out public transport times — I have no timetable for your area, and guessing one from the walking distance would be a made-up number.'
          : `I don’t know how to time a journey by “${req.transportMode}”.`,
    }
  }

  const [to] = await searchPlaces(req.destination).catch(() => [])
  if (!to) {
    return { ok: false, failed: 'destination', says: `I couldn’t find “${req.destination}” on the map, so I can’t time the journey to it.` }
  }
  // Biased toward the destination, so "the station" resolves to the one near
  // where he is going rather than one in another country.
  const [from] = await searchPlaces(req.origin, { lat: to.lat, lon: to.lon }).catch(() => [])
  if (!from) {
    return { ok: false, failed: 'origin', says: `I couldn’t place “${req.origin}”, so I have nowhere to measure the journey from.` }
  }

  const route = await routeBetween({ lat: from.lat, lon: from.lon }, { lat: to.lat, lon: to.lon }, req.transportMode)
    .catch((e: Error) => e)
  if (route instanceof Error) {
    return { ok: false, failed: 'route', says: `I couldn’t get a route: ${route.message}` }
  }

  const travelMinutes = minutes(route.durationS)
  const bufferMinutes = req.bufferMinutes ?? BUFFER_MINUTES
  const leaveAt = new Date(start - (travelMinutes + bufferMinutes) * 60_000).toISOString()

  /**
   * THE HEDGE TRAVELS WITH THE NUMBER.
   *
   * `routeBetween` computes walking and cycling from distance because the public
   * OSRM server only runs the car profile. That caveat is on the route object
   * and it has to reach the sentence, or the app is presenting an estimate in
   * the same voice as a measurement.
   */
  const how = route.summary

  return {
    ok: true,
    leaveAt,
    travelMinutes,
    bufferMinutes,
    how,
    destination: { label: to.label, lat: to.lat, lon: to.lon },
    origin: { label: from.label, lat: from.lat, lon: from.lon },
    says:
      `Leave by ${clock(leaveAt, tz)} — ${travelMinutes} min ${verb(req.transportMode)} from ${from.label} ` +
      `to ${to.label}, plus ${bufferMinutes} minutes' slack, to be there for ${clock(req.eventStart, tz)}. (${how})`,
  }
}

const verb = (mode: string) => (mode === 'drive' ? 'driving' : mode === 'cycle' ? 'cycling' : 'on foot')
