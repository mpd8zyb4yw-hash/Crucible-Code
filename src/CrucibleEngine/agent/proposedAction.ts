// ── A draft the user approves is an ACTION WAITING TO HAPPEN (cont.120) ───────
//
// Live failure, 2026-07-29:
//
//   user      "Draft a reply to the email from Google ... Show me the draft for review —
//              do NOT send it until I say so."
//   assistant <a correct four-line reply>
//   user      "send it"
//   assistant <the same four lines again>          ← nothing was sent, nothing was even attempted
//
// The second turn ran zero tools. Three separate things had to be missing for that, and all three
// are the same omission wearing different clothes:
//
//   * "send it" matched no routing predicate, so the turn never reached the agent at all.
//     `detectAgentTask`'s confirmation list has yes/ok/go ahead/do it and not "send it";
//     `isContinuationPhrase`'s verb list has run/fix/open/build and not "send".
//   * Even routed, there was nothing to send. The draft was PROSE in a transcript. No recipient,
//     no subject, no binding to the message it was replying to.
//   * The executor runs with `allowMutation: false`, correctly — a drafting turn must not be able
//     to send. But nothing ever ran with it true either.
//
// The missing concept is a PROPOSAL: a mutating action, fully bound, held pending the user's word.
// The user already said the important half out loud — "do NOT send it until I say so" — and the
// system had nowhere to put that sentence.
//
// WHY THIS IS NOT AN EMAIL FEATURE. The binding from "a thing I read" to "an action I can take on
// it" already exists and is provider-neutral: the affordance registry in tools/entities.ts, where
// `kind: 'message'` affords `reply` via gmail_send with `effect: 'send'`. This module holds a
// BoundAffordance and confirms it. Any tool that emits an entity whose kind affords a mutating
// action inherits draft-then-confirm without a line of code here changing — which is the same
// reason the affordance registry exists at all (crucible-no-templates-universal-fix).
//
// SAFETY POSTURE. Sending mail cannot be undone, so the rules are deliberately strict and are
// enforced here rather than left to a prompt:
//
//   1. A proposal is only ever created from arguments the SYSTEM bound from real tool output.
//      Nothing here is model-authored.
//   2. It is only executed on an explicit confirming turn from the user. A model cannot confirm
//      its own proposal, because a model never writes to this module.
//   3. It is CONSUMED on execution, so a second "yes" cannot send a second copy.
//   4. It expires. A "yes" that arrives an hour later is answering something else.
//   5. Anything that is not clearly a confirmation is not a confirmation. Ambiguity resolves to
//      "not confirmed", because the cost of a missed send is one more sentence from the user and
//      the cost of a wrong send is an email they did not write.

import type { Effect } from '../tools/entities'

export interface ProposedAction {
  /** Registry tool to invoke on confirmation. */
  tool: string
  /** Fully-bound arguments. NOTHING is resolved at confirmation time — what the user reviewed
   *  is byte-for-byte what runs. */
  args: Record<string, unknown>
  /** How much damage it can do, straight from the affordance. Only 'read' may skip confirmation. */
  effect: Effect
  /**
   * The verb the user would naturally use for it: "send", "create", "delete".
   *
   * This is what lets "send it" be recognised as a confirmation without enumerating phrasings.
   * The proposal knows its own verb, so the matcher asks "did they say my verb, or a plain yes?"
   * rather than carrying a list of every way a person might approve an email. A list is what was
   * missing in the first place; a second list would be the same bug with more entries.
   */
  verb: string
  /** One line describing what will happen, shown when the proposal is made. */
  summary: string
  /** What the user is approving, field by field, for review before they say yes. */
  preview: Array<{ label: string; value: string }>
  ts: number
}

const pending = new Map<string, ProposedAction>()

/**
 * How long an unconfirmed proposal survives.
 *
 * Short on purpose. This is the window in which "yes" unambiguously refers to the thing just
 * proposed; past it, a stray "ok" is answering something else entirely, and resolving it into a
 * send would be exactly the failure this module exists to prevent.
 */
export const PROPOSAL_TTL_MS = 15 * 60_000

export function proposeAction(convId: string, a: Omit<ProposedAction, 'ts'>, now: number): void {
  if (!convId) return
  pending.set(convId, { ...a, ts: now })
}

