/**
 * THE PRESENTATION BUDGET.
 *
 * A Home card is 224 pixels at most and the model does not know that. So every
 * generator that writes for Home used to write for nowhere in particular, the
 * card received a paragraph, and the only lever left at the bottom of the stack
 * was CSS — which produced the scrollbar in the screenshot. That is the failure
 * this file exists to make impossible:
 *
 *     model writes paragraph → CSS invents scroll
 *
 * The budget is applied HERE, at `needFrom`, because that is the one seam every
 * Home card passes through. Doing it in the renderer would be the same mistake
 * one layer up: the renderer would still be apologising for text that should
 * never have been aimed at a card.
 *
 * WHAT THIS IS NOT. It is not a truncator with a nicer name. Nothing is deleted
 * — everything trimmed off a card moves to `status`, which is what "Why am I
 * being asked?" opens, what the focused detail shows, and what the assistant
 * reads. The card gets the headline and the fact; the sentence that took three
 * clauses to be careful gets the place where being careful is the point.
 *
 * THE NUMBERS ARE TARGETS, NOT A GUILLOTINE. `SOFT` is what a generator should
 * aim at. `HARD` is where this file intervenes, and the gap between them is
 * deliberate: a question that is 54 characters because the person's name is long
 * is not a defect, and rewriting it to 50 would be. Only prose that has clearly
 * stopped budgeting for the card is moved.
 *
 * See docs/ui-contract.md — the copy budget table is frozen there.
 */

import { dayIn, partsIn, relativeDay, timeLabel } from './clock.js'
import type { Correction } from './attention.js'
import type { Need } from './think.js'

/** What a generator should aim at. */
export const SOFT = {
  question: 50,
  fact: 60,
  choice: 20,
} as const

/**
 * Where this file steps in.
 *
 * Set at the point where the text can no longer be about a card: `fact` at 130
 * is two full lines at the small size on the narrowest phone, so anything past
 * it was never going to be read on Home whatever the CSS did.
 */
const HARD = {
  question: 96,
  fact: 130,
} as const

/**
 * FOUR CHOICES. THE FIFTH IS A MENU.
 *
 * `fitness.objective` shipped five, and five chips at 1.5× text is three rows of
 * buttons under a two-line question inside a 224px box — which is the arithmetic
 * that made a scrollbar look like the only option. The ones past the fourth are
 * not lost: "Something else…" hands the question to the composer, and
 * `slotForReply` still routes his words into the same typed slot, so a freeform
 * answer and a chip write the identical fact.
 */
export const MAX_CHOICES = 4

/**
 * The first sentence, if leading with it loses nothing.
 *
 * Prose written for a card usually already opens with the fact and then explains
 * it — "You have averaged about 2,761 steps a day over the last 7 days. I do not
 * know whether that is…". The split is therefore almost always free, and when it
 * is not (one long unpunctuated sentence) this declines rather than cutting
 * mid-clause, and the caller moves the whole thing deeper.
 */
function lead(text: string, limit: number): { head: string; rest: string } | null {
  const m = /^(.{20,}?[.!?])(\s+)(\S[\s\S]*)$/.exec(text.trim())
  if (!m) return null
  const head = m[1]!.trim()
  if (head.length > limit) return null
  return { head, rest: m[3]!.trim() }
}

/**
 * The opening sentence and what follows it, at any length.
 *
 * `lead` above will not split under twenty characters, and that floor is right
 * for the LENGTH budget: leading with a five-word fragment and pushing the rest
 * deeper makes a card that says nothing. It is wrong for the restatement check,
 * where short is the normal case — "Monday at 9:00 PM." is eighteen characters
 * and is exactly the sentence worth removing. Two questions, two splits.
 */
function opener(text: string): { head: string; rest: string } | null {
  const m = /^(.+?[.!?])(\s+)(\S[\s\S]*)$/.exec(text.trim())
  return m ? { head: m[1]!.trim(), rest: m[3]!.trim() } : null
}

/**
 * WHAT THE CARD'S EYEBROW IS ALREADY SAYING, AS A CLAIM RATHER THAN AS ITS WORDS.
 *
 * A relevance card has three text slots and they are supposed to divide the work
 * — the eyebrow says WHEN, the head says WHAT, the sub says what is new. What was
 * shipping instead was two of them saying one thing:
 *
 *     TOMORROW · 11:00
 *     Restaurant with Odelia
 *     Tomorrow at 11:00 AM. You asked when to leave earlier today.
 *
 * The audit's finding #12, and the reason it was recorded rather than bodged is
 * that the obvious fix — compare the two rendered strings in the card and drop
 * one — is the prose re-derivation this codebase refuses everywhere else. It also
 * would not have worked: "TOMORROW · 11:00" and "Tomorrow at 11:00 AM" are not
 * the same string, and a comparison loose enough to catch them is loose enough to
 * delete a sentence that only mentioned a time in passing.
 *
 * So the pair is generated in one place, by the generator, and this is what the
 * generator is told: the INSTANT the eyebrow will render, not the text it will
 * render it as. From that, `restates` below can ask a question with an actual
 * answer — is this opening sentence made of nothing but that instant? — instead
 * of comparing two authors' prose.
 */
export interface EyebrowClaim {
  /** The instant the eyebrow renders, when it renders one. */
  at?: string
  /** Now, for "tomorrow". PASSED, never read here — `clock.ts`'s standing rule. */
  now: Date
  timeZone?: string
  hour12?: boolean
}

