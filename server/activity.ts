/**
 * ACTIVITY, REBUILT AROUND THE GOAL AND THE SOURCE.
 *
 * What the surface used to be: seven bars, an average, and a dashed line at that
 * average. Read against his real data on 2026-08-11 it said `Steps 7-day average
 * 4,385/day` and nothing else — which is a number with no meaning attached,
 * because 4,385 is progress for one person, a red flag for another and irrelevant
 * to a third. `think.ts` has had a standing rule about exactly this since the
 * beginning ("a step count is a weight-loss signal for one person, a weight-GAIN
 * signal for another; never assume which"). The surface obeyed it by saying
 * nothing at all, which is not obedience, it is abdication.
 *
 * Meanwhile the world model held the machinery to do better and none of it was
 * wired to the screen: an active `Goal` with a target and a direction, a
 * `source.steps` preference naming which source to believe, and an open
 * `Conflict` when two of them disagreed.
 *
 * So this file computes one honest report, and the surface renders it. Five
 * things, in the order they matter:
 *
 *   · THE TRUSTED CURRENT VALUE, or an explicit refusal. If two sources disagree
 *     and he has not ruled, there IS no current value, and printing one would be
 *     picking a winner by fiat — the thing `person.ts` built the conflict type to
 *     prevent.
 *   · THE TREND, with its own denominator. An average over "this week" that
 *     silently divided by three recorded days out of seven is the single most
 *     common way a health chart lies.
 *   · PROGRESS AGAINST THE GOAL, in the goal's own direction. Never a percentage
 *     of a target he never set.
 *   · WHAT IS MISSING OR IN DISPUTE, named. "You barely moved" and "nothing has
 *     synced since Friday" look identical on a chart and mean opposite things.
 *   · ONE NEXT ACTION, and only if there genuinely is one.
 *
 * AND THE REFUSAL THAT MATTERS MOST: if the source cannot support the goal, it
 * says so. He can name Apple Health as authoritative — the correct answer, it is
 * his phone — and no web app can read it. The old behaviour was that activity
 * reporting silently stopped. Here that becomes a stated sentence with a way out.
 */

import type { Ground } from './attention.js'
import {
  addDays,
  dayIn,
  daysBetweenDays,
  relativeDay,
  trailingWindow,
} from './clock.js'
import {
  authoritativeSource,
  type Conflict,
  type Goal,
  type GoalSignal,
  type Person_,
} from './person.js'
import type { World } from './world.js'


/**
 * HOW A GOAL READS. COMPILED FROM THE TYPED FIELDS, NEVER FROM STORED PROSE.
 *
 * What his account actually holds, saved once and then permanent:
 *
 *     "3221 steps of steps a day"
 *
 * Two defects in one string, from `${target}${unit} of ${metric} a day` where the
 * unit and the metric are both "steps": the noun is doubled and the number is
 * unformatted, beside a progress readout that reads `2,796 / 3,221`.
 *
 * §44 is the general lesson and this is the smallest possible instance of it: a
 * sentence cached longer than the thing it describes stays valid. So the phrase
 * is RECOMPILED on read — which repairs the goal already in his world without a
 * migration, and cannot be written wrong again because there is one expression.
 *
 * A description HE wrote is left exactly alone. Only the generated shape is
 * recognised and replaced, because losing "walk more in the mornings" to a
 * tidy-up would be a worse bug than the one being fixed.
 */
const GENERATED_GOAL = /^\s*[\d,.]+\s*(\w+\s+)?of\s+\w+\s+a day\s*$/i

export function goalPhrase(
  target: number,
  metric: string,
  unit?: string,
  stored?: string
): string {
  if (stored && !GENERATED_GOAL.test(stored)) return stored
  const noun = unit && unit.toLowerCase() !== metric.toLowerCase() ? `${unit} of ${metric}` : (unit || metric)
  return `${Math.round(target).toLocaleString('en-GB')} ${noun} a day`
}

export interface Reading {
  date: string
  value: number
}

