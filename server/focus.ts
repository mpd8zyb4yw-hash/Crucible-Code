/**
 * "WHAT SHOULD I FOCUS ON THIS WEEK?"
 *
 * The question the whole personal-intelligence substrate exists to answer, and
 * until now it could only be answered by asking a language model — which means it
 * was answered with a plausible list containing at least one wrong weekday, no way
 * to see what any item rested on, and no way to tell it that it was wrong.
 *
 * This answers it in code. Three properties, and each one is a thing the model
 * version structurally could not have:
 *
 *   · EVERY DATE IS COMPUTED. Not one weekday, countdown or relative day in the
 *     output comes from anywhere but `clock.ts`. The week's own boundaries come
 *     from `weekWindow`, which knows what day his week starts on.
 *
 *   · EVERY LINE CAN SHOW ITS GROUNDS. Each item carries the `Because` from the
 *     attention object it came from, so "why am I seeing this?" is answered by
 *     reading records rather than by asking a model to reconstruct its own
 *     reasoning — a thing models will happily do and cannot do honestly.
 *
 *   · EVERY LINE ACCEPTS A CORRECTION THAT CHANGES FUTURE BEHAVIOUR. The chips are
 *     the same closed verb set `applyCorrection` implements, so there is no way to
 *     offer him a control that does nothing.
 *
 * WHAT IT WILL NOT DO. It will not pad. A week with two real things in it gets two
 * lines and says so — the model version always produced five, because a model asked
 * "what matters?" has no way to answer "less than you would think".
 */

import { ASKED_THRESHOLD, compose, whenOf, type Attention, type Because, type Correction } from './attention.js'
import {
  dateVocabulary,
  dayIn,
  inWindow,
  relativeDay,
  restOfWeek,
  weekWindow,
  weekdayName,
  type Window,
} from './clock.js'
import { buildInsights } from './insight.js'
import { readPerson, type Person_ } from './person.js'
import type { World } from './world.js'

export interface FocusItem {
  id: string
  /** What to do or know, in one line. Contains no date it did not compute. */
  headline: string
  detail: string
  /** The day this belongs to, or null for something that spans the week. */
  day: string | null
  /** How he would say that day: "tomorrow", "Thursday". From `clock.ts`. */
  when: string
  kind: Attention['kind']
  score: number
  because: Because
  corrections: Correction[]
  uncertainty: string[]
  /** The one thing to do about it, when there is one. */
  suggest?: { label: string; detail: string }
}

export interface Focus {
  /** The window this answer is about, with each day named. */
  week: { from: string; to: string; days: { day: string; weekday: string; relative: string }[] }
  /** The part of the week he can still act on. */
  remaining: { from: string; to: string }
  /** One line at the top. Honest about a quiet week. */
  summary: string
  /** Things with a day attached, in day order. */
  days: { day: string; weekday: string; relative: string; items: FocusItem[] }[]
  /** Things about the week as a whole, best first. */
  standing: FocusItem[]
  /** Considered and not included, with the reason. Never silently dropped. */
  held: { title: string; why: string }[]
  /** Every date phrase this answer used, so a test can check each one. */
  dateVocabulary: ReturnType<typeof dateVocabulary>
}

/**
 * Build the answer.
 *
 * Runs the ordinary insight pass and then re-composes it for a WEEK rather than for
 * right now, which is a different question and needs a different ranking: `rank`
 * pitches urgency at the next few hours, and a thing on Friday scores badly against
 * that even when it is the most important thing in the week. So the urgency axis is
 * re-read against the week's own horizon before composing.
 */
