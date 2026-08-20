/**
 * WHO HE IS, AS STRUCTURE RATHER THAN AS PROSE.
 *
 * The world model already holds two things well: OBSERVATIONS (what a
 * connector saw) and BELIEFS (what the model concluded, decaying). Both are
 * sentences. That is the right shape for synthesis — a language model reasons
 * over prose — and the wrong shape for every question the app actually needs
 * answered before it can act.
 *
 * The concrete failure, read out of his live world model on 2026-08-11:
 *
 *     observations[]
 *       "While looking at \"Do you drive?\", he said: No"
 *       "While looking at \"Do you drive?\", he said: No"
 *       "He said: I walk to the market on SundaysI walk to the market on Sundays"
 *       "Takes the bus down into town to shop, about 20 minutes each way."
 *       "Lives in Castiglione dei Pepoli, a mountain village in the Bologna
 *        Apennines. No supermarket in the village itself."
 *
 * Every fact needed to plan his journey to the dinner on the 12th is in there.
 * He was ASKED whether he drives, he ANSWERED, and the answer was filed as a
 * sentence — twice, because nothing could tell that the question had already
 * been settled. No code path can read "does he drive?" out of that list, so
 * the router still has to guess a travel mode, and the question is still
 * askable, forever. A fact that cannot be queried is not knowledge; it is a
 * transcript.
 *
 * So this file adds the third thing: a small set of TYPED SHAPES whose subject
 * matter stays completely open.
 *
 * THAT DISTINCTION IS THE WHOLE DESIGN, and it is what keeps this compatible
 * with the standing rule in `think.ts` that the assistant HAS NO CATEGORIES.
 * The rule is about subject matter — no shopping feature, no health feature,
 * no assumption that a step count means weight loss — and nothing here breaks
 * it. What is typed is the ARGUMENT STRUCTURE: that a goal has a desired
 * outcome and evidence, that a preference has a key and a value and someone
 * who set it, that a person has a relationship distinct from an email address.
 * A doctor tracking patients and a parent tracking a household fill these with
 * entirely different content and neither needs a line added here.
 *
 * Four rules hold across everything in this file.
 *
 *   - EVERY FACT CARRIES WHERE IT CAME FROM. Not as decoration: `status` is
 *     read before a fact is allowed to appear in a sentence, and `inferred`
 *     never gets to speak in the source's voice. This mirrors `provenance.ts`
 *     for retrieved objects; the two vocabularies are deliberately aligned.
 *
 *   - HIS ANSWER OUTRANKS OUR INFERENCE, PERMANENTLY. `by: 'user'` is a lock,
 *     not a tiebreak. The same rule the shelf already enforces for his layout:
 *     an agent may only overwrite what an agent put there. Without it the next
 *     synthesis pass quietly reverts every correction he makes, which is worse
 *     than never having offered to be corrected.
 *
 *   - A THING THAT WAS ASKED AND ANSWERED IS SETTLED. `askedAt` and the fact's
 *     own existence are what stop the second "Do you drive?".
 *
 *   - NOTHING IS INVENTED TO FILL A SLOT. An empty slot is a first-class state
 *     with a name (`unknown`) and a use (it is what the question engine reads).
 *     Guessing to avoid an empty field is how a personal model fills up with
 *     confident fiction.
 */

import type { Observation, World } from './world.js'

// ── The unit: a fact with a paper trail ──────────────────────────────────────

/**
 * How a fact is known. Ordered loosely by how much it may be leaned on, but
 * the ORDER is not the point — the distinctions are, and each one changes what
 * the app is allowed to say and whether it should ask.
 */
export type FactStatus =
  /** A source asserted it and the assertion is still inside its own window. */
  | 'verified'
  /** He said so. The strongest thing there is, and never overwritten by us. */
  | 'user_provided'
  /** We worked it out from observations. Presentable, but as our conclusion. */
  | 'inferred'
  /** A stand-in we chose knowing it is approximate. Always says so. */
  | 'estimated'
  /** Was verified once; has outlived the rate at which this kind of thing moves. */
  | 'stale'
  /** Two sources disagree materially. NOT a value — a state. See `conflictId`. */
  | 'conflicting'
  /** Nothing known. A real state, not an absence: it is what gets asked about. */
  | 'unknown'

/** Who put a value here. Governs who is allowed to change it. */
export type Setter = 'user' | 'agent' | 'connector'

/**
 * One known thing about him.
 *
 * Generic in the value so a preference for a string, a threshold in euros and
 * a list of languages are all the same object to everything downstream — the
 * conflict detector, the correction endpoint and the explainer each work on
 * `Fact` without knowing what any particular key means.
 */
export interface Fact<T = unknown> {
  /** Namespaced and stable: 'transport.default', 'identity.homeCountry'. */
  key: string
  value: T
  /** Connector id, 'user', or the name of the computation that concluded it. */
  source: string
  /** When the SOURCE knew it — not when we wrote it down. */
  sourceAt: string
  /** When this record last changed. */
  updatedAt: string
  /** 0..1, what the METHOD warrants. Not how confident the sentence sounds. */
  confidence: number
  status: FactStatus
  /** Observation or object ids behind it. An inference with none is not one. */
  basis?: string[]
  /** Why it is estimated, what it was inferred from, what is in conflict. */
  note?: string
  /** Set when `status === 'conflicting'`. Points into `Person.conflicts`. */
  conflictId?: string
  by: Setter
  /**
   * When we last put this question to him, whatever he answered.
   *
   * Separate from `updatedAt` because "asked and he declined to answer" and
   * "never asked" are different, and only the first should stop us asking
   * again. This is the field that would have prevented the duplicate
   * "Do you drive?" in his observation list.
   */
  askedAt?: string
}