/** Where the number comes from, and whether it can do the job asked of it. */
export interface SourceState {
  /** The source we are reading, or null when nothing can be read. */
  id: string | null
  /**
   * How that was decided.
   *
   *   'chosen' — he named it authoritative.
   *   'only'   — it is the only one there is, so no choice was needed.
   *   'disputed' — two disagree and he has not ruled. `id` is null.
   *   'none'   — nothing has ever reported this metric.
   */
  by: 'chosen' | 'only' | 'disputed' | 'none'
  /** Can the chosen source actually supply a series to measure a goal against? */
  canSupportGoal: boolean
  /** Said on screen whenever `canSupportGoal` is false. Never silent. */
  why?: string
  /** Every source that has reported this metric, for the correction chips. */
  available: string[]
}

export interface Trend {
  /** The window measured, oldest first, INCLUDING days with no reading. */
  days: { date: string; value: number | null }[]
  windowDays: number
  /** Days that actually have a reading. The average's real denominator. */
  covered: number
  /** Average over covered days only. Null when nothing is covered. */
  average: number | null
  /** The same average over the preceding window, for comparison. */
  priorAverage: number | null
  /** Percent change against the prior window. Null when either side is empty. */
  changePercent: number | null
  direction: 'up' | 'down' | 'flat' | 'unknown'
}

export interface GoalProgress {
  goalId: string
  description: string
  target: number
  unit?: string
  direction: GoalSignal['direction']
  /** The measured figure being compared to the target. */
  current: number
  /** 0..1 against the target, clamped. Meaningless for 'steady' — see below. */
  fraction: number | null
  met: boolean
  /** In the metric's units, always positive. */
  shortfall: number
  timeframe?: string
}

export interface Gap {
  /** Days in the window with no reading at all. */
  missingDays: string[]
  /** Whole days between the newest reading and today. 0 means up to date. */
  staleDays: number
  /** The newest day anything was reported for, as `YYYY-MM-DD`. */
  lastDay: string | null
  /**
   * THAT DAY, THE WAY HE WOULD SAY IT. "Friday", "yesterday", "4 Aug".
   *
   * Carried alongside the machine date rather than left to each reader, and the
   * reason is a specific line that shipped: `Nothing since ${gap.lastDay}`,
   * which put "Nothing since 2026-08-07" on his home screen — an ISO date, in
   * an app that had just spent a whole pass moving every other date onto
   * `clock.ts`'s vocabulary. A reader given a `YYYY-MM-DD` will eventually
   * print it; a reader given both has no excuse.
   */
  lastDayLabel: string
}

/**
 * TODAY, THE NEWEST TRUSTED DAY, AND THE TREND ARE THREE DIFFERENT THINGS.
 *
 * They were two, and the missing one was the interesting one. `current` meant
 * "the newest reading we trust", which on a Tuesday whose data had not synced
 * since Friday was Friday's 4,385 — a correct number, presented in the position
 * a reader takes for "how am I doing today". Nothing on the surface said it was
 * four days old except a sentence further down that he had no reason to read.
 *
 * That is not a wording problem. Today's absence is a FACT ABOUT THE FEED and it
 * is often the most important thing on the screen: "you barely moved" and
 * "nothing has synced since Friday" look identical on a chart and mean opposite
 * things. So today gets its own field, which is null when there is no reading
 * for it, and every renderer has to decide what to do about that rather than
 * being handed a number that quietly stands in.
 */
export interface Freshness {
  /** The day it is now, in HIS zone. Never the runtime's. */
  today: string
  /** Is there a trusted reading for today at all? */
  haveToday: boolean
  /** Today's value, when there is one. Null is a fact, not a zero. */
  todayValue: number | null
  /** How out of date the newest reading is, in whole days. 0 means current. */
  staleDays: number
  /**
   * How loudly the surface should say so.
   *
   *   'current' — today's reading is in.
   *   'lagging' — yesterday's is the newest. Ordinary; phones sync late.
   *   'stale'   — two days or more. The number on screen is history.
   */
  level: 'current' | 'lagging' | 'stale'
}

