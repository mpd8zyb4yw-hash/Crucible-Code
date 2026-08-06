import { worldStore } from './store.js'

/**
 * The world model.
 *
 * An assistant that only emits advice goes stale in a day. This is the thing
 * that keeps it honest: a running set of beliefs about the user's life, each
 * carrying where it came from and how sure we are, where confidence DECAYS
 * with time. A belief that decays past the point of usefulness is what makes
 * the assistant turn around and ask ("you shopped Tuesday, but I never saw the
 * basket — how much pasta is left?"). That question is not a feature; it is
 * what this system does when it needs a fact it no longer trusts.
 */


export interface Observation {
  id: string
  /** Which connector saw it: 'calendar' | 'email' | 'health' | 'user' | 'seed' */
  source: string
  /** ISO date the thing happened (not when we saw it). */
  at: string
  /** Plain-language description of the raw event. */
  text: string
}

export interface Belief {
  id: string
  /** A claim about the user's life, in plain language. */
  statement: string
  /** Observation ids this rests on. A belief with no basis is not a belief. */
  basis: string[]
  /** 0..1 at the moment it was last confirmed. */
  confidence: number
  /** ISO date confidence was last refreshed by real evidence. */
  confirmedAt: string
  /**
   * Confidence points lost per day. "Pasta is running low" rots fast; "he
   * lives in Italy" does not. The model sets this when it forms the belief.
   */
  decayPerDay: number
}

/**
 * A standing interest.
 *
 * Beliefs are what we know; a track is what he has asked us to keep watching.
 * Nothing here is a category the app ships with — weather, flight status, a
 * restaurant's opening hours and a permit deadline are all the same object.
 * Either he asked for it or the assistant proposed it and he accepted; there
 * is no third kind, and no list of supported subjects anywhere in the code.
 */
export interface Track {
  id: string
  /** What to watch, in plain language. */
  what: string
  /** What he wants OUT of it — the intent that decides what is worth raising. */
  why: string
  /**
   * A searchable question for the open web, or null when the thing is already
   * arriving through a connector and only needs watching.
   */
  question: string | null
  /** How often it is worth looking again. Weather is hours; a law is months. */
  everyHours: number
  lastRunAt: string | null
  active: boolean
  /** Who put it there. Kept so the assistant never silently drops his. */
  by: 'user' | 'agent'
}

export interface World {
  /** Stable background the model should always know. */
  profile: string
  observations: Observation[]
  beliefs: Belief[]
  tracks: Track[]
  /**
   * Per-source consent. One Google sign-in, then he says source by source what
   * it may actually read. Absent means on — signing in is the consent for the
   * default set, and switching one off is a decision he made, so it persists.
   */
  sources: Record<string, boolean>
  /**
   * Who decides what reaches the screen: 'auto' lets the assistant curate,
   * 'manual' restricts the feed to what he has explicitly asked to see.
   */
  curation: 'auto' | 'manual'
}

const EMPTY: World = { profile: '', observations: [], beliefs: [], tracks: [], sources: {}, curation: 'auto' }

export async function readWorld(): Promise<World> {
  try {
    return { ...EMPTY, ...(await worldStore().read()) }
  } catch {
    return EMPTY
  }
}

export async function writeWorld(w: World): Promise<void> {
  await worldStore().write(w)
}

export async function addObservations(obs: Observation[]): Promise<World> {
  const w = await readWorld()
  const seen = new Set(w.observations.map((o) => o.id))
  w.observations.push(...obs.filter((o) => !seen.has(o.id)))
  await writeWorld(w)
  return w
}

/**
 * Confidence as of now, after decay. Kept as a function rather than a stored
 * value so it is always current and never needs a background job to tick it.
 */
export function currentConfidence(b: Belief, now = new Date()): number {
  const days = (now.getTime() - new Date(b.confirmedAt).getTime()) / 86_400_000
  return Math.max(0, Math.min(1, b.confidence - days * b.decayPerDay))
}

/** Beliefs the assistant no longer trusts enough to act on — worth asking about. */
export function staleBeliefs(w: World, threshold = 0.4, now = new Date()): Belief[] {
  return w.beliefs.filter((b) => currentConfidence(b, now) < threshold)
}

/** What the model is shown: every observation, and beliefs with live confidence. */
/**
 * How many characters of raw observation the prompt may carry.
 *
 * Every observation ever recorded used to go into every prompt. Google is
 * pulled every three hours, so the prompt grew without limit — and once it
 * passed what a free model will accept, EVERY pass failed, permanently, with
 * no action he could take to recover. The app got slower and more expensive
 * every day it ran and then stopped working altogether.
 *
 * The newest are kept, because a feed is about now. What is dropped is stated
 * in the prompt rather than hidden, so the model never claims to have looked
 * at a whole life when it was handed a window of it.
 */
const DEFAULT_OBS_BUDGET = 24_000

export function renderWorld(w: World, now = new Date(), obsBudget = DEFAULT_OBS_BUDGET): string {
  const lines = w.observations
    .slice()
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((o) => `- [${o.id}] (${o.source}, ${o.at}) ${o.text}`)

  // Fill backwards from the newest until the budget is spent.
  const kept: string[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].length + 1
    if (used + cost > obsBudget) break
    kept.unshift(lines[i])
    used += cost
  }
  const dropped = lines.length - kept.length
  const obs = kept.join('\n') + (dropped ? `\n(${dropped} older observation(s) not shown — say so if you need them.)` : '')
  const bel = w.beliefs
    .map((b) => {
      const c = currentConfidence(b, now)
      const tag = c < 0.4 ? ' STALE — worth confirming with him' : ''
      return `- [${b.id}] ${b.statement} (confidence ${c.toFixed(2)}, from ${b.basis.join(', ')})${tag}`
    })
    .join('\n')

  const trk = (w.tracks ?? [])
    .filter((t) => t.active)
    .map((t) => `- [${t.id}] ${t.what} — because ${t.why} (${t.by === 'user' ? 'he asked for this' : 'you proposed it, he accepted'})`)
    .join('\n')

  return [
    w.profile ? `ABOUT HIM:\n${w.profile}` : '',
    obs ? `WHAT I HAVE OBSERVED:\n${obs}` : 'WHAT I HAVE OBSERVED:\n(nothing yet)',
    bel ? `WHAT I CURRENTLY BELIEVE:\n${bel}` : '',
    trk ? `WHAT HE HAS ASKED ME TO WATCH:\n${trk}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}