/** Read the live proposal without consuming it. Returns null when absent or expired. */
export function peekProposal(convId: string, now: number): ProposedAction | null {
  if (!convId) return null
  const p = pending.get(convId)
  if (!p) return null
  if (now - p.ts > PROPOSAL_TTL_MS) { pending.delete(convId); return null }
  return p
}

/**
 * Consume the proposal — it can never be executed twice.
 *
 * Called BEFORE the tool runs, not after. If the tool throws or the process dies mid-send, the
 * proposal is already gone and the user is told the outcome is unknown. The alternative ordering
 * risks a retry sending a second copy of a message that already left, and of the two failures
 * only one is recoverable by asking.
 */
export function takeProposal(convId: string, now: number): ProposedAction | null {
  const p = peekProposal(convId, now)
  if (p) pending.delete(convId)
  return p
}

export function clearProposal(convId: string): void {
  pending.delete(convId)
}

// ── Reading the user's answer ─────────────────────────────────────────────────

/** Words that reverse everything after them. Checked FIRST and independently of everything else. */
const NEGATION = /\b(?:no|not|don'?t|do not|never|stop|cancel|abort|hold off|hold on|wait|scrap|discard|forget it|nevermind|never mind)\b/i

/**
 * A bare affirmative — the whole message is approval and nothing else.
 *
 * ACTION-INDEPENDENT ONLY. "send it" was briefly in this list and the bench caught it approving a
 * calendar_create: a phrasing that names one verb must never approve a different action. Anything
 * verb-specific belongs in the verb branch below, which reads the verb off the proposal.
 */
const AFFIRMATIVE =
  /^(?:yes|yeah|yep|yup|ya|ok|okay|k|sure|please|confirm(?:ed)?|proceed|approved?|affirmative|go|go ahead|do it|ship it|go for it|please do|sounds good|looks good|lgtm|perfect|great)\b/i

/**
 * Does this message approve the pending proposal?
 *
 * THE SHAPE OF THE TEST. A confirmation is a SHORT message that is either a bare affirmative or
 * the proposal's own verb, and contains no negation and no new instruction. Length is doing real
 * work: "send it" is a confirmation, "send it to my accountant and cc legal" is a new instruction
 * that happens to start the same way, and running the reviewed arguments for the second would
 * send the wrong mail to the wrong people.
 *
 * Everything ambiguous is NOT a confirmation. The user is one word away from resolving it; an
 * email is not.
 */
export function isConfirmationOf(message: string, action: ProposedAction): boolean {
  const m = (message ?? '').trim().toLowerCase().replace(/[.!]+$/, '')
  if (!m) return false
  // A confirmation is a short utterance. Anything longer is carrying new content, and new content
  // means the reviewed arguments are no longer what the user is asking for.
  if (m.split(/\s+/).length > 6) return false
  // "don't send it", "no, cancel that", "wait — don't". A negation anywhere disqualifies.
  if (NEGATION.test(m)) return false
  // A question is asking about the proposal, not approving it ("should I send it?", "send it?").
  if (m.endsWith('?')) return false
  if (AFFIRMATIVE.test(m)) return true
  // The proposal's OWN verb, optionally with a pronoun or article: "send", "send it", "send that
  // now", "send the email". No phrase list — the action supplies the word.
  const verb = action.verb.toLowerCase()
  return new RegExp(`^(?:please\\s+)?${verb}\\b(?:\\s+(?:it|that|this|them|the\\s+\\w+|now|please|already))*$`, 'i').test(m)
}

/**
 * Does this message call the proposal off?
 *
 * Separate from "not a confirmation", because the two deserve different behaviour: an unrecognised
 * message leaves the proposal standing (the user may be asking a side question before approving),
 * whereas an explicit cancellation must drop it so a later stray "ok" cannot resurrect it.
 */
export function isCancellationOf(message: string, action: ProposedAction): boolean {
  const m = (message ?? '').trim().toLowerCase()
  if (!m) return false
  if (m.split(/\s+/).length > 8) return false
  if (!NEGATION.test(m)) return false
  // "don't send it", "no", "cancel", "actually don't" — a negation in a short reply, optionally
  // naming the verb. The verb is not required: "no" alone cancels.
  return true
}

/** The block shown to the user when a proposal is made. Deterministic — never model-written. */
export function renderProposal(a: ProposedAction): string {
  const rows = a.preview.map(p => `**${p.label}:** ${p.value}`).join('\n')
  return `${rows}\n\nNothing has been sent. Say **"${a.verb} it"** and I'll ${a.verb} exactly this — or tell me what to change.`
}
