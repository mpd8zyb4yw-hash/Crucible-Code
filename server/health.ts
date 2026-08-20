/**
 * WHAT CRUCIBLE BELIEVES, WHERE IT CAME FROM, AND WHAT IS ROTTING.
 *
 * Every part of this already existed and none of it was reachable. A `Fact`
 * carries a source, a setter, a confidence, a status and a timestamp. A `Belief`
 * carries a basis and a decaying confidence. A `Conflict` carries two readings
 * that disagree and whether he has ruled. A `demand` records what something
 * wanted and could not have. Four kinds of provenance, all typed, all stored,
 * and the only way to see any of it was to read the JSON.
 *
 * That gap is not cosmetic. The product now makes a strong claim — every card
 * traces to a typed fact, a deterministic computation, or a marked inference —
 * and a claim nobody can check is indistinguishable from a claim nobody is
 * keeping. This is the check: one screen that lists what the app thinks it
 * knows, beside how it came to think it, so a wrong belief can be found before
 * it turns up wearing a confident sentence on his home screen.
 *
 * THREE THINGS IT REFUSES TO DO.
 *
 *   · IT DOES NOT SUMMARISE. No model touches this. A summary of provenance is
 *     the one thing provenance cannot survive: the whole value is in the exact
 *     source and the exact age, and both are the first casualties of prose.
 *
 *   · IT DOES NOT SCORE. There is no health percentage. A single number would
 *     be a vibe metric over four incommensurable things, and this codebase has
 *     been burned by exactly one of those. What it reports are COUNTS of named,
 *     enumerable states, each of which he can open.
 *
 *   · IT DOES NOT HIDE THE UNFLATTERING PART. Stale beliefs, unanswered
 *     questions and unresolved disagreements are the point of the screen, not an
 *     appendix to it. `unresolved` is first in the returned object for the same
 *     reason it is first on the surface.
 */

import { dayIn, relativeDay } from './clock.js'
import { authoritativeSource, type Conflict, type Fact, type Person_ } from './person.js'
import type { World } from './world.js'

/**
 * How old a stored belief is.
 *
 * NOT `activity.ts`'s `Freshness`, which is a different thing with a confusingly
 * similar name: that one is about whether TODAY'S reading has arrived for a
 * metric, and it answers a question about a feed. This is about how long ago
 * anything confirmed a fact, and it answers a question about a belief. They are
 * deliberately not merged — a step count that has not synced since Friday and a
 * home address stated in May are both "old" and mean nothing like each other.
 */
export type Staleness = 'live' | 'recent' | 'ageing' | 'stale' | 'unknown'

/**
 * The thresholds, written down once.
 *
 * Days rather than hours, because everything on this screen is a belief about
 * his life rather than a cache entry — "where do you live" does not go stale in
 * an afternoon, and "how many steps today" is a different kind of thing that
 * `activity.ts` reports on its own terms.
 */
const AGEING_DAYS = 14
const STALE_DAYS = 60

export function stalenessOf(iso: string | undefined, now: Date): Staleness {
  if (!iso) return 'unknown'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 'unknown'
  const days = (now.getTime() - t) / 86_400_000
  if (days < 0) return 'live'
  if (days <= 1) return 'live'
  if (days <= AGEING_DAYS) return 'recent'
  if (days <= STALE_DAYS) return 'ageing'
  return 'stale'
}

/** One thing the app believes, with everything needed to argue with it. */
export interface Known {
  key: string
  /** The value, rendered for reading. Objects become JSON rather than "[object Object]". */
  value: string
  /**
   * WHO PUT IT THERE. The most important field on this screen.
   *
   *   'user'      — he said it. Nothing may overwrite it.
   *   'connector' — a source reported it.
   *   'agent'     — the app worked it out. The correctable kind.
   */
  by: 'user' | 'agent' | 'connector'
  /** Which connector or pass, by name. */
  source: string
  status: string
  confidence: number
  /** When the underlying evidence is from, not when the record was written. */
  at: string
  /** That instant, the way he would say it. Through `clock.ts`, like everything. */
  atLabel: string
  freshness: Staleness
  /** Where in the model it lives, so the surface can group without guessing. */
  bag: 'identity' | 'preferences'
  /** True when this key is currently in dispute. See `unresolved`. */
  disputed: boolean
}