/** The one thing worth doing about the state of this metric, if anything is. */
export interface NextAction {
  label: string
  detail: string
  /**
   * What it is, so the surface can wire it to something real rather than draw a
   * button that does nothing. Each maps to an existing endpoint or correction.
   */
  does:
    | { kind: 'choose-source'; metric: string; options: string[] }
    | { kind: 'set-goal'; metric: string }
    | { kind: 'enter-reading'; metric: string; day: string }
    | { kind: 'reconnect'; source: string }
    | { kind: 'nothing' }
}

export interface ActivityReport {
  metric: string
  unit?: string
  source: SourceState
  /**
   * The trusted figure for the most recent covered day. Null when disputed.
   *
   * `isToday` is the field that stops this being read as "today's number". It
   * was not there, and the surface printed Friday's 4,385 on a Tuesday in the
   * position a reader takes for today — correct, and unreadable as anything but
   * a lie. See `Freshness`.
   */
  current: { day: string; value: number; label: string; isToday: boolean } | null
  /** How old the newest reading is, and how loudly to say so. */
  freshness: Freshness
  trend: Trend
  goal: GoalProgress | null
  gap: Gap
  /** Open disagreements about this metric. Rendered, never resolved silently. */
  conflicts: Conflict[]
  next: NextAction
  /**
   * ONE SENTENCE, and it is the whole report in miniature.
   *
   * Composed here rather than by a model because it has to be exactly true: it
   * states the goal if there is one, the number if there is a trustworthy one,
   * and the reason there is not if there is not. This is what the Home row and
   * the surface header both read, so they cannot say different things.
   */
  says: string
  /** Why the surface shows what it shows. Same contract as an attention item. */
  grounds: Ground[]
}

// ── Reading the series ───────────────────────────────────────────────────────

/**
 * Every reading for a metric, per source, newest reading of each day winning.
 *
 * The merge rule is the one `panes.ts` and `insight.ts` both already use and
 * document at length: syncs write overlapping windows under different ids, so
 * taking one record hides the rest and days present only in an older record
 * disappear. Kept here as the single implementation the surface, the Home row and
 * the goal check all read, because those three disagreeing about the same week is
 * the exact class of bug the canonical-read design exists to stop.
 */
export function seriesBySource(w: Pick<World, 'observations'>, metric = 'steps'): Map<string, Reading[]> {
  const out = new Map<string, Map<string, number>>()
  const newestFirst = [...w.observations].sort((a, b) => b.at.localeCompare(a.at))

  for (const o of newestFirst) {
    if (o.data?.kind !== 'steps' || metric !== 'steps') continue
    const id = o.source === 'health' ? 'google-fit' : o.source
    const byDay = out.get(id) ?? new Map<string, number>()
    out.set(id, byDay)
    for (const d of o.data.days) if (!byDay.has(d.date)) byDay.set(d.date, d.steps)
  }

  /**
   * Numbers he typed himself count as a source like any other.
   *
   * Stored by `noteReading` as `reading.<metric>.<day>` with the source's NAME in
   * the note — "my phone says 10,347". Reading them here is what makes a
   * disagreement between his phone and Google Fit representable at all, rather
   * than a value that overwrites and loses the fact that two were reported.
   */
  const person = (w as { person?: Person_ }).person
  for (const [key, f] of Object.entries(person?.identity ?? {})) {
    const m = new RegExp(`^reading\\.${metric}\\.(\\d{4}-\\d{2}-\\d{2})$`).exec(key)
    if (!m || typeof f.value !== 'number') continue
    const id = typeof f.note === 'string' && f.note ? f.note : 'you'
    const byDay = out.get(id) ?? new Map<string, number>()
    out.set(id, byDay)
    if (!byDay.has(m[1]!)) byDay.set(m[1]!, f.value)
  }

  const result = new Map<string, Reading[]>()
  for (const [id, byDay] of out) {
    result.set(
      id,
      [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, value]) => ({ date, value }))
    )
  }
  return result
}

