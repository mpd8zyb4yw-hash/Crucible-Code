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
 * connector added next month gets the same vocabulary and the same staleness
 * arithmetic without touching this file.
 *
 * Three things here are load-bearing for everything downstream, and each one
 * exists because the single-origin version of it was already wrong:
 *
 *   - Provenance COMPOSES. A result can be retrieved from Gmail, transformed
 *     by the model, enriched from the web and ranked against his preferences.
 *     Five mutually exclusive origins cannot say that, so a step carries its
 *     parents in `from` and the whole thing is a chain, not a label.
 *
 *   - Freshness is per FIELD. A video's identity does not rot because the
 *     retrieval is twenty hours old; its view count does, and its availability
 *     might. One universal decay function baked into the abstraction would
 *     force every field to age at the rate of the fastest-moving one.
 *
 *   - A fact and an inference from it are different objects. "Most watched"
 *     is a claim ABOUT 47 watch events, and it carries them rather than
 *     becoming them.
 */

/**
 * What a step DID. Deliberately small — every one of them changes what the app
 * is allowed to SAY about the result.
 *
 * The first five are the original origins and keep their exact meanings, so
 * data written before this file grew a chain still reads correctly. The last
 * three are what composition needs: they only ever appear with parents.
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
  /** Reshaped by the model without new facts: summarised, extracted, grouped. */
  | 'transformed'
  /** Real facts from a SECOND source attached to the first's identity. */
  | 'enriched'
  /** Ordered by a judgement. The order is an opinion; the items are not. */
  | 'ranked'

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
   * How long this kind of fact stays true, when nothing more specific is known.
   * A calendar event goes stale in minutes; a video's title effectively never
   * does. Absent means no opinion.
   */
  staleAfterMs?: number
  /**
   * Per-field overrides, which is the honest shape.
   *
   * `{ views: HOUR, title: 30 * DAY }` on one record, because a title and a
   * view count are not the same kind of true. A field named here ages at its
   * own rate; anything unnamed falls back to `staleAfterMs`. `identity` fields
   * — the id, source and kind — never age at all and are not expressible here.
   */
  fieldStaleAfterMs?: Record<string, number>
  /** Why it is unavailable, or what an inference was drawn from. */
  note?: string
  /**
   * Ids of the objects an inference rests on. A card citing one observation is
   * a restatement; this is what lets that be measured rather than felt.
   */
  basis?: string[]
  /**
   * What this step was performed ON.
   *
   * Empty for a fetch, which is where every chain bottoms out. Present for
   * anything derived, and this is the only reason the app can answer "what is
   * the weakest link in how you know that" rather than reporting the last thing
   * that happened to the data.
   */
  from?: Provenance[]
}

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** Convenience for the overwhelmingly common case. */
export function retrieved(
  source: string,
  via?: string,
  staleAfterMs?: number,
  fieldStaleAfterMs?: Record<string, number>
): Provenance {
  return {
    origin: 'retrieved',
    source,
    via,
    retrievedAt: new Date().toISOString(),
    staleAfterMs,
    fieldStaleAfterMs,
  }
}

/**
 * `via` defaults to 'import' rather than to any particular product's word for
 * an export. This file is the general layer; the connector that knows the
 * export is called a Takeout is the one that should say so.
 */
export function historical(source: string, exportedAt: string, via = 'import'): Provenance {
  return { origin: 'historical', source, via, retrievedAt: exportedAt }
}

export function inferred(source: string, note: string, basis?: string[], from?: Provenance[]): Provenance {
  return { origin: 'inferred', source, retrievedAt: new Date().toISOString(), note, basis, from }
}

export function unavailable(source: string, note: string): Provenance {
  return { origin: 'unavailable', source, retrievedAt: new Date().toISOString(), note }
}

/**
 * A step performed on earlier steps.
 *
 * The one way to build a chain, so a derived result cannot accidentally be
 * written as though it came straight off a wire. `source` defaults to the
 * parents' when they agree and becomes 'mixed' when they do not, which is
 * itself the useful thing to show him.
 */
export function derive(
  origin: Extract<Origin, 'transformed' | 'enriched' | 'ranked' | 'inferred'>,
  from: Provenance[],
  detail: { source?: string; via?: string; note?: string; basis?: string[] } = {}
): Provenance {
  const sources = [...new Set(from.map((p) => p.source))]
  return {
    origin,
    source: detail.source ?? (sources.length === 1 ? sources[0]! : 'mixed'),
    via: detail.via,
    retrievedAt: new Date().toISOString(),
    note: detail.note,
    basis: detail.basis,
    from: from.length ? from : undefined,
  }
}

/** Every step in the graph, head first, breadth-first, each visited once. */
export function chainOf(p: Provenance): Provenance[] {
  const out: Provenance[] = []
  const queue: Provenance[] = [p]
  const seen = new Set<Provenance>()
  while (queue.length) {
    const step = queue.shift()!
    if (seen.has(step)) continue
    seen.add(step)
    out.push(step)
    for (const parent of step.from ?? []) queue.push(parent)
  }
  return out
}