/** A question the app is waiting on, and what it is blocking. */
export interface OpenQuestion {
  key: string
  /** What wanted the answer, in the words of the thing that wanted it. */
  why: string
  /** How many separate things have wanted it. */
  wanted: number
  /** When the answer stops being useful, when something gave a deadline. */
  before?: string
  /** Have we asked, and how many times? Asking is not the same as wanting. */
  asked: number
}

export interface DisagreementReport {
  metric: string
  /** The raw scope key — usually a `YYYY-MM-DD`. For computing with, not saying. */
  scope: string
  /**
   * The scope the way he would say it. "last Friday", "today".
   *
   * Carried for the same reason `Gap.lastDayLabel` is: a reader handed a
   * `YYYY-MM-DD` eventually prints it, and this screen shipped once reading
   * "58% apart, for 2026-08-11" — a machine date, on the one screen whose whole
   * subject is whether the app's records can be trusted.
   */
  scopeLabel: string
  readings: { source: string; value: number }[]
  differencePercent: number
  /** Whether he has ruled, and on what. */
  state: Conflict['state']
  resolvedTo?: string
}

/** A connector, and whether what it gave us is still worth anything. */
export interface SourceHealth {
  id: string
  /** How many observations it has contributed. */
  records: number
  /** The most recent thing it reported. */
  newest?: string
  newestLabel?: string
  freshness: Staleness
  /** Metrics for which HE named this source as the one to trust. */
  authoritativeFor: string[]
}

export interface DataHealth {
  at: string
  /**
   * WHAT IS ACTUALLY WRONG, first.
   *
   * Disagreements nobody has ruled on, questions nobody has answered, and
   * beliefs that have outlived their evidence. On a healthy model all three are
   * empty, and an empty list here is the best thing this screen can say.
   */
  unresolved: {
    disagreements: DisagreementReport[]
    questions: OpenQuestion[]
    /** Beliefs whose confidence has decayed past usefulness. */
    decayed: {
      id: string
      statement: string
      confidence: number
      /** When real evidence last confirmed it — not when it was last written. */
      confirmedAt: string
      confirmedLabel: string
      /**
       * Set when the evidence UNDER the belief moved after it was confirmed.
       *
       * Reported separately from decay because they are different failures and
       * only one of them is about time: decay says nobody has checked lately, a
       * contest says the thing it cites has since changed. A screen that
       * collapsed them would tell him to go and re-confirm something that is
       * already known to be wrong.
       */
      contested?: string
    }[]
  }
  /** Everything the typed model holds, newest evidence first. */
  known: Known[]
  /** Every connector that has ever reported anything. */
  sources: SourceHealth[]
  /**
   * Counts, not a score. See the header for why there is no percentage here.
   */
  counts: {
    known: number
    fromHim: number
    stale: number
    observations: number
    beliefs: number
    people: number
    goals: number
  }
}

/** A value a person can read. Never `[object Object]`, never `undefined`. */
function render(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return '—'
  }
}

/**
 * The whole report, computed from the world and nothing else.
 *
 * Deterministic and cheap: no network, no model, three walks of lists the prompt
 * budget already caps. It can therefore be recomputed on every request rather
 * than stored, which matters — a cached picture of what is stale is the one
 * thing on this screen that must never itself be stale.
 */