/**
 * Which source to read, and whether we are allowed to read one at all.
 *
 * The 'disputed' branch is the one that took work. When two sources disagree and
 * he has not ruled, the honest answer is that there is no current value — so this
 * returns a null id and every downstream figure becomes null with a stated
 * reason, rather than the surface quietly picking whichever sorted first.
 */
export function sourceStateFor(
  p: Person_,
  series: Map<string, Reading[]>,
  metric: string,
  openConflicts: Conflict[]
): SourceState {
  const available = [...series.keys()].sort()
  const chosen = authoritativeSource(p, metric)

  if (chosen) {
    const held = series.get(chosen.value) ?? []
    /**
     * HE NAMED A SOURCE WE CANNOT CONTINUOUSLY READ.
     *
     * Three days is the floor for calling something a series: below that there is
     * nothing to trend and nothing to average, so a goal cannot be measured
     * against it however authoritative it is. The decision stays HIS — it is not
     * overridden here — and what changes is that the consequence is stated.
     */
    if (held.length < 3) {
      const alternative = available.find((s) => s !== chosen.value && (series.get(s)?.length ?? 0) >= 3)
      return {
        id: chosen.value,
        by: 'chosen',
        canSupportGoal: false,
        why: held.length
          ? `You told me to trust ${chosen.value}, and I only have ${held.length} day${held.length === 1 ? '' : 's'} from it — not enough to show a trend or measure a goal against.` +
            (alternative ? ` ${alternative} has a continuous series if you would rather I used that.` : '')
          : `You told me to trust ${chosen.value}, and nothing from it has reached me.` +
            (alternative ? ` The only continuous series I can read is ${alternative}'s.` : ''),
        available,
      }
    }
    return { id: chosen.value, by: 'chosen', canSupportGoal: true, available }
  }

  const open = openConflicts.filter((c) => c.metric === metric && c.state === 'open')
  if (open.length) {
    return {
      id: null,
      by: 'disputed',
      canSupportGoal: false,
      why:
        `${open[0]!.readings.map((r) => `${r.source} says ${r.value.toLocaleString()}`).join(' and ')} for ${open[0]!.scope}. ` +
        `Until you tell me which to trust I will not put a single figure on screen.`,
      available,
    }
  }

  if (!available.length) {
    return { id: null, by: 'none', canSupportGoal: false, why: `Nothing has reported ${metric} yet.`, available }
  }
  const only = available[0]!
  const held = series.get(only) ?? []
  return {
    id: only,
    by: 'only',
    canSupportGoal: held.length >= 3,
    why: held.length >= 3 ? undefined : `Only ${held.length} day${held.length === 1 ? '' : 's'} of ${metric} so far — too little to measure against a goal.`,
    available,
  }
}

// ── The trend ────────────────────────────────────────────────────────────────

/**
 * A trailing average that names its own denominator.
 *
 * `days` deliberately carries `null` for days with no reading rather than
 * omitting them, because the SHAPE of the window is information: four blanks and
 * three bars is a coverage problem, and a chart of three bars is a quiet week.
 * The average divides by covered days only — dividing by seven would invent four
 * zero-step days and halve him — and `covered` is returned so the label can say
 * so.
 */
