/**
 * WHEN HE ANSWERS, THE ANSWER IS THE PRIMARY WRITE.
 *
 * The old path, in full: the app asked "Do you drive?", he tapped "No", and the
 * only thing that happened was that a SENTENCE was appended to the observation
 * list — `While looking at "Do you drive?", he said: No`. The typed fact
 * `identity.drives = false` did not exist. Nothing could read it. So the router
 * still had to guess a travel mode, and the question was still askable, forever
 * — which is why that exact sentence appears TWICE in his real world model.
 *
 * `liftFromObservations` was written to rescue that, and it does: it reads those
 * sentences back with narrow regexes and produces the facts that should have been
 * written at the time. It is genuinely useful for the data already sitting there.
 *
 * IT MUST NOT BECOME THE NORMAL INGESTION PATH, and this file is what stops it.
 * Round-tripping a structured answer through English prose and back is lossy in
 * three specific ways, none of them recoverable:
 *
 *   · PROVENANCE COLLAPSES. A lifted fact is `by: 'agent'`, because an agent read
 *     it out of a sentence — that is honest, and it means the next synthesis pass
 *     is permitted to overwrite it. An answer he TAPPED is `by: 'user'`, which is
 *     permanent. Going through prose downgrades a lock into a suggestion.
 *
 *   · IT ONLY WORKS FOR SENTENCES SOMEONE ANTICIPATED. The lifter matches "do you
 *     drive?" and "lives in X". It will never match the question added next week,
 *     so the fact quietly does not exist and nothing indicates that.
 *
 *   · THE FACT ARRIVES LATE. Lifting happens on the next build. Between his tap
 *     and that build, everything reads the old value — so the card he just
 *     corrected is recomputed from the thing he corrected.
 *
 * So: `recordAnswer` writes the typed field FIRST, from the structured slot the
 * question already carried, and returns a human-readable observation as a
 * SECONDARY record for history. The observation still exists — it is genuinely
 * useful to the synthesis pass and to him reading his own file — it is just no
 * longer the only copy.
 */

import type { Correction } from './attention.js'
import {
  fact,
  getFact,
  setFact,
  settled,
  SLOTS,
  type Person_,
  type Slot,
} from './person.js'
import type { Observation } from './world.js'

export interface AnswerRecord {
  /** The typed keys this answer settled. Empty when it was ordinary prose. */
  touched: string[]
  /** The history record. Always produced — see this file's opening comment. */
  observation: Observation
  /** What to say back, so the write is visible rather than assumed. */
  said: string
}

/**
 * The value a slot's answer should be STORED as, given what he tapped or typed.
 *
 * Structured where the slot is structured, raw where it is not. The boolean case
 * is the one worth naming: `identity.drives` is a yes/no question and storing the
 * string "No" would make every reader do its own truthiness dance, which is how
 * `"false"` ends up meaning true. A slot declares its own type.
 */
function coerce(slot: Slot | undefined, raw: string): unknown {
  const t = raw.trim()
  if (slot?.answers === 'boolean') {
    if (/^(no|nope|never|nah|false|non|nein)\b/i.test(t)) return false
    if (/^(yes|yep|yeah|sure|true|si|sì|ja)\b/i.test(t)) return true
    return null
  }
  if (slot?.answers === 'number') {
    const n = Number(t.replace(/[^\d.-]/g, ''))
    return Number.isFinite(n) ? n : null
  }
  if (slot?.answers === 'list') {
    return t.split(/\s*[,;/]\s*|\s+and\s+/i).map((s) => s.trim()).filter(Boolean)
  }
  /**
   * A declared option matched by LABEL becomes its VALUE.
   *
   * He taps a chip reading "Bus or train"; the thing code reads is `transit`.
   * Storing the label would mean `modeFor` comparing against display text, which
   * breaks the moment the wording is improved.
   */
  const option = slot?.options?.find(
    (o) => o.label.toLowerCase() === t.toLowerCase() || o.value.toLowerCase() === t.toLowerCase()
  )
  return option ? option.value : t
}