export function fact<T>(
  key: string,
  value: T,
  d: {
    source: string
    status: FactStatus
    confidence: number
    by: Setter
    sourceAt?: string
    basis?: string[]
    note?: string
    askedAt?: string
  }
): Fact<T> {
  const now = new Date().toISOString()
  return {
    key,
    value,
    source: d.source,
    sourceAt: d.sourceAt ?? now,
    updatedAt: now,
    confidence: Math.max(0, Math.min(1, d.confidence)),
    status: d.status,
    basis: d.basis,
    note: d.note,
    by: d.by,
    askedAt: d.askedAt,
  }
}

/**
 * May `next` replace `held`?
 *
 * The one place the ownership rule lives, so no caller can forget it. An agent
 * or a connector may refine what an agent or a connector put there; neither may
 * touch what HE said. He may change anything, including his own earlier answer.
 *
 * The failure this prevents is specific and would be invisible: he corrects
 * his travel mode to "bus", the next synthesis pass observes three walking
 * routes and re-infers "walk", and his correction is gone with no error
 * anywhere. A correction that does not survive the next pass is not a
 * correction, and he would have no way of knowing it had been reverted.
 */
export function mayReplace(held: Fact | undefined, next: Setter): boolean {
  if (!held) return true
  if (next === 'user') return true
  return held.by !== 'user'
}

// ── Goals ────────────────────────────────────────────────────────────────────

/**
 * Something he is trying to bring about.
 *
 * A goal is not a category of card and not a tag. It is the thing that decides
 * what a number MEANS: the same 4,385 steps is progress for one objective,
 * a red flag for another and irrelevant to a third, and the app has no way to
 * tell which without this. That is why `outcome` exists and why nothing here
 * defaults it — `think.ts` already states the rule ("a step count is a
 * weight-loss signal for one person, a weight-GAIN signal for another"), and
 * this is the storage that finally lets the rule be obeyed rather than
 * restated in a prompt.
 */
export interface Goal {
  id: string
  /** In his words where possible: 'improve my Italian'. */
  description: string
  /** Why he wants it. Absent until he says; never guessed. */
  reason?: string
  status: 'active' | 'paused' | 'achieved' | 'abandoned'
  /** 1..5. His ranking if he gave one, ours if inferred, and `by` says which. */
  importance: number
  /** 'by October', 'this month', 'no deadline'. Free text — it is his phrase. */
  timeframe?: string
  /** What done looks like, concretely enough to be measured against. */
  outcome?: string
  /** Ids into `Person.constraints` that bear on this goal. */
  constraints: string[]
  /**
   * What would show movement, and where the number comes from.
   *
   * A goal with no signal is a wish: nothing can ever report progress on it,
   * and it should be asked about rather than displayed with a fake bar.
   */
  signals: GoalSignal[]
  /** Surfaces that bear on it. Advisory — used to decide where to show it. */
  surfaces: string[]
  by: Setter
  confidence: number
  basis: string[]
  createdAt: string
  updatedAt: string
}

export interface GoalSignal {
  /** 'steps', 'italian.practice.sessions', 'balance' — open by design. */
  metric: string
  /** Where the number would come from, or null when nothing supplies it yet. */
  source: string | null
  /** The direction that counts as progress. */
  direction: 'up' | 'down' | 'steady'
  /** His target, if he has one. Never invented to make a chart look complete. */
  target?: number
  unit?: string
}

// ── People ───────────────────────────────────────────────────────────────────

/**
 * Someone in his life.
 *
 * `relationship` is a Fact and `contact` is not, and that separation is the
 * requirement rather than a nicety: an email address is a string Gmail can
 * assert, and "someone who sometimes drives me places" is a claim with a
 * source, a confidence and a correction path. Storing the second the way we
 * store the first is how "Jamie gives me lifts" becomes unfalsifiable.
 */
export interface Person {
  id: string
  name: string
  /** 'friend', 'neighbour', 'sister', 'gives me lifts sometimes'. Open. */
  relationship?: Fact<string>
  /** Roles he has confirmed, kept apart from anything we merely noticed. */
  roles: Fact<string>[]
  contact?: { email?: string; phone?: string }
  basis: string[]
  by: Setter
  updatedAt: string
}

// ── Routines and constraints ─────────────────────────────────────────────────

/** Something he does on a rhythm. Evidence-backed or it does not exist. */
export interface Routine {
  id: string
  /** 'walks to the market', 'watches long-form video before bed'. */
  what: string
  /** His words for the rhythm: 'Sundays', 'most weekday evenings'. */
  cadence: string
  /** Observation ids. A routine claimed from one sighting is not a routine. */
  basis: string[]
  confidence: number
  lastSeen?: string
  by: Setter
  updatedAt: string
}

/**
 * Something that is true about his situation and limits what is possible.
 *
 * The difference between a constraint and a preference is whether he has a
 * choice. "No car" is a constraint; "prefers walking" is a preference. Planning
 * must treat them differently — a preference may be overridden when it is
 * raining and a constraint may not — and collapsing the two is how an
 * assistant confidently suggests driving to someone with no car.
 */
export interface Constraint {
  id: string
  /** Open string: 'transport', 'financial', 'language', 'geographic', 'time'. */
  kind: string
  /** 'has no car', 'B1 Italian', 'lives 20 minutes by bus from the shops'. */
  what: string
  /** Structured where it can be, for the planner. */
  value?: unknown
  basis: string[]
  confidence: number
  by: Setter
  updatedAt: string
}

// ── Disagreement between sources ─────────────────────────────────────────────