export async function focusThisWeek(
  w: World,
  opts: { now?: Date; offline?: boolean; startsOn?: number } = {}
): Promise<Focus> {
  const now = opts.now ?? new Date()
  const tz = w.timeZone
  const person = readPerson(w)
  const week = weekWindow(now, tz, opts.startsOn ?? 1)
  const rest = restOfWeek(now, tz, opts.startsOn ?? 1)
  const vocab = dateVocabulary(now, tz, { startsOn: opts.startsOn ?? 1 })

  const run = await buildInsights(w, person, { now, offline: opts.offline })

  /**
   * EVERYTHING THE PASS PRODUCED, not only what cleared the bar for Home.
   *
   * `held` items are held back from interrupting him, which is a judgement about
   * NOW. Asked directly what his week holds, a thing that scored 0.28 is a
   * perfectly good answer — and withholding it here while claiming to have covered
   * the week would be the silent truncation this codebase keeps warning itself
   * about. Which is why `held` is returned too.
   */
  const candidates = [...run.ranked.surface, ...run.ranked.held.map((h) => h.item)]

  /**
   * Only what falls inside the week — and NOT re-filtered to the remaining days.
   *
   * A thing that happened on Monday is still part of "this week" on Thursday, and a
   * question that has been outstanding since Monday is more pressing on Thursday,
   * not less. What gets dropped is only what belongs to a different week.
   */
  const thisWeek = candidates.filter((a) => !a.at || inWindow(a.at, week, tz))
  const outside = candidates.filter((a) => a.at && !inWindow(a.at, week, tz))

  /**
   * Urgency, re-read against the WEEK.
   *
   * `urgencyOf` scores anything more than three days out at 0.1, which is correct
   * for "should this interrupt him right now" and wrong for "what should he plan
   * for". Rescored so that a thing inside the week he has not yet passed counts as
   * pressing — because it is: it is the whole subject of the question.
   */
  const rescored: Attention[] = thisWeek.map((a) => {
    if (!a.at) return a
    const day = dayIn(new Date(a.at), tz)
    const inside = day >= rest.from && day <= rest.to
    return { ...a, scores: { ...a.scores, urgency: inside ? Math.max(a.scores.urgency, 0.6) : a.scores.urgency } }
  })

  /**
   * Composed with a generous limit AND a lower bar, because neither of Home's two
   * constraints applies to a screen he asked for.
   *
   * The limit exists so Home cannot become a list; he has just asked for a list. The
   * threshold exists so nothing marginal may interrupt him; nothing here is
   * interrupting. Composing the week against the Home bar is what made the first
   * version answer "nothing needs you this week" over a goal he had missed by 3,600
   * steps a day — withheld at 0.31 from the one screen built to show it.
   */
  const composed = compose(rescored, person, { now, limit: 12, threshold: ASKED_THRESHOLD })

  const byDay = new Map<string, FocusItem[]>()
  const standing: FocusItem[] = []

  for (const a of composed.surface) {
    const item = itemOf(a, now, tz)
    if (item.day) {
      const list = byDay.get(item.day) ?? []
      list.push(item)
      byDay.set(item.day, list)
    } else {
      standing.push(item)
    }
  }

  const days = week.days
    .filter((d) => byDay.has(d))
    .map((day) => ({
      day,
      weekday: weekdayName(day, 'long'),
      relative: relativeDay(day, now, tz),
      items: (byDay.get(day) ?? []).sort((a, b) => b.score - a.score),
    }))

  const held = [
    ...composed.held.map((h) => ({ title: h.item.title, why: h.why })),
    ...composed.withdrawn.map((x) => ({ title: x.id, why: x.why })),
    ...outside.map((a) => ({
      title: a.title,
      why: `falls on ${dayIn(new Date(a.at!), tz)}, outside ${week.from}–${week.to}`,
    })),
  ]

  return {
    week: {
      from: week.from,
      to: week.to,
      days: week.days.map((d) => ({
        day: d,
        weekday: weekdayName(d, 'long'),
        relative: relativeDay(d, now, tz),
      })),
    },
    remaining: { from: rest.from, to: rest.to },
    summary: summaryOf(days, standing, week, rest, now, tz, person),
    days,
    standing: standing.sort((a, b) => b.score - a.score),
    held,
    dateVocabulary: vocab,
  }
}

function itemOf(a: Attention, now: Date, tz?: string): FocusItem {
  const day = a.at ? dayIn(new Date(a.at), tz) : null
  return {
    id: a.id,
    headline: a.title,
    detail: a.detail,
    day,
    // Never a weekday this file worked out. `whenOf` is `clock.ts` throughout.
    when: a.at ? whenOf(a, now, tz) : 'this week',
    kind: a.kind,
    score: a.score,
    because: a.because,
    corrections: a.corrections,
    uncertainty: a.uncertainty ?? [],
    suggest: a.suggest,
  }
}

/**
 * The one line at the top.
 *
 * A QUIET WEEK IS A REAL ANSWER and is stated as one. The model version could not
 * produce it — asked what matters, a language model always finds something — and
 * that is precisely why the summary is composed here from counts of things that
 * actually exist.
 */
function summaryOf(
  days: { day: string; items: FocusItem[] }[],
  standing: FocusItem[],
  week: Window,
  rest: Window,
  now: Date,
  tz: string | undefined,
  p: Person_
): string {
  const dated = days.reduce((n, d) => n + d.items.length, 0)
  const needsAnswer = [...days.flatMap((d) => d.items), ...standing].filter(
    (i) => i.kind === 'clarification' || i.kind === 'conflict'
  ).length

  if (!dated && !standing.length) {
    const left = rest.days.length
    return `Nothing in what I can see needs you for the rest of this week — ${left} day${left === 1 ? '' : 's'} to ${relativeDay(rest.to, now, tz)}. That is the honest answer, not an empty screen.`
  }

  const first = days[0]
  const lead = first
    ? `The nearest thing is ${relativeDay(first.day, now, tz)}: ${first.items[0]!.headline}.`
    : `Nothing is pinned to a day.`

  const rest_ = [
    dated ? `${dated} thing${dated === 1 ? '' : 's'} with a day attached` : '',
    standing.length ? `${standing.length} running through the week` : '',
    needsAnswer ? `${needsAnswer} waiting on an answer from you` : '',
  ]
    .filter(Boolean)
    .join(', ')

  return `${lead} ${rest_ ? `${rest_[0]!.toUpperCase()}${rest_.slice(1)}.` : ''}`.trim()
}

/**
 * The answer as prose, for chat.
 *
 * Rendered from the structure rather than written by a model, so the sentence he
 * reads and the object the tests assert over are the same thing. Every date in it
 * came out of `clock.ts`.
 */
export function renderFocus(f: Focus): string {
  const out: string[] = [f.summary, '']
  for (const d of f.days) {
    out.push(`${d.relative === d.weekday ? d.weekday : `${d.relative} (${d.weekday} ${d.day})`}`)
    for (const i of d.items) {
      out.push(`  · ${i.headline}${i.when && i.when !== d.relative ? ` — ${i.when}` : ''}`)
      if (i.detail) out.push(`    ${i.detail}`)
    }
  }
  if (f.standing.length) {
    out.push('', 'Running through the week')
    for (const i of f.standing) out.push(`  · ${i.headline}`)
  }
  if (f.held.length) {
    // Stated rather than hidden: a list that was cut must never read as complete.
    out.push('', `I also looked at ${f.held.length} other thing${f.held.length === 1 ? '' : 's'} and left ${f.held.length === 1 ? 'it' : 'them'} out.`)
  }
  return out.join('\n')
}
