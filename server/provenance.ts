/**
 * Where a fact came from, and how much of it is still true.
 *
 * The app shows him things. Some of them were read out of an account thirty
 * seconds ago, some were exported from Google in March and have not moved
 * since, and some the model worked out by looking at the others. Rendered the
 * same way, those three are indistinguishable — which is how "here are the
 * channels you watch most" ends up meaning "here are channels, and I guessed".
 *
 * So origin travels WITH the data, from the fetch that produced it all the way
 * to the pixel. Nothing in this file knows what YouTube is, or Gmail: a
 * connector added next month gets the same five origins and the same staleness
 * arithmetic without touching this file.
 */

/**
 * The five things a piece of data can be. Deliberately small — every one of
 * them changes what the app is allowed to SAY about the data.
 */
export type Origin =
  /** Read from the source's own API within this session. The strong case. */
  | 'retrieved'
  /** Real, dated, and not live: a Takeout export, an imported archive. */
  | 'historical'
  /** The model worked it out. Never presentable as a fact from the source. */
  | 'inferred'
  /** Retrieved once, but older than the source's own rate of change. */
  | 'stale'
  /** The source cannot answer this. Carries `note` saying why. */
  | 'unavailable'

export interface Provenance {
  origin: Origin
  /** Connector id: 'youtube', 'gmail', 'calendar', 'osm'. Free-form by design. */
  source: string
  /**
   * Which route within that source produced it — 'subscriptions', 'search',
   * 'takeout', 'likes'. Two videos can both be `retrieved` from `youtube` and
   * mean very different things, and #6 asks that the difference survive.
   */
  via?: string
  /** When the fetch happened. ISO. For `historical`, when the EXPORT was made. */
  retrievedAt: string
  /**
   * How long this kind of fact stays true. A calendar event goes stale in
   * minutes; a video's title effectively never does. Absent means no opinion.
   */
  staleAfterMs?: number
  /** Why it is unavailable, or what an inference was drawn from. */
  note?: string
  /**
   * Ids of the objects an inference rests on. A card citing one observation is
   * a restatement; this is what lets that be measured rather than felt.
   */
  basis?: string[]
}

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** Convenience for the overwhelmingly common case. */
export function retrieved(source: string, via?: string, staleAfterMs?: number): Provenance {
  return { origin: 'retrieved', source, via, retrievedAt: new Date().toISOString(), staleAfterMs }
}

export function historical(source: string, exportedAt: string, via = 'takeout'): Provenance {
  return { origin: 'historical', source, via, retrievedAt: exportedAt }
}

export function inferred(source: string, note: string, basis?: string[]): Provenance {
  return { origin: 'inferred', source, retrievedAt: new Date().toISOString(), note, basis }
}

export function unavailable(source: string, note: string): Provenance {
  return { origin: 'unavailable', source, retrievedAt: new Date().toISOString(), note }
}

/**
 * Re-read origin in light of the clock.
 *
 * `retrieved` is not a permanent property — it decays into `stale` once the
 * data outlives `staleAfterMs`. Doing this at read time rather than write time
 * means a pane sitting on screen for an hour tells the truth about itself
 * without anyone having to remember to re-stamp it.
 */
export function effectiveOrigin(p: Provenance, now = Date.now()): Origin {
  if (p.origin !== 'retrieved' || !p.staleAfterMs) return p.origin
  const age = now - Date.parse(p.retrievedAt)
  return Number.isFinite(age) && age > p.staleAfterMs ? 'stale' : 'retrieved'
}

export function ageMs(p: Provenance, now = Date.now()): number | undefined {
  const t = Date.parse(p.retrievedAt)
  return Number.isFinite(t) ? Math.max(0, now - t) : undefined
}

/** "just now", "12 min ago", "3 days ago" — his units, not a timestamp. */
export function agoLabel(p: Provenance, now = Date.now()): string | undefined {
  const age = ageMs(p, now)
  if (age === undefined) return undefined
  if (age < 90 * 1000) return 'just now'
  if (age < HOUR) return `${Math.round(age / MINUTE)} min ago`
  if (age < DAY) return `${Math.round(age / HOUR)} hr ago`
  const days = Math.round(age / DAY)
  if (days < 45) return `${days} day${days === 1 ? '' : 's'} ago`
  const months = Math.round(days / 30)
  return months < 18 ? `${months} months ago` : `${Math.round(days / 365)} years ago`
}

/**
 * One short phrase for the UI. This is the whole point of the file: whatever
 * renders a pane can put this under it and the distinction he asked for
 * survives into something he can actually read.
 */
export function provenanceLabel(p: Provenance, now = Date.now()): string {
  const origin = effectiveOrigin(p, now)
  const ago = agoLabel(p, now)
  const where = p.via ? `${p.source} · ${p.via}` : p.source
  switch (origin) {
    case 'retrieved':
      return ago ? `${where} · ${ago}` : where
    case 'historical':
      return `${where} · exported ${ago ?? 'previously'}`
    case 'stale':
      return `${where} · ${ago ?? 'old'} · may have changed`
    case 'inferred':
      return `worked out from ${p.basis?.length ?? 0} record${p.basis?.length === 1 ? '' : 's'}`
    case 'unavailable':
      return p.note ?? `${where} · unavailable`
  }
}

/**
 * May this data be described as a fact the source asserted?
 *
 * The guard behind his rule about "most watched": inference and absence never
 * get to borrow the source's authority.
 */
export function isAssertable(p: Provenance, now = Date.now()): boolean {
  const o = effectiveOrigin(p, now)
  return o === 'retrieved' || o === 'historical' || o === 'stale'
}