/** One source's number for one metric over one period. */
export interface Reading {
  metric: string
  /** The period this covers: a date, a month, an instant. His scope, not UTC. */
  scope: string
  source: string
  value: number
  /** When the source observed it. */
  at: string
  unit?: string
}

/**
 * Two sources that will not agree, kept as a disagreement.
 *
 * The alternative — and what every version of this app did until now — is that
 * the last writer wins and the number on screen is whichever sync ran most
 * recently. That is not merely imprecise, it is unfalsifiable: he sees 6,012,
 * his phone says 10,347, and nothing in the app is even capable of representing
 * the fact that both were reported. A conflict is a THING, with an id, a
 * lifetime and a resolution.
 */
export interface Conflict {
  id: string
  metric: string
  scope: string
  readings: { source: string; value: number; at: string }[]
  difference: number
  differencePercent: number
  state: 'open' | 'resolved' | 'ignored'
  /** The source he named as authoritative, once he has. */
  resolvedTo?: string
  resolvedAt?: string
  noticedAt: string
  unit?: string
}

/**
 * When is a disagreement worth raising?
 *
 * Both a floor and a ratio, because either alone misbehaves at one end of the
 * range. A ratio alone makes 3 steps versus 6 a "100% discrepancy" worth a
 * question; a floor alone lets 60,000 versus 70,000 pass as agreement. A
 * reading has to clear both to count.
 */
export interface Materiality {
  /** Absolute difference below which we do not care. In the metric's units. */
  floor: number
  /** Fraction of the larger reading. 0.15 = 15%. */
  ratio: number
}

const DEFAULT_MATERIALITY: Materiality = { floor: 500, ratio: 0.15 }

/** Per-metric thresholds. Anything unnamed uses the default. */
const MATERIALITY: Record<string, Materiality> = {
  steps: { floor: 750, ratio: 0.15 },
  // Money is not steps: ten euros apart matters, and 15% of a balance does not.
  balance: { floor: 5, ratio: 0.01 },
}

export function materialityFor(metric: string): Materiality {
  return MATERIALITY[metric] ?? DEFAULT_MATERIALITY
}

/**
 * Group readings and report the ones that genuinely disagree.
 *
 * Pure, and takes the clock as an argument, so this is testable without a
 * store, a network or a fixed date. Existing conflicts are passed in so a
 * disagreement he has already settled does not come back as new every sync —
 * the resolution is keyed on metric+scope, and a REOPEN only happens when the
 * numbers move outside what he resolved.
 */
export function detectConflicts(
  readings: Reading[],
  existing: Conflict[] = [],
  now = new Date()
): Conflict[] {
  const groups = new Map<string, Reading[]>()
  for (const r of readings) {
    const k = `${r.metric} ${r.scope}`
    const list = groups.get(k)
    if (list) list.push(r)
    else groups.set(k, [r])
  }

  const byKey = new Map(existing.map((c) => [`${c.metric} ${c.scope}`, c]))
  const out: Conflict[] = []

  for (const [k, group] of groups) {
    // One source cannot disagree with itself. Two readings from the SAME source
    // for the same period is a re-sync, not a conflict — newest wins there.
    const bySource = new Map<string, Reading>()
    for (const r of group) {
      const held = bySource.get(r.source)
      if (!held || r.at > held.at) bySource.set(r.source, r)
    }
    const distinct = [...bySource.values()]
    if (distinct.length < 2) continue

    const values = distinct.map((r) => r.value)
    const min = Math.min(...values)
    const max = Math.max(...values)
    const difference = max - min
    const { floor, ratio } = materialityFor(distinct[0]!.metric)
    if (difference < floor) continue
    if (max === 0 || difference / max < ratio) continue

    const prior = byKey.get(k)
    const readingsOut = distinct
      .map((r) => ({ source: r.source, value: r.value, at: r.at }))
      .sort((a, b) => b.value - a.value)

    /**
     * A settled conflict stays settled while the same two sources keep saying
     * roughly the same thing. Re-asking every day which step source to trust,
     * about a discrepancy he has already ruled on, is exactly the "noisy
     * fortune cookie machine" this system is supposed not to be.
     */
    if (prior && prior.state !== 'open') {
      const sameSources =
        prior.readings.length === readingsOut.length &&
        prior.readings.every((p) => readingsOut.some((r) => r.source === p.source))
      if (sameSources) {
        out.push({ ...prior, readings: readingsOut, difference, differencePercent: pct(difference, max) })
        continue
      }
    }

    out.push({
      id: prior?.id ?? `conflict:${distinct[0]!.metric}:${distinct[0]!.scope}`,
      metric: distinct[0]!.metric,
      scope: distinct[0]!.scope,
      readings: readingsOut,
      difference,
      differencePercent: pct(difference, max),
      state: 'open',
      noticedAt: prior?.noticedAt ?? now.toISOString(),
      unit: distinct[0]!.unit,
    })
  }

  return out
}

const pct = (d: number, of: number) => (of === 0 ? 0 : Math.round((d / of) * 1000) / 10)

/**
 * Which source to believe for a metric, and how sure that is.
 *
 * Returns `null` rather than picking one when he has not said and the sources
 * disagree. A caller that gets null must say so on screen; it must not fall
 * back to "the first one" and print a number as though it were settled.
 */
export function authoritativeSource(p: Person_, metric: string): Fact<string> | null {
  const held = p.preferences[`source.${metric}`]
  return held && typeof held.value === 'string' ? (held as Fact<string>) : null
}

// ── The model itself ─────────────────────────────────────────────────────────

