/**
 * A MESSAGE HE MIGHT SEND, WRITTEN OUT SO HE DOES NOT HAVE TO.
 *
 * This is the last step of the journey the brief asked for, and it is the step
 * where an assistant most easily stops being trustworthy:
 *
 *     calendar → destination problem → who is going → what they are to him
 *     → a suggested action → A DRAFT → his correction → a learned preference
 *
 * Three rules, and they are the whole file.
 *
 * IT NEVER SENDS. Nothing here reaches Gmail, and the one capability that could
 * (`mail.draft`) creates a DRAFT in his own mailbox — a thing he opens, reads,
 * edits and sends himself, or deletes. The app has one outbound verb,
 * `mail.send`, it is marked irreversible, `perform` refuses it without a
 * confirmation from him, and no path in this file leads to it. Messaging a third
 * party on someone's behalf, about a favour, is not a thing to get 95% right.
 *
 * IT IS NOT WRITTEN BY A MODEL. The text is assembled from typed fields — a
 * name, an event, a day out of `clock.ts` — for the same reason every other
 * conclusion in this codebase is computed rather than generated: a model asked
 * to write a note to Paolo will produce something fluent, plausible and
 * occasionally wrong about the day, the place or how well they know each other.
 * Wrong prose in a message he sends is worse than wrong prose on a card, because
 * the card is his and the message is not.
 *
 * IT ASKS A QUESTION AND MAKES NO CLAIM. The draft says "are you driving?" and
 * never "could you give me a lift?" — because the app does not know that Paolo
 * has a car, is going by car, or is in any position to offer. What the app knows
 * is that they are both invited and that HE has said Paolo is someone he would
 * ask. Everything past that is his to say in his own words, which is why the
 * draft is short and ends where his judgement starts.
 */

import { relativeDay, timeLabel } from './clock.js'
import type { Ground } from './attention.js'
import type { Person } from './person.js'

export interface Draft {
  /** Who it is for. Their address, from the record that named them. */
  to: string
  toName: string
  subject: string
  body: string
  /** Every line of it traceable to something typed. Same contract as a card. */
  grounds: Ground[]
  /** What the app does not know, stated on the draft rather than hidden. */
  uncertainty: string[]
  /**
   * Said beside the draft, every time, in the app's own voice.
   *
   * Not a legal disclaimer — a statement of what did and did not happen. The one
   * thing he must never have to wonder about is whether tapping something in
   * this app sent a message to someone.
   */
  disclosure: string
}

export interface LiftContext {
  /** The event they are both going to. */
  event: { summary: string; start: string; location?: string }
  /** Where it is, as the planner resolved it. */
  destination?: string
  /** Why the journey is stuck, in his terms. */
  problem: string
  timeZone?: string
  hour12?: boolean
}

/**
 * The note asking whether someone is driving.
 *
 * Deliberately plain and slightly under-written. An assistant-drafted message
 * that is too polished is its own tell, and he is going to read this before it
 * goes anywhere — a short true note he can adjust beats a warm paragraph he has
 * to unpick.
 */
export function liftDraft(person: Person, ctx: LiftContext, now = new Date()): Draft | null {
  const to = person.contact?.email
  if (!to) return null

  const start = new Date(ctx.event.start)
  const day = Number.isFinite(start.getTime()) ? relativeDay(ctx.event.start.slice(0, 10), now, ctx.timeZone) : ''
  const clock = Number.isFinite(start.getTime()) ? timeLabel(start, ctx.timeZone, { hour12: ctx.hour12 }) : ''
  const first = person.name.split(/\s+/)[0] || person.name
  // "on Wednesday at 18:00", "tomorrow at 6:00pm" — never a bare weekday for
  // something more than a week out, and never an hour invented for an all-day
  // event. Both rules are `clock.ts`'s and neither is restated here.
  const when = [day, clock ? `at ${clock}` : ''].filter(Boolean).join(' ')

  const body = [
    `Hi ${first},`,
    '',
    `Are you driving to ${ctx.event.summary}${when ? ` ${when}` : ''}?`,
    '',
  ].join('\n')

  return {
    to,
    toName: person.name,
    subject: ctx.event.summary,
    body,
    grounds: [
      {
        kind: 'observation',
        id: `event:${ctx.event.summary}`,
        says: `${person.name} is named on the invitation to ${ctx.event.summary}`,
      },
      {
        kind: 'computation',
        id: 'travel',
        says: ctx.problem,
      },
      {
        kind: 'preference',
        id: `transport.lift.${person.id}`,
        says: `you told me ${person.name} is someone you would ask for a lift`,
      },
    ],
    uncertainty: [
      `I do not know whether ${first} is driving, or has room.`,
      `I have not written the ask itself — that is yours, and it depends on things I cannot see.`,
    ],
    disclosure: 'I have not sent this. It goes to your drafts, and nowhere else, unless you send it.',
  }
}
