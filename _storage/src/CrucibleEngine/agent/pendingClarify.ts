// ── A clarifying question leaves the conversation MID-GOAL (cont.119) ─────────
//
// Live failure, 2026-07-29:
//
//   user      "build me a quizlet flashcard set with simple grammatical italian terms"
//   assistant "What should the flashcard set cover?"          ← wrong: it was already stated
//   user      "i already told you"
//   assistant a flashcard list containing "Question: i already told you" and
//             "Question: Three Cheers for Sweet Revenge", after fetching
//             en.wikipedia.org/wiki/List_of_capitals_of_France
//
// The debug event for that third turn reads `{"goal":"i already told you"}`. That is the whole
// bug: the reply to a question was routed as a BRAND-NEW GOAL, so the request it was answering no
// longer existed. Everything downstream — the Wikipedia fetch, the garbage cards — is a model
// doing its best with a goal that is literally the words "i already told you".
//
// Asking a question is therefore not a stateless act. Whoever asks owes the next turn the context
// to interpret the answer, and that is what this holds.
//
// Deliberately in-memory and short-lived: it is conversational state, not a record. A restart
// losing it costs one re-ask, whereas persisting it risks resurrecting a stale question days
// later, which is a worse failure than the one it prevents.

export interface PendingClarification {
  /** The user's ORIGINAL message — the goal the question was asked about. */
  goal: string
  /** What was asked, so a re-ask can acknowledge rather than repeat blindly. */
  question: string
  /** Slot keys that were blocking. */
  asked: string[]
  ts: number
}

const pending = new Map<string, PendingClarification>()

/** Answers arrive in the next turn or two. Beyond that the user has moved on, and applying an old
 *  question to a new message would be its own kind of context bleed. */
export const CLARIFY_TTL_MS = 30 * 60_000

export function rememberClarification(convId: string, c: Omit<PendingClarification, 'ts'>, now: number): void {
  if (!convId) return
  pending.set(convId, { ...c, ts: now })
}

export function takeClarification(convId: string, now: number): PendingClarification | null {
  if (!convId) return null
  const c = pending.get(convId)
  if (!c) return null
  if (now - c.ts > CLARIFY_TTL_MS) { pending.delete(convId); return null }
  return c
}

export function clearClarification(convId: string): void {
  pending.delete(convId)
}

/**
 * Fold a reply to a clarifying question back into the goal it was answering.
 *
 * The reply is APPENDED rather than substituted, and the original leads, because the original is
 * the request — the reply only adds to it. This also repairs the case that produced the live
 * failure: "i already told you" adds nothing, so the combined text is the original goal, which a
 * fixed extractor now reads correctly. A protest and a genuine answer take the same path, and
 * neither can lose the request.
 */
export function mergeClarificationReply(goal: string, reply: string, asked: string[] = []): string {
  const r = (reply ?? '').trim()
  if (!r) return goal
  // A reply that merely asserts the answer was already given carries no new content — folding it
  // in as though it were the subject is how "Question: i already told you" ends up on a flashcard.
  if (/^(?:i\s+)?(?:already\s+(?:told|said|gave|answered)|told you|said(?: it)?|as (?:i|we) said)\b/i.test(r)) {
    return goal
  }
  // The merge must produce a goal the SPEC PARSER can still read, not a note stapled to one.
  // Appending "(clarification from the user: italian grammar)" left specForGoal unable to parse
  // the result at all, so the user answered the question and the request STILL could not be
  // built — the loop asked, was answered, and went nowhere.
  //
  // Folding the reply in as the slot that was actually asked about keeps the goal a goal. Only
  // `subject` has a natural grammatical join today; anything else falls back to appending, which
  // is at least non-destructive.
  const answered = r.replace(/^(?:it'?s|its|about|on|the topic is|make it)\s+/i, '').trim()
  if (asked.includes('subject') && answered && !/\babout\b/i.test(goal)) {
    return `${goal} about ${answered}`
  }
  return `${goal}\n\n(clarification from the user: ${r})`
}