/**
 * Everything typed we know about him.
 *
 * Named `Person_` in code and `person` in the world, because `Person` is
 * already taken above by someone in his life — and those two really are
 * different things, so the collision is a signal rather than a nuisance.
 *
 * `identity` and `preferences` are open maps of Facts rather than named fields.
 * A named field per attribute would mean editing this file, the store, the
 * correction endpoint and the prompt every time he turns out to have one more
 * property, and would put a fixed list of what a human being can be into the
 * type system. The KEYS are conventional (see `SLOTS`) and the map is not
 * limited to them.
 */
export interface Person_ {
  /** 'identity.currentCountry', 'identity.languages', … */
  identity: Record<string, Fact>
  /** 'transport.default', 'browser.external', 'source.steps', … */
  preferences: Record<string, Fact>
  goals: Goal[]
  people: Person[]
  routines: Routine[]
  constraints: Constraint[]
  conflicts: Conflict[]
  /**
   * Questions put to him and not yet answered, so they are neither re-asked
   * nor forgotten. Keyed by slot.
   */
  asked: Record<string, { at: string; question: string; times: number }>
  /**
   * Slots a reader wanted THIS SESSION and could not get.
   *
   * This is what makes the question engine demand-driven rather than an
   * onboarding form: a question is worth asking because something concrete
   * tried to read the answer and stalled, and this records which thing. See
   * `demand()`.
   */
  demands: Record<string, {
    at: string
    why: string
    count: number
    /**
     * The instant the answer stops being useful, when the thing that wanted it has
     * one.
     *
     * WHY A COUNT ALONE IS NOT ENOUGH. Questions were ranked purely by how many
     * things had asked for the answer, and `count` accumulates across every build —
     * so a chronic gap ("what are you tracking activity for?", re-demanded on every
     * pass, forever) reaches a count no acute gap can catch. A question blocking a
     * journey tomorrow was structurally unable to out-rank it, and with at most one
     * question reaching Home per pass, that meant it was never asked at all.
     *
     * A deadline fixes it honestly: a demand attached to something happening soon is
     * asked first, and once that thing has passed it drops back to competing on
     * count like everything else.
     */
    before?: string
  }>
  /**
   * WHAT HE ACTUALLY DOES WITH WHAT WE SHOW HIM, PER SUBJECT.
   *
   * Deliberately NOT a preference, and kept in its own bag rather than under
   * `preferences` so that nothing can confuse the two. The distinction is the
   * whole design of the proactivity loop:
   *
   *   · A PREFERENCE is something he SAID. `by: 'user'`, permanent, outranks
   *     every inference, and only he may change it.
   *   · ENGAGEMENT is something he DID. Accepting six travel warnings and
   *     dismissing four activity nudges is real evidence about what is worth
   *     his attention, and it would be absurd to ignore it.
   *
   * Silently rewriting the first from the second is the failure to avoid. If he
   * has set `assistant.proactivity` to "high", dismissing three cards must not
   * quietly turn it down — he would find his stated setting had been overruled
   * by the app, with nothing on screen saying so. So engagement moves the
   * RANKING, within a bounded range, on top of whatever he stated, and the
   * stated value is never touched. See `engagementBiasOf`.
   *
   * Keyed by subject — 'travel', 'fitness' — which is the same vocabulary
   * `not-relevant` and `fitOf` already use.
   */
  engagement: Record<string, {
    /** He acted on it, opened it, or answered it. */
    accepted: number
    /** He dismissed it, or told us it was not relevant. */
    dismissed: number
    /** When the most recent of either was, so a stale opinion can decay. */
    at: string
  }>
  updatedAt: string
}

export const EMPTY_PERSON: Person_ = {
  identity: {},
  preferences: {},
  goals: [],
  people: [],
  routines: [],
  constraints: [],
  conflicts: [],
  asked: {},
  demands: {},
  engagement: {},
  updatedAt: '1970-01-01T00:00:00.000Z',
}

/**
 * Read the typed model off a world, filling in what an older stored world does
 * not have.
 *
 * A world written before this existed simply has no `person`, and gets an empty
 * one — the same degrade-do-not-break rule `addObservations` follows for
 * observations with no `data`. Spread field by field rather than
 * `{...EMPTY, ...held}` because a partially-written person (one key present,
 * the rest absent) must not end up with `undefined` where every reader expects
 * an array.
 */
export function readPerson(w: Pick<World, 'person'>): Person_ {
  const held = w.person
  /**
   * A FRESH EMPTY PERSON, NOT A SHALLOW COPY OF THE SHARED ONE.
   *
   * This was `{ ...EMPTY_PERSON }`, which copies the FIELDS and shares every array
   * and map inside them. So `setFact` on a world with no `person` wrote into
   * `EMPTY_PERSON.identity` — a module-level singleton — and `liftPeople` pushed into
   * `EMPTY_PERSON.people`. The next world to arrive without a stored person inherited
   * all of it.
   *
   * On the running app this is mostly invisible, because there is one world per
   * process and it acquires a `person` on the first write. It is catastrophic on the
   * edge, where one isolate serves several requests: facts about a cold-start world
   * would accumulate in the module and be read back as though they had been stored.
   * It also made every test that constructed an empty person leak into the next one,
   * which is how it was found.
   */
  if (!held) {
    return {
      identity: {},
      preferences: {},
      goals: [],
      people: [],
      routines: [],
      constraints: [],
      conflicts: [],
      asked: {},
      demands: {},
      engagement: {},
      updatedAt: EMPTY_PERSON.updatedAt,
    }
  }
  return {
    identity: held.identity ?? {},
    preferences: held.preferences ?? {},
    goals: held.goals ?? [],
    people: held.people ?? [],
    routines: held.routines ?? [],
    constraints: held.constraints ?? [],
    conflicts: held.conflicts ?? [],
    asked: held.asked ?? {},
    demands: held.demands ?? {},
    engagement: held.engagement ?? {},
    updatedAt: held.updatedAt ?? EMPTY_PERSON.updatedAt,
  }
}