export function trendOf(readings: Reading[], now: Date, windowDays: number, tz?: string): Trend {
  const window = trailingWindow(now, windowDays, tz)
  const byDay = new Map(readings.map((r) => [r.date, r.value]))
  const days = window.days.map((date) => ({ date, value: byDay.get(date) ?? null }))
  const present = days.flatMap((d) => (d.value === null ? [] : [d.value]))
  const average = present.length ? Math.round(present.reduce((a, b) => a + b, 0) / present.length) : null

  const priorFrom = addDays(window.from, -windowDays)
  const prior: number[] = []
  for (let i = 0; i < windowDays; i++) {
    const v = byDay.get(addDays(priorFrom, i))
    if (v !== undefined) prior.push(v)
  }
  const priorAverage = prior.length ? Math.round(prior.reduce((a, b) => a + b, 0) / prior.length) : null

  const changePercent =
    average !== null && priorAverage !== null && priorAverage !== 0
      ? Math.round(((average - priorAverage) / priorAverage) * 1000) / 10
      : null

  return {
    days,
    windowDays,
    covered: present.length,
    average,
    priorAverage,
    changePercent,
    /**
     * FLAT IS A REAL ANSWER AND HAS A THRESHOLD.
     *
     * Without one, every week is "up" or "down" by a fraction of a percent, and a
     * trend arrow that always points somewhere carries no information. Five
     * percent is a judgement about what a person would notice, not a measurement.
     */
    direction:
      changePercent === null
        ? 'unknown'
        : changePercent > 5
          ? 'up'
          : changePercent < -5
            ? 'down'
            : 'flat',
  }
}

// ── Progress ─────────────────────────────────────────────────────────────────

/** The active goal that this metric is a signal for, if he has one. */
export function goalFor(p: Person_, metric: string): { goal: Goal; signal: GoalSignal } | null {
  for (const g of p.goals) {
    if (g.status !== 'active') continue
    const signal = g.signals.find((s) => s.metric === metric)
    if (signal) return { goal: g, signal }
  }
  return null
}

function progressOf(goal: Goal, signal: GoalSignal, current: number): GoalProgress | null {
  if (signal.target === undefined) return null
  const target = signal.target
  /**
   * PROGRESS IS MEASURED IN THE GOAL'S OWN DIRECTION.
   *
   * A target of 8,000 with direction 'up' is met at 8,200. The same target with
   * direction 'down' — someone told to reduce load while an injury heals — is
   * MISSED at 8,200, and a bar that filled up as he overshot would be reporting
   * his setback as an achievement.
   *
   * 'steady' has no fraction at all. There is no honest way to draw "keep it
   * about here" as a progress bar, and inventing one would be a chart implying a
   * finish line that does not exist.
   */
  const met = signal.direction === 'up' ? current >= target : signal.direction === 'down' ? current <= target : Math.abs(current - target) <= target * 0.1
  const fraction =
    signal.direction === 'steady'
      ? null
      : signal.direction === 'up'
        ? Math.max(0, Math.min(1, target === 0 ? 1 : current / target))
        // Counting down: full when at or below target, emptying as it rises.
        : Math.max(0, Math.min(1, target === 0 ? (current === 0 ? 1 : 0) : Math.min(1, target / Math.max(current, 1))))

  return {
    goalId: goal.id,
    description: goalPhrase(target, signal.metric, signal.unit, goal.description),
    target,
    unit: signal.unit,
    direction: signal.direction,
    current,
    fraction,
    met,
    shortfall: Math.abs(target - current),
    timeframe: goal.timeframe,
  }
}

// ── The report ───────────────────────────────────────────────────────────────

