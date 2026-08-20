import { useSyncExternalStore } from 'react'

/**
 * Where he is, and how we know.
 *
 * Location was a pair of coordinates and a flat error string, requested only
 * when a `follow` prop happened to be set. That cannot answer any of the
 * questions that actually matter: is this a live fix or something he told us
 * last week, how accurate, how old, and — when it is missing — whether he was
 * never asked, said no, or the device simply could not get a fix. Those need
 * different responses, and one string cannot carry them.
 *
 * PROVENANCE IS THE POINT. A coordinate from the device and a coordinate typed
 * into a box are both "the location", and treating them as the same thing is
 * how a stale guess ends up steering a route.
 */

export type LocationProvenance =
  /** A fix from the device, right now. Ephemeral. */
  | 'live-device'
  /** He said where he is. Durable until he says otherwise. */
  | 'user-stated'
  /** A place he has saved. */
  | 'saved'
  /** Taken from an event's location field. */
  | 'event-derived'
  /** Worked out from something else. Always the weakest claim. */
  | 'inferred'

export type PermissionState = 'unknown' | 'prompt' | 'granted' | 'denied' | 'unsupported'

export interface Fix {
  lat: number
  lon: number
  /** Metres, as reported. Absent when the provenance has no meaningful accuracy. */
  accuracy?: number
  at: string
  provenance: LocationProvenance
  /** Free text for anything he stated himself: "Tremenico". */
  label?: string
}

export interface LocationState {
  permission: PermissionState
  fix: Fix | null
  /** Set only while a request is genuinely outstanding. */
  requesting: boolean
  /** Why the last attempt failed, in his words. */
  error: string | null
  /** What he can do about it, when there is something. */
  recovery: string | null
}

let state: LocationState = {
  permission: 'unknown',
  fix: null,
  requesting: false,
  error: null,
  recovery: null,
}

const listeners = new Set<() => void>()
let version = 0
const emit = () => { version++; for (const l of listeners) l() }
const set = (p: Partial<LocationState>) => { state = { ...state, ...p }; emit() }

export const locationState = () => state

/**
 * Ask the browser what it already knows, WITHOUT prompting.
 *
 * The distinction between "never asked" and "said no" decides whether the UI
 * offers a button or an explanation, and the Permissions API answers it
 * without putting a dialog in front of him. Safari has supported it for
 * geolocation since 16, and where it is missing the state stays 'unknown',
 * which the UI treats as "offer the button".
 */
export async function probePermission(): Promise<PermissionState> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    set({ permission: 'unsupported', error: 'This browser has no location support.', recovery: null })
    return 'unsupported'
  }
  try {
    const p = await navigator.permissions?.query({ name: 'geolocation' as PermissionName })
    if (!p) return state.permission
    const map = (s: string): PermissionState => (s === 'granted' ? 'granted' : s === 'denied' ? 'denied' : 'prompt')
    const next = map(p.state)
    set({ permission: next, ...explain(next) })
    // If he changes it in Settings while the app is open, believe the change.
    p.onchange = () => { const n = map(p.state); set({ permission: n, ...explain(n) }) }
    return next
  } catch {
    return state.permission
  }
}

/**
 * WHAT A KNOWN PERMISSION STATE MEANS, AND WHAT TO DO ABOUT IT.
 *
 * `error` and `recovery` used to be written only by a FAILED REQUEST, so the
 * state the probe discovers on mount — the common one — carried neither. Maps
 * therefore opened on a bare orange "No location." : a problem announced with
 * no cause and no way forward, which is the one thing the location model was
 * built to stop ("denied", "unavailable", "timed out" and "never asked" need
 * different responses, and one string cannot carry them).
 *
 * `prompt` deliberately clears both. Nothing has gone wrong yet — he has simply
 * not been asked — and reporting that as a fault is how a button that works
 * comes to look broken.
 */
/**
 * Where THIS browser hides the permission, in its own words.
 *
 * Deliberately three cases and a fallback rather than a matrix: these are the
 * engines, the wording inside each is stable, and anything not recognised is
 * told the truth in general terms rather than sent to the wrong menu.
 */