/**
 * Write a fact, honouring the ownership rule, and say whether anything changed.
 *
 * Returning a boolean rather than throwing on refusal because a refused write
 * is the NORMAL case, not an error: every synthesis pass re-infers things he
 * has already corrected, and the correct behaviour is to leave his answer
 * alone and carry on quietly.
 */
export function setFact(p: Person_, into: 'identity' | 'preferences', f: Fact): boolean {
  const bag = p[into]
  const held = bag[f.key]
  if (!mayReplace(held, f.by)) return false
  // An identical value from the same kind of setter is not a change. Without
  // this, every sync rewrites `updatedAt` and everything downstream that keys
  // off "recently changed" fires on data that has been the same for a month.
  if (
    held &&
    JSON.stringify(held.value) === JSON.stringify(f.value) &&
    held.status === f.status &&
    held.by === f.by
  ) {
    return false
  }
  bag[f.key] = { ...f, askedAt: f.askedAt ?? held?.askedAt }
  p.updatedAt = new Date().toISOString()
  return true
}

/** Read a fact, or undefined. Never invents a default. */
export function getFact<T = unknown>(p: Person_, key: string): Fact<T> | undefined {
  return (p.identity[key] ?? p.preferences[key]) as Fact<T> | undefined
}

/**
 * Read a fact AND record that something needed it.
 *
 * The second half is the point. When the travel planner cannot find
 * `transport.default` it does not merely fall back — it leaves a note saying
 * that planning the route to a named event is what wanted it. The question
 * engine reads those notes, so the question he eventually sees is "Do you
 * normally walk to nearby events, or should I ask each time?" arriving on the
 * day it would change an answer, rather than in a setup wizard three weeks ago.
 */
export function demand<T = unknown>(
  p: Person_,
  key: string,
  why: string,
  opts: { before?: string } = {}
): Fact<T> | undefined {
  const held = getFact<T>(p, key)
  if (held && held.status !== 'unknown') return held
  const prior = p.demands[key]
  p.demands[key] = {
    at: new Date().toISOString(),
    why,
    count: (prior?.count ?? 0) + 1,
    // The nearest deadline wins: two things can want the same answer, and the one
    // happening sooner is the one that decides when it has to be asked.
    before:
      opts.before && (!prior?.before || opts.before < prior.before) ? opts.before : prior?.before,
  }
  return undefined
}

/** Clear a demand once it has been satisfied, so it stops being asked about. */
export function settled(p: Person_, key: string): void {
  delete p.demands[key]
}

// ── The slots the app knows how to use ───────────────────────────────────────

/**
 * A preference or identity slot that some behaviour reads.
 *
 * This is NOT a list of what he is allowed to have — the maps are open. It is
 * the list of keys that CODE reads, which is a different and much smaller set,
 * and it exists so a question can be asked in his language with real options
 * and an honest statement of what answering unlocks.
 *
 * `unlocks` is load-bearing: it is what ranks the question. A slot nothing
 * reads is never asked about, however empty it is.
 */
export interface Slot {
  key: string
  /** Put to him exactly as written. One question, his words, no preamble. */
  question: string
  /** What answering makes possible. Shown, so the question justifies itself. */
  unlocks: string
  /** Tappable answers. He can always reply in prose instead. */
  options?: { value: string; label: string }[]
  /** Freeform answers allowed? False for a genuine multiple choice. */
  freeform?: boolean
  /**
   * What TYPE the stored answer is, so a freeform reply can be coerced once,
   * here, rather than by each reader.
   *
   * This exists because `identity.drives` is a boolean and the old path stored
   * the string "No" — which is truthy. Every reader then either wrote its own
   * parser or got the answer exactly backwards. Declaring the type beside the
   * question is what lets `recordAnswer` write `false` and be done. Absent means
   * a string, which is most of them.
   */
  answers?: 'string' | 'boolean' | 'number' | 'list'
  /**
   * Offer this in the settings surface even when nothing has demanded it.
   *
   * Almost nothing should. The demand-driven rule is what keeps this app from
   * being an onboarding questionnaire, and a slot that appears in settings
   * unprompted has to be one he would plausibly go LOOKING for — how proactive
   * the assistant is, for instance, which is a thing people want to change
   * without waiting to be asked.
   */
  settings?: { section: string; label: string }
}