export function activityReport(
  w: Pick<World, 'observations' | 'timeZone'> & { person?: Person_ },
  p: Person_,
  opts: { metric?: string; now?: Date; windowDays?: number } = {}
): ActivityReport {
  const metric = opts.metric ?? 'steps'
  const now = opts.now ?? new Date()
  const tz = w.timeZone
  const windowDays = opts.windowDays ?? 7
  const today = dayIn(now, tz)

  const series = seriesBySource({ ...w, person: p } as never, metric)
  const openConflicts = p.conflicts.filter((c) => c.metric === metric && c.state === 'open')
  const source = sourceStateFor(p, series, metric, p.conflicts)
  const readings = source.id ? (series.get(source.id) ?? []) : []
  const trend = trendOf(readings, now, windowDays, tz)

  const newest = readings[readings.length - 1] ?? null
  /**
   * THE CURRENT VALUE IS NULL WHENEVER IT CANNOT BE TRUSTED.
   *
   * Not zero, not the last value we happen to have, and not the higher of two
   * disagreeing readings. Null propagates to the screen as a stated absence with a
   * reason beside it, which is the only presentation that does not amount to
   * asserting a number nobody stands behind.
   */
  const current =
    source.by === 'disputed' || !newest
      ? null
      : {
          day: newest.date,
          value: newest.value,
          label: newest.value.toLocaleString(),
          isToday: newest.date === today,
        }

  const staleDays = newest ? Math.max(0, daysBetweenDays(newest.date, today)) : 0
  const todayReading = source.by === 'disputed' ? undefined : readings.find((r) => r.date === today)
  const freshness: Freshness = {
    today,
    haveToday: todayReading !== undefined,
    todayValue: todayReading?.value ?? null,
    staleDays,
    /**
     * ONE DAY BEHIND IS NORMAL AND TWO IS NOT.
     *
     * A phone syncs its step count when it feels like it, so "yesterday's is the
     * newest" at nine in the morning is not a problem and should not be dressed
     * as one — an app that cries wolf about ordinary lag teaches him to ignore
     * the times it is right. Two days is the point at which the number on screen
     * has stopped being about this week.
     */
    level: !newest ? 'stale' : staleDays === 0 ? 'current' : staleDays === 1 ? 'lagging' : 'stale',
  }

  const paired = goalFor(p, metric)
  const measurable = source.canSupportGoal && trend.average !== null
  const goal =
    paired && measurable ? progressOf(paired.goal, paired.signal, trend.average!) : null

  const missingDays = trend.days.flatMap((d) => (d.value === null ? [d.date] : []))
  const gap: Gap = {
    missingDays,
    staleDays,
    lastDay: newest?.date ?? null,
    // Through `clock.ts`, like every other date phrase in this app. See `Gap`.
    lastDayLabel: newest ? relativeDay(newest.date, now, tz) : 'never',
  }

  const next = nextActionFor({ metric, source, goal, paired, gap, trend, today, now, tz, openConflicts })

  return {
    metric,
    unit: paired?.signal.unit ?? (metric === 'steps' ? 'steps' : undefined),
    source,
    current,
    freshness,
    trend,
    goal,
    gap,
    conflicts: openConflicts,
    next,
    says: sentenceFor({ metric, source, current, freshness, trend, goal, gap, paired, now, tz }),
    grounds: groundsFor({ metric, source, trend, goal, paired }),
  }
}