function settingsPath(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const iOS = /iPad|iPhone|iPod/.test(ua)
  // Every iOS browser is WebKit, so the Safari path is the right one on all of
  // them — this is the one case where the engine matters more than the brand.
  if (iOS) return 'Safari → aA in the address bar → Website Settings → Location.'
  if (/Firefox\//.test(ua)) return 'Click the padlock in the address bar → Clear permission.'
  if (/Chrome\/|Chromium\/|Edg\//.test(ua)) return 'Click the icon at the left of the address bar → Location → Allow.'
  if (/Safari\//.test(ua)) return 'Safari → Settings → Websites → Location.'
  return 'Re-enable location for this site in your browser\u2019s site settings.'
}

function explain(p: PermissionState): { error: string | null; recovery: string | null } {
  if (p === 'denied') {
    return {
      error: 'Location is turned off for Crucible.',
      /*
        THE INSTRUCTIONS HAVE TO BE FOR THE BROWSER HE IS ACTUALLY IN.

        No browser lets a page re-prompt once location is denied, so the only way
        out is a settings path — and this hard-coded Safari's, which is a set of
        directions to a menu that does not exist for anyone reading it in Chrome.
        "aA in the address bar" is worse than saying nothing: it is a confident
        wrong answer to the one question the message exists to answer.

        Sniffed rather than enumerated, and the fallback is deliberately generic:
        an unrecognised browser gets a true sentence instead of a guess.
      */
      recovery: `${settingsPath()} Or tell me where you are.`,
    }
  }
  if (p === 'unsupported') {
    return { error: 'This browser has no location support.', recovery: 'Tell me where you are and I’ll use that.' }
  }
  return { error: null, recovery: null }
}

/**
 * Ask for a fix. Only ever called from something he tapped.
 *
 * Never on mount, never on a timer: an unprompted location dialog is the kind
 * of thing that gets permission denied permanently, and a denied permission is
 * far more expensive than a button he has to press once.
 */

/**
 * Tell the server where he is.
 *
 * Location has always been client-only state, which is why nothing on the
 * server could ever compute a journey: the travel planner runs where the
 * calendar and the geocoder are, and the one thing it needed — a starting
 * point — never left the browser. So every fix is reported, once, as it
 * arrives.
 *
 * Deliberately fire-and-forget. A fix is useful on screen whether or not the
 * server hears about it, and blocking the map on a POST would make the ◎ button
 * feel broken on a bad connection. The failure that matters — the server never
 * learning a position — shows up as the plan honestly saying it is timing from
 * home, which is exactly what it should say in that case.
 *
 * `provenance` travels with it, so a place he typed and a GPS reading cannot be
 * confused server-side either; only a stated place is allowed to become the
 * durable fallback origin.
 */
function report(fix: Fix): void {
  void fetch('/api/person/where', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      lat: fix.lat,
      lon: fix.lon,
      accuracy: fix.accuracy,
      at: fix.at,
      label: fix.label,
      provenance: fix.provenance,
    }),
    keepalive: true,
  }).catch(() => null)
}

export function requestLocation(opts: { highAccuracy?: boolean } = {}): Promise<Fix | null> {
  if (!navigator.geolocation) {
    set({ permission: 'unsupported', error: 'This browser has no location support.' })
    return Promise.resolve(null)
  }
  set({ requesting: true, error: null, recovery: null })
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const fix: Fix = {
          lat: p.coords.latitude,
          lon: p.coords.longitude,
          accuracy: Number.isFinite(p.coords.accuracy) ? Math.round(p.coords.accuracy) : undefined,
          at: new Date(p.timestamp || Date.now()).toISOString(),
          provenance: 'live-device',
        }
        set({ fix, requesting: false, permission: 'granted', error: null, recovery: null })
        report(fix)
        resolve(fix)
      },
      (e) => {
        // Each of these is a different situation with a different way out.
        const denied = e.code === e.PERMISSION_DENIED
        set({
          requesting: false,
          permission: denied ? 'denied' : state.permission,
          error: denied
            ? 'Location is turned off for Crucible.'
            : e.code === e.POSITION_UNAVAILABLE
              ? 'Your device could not get a fix.'
              : 'Getting your location timed out.',
          recovery: denied
            // Safari gives no way to re-prompt once denied; only the user can
            // undo it, so say exactly where.
            ? 'Safari → aA in the address bar → Website Settings → Location. Or tell me where you are.'
            : 'Try again, or tell me where you are.',
        })
        resolve(null)
      },
      { enableHighAccuracy: opts.highAccuracy ?? true, maximumAge: 15_000, timeout: 12_000 },
    )
  })
}

/**
 * Record a location he stated himself.
 *
 * A separate provenance rather than a fake device fix, so nothing downstream
 * can mistake "Tremenico, he told me on Tuesday" for a current GPS reading.
 */
export function stateLocation(lat: number, lon: number, label?: string) {
  const fix: Fix = { lat, lon, at: new Date().toISOString(), provenance: 'user-stated', label }
  set({ fix, error: null, recovery: null })
  report(fix)
}

export function clearLocation() {
  set({ fix: null, error: null, recovery: null })
}

/** How old the current fix is, in seconds. Live coordinates go stale quickly. */
export function ageSeconds(fix: Fix | null): number | null {
  if (!fix) return null
  return Math.max(0, Math.round((Date.now() - Date.parse(fix.at)) / 1000))
}

/**
 * Deliberately NOT persisted.
 *
 * A live device fix is where he was for a moment, not a fact about him. It is
 * held in memory for the session and re-requested when needed; writing precise
 * coordinates into durable storage is a different decision with different
 * consequences, and it is not one this module makes on its own.
 */
export function useLocation(): LocationState {
  // Subscribe on the version counter, not the object: `state` is replaced on
  // every change, so comparing it directly would re-render on nothing.
  useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l) } },
    () => version,
    () => version,
  )
  return state
}