export const SLOTS: Record<string, Slot> = {
  'transport.default': {
    key: 'transport.default',
    question: 'How do you usually get to things near you?',
    unlocks: 'travel times and a leave-by time on your calendar events',
    options: [
      { value: 'walk', label: 'Walk' },
      { value: 'transit', label: 'Bus or train' },
      { value: 'cycle', label: 'Cycle' },
      { value: 'drive', label: 'Drive' },
      { value: 'ask', label: 'Ask me each time' },
    ],
  },
  'source.steps': {
    key: 'source.steps',
    question: 'Which should I trust for your daily steps?',
    unlocks: 'one activity number instead of two that disagree',
    // Options are filled in from the conflict itself — the sources that
    // actually disagree, never a hardcoded list of vendors.
  },
  'fitness.objective': {
    key: 'fitness.objective',
    /*
      40 characters, and that is not a style preference — it is the copy budget
      in docs/ui-contract.md. The previous wording was 57, which is fine on its
      own and is not fine above a two-line baseline and four chips inside a
      224px card. See `homeCopy.ts`.
    */
    question: 'What do you want from activity tracking?',
    unlocks: 'activity shown against your goal instead of a bare step count',
    options: [
      { value: 'walk-more', label: 'Walk more' },
      { value: 'cardio', label: 'Cardio fitness' },
      { value: 'maintain', label: 'Keep it steady' },
      { value: 'train', label: 'Training for something' },
      { value: 'observe', label: 'Just watching' },
    ],
    freeform: true,
  },
  'video.destination': {
    key: 'video.destination',
    question: 'Where should videos open?',
    unlocks: 'one tap to watch instead of a menu every time',
    // Options come from what this device can actually do — see externalOpen.
  },
  'identity.languages': {
    key: 'identity.languages',
    question: 'Which languages do you use day to day?',
    unlocks: 'knowing what you can read, and what would be practice',
    freeform: true,
  },
  'identity.home': {
    key: 'identity.home',
    question: 'Where should I treat as home when you have no live location?',
    unlocks: 'travel times when your phone has not reported a position',
    freeform: true,
  },
  /**
   * The question whose answer was thrown away twice.
   *
   * It had no slot at all — it was asked by a synthesis card, in prose, and the
   * answer went into the observation list as a sentence. Declaring it means the
   * answer is a typed boolean written `by: 'user'` at the moment he taps it, and
   * that the app can tell it has already been asked.
   */
  'identity.drives': {
    key: 'identity.drives',
    question: 'Do you drive?',
    unlocks: 'journeys planned the way you actually travel, not by car',
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ],
    answers: 'boolean',
  },
  /**
   * HOW MUCH HE WANTS TO HEAR FROM IT.
   *
   * `fitOf` has read this key since the attention model landed, and there was no
   * way to set it except by POSTing to the correction endpoint by hand — a
   * preference the ranker obeys and the person it describes cannot reach. It is
   * asked when the ranking has visibly held things back (see `insight.ts`), and
   * it sits in settings, because "this app talks too much" is a complaint people
   * act on without being prompted.
   */
  'assistant.proactivity': {
    key: 'assistant.proactivity',
    question: 'How much should I bring to you unprompted?',
    unlocks: 'a home screen pitched at how much you actually want to hear',
    options: [
      { value: 'low', label: 'Only when it matters' },
      { value: 'medium', label: 'A balance' },
      { value: 'high', label: 'Tell me everything' },
    ],
    settings: { section: 'How I work', label: 'How much I raise' },
  },
  /**
   * WHETHER TO ASK OR TO ASSUME.
   *
   * The other half of the same dial and genuinely a different preference: someone
   * can want few cards and still want to be asked rather than guessed at. Read by
   * the clarification path, which drops questions entirely on 'assume' and lets
   * two through at once on 'ask'.
   */
  'assistant.clarification': {
    key: 'assistant.clarification',
    question: 'When I do not know something, would you rather I asked or made a sensible guess?',
    unlocks: 'fewer questions, or fewer assumptions — whichever you prefer',
    options: [
      { value: 'ask', label: 'Ask me' },
      { value: 'balanced', label: 'Ask if it matters' },
      { value: 'assume', label: 'Just make a guess' },
    ],
    settings: { section: 'How I work', label: 'When I am unsure' },
  },
}

/** The slots the settings surface offers directly, grouped as declared. */
export const SETTINGS_SLOTS = Object.values(SLOTS).filter((s) => s.settings)

/**
 * How proactive to be, as a number the ranker can multiply by.
 *
 * One reading of the preference, so `fitOf`, the clarification cap and the Home
 * limit cannot disagree about what "low" means.
 */
export function proactivityOf(p: Person_): 'low' | 'medium' | 'high' {
  const v = p.preferences['assistant.proactivity']?.value
  return v === 'low' || v === 'high' ? v : 'medium'
}

export function clarificationStyleOf(p: Person_): 'ask' | 'balanced' | 'assume' {
  const v = p.preferences['assistant.clarification']?.value
  return v === 'ask' || v === 'assume' ? v : 'balanced'
}

// ── Learning from what he does, without overruling what he said ──────────────

/**
 * Record that a card about a subject was acted on, or was dismissed.
 *
 * Counts rather than a running average, because the two numbers answer different
 * questions and a single ratio hides the one that matters most: how much
 * evidence there is at all. Two dismissals are not an opinion.
 */
export function noteEngagement(
  p: Person_,
  about: string,
  verdict: 'accepted' | 'dismissed',
  now = new Date()
): void {
  if (!about) return
  const held = p.engagement[about] ?? { accepted: 0, dismissed: 0, at: now.toISOString() }
  p.engagement[about] = {
    accepted: held.accepted + (verdict === 'accepted' ? 1 : 0),
    dismissed: held.dismissed + (verdict === 'dismissed' ? 1 : 0),
    at: now.toISOString(),
  }
  p.updatedAt = now.toISOString()
}

/**
 * ENOUGH TIMES TO BE A PATTERN RATHER THAN A MOOD.
 *
 * Four is not a statistical threshold, it is a judgement about the cost of being
 * wrong in each direction. Reacting after one dismissal means a card he happened
 * to swipe on a bus disappears for a month; waiting for twenty means the loop
 * never closes on a subject that only comes up weekly.
 */
export const ENGAGEMENT_MIN = 4

/**
 * HOW HIS BEHAVIOUR NUDGES THE RANKING. NEVER MORE THAN A NUDGE.
 *
 * Returns roughly -0.2..+0.2, added to the `fit` axis on top of whatever he has
 * stated. Three properties are deliberate:
 *
 *   · IT IS BOUNDED. However many activity nudges he dismisses, the subject
 *     cannot be driven off the screen by this alone — that is what
 *     `not-relevant` is for, which is him SAYING it, and which is visible in
 *     settings and reversible by him. A behavioural signal that could silently
 *     suppress a whole subject would be an invisible filter, and this codebase
 *     has an argument about those already.
 *   · IT NEEDS EVIDENCE. Below `ENGAGEMENT_MIN` interactions it returns 0.
 *   · IT DECAYS. An opinion formed from a fortnight ago is halved, and one from
 *     two months ago is gone. What he wanted in June is not evidence about
 *     August, and a loop with no decay is a loop that cannot be changed by
 *     changing his mind.
 */