/**
 * Record an answer he gave to a question the app asked.
 *
 * `slot` is the KEY OF THE QUESTION, carried on the card that asked it — not
 * inferred from what he typed. That is the structural half of the rule: the app
 * knows what it asked, so it does not have to work out what he answered.
 *
 * Mutates the person and returns the observation for the caller to store in the
 * same transaction. Returning it rather than writing it keeps this synchronous
 * and pure, which is what lets one `mutateWorld` cover both writes — if the fact
 * landed and the observation did not, history would disagree with the model.
 */
export function recordAnswer(
  p: Person_,
  input: { slot?: string; question?: string; text: string; at?: Date }
): AnswerRecord {
  const now = input.at ?? new Date()
  const iso = now.toISOString()
  const text = input.text.trim()
  const touched: string[] = []

  const key = input.slot
  const slot = key ? SLOTS[key] : undefined
  const value = key ? coerce(slot, text) : null

  /**
   * An unusable answer to a typed question is not a fact.
   *
   * "Do you drive?" answered with "depends" coerces to null, and storing null as
   * though it were an answer would leave a fact that reads as known and means
   * nothing. What happens instead is that `askedAt` is recorded without a value —
   * so the app knows it asked, does not ask again immediately, and the prose
   * still reaches the synthesis pass, which can make sense of "depends" in a way
   * no field can.
   */
  if (key && value !== null && value !== '') {
    const into = key.startsWith('identity.') ? 'identity' : 'preferences'
    const wrote = setFact(
      p,
      into,
      fact(key, value, {
        source: 'user',
        status: 'user_provided',
        confidence: 1,
        // HIS, and therefore permanent. This is the whole reason the direct path
        // exists — the same answer lifted from prose would be `agent`.
        by: 'user',
        sourceAt: iso,
        note: input.question ? `He answered "${clip(text, 60)}" when asked: ${clip(input.question, 90)}` : 'He told me directly.',
        askedAt: p.asked[key]?.at ?? iso,
      })
    )
    if (wrote) touched.push(key)
    // Answered means answered, whether or not the value differed from what was
    // already held. Leaving the demand up is how a settled question comes back.
    settled(p, key)
    delete p.asked[key]
    for (const extra of consequences(p, key, value, iso)) touched.push(extra)
  } else if (key) {
    // Asked, not usefully answered. Recorded so it is not re-asked in an hour.
    p.asked[key] = { at: iso, question: input.question ?? SLOTS[key]?.question ?? key, times: (p.asked[key]?.times ?? 0) + 1 }
    p.updatedAt = iso
  }

  /**
   * The history record, generated SECONDARILY.
   *
   * Deliberately still in the same shape the old path produced, because the
   * synthesis prompt reads these and there was nothing wrong with the prose — the
   * mistake was that it was the only copy. The id is derived from the slot where
   * there is one, so answering the same question again REPLACES the record rather
   * than appending a second identical sentence. That duplicate pair in his real
   * world model is exactly what this id does away with.
   */
  const observation: Observation = {
    id: key ? `answer-${slugKey(key)}` : `said-${now.getTime().toString(36)}`,
    source: 'user',
    at: iso.slice(0, 10),
    text: input.question
      ? `Asked "${clip(input.question, 160)}" — he said: ${clip(text, 200)}`
      : `He said: ${clip(text, 240)}`,
  }

  return {
    touched,
    observation,
    said: touched.length ? `Noted — ${describeAnswer(key!, value)}. I will use that and stop asking.` : 'Noted.',
  }
}

/**
 * Facts that FOLLOW from an answer, written at the same moment.
 *
 * Only where the implication is definitional rather than a guess. "He does not
 * drive" IS a transport constraint — the constraint and the fact are two readings
 * of one answer, and the planner reads the constraint while the prompt reads the
 * fact. Deriving it here rather than in a later pass is the same argument as the
 * rest of this file: a consequence discovered on the next build is a consequence
 * that was missing when the card he was looking at was computed.
 *
 * Nothing speculative belongs in here. "He walks" does not imply he has no car.
 */
