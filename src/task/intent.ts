/**
 * WHAT KIND OF WORK HE IS ASKING FOR, decided in one place.
 *
 * This existed as a regex in `App.tsx` called `asksForRoute`, and the specific
 * failure it produced is the reason this file exists:
 *
 *     "What time should I leave for Avano?"
 *
 * matched nothing — `leave for` was not in the pattern — so the request never
 * entered the task machinery at all. It went to the chat model, which has no
 * route engine, no departure arithmetic and no way to suspend on a missing
 * start time, and it answered with the only calendar fact it could see:
 * "your events tomorrow are all marked as all day". A true sentence, about the
 * wrong question, delivered confidently.
 *
 * Two things are wrong with fixing that by adding `leave for` to the regex.
 *
 * First, a route and a departure time are DIFFERENT COMPUTATIONS. "How do I get
 * to Avano" needs a destination. "What time should I leave for Avano" needs a
 * destination, an event start, an origin, a mode of travel, a duration and a
 * buffer, and it is wrong — not merely incomplete — if any of them is guessed.
 * They cannot share a task kind.
 *
 * Second, a pattern that grows a phrase per bug report is a pattern that is
 * always one phrasing behind. So this classifies by SHAPE rather than by
 * literal: a departure question is a time-word, a departure verb, and
 * optionally a destination, in any of the arrangements English puts them in.
 * `variants()` below is the acceptance test — every ordinary way of asking
 * reaches the same task — and it is exported so `scripts/contract.mjs` can
 * assert it rather than trusting that someone checked.
 */

export type TaskKind = 'leaveBy' | 'route' | 'search'

/** What the classifier decided, and enough to explain the decision. */
export interface Intent {
  kind: TaskKind | null
  /** The phrase that carried it. For tests and for the transcript, not the UI. */
  matched?: string
  /** The place he named, when the sentence names one. */
  destination?: string
}

const norm = (s: string) =>
  s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * DEPARTING, as a verb family rather than as a list of sentences.
 *
 * `head out`, `set off`, `get going` and `leave` are one idea. `be there by`
 * and `make it to` are the same question asked from the other end — the answer
 * is still a departure time — and they were the two forms that had no chance of
 * ever matching a pattern built around the word "leave".
 */
const DEPART = /\b(leave|leaving|head (?:out|off|over|to|for)|set off|get going|start out|be there|get there|make it (?:to|for)|arrive)\b/

/**
 * ASKING ABOUT A TIME. A departure verb alone is not a departure question:
 * "I'm going to leave the car at home" is a statement about a car.
 */
const TIME_ASK = /\b(what time|when|how early|how long before|by when|which time|at what time)\b/

/** Directions, which is a different task with a smaller set of prerequisites. */
const ROUTE = /\b(route|directions|navigate|take me|how do i get|how far|drive there|walk there|show me the way)\b/

/**
 * The place, when the sentence names one.
 *
 * Deliberately shallow. It captures the obvious "to X" / "for X" tail and gives
 * up otherwise, because the resolution ladder is far better at identifying a
 * place than a regex is — it can see the calendar event actually on screen. A
 * wrong guess here would OUTRANK that, which is worse than no guess at all.
 */
function destinationIn(text: string): string | undefined {
  const m = /\b(?:leave|head|set off|going|get|be|arrive|make it|route|directions|navigate)\b[^,.?!]*?\b(?:for|to|at)\s+([a-z0-9'’\- ]{2,40})/i.exec(text)
  const raw = m?.[1]?.trim()
  if (!raw) return undefined
  // Trailing time words are not part of a place name: "to Avano tomorrow".
  const cleaned = raw.replace(/\b(today|tomorrow|tonight|this (morning|afternoon|evening)|on \w+day|at \d.*)$/i, '').trim()
  return cleaned.length >= 2 ? cleaned : undefined
}

/**
 * Classify one utterance.
 *
 * `leaveBy` is checked before `route` and that order is load-bearing: "how long
 * will it take me to get to Avano before six" contains both, and the departure
 * reading is the one that needs the stricter prerequisites. Preferring the
 * looser task would be exactly the failure this file was written for — an
 * answer produced because the harder question was not recognised.
 */
export function classify(text: string): Intent {
  const t = norm(text)
  if (!t) return { kind: null }

  const departure = DEPART.exec(t)
  const timeAsk = TIME_ASK.exec(t)
  if (departure && (timeAsk || /\bshould i\b/.test(t))) {
    return {
      kind: 'leaveBy',
      matched: `${timeAsk?.[0] ?? 'should i'} … ${departure[0]}`,
      destination: destinationIn(text),
    }
  }

  const route = ROUTE.exec(t)
  if (route) return { kind: 'route', matched: route[0], destination: destinationIn(text) }

  // A bare "when should I leave?" with no destination at all is still a
  // departure question — the destination is what the ladder resolves from the
  // event he is looking at, which is the entire point of the anchor rung.
  if (departure && /\bwhen\b|\bwhat time\b/.test(t)) {
    return { kind: 'leaveBy', matched: departure[0], destination: destinationIn(text) }
  }

  return { kind: null }
}

/**
 * THE ACCEPTANCE TEST, kept beside the thing it tests.
 *
 * The rule the handoff states is semantic: every ordinary way of asking a
 * departure question reaches the same task. That is not something a comment can
 * promise, so the list is data and `scripts/contract.mjs` runs `classify` over
 * every line of it. Adding a phrasing here fails the build until it routes.
 */
export const DEPARTURE_PHRASINGS = [
  'when should I leave',
  'what time should I leave',
  'when do I need to leave',
  'when should I leave for Avano',
  'what time should I leave for Avano?',
  'leave for Avano — when?',
  'when should I head out',
  'what time should I head to Avano',
  'how early should I leave',
  'when do I have to set off',
  'what time do I need to be there',
  'how long before I should get going',
  'when should I set off for the restaurant',
  'what time should I leave to make it to lunch',
]

/** Route phrasings, which must NOT be read as departure questions. */
export const ROUTE_PHRASINGS = [
  'show me the route',
  'directions to Avano',
  'how do I get to Avano',
  'take me there',
  'navigate to the restaurant',
]