export function engagementBiasOf(p: Person_, about: string | undefined, now = new Date()): number {
  if (!about) return 0
  const held = p.engagement[about]
  if (!held) return 0
  const total = held.accepted + held.dismissed
  if (total < ENGAGEMENT_MIN) return 0

  const days = (now.getTime() - Date.parse(held.at)) / 86_400_000
  const freshness = !Number.isFinite(days) ? 1 : days <= 14 ? 1 : days <= 60 ? 0.5 : 0
  if (!freshness) return 0

  // -1 (always dismissed) .. +1 (always acted on), scaled into the nudge range.
  const lean = (held.accepted - held.dismissed) / total
  return Math.round(lean * 0.2 * freshness * 1000) / 1000
}

// ── Learning the typed model from what is already there ──────────────────────

/**
 * Lift structure out of the observation list. A RESCUE PASS, NOT AN INGESTION
 * PATH.
 *
 * There is a real temptation to skip this and only populate the typed model
 * going forward. That would be wrong for one reason: everything he has ALREADY
 * told this app is sitting in `observations` as prose, including the answers to
 * questions it is about to ask him again. Re-asking a man whether he drives,
 * when he answered twice, is the single most obvious way for this to feel like
 * it has no memory.
 *
 * WHAT THIS IS EXPLICITLY NOT FOR. New answers do not come through here. They are
 * written as typed facts at the moment he gives them, by `answer.ts`, which
 * carries the argument for why in full: prose round-tripping downgrades
 * `by: 'user'` to `by: 'agent'`, only works for sentences someone anticipated,
 * and lands a build late. This function exists for the backlog and for a sentence
 * that arrived through some path nobody has typed a slot for yet. It is a floor,
 * not a road.
 *
 * Deliberately conservative. It only lifts what is unambiguous, and everything
 * it produces is `inferred`/`agent` with the observation id as basis, so his
 * first correction overrides it permanently and the provenance says plainly that
 * this was read out of a sentence rather than asked. Notably it therefore CANNOT
 * overwrite anything `answer.ts` wrote, which is the property that makes it safe
 * to keep running.
 *
 * What it does NOT do is guess. A sentence it does not recognise stays a
 * sentence; the synthesis pass still reads all of them, exactly as before.
 */
export function liftFromObservations(p: Person_, obs: Observation[]): string[] {
  const learned: string[] = []
  const said = obs.filter((o) => o.source === 'user')

  for (const o of said) {
    const t = o.text.toLowerCase()

    // "Do you drive?" → No. Asked by the app, answered by him: the clearest
    // possible signal, and currently the most thoroughly wasted one.
    if (/do you drive\?/.test(t) && /\bhe said:\s*no\b/.test(t)) {
      if (
        setFact(
          p,
          'identity',
          fact('identity.drives', false, {
            source: 'user',
            status: 'user_provided',
            confidence: 1,
            by: 'agent',
            sourceAt: o.at,
            basis: [o.id],
            note: 'He answered "No" when asked whether he drives.',
            askedAt: o.at,
          })
        )
      ) {
        learned.push('identity.drives = false')
        addConstraint(p, {
          kind: 'transport',
          what: 'Does not drive',
          basis: [o.id],
          confidence: 1,
          by: 'agent',
        })
      }
    }

    // "I walk to the market on Sundays" — a routine AND a transport signal.
    if (/\bi walk\b/.test(t)) {
      const added = addRoutine(p, {
        what: 'Walks to the market',
        cadence: /sunday/.test(t) ? 'Sundays' : 'regularly',
        basis: [o.id],
        confidence: 0.8,
        by: 'agent',
      })
      if (added) learned.push('routine: walks to the market')
    }

    /**
     * "Lives in Castiglione dei Pepoli, a mountain village in the Bologna
     * Apennines." — the single most useful sentence in his observation list,
     * and the one nothing could read.
     *
     * Only the place NAME is lifted, not coordinates: geocoding belongs to the
     * planner, which knows how to cache the answer and how to report an
     * ambiguous one. Storing a name here and a point there also keeps the two
     * correctable separately, which matters — the village is right even when
     * the geocoder puts the pin on the wrong side of it.
     */
    // Case-insensitive against the ORIGINAL text, not the lowercased copy: the
    // place name has to come back with its capitals ("Castiglione dei Pepoli"),
    // and matching on `t` would store a lowercased town.
    const lives = /lives in ([^,.]{3,60})/i.exec(o.text)
    if (lives?.[1]) {
      const place = lives[1].trim()
      if (
        setFact(
          p,
          'identity',
          fact('identity.home', place, {
            source: 'user',
            status: 'user_provided',
            confidence: 0.9,
            by: 'agent',
            sourceAt: o.at,
            basis: [o.id],
            note: `Read from "${clip(o.text, 90)}".`,
          })
        )
      ) {
        learned.push(`identity.home = ${place}`)
      }
    }

    if (/takes the bus/.test(t)) {
      const added = addRoutine(p, {
        what: 'Takes the bus into town to shop',
        cadence: 'when shopping',
        basis: [o.id],
        confidence: 0.8,
        by: 'agent',
      })
      if (added) learned.push('routine: bus into town')
    }
  }

  return learned
}