function nextActionFor(x: {
  metric: string
  source: SourceState
  goal: GoalProgress | null
  paired: { goal: Goal; signal: GoalSignal } | null
  gap: Gap
  trend: Trend
  today: string
  now: Date
  tz?: string
  openConflicts: Conflict[]
}): NextAction {
  /**
   * THE ORDER IS THE ARGUMENT, and it runs from "nothing downstream is valid
   * until this is settled" to "nice to have".
   *
   * A disputed source poisons every number, so it is first. A named source that
   * cannot be read is next, because he made a decision and it silently cost him a
   * feature. A missing goal is third — the numbers are real but meaningless. Only
   * then does a gap in the data matter, and only then a shortfall.
   */
  if (x.source.by === 'disputed') {
    return {
      label: `Which should I trust?`,
      detail: x.source.why ?? '',
      does: { kind: 'choose-source', metric: x.metric, options: x.source.available },
    }
  }
  if (!x.source.canSupportGoal && x.source.by === 'chosen') {
    return {
      label: `Use a source I can read`,
      detail: x.source.why ?? '',
      does: { kind: 'choose-source', metric: x.metric, options: x.source.available },
    }
  }
  if (x.source.by === 'none') {
    return {
      label: 'Connect something that counts this',
      detail: `Nothing has reported ${x.metric}, so there is nothing to show.`,
      does: { kind: 'reconnect', source: 'google-fit' },
    }
  }
  /**
   * A GAP OUT-RANKS A MISSING GOAL, and the order was the other way round at first.
   *
   * The argument for asking what he is aiming for is strong — numbers with no goal
   * mean nothing — and it is the wrong thing to ask when the numbers stopped
   * arriving four days ago. Asking someone what they are trying to achieve, about
   * data that has not been delivered since Friday, is the app talking about itself
   * while a plainly broken thing sits underneath. Fix the feed, then ask what it is
   * for.
   */
  if (x.gap.staleDays >= 2) {
    return {
      label: `Fill in ${relativeDay(x.today, x.now, x.tz)}`,
      /**
       * `lastDayLabel`, NOT `lastDay`. This line said "The last day I have
       * anything for is 2026-08-07" — an ISO date on his home screen, in an app
       * whose entire previous pass was about no date being written by anything
       * but `clock.ts`. The machine date is still on the object for anything
       * that needs to compute with it; nothing that speaks may reach for it.
       */
      detail: `The last day I have anything for is ${x.gap.lastDayLabel}. That is a gap in the feed, not ${x.gap.staleDays} days of sitting still.`,
      does: { kind: 'enter-reading', metric: x.metric, day: x.today },
    }
  }
  if (!x.paired) {
    return {
      label: 'What is this for?',
      detail: `I can show you the numbers, but not whether they are good news — that depends on what you are trying to do.`,
      does: { kind: 'set-goal', metric: x.metric },
    }
  }
  if (x.paired && !x.paired.signal.target) {
    return {
      label: 'Give it a number',
      detail: `"${x.paired.goal.description}" has no target, so nothing can report progress on it.`,
      does: { kind: 'set-goal', metric: x.metric },
    }
  }
  if (x.goal && !x.goal.met) {
    /**
     * A SHORTFALL IS NOT AN ACTION.
     *
     * There is nothing for the app to DO about being 1,600 steps short, and
     * offering a button that pretends otherwise is the "noisy fortune cookie
     * machine" this codebase keeps warning itself about. What it can honestly
     * offer is the arithmetic he would otherwise do in his head.
     */
    const perDay = Math.round(x.goal.shortfall)
    return {
      label: 'Nothing to do — just so you know',
      detail:
        x.goal.direction === 'up'
          ? `You are averaging ${x.goal.current.toLocaleString()} against ${x.goal.target.toLocaleString()}. About ${perDay.toLocaleString()} more a day closes it.`
          : `You are averaging ${x.goal.current.toLocaleString()} against a ceiling of ${x.goal.target.toLocaleString()}.`,
      does: { kind: 'nothing' },
    }
  }
  return {
    label: 'Nothing needs you here',
    detail: x.goal ? `You are meeting ${x.goal.description}.` : 'This is up to date.',
    does: { kind: 'nothing' },
  }
}