export function dataHealth(w: World, p: Person_, now = new Date()): DataHealth {
  const tz = w.timeZone
  const label = (iso: string | undefined) =>
    iso ? relativeDay(iso.slice(0, 10), now, tz) : 'never'

  const disputedKeys = new Set(
    p.conflicts.filter((c) => c.state === 'open').map((c) => `source.${c.metric}`)
  )

  const facts: Known[] = (['identity', 'preferences'] as const).flatMap((bag) =>
    Object.values(p[bag]).map((f: Fact): Known => ({
      key: f.key,
      value: render(f.value),
      by: f.by,
      source: f.source,
      status: f.status,
      confidence: f.confidence,
      at: f.sourceAt,
      atLabel: label(f.sourceAt),
      freshness: stalenessOf(f.sourceAt, now),
      bag,
      disputed: disputedKeys.has(f.key),
    }))
  )
  // Newest evidence first, so what he is most likely to want to check is at the
  // top — and so a screen he scrolls to the bottom of ends on the oldest thing
  // the app believes, which is the right place for a doubt to land.
  facts.sort((a, b) => b.at.localeCompare(a.at))

  const questions: OpenQuestion[] = Object.entries(p.demands)
    .map(([key, d]) => ({
      key,
      why: d.why,
      wanted: d.count,
      before: d.before,
      asked: p.asked[key]?.times ?? 0,
    }))
    /**
     * A DEADLINE OUTRANKS A TALLY, the same rule the question engine itself
     * uses. Sorting purely on how many things have wanted an answer is what let
     * a chronic gap permanently starve one blocking a journey tomorrow.
     */
    .sort((a, b) => {
      if (a.before && !b.before) return -1
      if (b.before && !a.before) return 1
      if (a.before && b.before) return a.before.localeCompare(b.before)
      return b.wanted - a.wanted
    })

  const decayed = w.beliefs
    .filter((b) => b.confidence <= 0.35 || b.contested)
    .map((b) => ({
      id: b.id,
      statement: b.statement,
      confidence: b.confidence,
      confirmedAt: b.confirmedAt,
      confirmedLabel: label(b.confirmedAt),
      contested: b.contested?.note,
    }))
    .sort((a, b) => a.confidence - b.confidence)

  /**
   * SOURCES, COUNTED FROM THE OBSERVATIONS THEMSELVES.
   *
   * Not from `w.sources`, which records which connectors he has switched ON —
   * a different question, and one that says nothing about whether anything has
   * arrived. A source that is enabled and has delivered nothing for a month is
   * exactly the state this screen exists to make visible, and reading the
   * toggle would report it as healthy.
   */
  const bySource = new Map<string, { records: number; newest?: string }>()
  for (const o of w.observations) {
    const held = bySource.get(o.source) ?? { records: 0 }
    held.records++
    if (!held.newest || o.at > held.newest) held.newest = o.at
    bySource.set(o.source, held)
  }

  const sources: SourceHealth[] = [...bySource.entries()]
    .map(([id, held]) => ({
      id,
      records: held.records,
      newest: held.newest,
      newestLabel: held.newest ? label(held.newest) : undefined,
      freshness: stalenessOf(held.newest, now),
      authoritativeFor: Object.keys(p.preferences)
        .filter((k) => k.startsWith('source.'))
        .filter((k) => authoritativeSource(p, k.slice('source.'.length))?.value === id)
        .map((k) => k.slice('source.'.length)),
    }))
    .sort((a, b) => (b.newest ?? '').localeCompare(a.newest ?? ''))

  return {
    at: dayIn(now, tz),
    unresolved: {
      disagreements: p.conflicts
        .filter((c) => c.state === 'open')
        .map((c) => ({
          metric: c.metric,
          scope: c.scope,
          // Through `clock.ts` when the scope is a day, and left alone when it
          // is not — a scope is not guaranteed to be a date.
          scopeLabel: /^\d{4}-\d{2}-\d{2}$/.test(c.scope) ? relativeDay(c.scope, now, tz) : c.scope,
          readings: c.readings.map((r) => ({ source: r.source, value: r.value })),
          differencePercent: c.differencePercent,
          state: c.state,
          resolvedTo: c.resolvedTo,
        })),
      questions,
      decayed,
    },
    known: facts,
    sources,
    counts: {
      known: facts.length,
      fromHim: facts.filter((f) => f.by === 'user').length,
      stale: facts.filter((f) => f.freshness === 'stale').length,
      observations: w.observations.length,
      beliefs: w.beliefs.length,
      people: p.people.length,
      goals: p.goals.filter((g) => g.status === 'active').length,
    },
  }
}