/** Add a constraint unless an equivalent one is already held. */
export function addConstraint(
  p: Person_,
  c: Omit<Constraint, 'id' | 'updatedAt'> & { id?: string }
): boolean {
  const id = c.id ?? `constraint:${slug(c.what)}`
  const held = p.constraints.find((x) => x.id === id)
  if (held && held.by === 'user' && c.by !== 'user') return false
  const next: Constraint = { ...c, id, updatedAt: new Date().toISOString() }
  if (held) {
    if (held.what === next.what && held.kind === next.kind) return false
    Object.assign(held, next)
  } else {
    p.constraints.push(next)
  }
  p.updatedAt = next.updatedAt
  return true
}

export function addRoutine(
  p: Person_,
  r: Omit<Routine, 'id' | 'updatedAt'> & { id?: string }
): boolean {
  const id = r.id ?? `routine:${slug(r.what)}`
  const held = p.routines.find((x) => x.id === id)
  if (held && held.by === 'user' && r.by !== 'user') return false
  const next: Routine = { ...r, id, updatedAt: new Date().toISOString() }
  if (held) {
    // Merge evidence rather than replacing it: a routine seen three times is
    // better supported than the same routine seen once, and overwriting the
    // basis would throw that away on every pass.
    next.basis = [...new Set([...held.basis, ...r.basis])]
    next.confidence = Math.min(0.98, Math.max(held.confidence, r.confidence) + (next.basis.length > held.basis.length ? 0.05 : 0))
    const same = held.what === next.what && held.cadence === next.cadence && held.basis.length === next.basis.length
    Object.assign(held, next)
    if (same) return false
  } else {
    p.routines.push(next)
  }
  p.updatedAt = next.updatedAt
  return true
}

export function addGoal(p: Person_, g: Omit<Goal, 'createdAt' | 'updatedAt' | 'id'> & { id?: string }): Goal {
  const id = g.id ?? `goal:${slug(g.description)}`
  const now = new Date().toISOString()
  const held = p.goals.find((x) => x.id === id)
  if (held) {
    if (held.by === 'user' && g.by !== 'user') return held
    Object.assign(held, g, { id, updatedAt: now })
    p.updatedAt = now
    return held
  }
  const next: Goal = { ...g, id, createdAt: now, updatedAt: now }
  p.goals.push(next)
  p.updatedAt = now
  return next
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)

// ── What the model gets told ─────────────────────────────────────────────────

/**
 * The typed model, rendered for a prompt.
 *
 * Kept short on purpose. The synthesis pass already receives every observation;
 * this is not a second copy of his life, it is the SETTLED conclusions — the
 * things that should stop being re-derived on every pass and should never be
 * contradicted. Empty sections are omitted rather than printed as "none", so a
 * cold-start person does not spend a third of the prompt on empty headings.
 *
 * Unknown-but-demanded slots are included deliberately. Telling the model what
 * it does not know, and what that is blocking, is what turns "ask when asking
 * beats guessing" from an instruction into something it can act on precisely.
 */
export function renderPerson(p: Person_): string {
  const out: string[] = []

  /**
   * Not everything stored is worth a line in the prompt.
   *
   * `place.*` is a geocoding cache and `reading.*` is raw per-day numbers —
   * both grow without limit and neither tells the model anything about who he
   * is. Left in, a month of events would spend a third of the prompt listing
   * coordinates. The observation list already carries the underlying facts.
   */
  const noisy = (key: string) => key.startsWith('place.') || key.startsWith('reading.')
  const facts = [...Object.values(p.identity), ...Object.values(p.preferences)].filter(
    (f) => f.status !== 'unknown' && !noisy(f.key)
  )
  if (facts.length) {
    out.push('SETTLED ABOUT HIM (do not contradict these; his answers outrank your inferences):')
    for (const f of facts) {
      const how =
        f.status === 'user_provided' ? 'he told you' : f.status === 'verified' ? `from ${f.source}` : f.status
      out.push(`- ${f.key} = ${render(f.value)} (${how})`)
    }
  }

  const active = p.goals.filter((g) => g.status === 'active')
  if (active.length) {
    out.push('', 'WHAT HE IS TRYING TO DO:')
    for (const g of active) {
      const bits = [g.outcome ? `wants: ${g.outcome}` : '', g.timeframe ? `by ${g.timeframe}` : '']
        .filter(Boolean)
        .join('; ')
      out.push(`- ${g.description}${bits ? ` (${bits})` : ''}`)
    }
  }

  if (p.constraints.length) {
    out.push('', 'WHAT HE CANNOT DO (these are not preferences; do not suggest around them):')
    for (const c of p.constraints) out.push(`- ${c.what}`)
  }

  if (p.routines.length) {
    out.push('', 'WHAT HE DOES REGULARLY:')
    for (const r of p.routines) out.push(`- ${r.what}, ${r.cadence}`)
  }

  const openConflicts = p.conflicts.filter((c) => c.state === 'open')
  if (openConflicts.length) {
    out.push('', 'SOURCES THAT DISAGREE (never state one of these as settled fact):')
    for (const c of openConflicts) {
      out.push(
        `- ${c.metric} for ${c.scope}: ${c.readings.map((r) => `${r.source} says ${r.value}`).join(', ')} — ${c.differencePercent}% apart, unresolved`
      )
    }
  }

  const wanted = Object.entries(p.demands).filter(([k]) => !getFact(p, k))
  if (wanted.length) {
    out.push('', 'WHAT YOU DO NOT KNOW, AND WHAT IT IS BLOCKING:')
    for (const [k, d] of wanted) out.push(`- ${k}: needed for ${d.why}`)
  }

  return out.join('\n')
}

const render = (v: unknown): string =>
  Array.isArray(v) ? v.join(', ') : typeof v === 'object' && v ? JSON.stringify(v) : String(v)
