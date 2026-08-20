/**
 * WHERE SOMETHING OPENS, KEPT SEPARATE FROM WHAT IT IS.
 *
 * The video card's job is to say WHICH video. This file's job is to say WHERE
 * it opens. Collapsing the two is how `window.open('…watch?v=' + v.id)` ended
 * up inline in a renderer: one expression that both asserted a video exists and
 * decided which app should show it, so neither could be changed or checked
 * independently.
 *
 * WHAT A WEB APP CAN HONESTLY PROMISE ON iOS, which is less than it looks.
 *
 * An https link is subject to the system's own routing: iOS may hand
 * youtube.com to the YouTube app via a universal link, or to the default
 * browser, and the page does not get a say and is not told which happened.
 * Custom schemes (`vnd.youtube:`, `brave://`) address a specific app, but there
 * is NO API that reports whether that app is installed — navigation to a scheme
 * nobody handles simply does nothing observable.
 *
 * So this file does not pretend to know. Every destination is an adapter that
 * states what it can actually guarantee, and the one destination that can fail
 * silently — a custom scheme — is given a real fallback: if the page is still
 * in the foreground shortly after the attempt, nothing handled it, and the
 * https URL is opened instead. That is a heuristic and it is labelled as one.
 * The alternative is a "Open in Brave" button that does nothing on a phone
 * without Brave, with no way for anyone to find out.
 */

export type DestinationId = 'browser' | 'youtube-app' | 'brave' | 'copy'

export interface Destination {
  id: DestinationId
  label: string
  /**
   * What this can actually be relied on to do. Shown in the picker, because a
   * choice between four options is only meaningful if their differences are.
   */
  note: string
  /**
   * Whether the app can confirm this worked. `false` means the attempt is
   * fire-and-forget and a fallback is armed.
   */
  confirmable: boolean
}

export const DESTINATIONS: Destination[] = [
  {
    id: 'browser',
    label: 'Default browser',
    note: 'Always works. iOS may still hand youtube.com to the YouTube app.',
    confirmable: true,
  },
  {
    id: 'youtube-app',
    label: 'YouTube app',
    note: 'Opens the app if it is installed; otherwise falls back to the browser.',
    confirmable: false,
  },
  {
    id: 'brave',
    label: 'Brave',
    note: 'Opens Brave if it is installed; otherwise falls back to the browser.',
    confirmable: false,
  },
  {
    id: 'copy',
    label: 'Copy link',
    note: 'Puts the link on the clipboard and opens nothing.',
    confirmable: true,
  },
]

export const destinationById = (id: string): Destination | undefined =>
  DESTINATIONS.find((d) => d.id === id)

/**
 * The stored preference, read locally.
 *
 * Kept in localStorage rather than only on the server because it is a property
 * of THIS DEVICE — the phone has Brave, the laptop may not — and a preference
 * synced across both would be wrong on one of them. The server-side
 * `video.destination` preference exists too and is what the assistant reasons
 * about; this is what the button uses, and the picker writes both.
 */
const KEY = 'cru:open-destination'

export function preferredDestination(): DestinationId | null {
  try {
    const held = localStorage.getItem(KEY)
    return held && destinationById(held) ? (held as DestinationId) : null
  } catch {
    return null
  }
}

export function rememberDestination(id: DestinationId): void {
  try {
    localStorage.setItem(KEY, id)
  } catch {
    // A device with storage blocked still gets a working button; it just asks
    // every time. Failing the open because the preference could not be saved
    // would be the wrong trade.
  }
}

/** How long to wait before deciding a custom scheme was not handled. */
const SCHEME_GRACE_MS = 900

/**
 * Open a URL at a destination.
 *
 * Returns what actually happened, as far as it can be known. `'fell-back'` is a
 * real and expected outcome, not an error.
 */
export async function openAt(
  url: string,
  destination: DestinationId
): Promise<'opened' | 'fell-back' | 'copied' | 'blocked'> {
  if (destination === 'copy') {
    try {
      await navigator.clipboard.writeText(url)
      return 'copied'
    } catch {
      return 'blocked'
    }
  }

  if (destination === 'browser') {
    return window.open(url, '_blank', 'noopener,noreferrer') ? 'opened' : 'blocked'
  }

  const scheme =
    destination === 'brave'
      ? `brave://open-url?url=${encodeURIComponent(url)}`
      : youtubeScheme(url)

  if (!scheme) return window.open(url, '_blank', 'noopener,noreferrer') ? 'opened' : 'blocked'

  /**
   * The fallback test: if this document is still visible and focused after the
   * grace period, no other app came to the foreground, so nothing handled the
   * scheme.
   *
   * `visibilitychange` rather than a blur listener because iOS Safari fires
   * blur for things that are not app switches (the keyboard, a share sheet),
   * and a false positive here means the video silently never opens.
   */
  let switched = false
  const onHide = () => {
    if (document.visibilityState === 'hidden') switched = true
  }
  document.addEventListener('visibilitychange', onHide)

  try {
    window.location.href = scheme
  } catch {
    document.removeEventListener('visibilitychange', onHide)
    return window.open(url, '_blank', 'noopener,noreferrer') ? 'opened' : 'blocked'
  }

  await new Promise((r) => setTimeout(r, SCHEME_GRACE_MS))
  document.removeEventListener('visibilitychange', onHide)

  if (switched) return 'opened'
  return window.open(url, '_blank', 'noopener,noreferrer') ? 'fell-back' : 'blocked'
}

/**
 * YouTube's own scheme, from a canonical watch URL.
 *
 * Parsed rather than string-sliced so a URL this app did not build cannot smuggle
 * something odd through — and returns null rather than guessing when the URL is
 * not a YouTube watch link, in which case the caller uses the https URL.
 */
function youtubeScheme(url: string): string | null {
  try {
    const u = new URL(url)
    if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null
    const v = u.searchParams.get('v')
    return v && /^[A-Za-z0-9_-]{11}$/.test(v) ? `vnd.youtube://${v}` : null
  } catch {
    return null
  }
}