function consequences(p: Person_, key: string, value: unknown, iso: string): string[] {
  const out: string[] = []
  if (key === 'identity.drives' && value === false) {
    // Imported lazily would be cleaner; person.ts is already a runtime import
    // everywhere in this file, so the constraint is written inline instead.
    const id = 'constraint:does-not-drive'
    const held = p.constraints.find((c) => c.id === id)
    if (!held) {
      p.constraints.push({
        id,
        kind: 'transport',
        what: 'Does not drive',
        basis: [],
        confidence: 1,
        by: 'user',
        updatedAt: iso,
      })
      out.push(id)
    } else if (held.by !== 'user') {
      held.by = 'user'
      held.confidence = 1
      held.updatedAt = iso
      out.push(id)
    }
    p.updatedAt = iso
  }
  if (key === 'identity.drives' && value === true) {
    // The reverse must also apply, or "actually I do drive now" leaves a
    // constraint standing that silently rules driving out of every plan.
    const held = p.constraints.find((c) => c.id === 'constraint:does-not-drive')
    if (held) {
      p.constraints = p.constraints.filter((c) => c !== held)
      p.updatedAt = iso
      out.push('constraint:does-not-drive (removed)')
    }
  }
  return out
}

/**
 * The correction an answer is equivalent to.
 *
 * A tapped chip on a clarification card already goes down the correction path,
 * which writes typed facts directly — so that path was never the problem. This
 * exists so a FREEFORM answer to the same question takes the identical route:
 * one implementation, one set of guarantees, whether he tapped or typed.
 */
export function correctionForAnswer(slot: string, text: string): Correction | null {
  const declared = SLOTS[slot]
  const value = coerce(declared, text)
  if (value === null || value === '') return null
  return { verb: 'set-preference', label: text.slice(0, 80), key: slot, value }
}

/**
 * Which open question a piece of prose is answering, if the app can tell.
 *
 * STRUCTURAL ONLY, and that restriction is the point. It matches on what the app
 * ASKED — the card he had open, or the single question outstanding — and never on
 * the content of his reply. The tempting version of this function pattern-matches
 * "I take the bus" onto `transport.default`, which is `liftFromObservations` in a
 * new location and carries all the same problems.
 *
 * Returns null when there is any doubt. A wrong slot writes a permanent
 * `by: 'user'` fact from something he did not say, which is worse than a fact
 * arriving late.
 */
export function slotForReply(p: Person_, opts: { cardId?: string; question?: string }): string | null {
  /**
   * A clarification card's id IS the slot. `insight.ts` mints them as
   * `ask:<key>`, so the card he is looking at names the question exactly, with no
   * inference at all. This is the reliable case and the one that covers a
   * freeform reply to a question card.
   */
  const fromCard = /^ask:(.+)$/.exec(opts.cardId ?? '')?.[1]
  if (fromCard) return fromCard

  if (opts.question) {
    const match = Object.values(SLOTS).find((s) => s.question === opts.question)
    if (match) return match.key
  }

  /**
   * Exactly one question outstanding, asked recently, and he is replying.
   *
   * Bounded to one because with two outstanding there is no way to know which he
   * answered, and to the last six hours because a question from last week is not
   * what a reply now is about.
   */
  const open = Object.entries(p.asked).filter(([k, a]) => {
    const held = getFact(p, k)
    if (held && held.status !== 'unknown') return false
    return Date.now() - Date.parse(a.at) < 6 * 3_600_000
  })
  return open.length === 1 ? open[0]![0] : null
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const slugKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

function describeAnswer(key: string, value: unknown): string {
  const v = Array.isArray(value) ? value.join(', ') : String(value)
  if (key === 'identity.drives') return value === false ? 'you do not drive' : 'you drive'
  if (key === 'transport.default') return v === 'ask' ? 'I will ask each time' : `you usually ${v === 'transit' ? 'take the bus' : v}`
  if (key === 'assistant.proactivity') return `you want me ${v === 'low' ? 'to stay out of the way' : v === 'high' ? 'to speak up' : 'somewhere in between'}`
  return `${key.split('.').pop()} is ${v}`
}