/**
 * Is this sentence made of nothing but the instant the eyebrow is showing?
 *
 * STRIP, THEN LOOK AT WHAT SURVIVES. The renderings of the instant come out,
 * then the handful of words English needs to attach a time to a sentence, and
 * what is left decides. "Tomorrow at 11:00 AM." goes to nothing and is moved
 * deeper; "Tomorrow it will be closed." keeps "will be closed" and is left
 * exactly alone.
 *
 * That direction is the important one. A rule that looked for a MATCH would have
 * to guess how loose to be, and every loosening deletes a sentence that merely
 * mentioned a time. A rule that asks what remains can only ever be wrong by
 * leaving a restatement in place, which costs a duplicated line rather than a
 * lost fact.
 *
 * The renderings are `clock.ts`'s, in both clock conventions, because the card
 * does not know which one he is on and a rule that only understood one would
 * work in Rome and not in Chicago. Longest first, so "9:00pm" is removed whole
 * rather than being broken in half by "9:00".
 */
function saysOnly(sentence: string, claim: EyebrowClaim): boolean {
  if (!claim.at) return false
  const at = new Date(claim.at)
  if (Number.isNaN(at.getTime())) return false

  const day = dayIn(at, claim.timeZone)
  const p = partsIn(at, claim.timeZone)
  const h12 = p.hour % 12 || 12
  const mm = String(p.minute).padStart(2, '0')
  const forms = [
    relativeDay(day, claim.now, claim.timeZone),
    timeLabel(at, claim.timeZone, { hour12: true }),
    timeLabel(at, claim.timeZone, { hour12: false }),
    `${h12}:${mm}`,
    `${h12}:${mm} ${p.hour < 12 ? 'am' : 'pm'}`,
  ]
    .filter(Boolean)
    .map((f) => f.toLowerCase())
    .sort((a, b) => b.length - a.length)

  let rest = sentence.toLowerCase().replace(/\s+/g, ' ')
  for (const f of forms) rest = rest.split(f).join(' ')
  /*
    The filler. `am` and `pm` are here rather than in `forms` because a meridiem
    can be written half a dozen ways — "AM", "a.m.", "A.M" — and none of them
    means anything on its own, so removing the word is safer than enumerating the
    spellings.
  */
  rest = rest.replace(/\b(at|on|is|the|this|in|from|around|by|it|and|a\.?m|p\.?m)\b/g, ' ')
  return !/[a-z0-9]/.test(rest)
}

/**
 * Apply the budget to one card's copy.
 *
 * Returns the same three fields it was given. `status` only ever grows — it is
 * where everything that did not fit on the card ends up, in the order it was
 * written, so the deeper view reads as one continuous explanation rather than as
 * a card's leftovers.
 */
export function budgetForHome(copy: {
  title: string
  sub: string
  status: string
  corrections: Correction[]
  /** What the card's eyebrow will already have said. See `EyebrowClaim`. */
  eyebrow?: EyebrowClaim
}): { title: string; sub: string; status: string; corrections: Correction[] } {
  const deeper: string[] = []

  /**
   * THE QUESTION IS NEVER CUT. It is critical content — the card cannot be
   * answered without it — so an over-budget title is reported by being left
   * alone and letting the card wrap it. What the ladder in `QuestionCard` drops
   * instead is the reason, the "why", and the fifth chip. A truncated question
   * would be the one failure worse than a scrollbar: a card that asks something
   * other than what it means.
   */
  const title = copy.title

  let sub = copy.sub

  /*
    THE SUB DOES NOT OPEN BY SAYING WHAT THE EYEBROW SAYS.

    Nothing is deleted: the opening clause moves into `status`, which is where
    everything this file trims already goes and which the report, the focused
    detail and the assistant all read. So the FACT is not lost — it stops being
    printed twice on one card, three lines apart, which is the whole complaint.

    Done before the length budget, deliberately. A sentence that is over budget
    BECAUSE it opens with a restatement should be measured after the restatement
    is gone, or the ladder starts clamping the half that was actually worth
    reading.
  */
  if (copy.eyebrow?.at) {
    const split = opener(sub)
    if (split && saysOnly(split.head, copy.eyebrow)) {
      deeper.push(split.head)
      sub = split.rest
    } else if (!split && sub && saysOnly(sub, copy.eyebrow)) {
      deeper.push(sub)
      sub = ''
    }
  }

  if (sub.length > HARD.fact) {
    const split = lead(sub, HARD.fact)
    if (split) {
      sub = split.head
      deeper.push(split.rest)
    } else {
      // No sentence boundary to lead with. The whole thing goes deeper and the
      // card says nothing rather than saying half of something.
      deeper.push(sub)
      sub = ''
    }
  }

  const corrections = copy.corrections.slice(0, MAX_CHOICES)
  if (copy.corrections.length > MAX_CHOICES) {
    deeper.push(
      `Other answers: ${copy.corrections.slice(MAX_CHOICES).map((c) => c.label).join(', ')}.`,
    )
  }

  return {
    title,
    sub,
    corrections,
    status: [copy.status, ...deeper].filter(Boolean).join(' '),
  }
}

/**
 * Does this card's copy fit the budget it was given?
 *
 * Exported for `scripts/contract.mjs`, which runs it over every card the
 * fixtures and the real builders produce. A generator drifting back towards
 * paragraphs is a thing to find in a test rather than in a screenshot.
 */
export function overBudget(n: Pick<Need, 'title' | 'sub'> & { corrections?: Correction[] }): string[] {
  const out: string[] = []
  if (n.title.length > HARD.question) out.push(`title is ${n.title.length} chars (hard limit ${HARD.question})`)
  if ((n.sub ?? '').length > HARD.fact) out.push(`sub is ${n.sub.length} chars (hard limit ${HARD.fact})`)
  if ((n.corrections?.length ?? 0) > MAX_CHOICES) out.push(`${n.corrections!.length} choices (max ${MAX_CHOICES})`)
  return out
}
