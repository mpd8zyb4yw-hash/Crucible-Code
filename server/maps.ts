/**
 * Maps, without a key and without a bill.
 *
 * Google's Directions and Places APIs are billable, which would mean putting a
 * payment method behind a button he taps on a card. OpenStreetMap's stack does
 * the same job for nothing: Nominatim geocodes, OSRM routes, and the tiles come
 * straight from openstreetmap.org. Nothing here can expire, run out of credit
 * or leak a key from a phone.
 *
 * Both services are volunteer-run and ask for two things in return, which this
 * file honours: identify yourself with a real User-Agent, and do not hammer
 * them. Requests are cached and rate limited below. If a Google key is ever
 * wanted for better coverage it slots in beside this rather than replacing it.
 */

const UA = 'Crucible/1.0 (personal assistant; https://crucible.cam)'

/** Nominatim asks for at most one request a second. This holds us to it. */
let lastCall = 0
async function polite<T>(fn: () => Promise<T>, minGapMs = 1100): Promise<T> {
  const wait = Math.max(0, lastCall + minGapMs - Date.now())
  if (wait) await new Promise((r) => setTimeout(r, wait))
  lastCall = Date.now()
  return fn()
}

/**
 * Repeat lookups are common and cheap to avoid — the same card is opened, the
 * same route redrawn — so answers are held for an hour. A place does not move.
 */
const cache = new Map<string, { at: number; value: unknown }>()
const TTL = 60 * 60_000

function cached<T>(key: string): T | null {
  const hit = cache.get(key)
  if (!hit || Date.now() - hit.at > TTL) return null
  return hit.value as T
}

function remember(key: string, value: unknown): void {
  // Bounded so a long-running Worker cannot grow this without limit.
  if (cache.size > 200) cache.clear()
  cache.set(key, { at: Date.now(), value })
}

export interface FoundPlace {
  id: string
  label: string
  lat: number
  lon: number
  sub?: string
}

/** Find places by name. Returns at most five, best first. */
export async function searchPlaces(query: string, near?: { lat: number; lon: number }): Promise<FoundPlace[]> {
  const q = query.trim()
  if (!q) return []
  const key = `s:${q}:${near ? `${near.lat.toFixed(2)},${near.lon.toFixed(2)}` : ''}`
  const hit = cached<FoundPlace[]>(key)
  if (hit) return hit

  const params = new URLSearchParams({ q, format: 'jsonv2', limit: '5', addressdetails: '1' })
  // Bias toward where he actually is. Without this, searching "the market"
  // from a village in the Apennines can return one in another hemisphere.
  if (near) {
    const d = 0.75
    params.set('viewbox', `${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}`)
    params.set('bounded', '0')
  }

  const r = await polite(() =>
    fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { 'user-agent': UA, accept: 'application/json' } })
  )
  if (!r.ok) throw new Error(`Place search is unavailable right now (${r.status}).`)
  const body = (await r.json()) as any[]

  const places: FoundPlace[] = (body ?? []).slice(0, 5).flatMap((p) => {
    const lat = Number(p.lat)
    const lon = Number(p.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return []
    const name = String(p.name || p.display_name || '').split(',')[0]!.trim()
    return [{
      id: String(p.osm_id ?? `${lat},${lon}`),
      label: name || String(p.display_name ?? 'Unnamed').slice(0, 60),
      lat,
      lon,
      sub: String(p.display_name ?? '').split(',').slice(1, 4).join(',').trim() || undefined,
    }]
  })
  remember(key, places)
  return places
}

export interface Route {
  points: { lat: number; lon: number }[]
  summary: string
  distanceM: number
  durationS: number
}

const PROFILE: Record<string, string> = { walk: 'foot', cycle: 'bike', drive: 'car' }

/** A route between two points, as a line to draw and a sentence to read. */
export async function routeBetween(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  mode: string
): Promise<Route> {
  const profile = PROFILE[mode] ?? 'foot'
  const key = `r:${profile}:${from.lat.toFixed(4)},${from.lon.toFixed(4)}:${to.lat.toFixed(4)},${to.lon.toFixed(4)}`
  const hit = cached<Route>(key)
  if (hit) return hit

  const url =
    `https://router.project-osrm.org/route/v1/${profile}/` +
    `${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`

  const r = await polite(() => fetch(url, { headers: { 'user-agent': UA } }), 400)
  if (!r.ok) throw new Error(`Routing is unavailable right now (${r.status}).`)
  const body = (await r.json()) as any
  const leg = body?.routes?.[0]
  if (!leg) throw new Error('I could not find a way between those two points.')

  const points = (leg.geometry?.coordinates ?? [])
    .map((c: number[]) => ({ lat: Number(c[1]), lon: Number(c[0]) }))
    .filter((p: { lat: number; lon: number }) => Number.isFinite(p.lat) && Number.isFinite(p.lon))

  const distanceM = Number(leg.distance) || 0

  /**
   * The public OSRM server only runs the CAR profile.
   *
   * The profile in the URL is accepted and ignored — measured directly: foot,
   * bike and car for the same pair all return distance 2936 m and duration
   * 439 s, identical to the second. Passing that number through as "7 min on
   * foot" would be reporting a driving time under a walking label, which is a
   * fabricated figure of exactly the kind this codebase has a standing rule
   * against.
   *
   * So the driving duration is used only for driving. Walking and cycling are
   * computed from the distance at a stated speed and described as estimates.
   * The GEOMETRY is still worth having — it follows real roads — and a route
   * drawn along a road is right even when the car's timing for it is not.
   */
  const drivingS = Number(leg.duration) || 0
  const SPEED_MS: Record<string, number> = { walk: 1.35, cycle: 4.2 } // ~4.9 km/h, ~15 km/h
  const isDrive = mode === 'drive'
  const durationS = isDrive ? drivingS : distanceM / (SPEED_MS[mode] ?? 1.35)

  const out: Route = {
    points,
    distanceM,
    durationS,
    summary: isDrive
      ? `${human(distanceM)} · about ${minutes(durationS)} driving`
      : `${human(distanceM)} · roughly ${minutes(durationS)} ${mode === 'cycle' ? 'cycling' : 'on foot'} (estimated from distance)`,
  }
  remember(key, out)
  return out
}

const human = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`)
const minutes = (s: number) => {
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