function sentenceFor(x: {
  metric: string
  source: SourceState
  current: { day: string; value: number; isToday: boolean } | null
  freshness: Freshness
  trend: Trend
  goal: GoalProgress | null
  gap: Gap
  paired: { goal: Goal; signal: GoalSignal } | null
  now: Date
  tz?: string
}): string {
  if (x.source.by === 'disputed') return x.source.why ?? `Two sources disagree about your ${x.metric}.`
  if (x.source.by === 'none') return `No ${x.metric} data yet.`
  if (!x.source.canSupportGoal && x.source.why) return x.source.why
  if (x.trend.average === null) return `No ${x.metric} recorded in the last ${x.trend.windowDays} days.`

  const denominator =
    x.trend.covered < x.trend.windowDays
      ? `${x.trend.covered} of the last ${x.trend.windowDays} days`
      : `the last ${x.trend.windowDays} days`

  /**
   * WHEN THE NUMBER IS OLD, THE SENTENCE SAYS SO FIRST.
   *
   * It used to lead with the figure and mention the age at the end, which is the
   * order that produced the actual defect: "4,385 steps Friday, averaging 5,036
   * over 3 of the last 7 days" read on a Tuesday as a report about now. The age
   * is not a footnote to the number — on a stale feed it IS the story, and the
   * number is the supporting detail.
   */
  const head = x.current
    ? x.current.isToday
      ? `${x.current.value.toLocaleString()} ${x.metric} today`
      : `Nothing since ${relativeDay(x.current.day, x.now, x.tz)}, when you did ${x.current.value.toLocaleString()}`
    : `${x.trend.average.toLocaleString()} ${x.metric} a day`

  const avg = `averaging ${x.trend.average.toLocaleString()} over ${denominator}`
  /**
   * THE GAP IS STATED WHETHER OR NOT THERE IS A GOAL, and no longer twice.
   *
   * It was appended only to the goal branch, so a world with real numbers and no
   * goal reported an average over three of seven days without ever mentioning
   * that the feed had stopped. Now the HEAD carries it when the reading is not
   * today's — which covers every stale case — and this only adds the count when
   * the lag is long enough to be worth a number.
   */
  const stale = x.gap.staleDays >= 2 ? ` That is ${x.gap.staleDays} days with nothing recorded.` : ''

  if (!x.goal) {
    return `${head}, ${avg}.${stale} I do not know what you are aiming for, so I will not call it good or bad.`
  }
  /**
   * A SHORTFALL IS A VERDICT, AND A DAY IN PROGRESS HAS NOT EARNED ONE.
   *
   * On the morning he wrote in, this card read "0 steps today, averaging 2,796
   * over the last 7 days — 425 short of your 3,221". Every figure in it was
   * correct. It was still the wrong thing to say: the sync had run at 08:00, it
   * was 10:00, and the sentence delivered a daily verdict on two hours.
   *
   * `shortfall` against a daily target only means anything once the day is over.
   * Before that the honest reading is progress — the same numbers, without the
   * judgement — and a target he has already met today is still worth saying,
   * because that is an achievement rather than an accusation.
   */
  const dayInProgress = !!x.current?.isToday && x.goal.direction === 'up' && !x.goal.met
  const against =
    x.goal.direction === 'steady'
      ? `against a target of about ${x.goal.target.toLocaleString()}`
      : x.goal.met
        ? `which meets your ${x.goal.target.toLocaleString()}`
        : dayInProgress
          // The same figure and the same target. What goes is only the framing:
          // a distance still to cover, rather than an amount already missed.
          ? `${x.goal.shortfall.toLocaleString()} to go to your ${x.goal.target.toLocaleString()}`
          : x.goal.direction === 'up'
            ? `${x.goal.shortfall.toLocaleString()} short of your ${x.goal.target.toLocaleString()}`
            : `${x.goal.shortfall.toLocaleString()} over your ceiling of ${x.goal.target.toLocaleString()}`
  return `${head}, ${avg} — ${against}.${stale}`
}

function groundsFor(x: {
  metric: string
  source: SourceState
  trend: Trend
  goal: GoalProgress | null
  paired: { goal: Goal; signal: GoalSignal } | null
}): Ground[] {
  const out: Ground[] = []
  if (x.paired) {
    out.push({
      kind: 'goal',
      id: x.paired.goal.id,
      says: `${x.paired.goal.description}${x.paired.signal.target !== undefined ? `, target ${x.paired.signal.target} ${x.paired.signal.unit ?? ''}`.trimEnd() : ' (no target set)'}`,
    })
  }
  out.push({
    kind: x.source.by === 'chosen' ? 'preference' : 'observation',
    id: x.source.by === 'chosen' ? `source.${x.metric}` : `${x.source.id ?? 'none'}:${x.metric}`,
    says:
      x.source.by === 'chosen'
        ? `you chose ${x.source.id} as the one to trust`
        : x.source.by === 'only'
          ? `${x.source.id} is the only source reporting ${x.metric}`
          : x.source.by === 'disputed'
            ? `${x.source.available.join(' and ')} disagree, and you have not ruled`
            : `nothing reports ${x.metric}`,
  })
  if (x.trend.average !== null) {
    out.push({
      kind: 'computation',
      id: `${x.metric}-average`,
      says: `${x.trend.average} a day, averaged over ${x.trend.covered} recorded day(s) of the last ${x.trend.windowDays}`,
    })
  }
  return out
}