/** Every distinct source that contributed anything, in first-seen order. */
export function sourcesOf(p: Provenance): string[] {
  return [...new Set(chainOf(p).map((s) => s.source).filter((s) => s !== 'mixed'))]
}

/**
 * Re-read origin in light of the clock.
 *
 * `retrieved` is not a permanent property — it decays into `stale` once the
 * data outlives its window. Doing this at read time rather than write time
 * means a pane sitting on screen for an hour tells the truth about itself
 * without anyone having to remember to re-stamp it.
 *
 * Naming a field asks about THAT field's window. Asking without one asks about
 * the record as a whole, which is the record's own `staleAfterMs` — and note
 * that the answer differs: a video is `retrieved` for its title and `stale`
 * for its view count at the same instant, and both answers are correct.
 */
export function effectiveOrigin(p: Provenance, now = Date.now(), field?: string): Origin {
  if (p.origin !== 'retrieved' && p.origin !== 'enriched') return p.origin
  const window = (field ? p.fieldStaleAfterMs?.[field] : undefined) ?? p.staleAfterMs
  if (!window) return p.origin
  const age = now - Date.parse(p.retrievedAt)
  return Number.isFinite(age) && age > window ? 'stale' : p.origin
}

/**
 * How much authority a step carries. Only the ORDER matters.
 *
 * Used to find the weakest link, because that is what governs what may be
 * claimed: retrieved facts ranked by a model are, as a whole, a ranking — and
 * a chain is never stronger than its worst step.
 */
const AUTHORITY: Record<Origin, number> = {
  retrieved: 6,
  historical: 5,
  enriched: 5,
  stale: 4,
  ranked: 3,
  transformed: 2,
  inferred: 1,
  unavailable: 0,
}

/** The least-authoritative step in the whole graph, after decay. */
export function weakestOrigin(p: Provenance, now = Date.now()): Origin {
  return chainOf(p)
    .map((s) => effectiveOrigin(s, now))
    .reduce((worst, o) => (AUTHORITY[o] < AUTHORITY[worst] ? o : worst), 'retrieved' as Origin)
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
 *
 * A derived result names what was done and what it was done to, rather than
 * reporting only the last step — "ranked · from youtube, gmail" is the truth
 * about a ranking over two accounts, and "ranked" alone is not.
 */
export function provenanceLabel(p: Provenance, now = Date.now(), field?: string): string {
  const origin = effectiveOrigin(p, now, field)
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
    case 'transformed':
    case 'enriched':
    case 'ranked': {
      const from = sourcesOf(p).filter((s) => s !== p.source)
      return from.length ? `${origin} · from ${from.join(', ')}` : `${origin} · ${where}`
    }
  }
}

/**
 * May this data be described as a fact the source asserted?
 *
 * The guard behind his rule about "most watched": inference and absence never
 * get to borrow the source's authority. Now asked of the WHOLE chain, because
 * a model-transformed copy of a retrieved fact is not a retrieved fact, however
 * real its ancestor was.
 */
export function isAssertable(p: Provenance, now = Date.now()): boolean {
  const o = weakestOrigin(p, now)
  return o === 'retrieved' || o === 'historical' || o === 'stale' || o === 'enriched'
}

// ── Facts and what we concluded from them ────────────────────────────────────

/**
 * A conclusion, kept apart from its evidence.
 *
 * "He watches 60 Minutes most" is not a fact in the world; it is what counting
 * 47 rows in a Takeout file implies, and the two must not be stored as one
 * thing. Once the world model starts combining sources this is what stops a
 * conclusion drawn from one weak reading being reused as though it were an
 * observation — the basis travels, so a later pass can re-weigh it, and a
 * conclusion whose evidence was retired can be found and dropped.
 *
 * `basis` names object or observation ids, never prose. Breadth of basis is
 * therefore countable, which is the only reason "synthesis" can be measured
 * rather than felt.
 */
export interface Claim<T = unknown> {
  /** What is being asserted, in whatever shape the caller needs. */
  claim: T
  /** How it was reached, in plain language: 'counted watch events'. */
  method: string
  /** Ids of the evidence. A claim with no basis is not a claim. */
  basis: string[]
  /** 0..1. What the METHOD warrants, not how the sentence reads. */
  confidence: number
  /** Always derived — a claim can never be `retrieved`. */
  prov: Provenance
}

export function claim<T>(
  value: T,
  detail: { method: string; basis: string[]; confidence: number; source?: string; from?: Provenance[] }
): Claim<T> {
  return {
    claim: value,
    method: detail.method,
    basis: detail.basis,
    confidence: Math.max(0, Math.min(1, detail.confidence)),
    prov: inferred(
      detail.source ?? (detail.from?.length ? derive('inferred', detail.from).source : 'crucible'),
      detail.method,
      detail.basis,
      detail.from
    ),
  }
}

/**
 * The sentence a claim is allowed to appear under.
 *
 * Never the source's voice. "counted from 47 watch events" is what he sees,
 * and there is no code path that turns it into "YouTube says".
 */
export function claimLabel(c: Claim): string {
  return `${c.method} · ${c.basis.length} record${c.basis.length === 1 ? '' : 's'}`
}
