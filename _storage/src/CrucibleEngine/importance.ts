// Deterministic inbox-importance verifier (doctrine: importance is deterministic-first
// + a LABELED SUGGESTION, never fabricated). This module is a pure function over signals
// that Gmail hands us verbatim — no model, no guessing. The tile widget renders its
// verdict as a small "Priority" pill whose tooltip lists exactly the reasons below, so
// the user always sees WHY a message was flagged and can dismiss the judgement.
//
// The signals are extracted at the data source (server.ts inbox preview) from real Gmail
// metadata; keeping the scoring here (not inline in the fetch) makes it unit-benchable
// (see __importance_bench.ts) and keeps the two surfaces from drifting.

export interface ImportanceSignals {
  /** Message carries Gmail's UNREAD label. */
  unread: boolean
  /** The account's own address appears in the To header — a direct message to the user,
   *  not something they were merely cc'd or list-blasted on. */
  addressedToMe: boolean
  /** A literal question mark in the subject or snippet — a concrete ask awaiting a reply. */
  asksQuestion: boolean
  /** Message carries a List-Unsubscribe header → a mailing list / bulk sender, not a person. */
  bulk: boolean
}

export interface ImportanceVerdict {
  /** Whether to flag this row as a suggested priority. */
  important: boolean
  /** Human-readable contributing signals, shown in the pill's tooltip. Empty when not flagged. */
  reasons: string[]
}

// Threshold rationale: bulk mail is NEVER flagged (a newsletter that says "got a question?"
// is not a personal ask). Otherwise a message is a suggested priority only when it is
// addressed DIRECTLY to the user AND is either unread or asks a question — a single weak
// signal (merely unread, or merely a "?") is not enough, so the flag stays rare and
// meaningful rather than crying wolf on every unread row.
export function assessImportance(s: ImportanceSignals): ImportanceVerdict {
  if (s.bulk) return { important: false, reasons: [] }
  const important = s.addressedToMe && (s.unread || s.asksQuestion)
  if (!important) return { important: false, reasons: [] }
  const reasons: string[] = []
  if (s.addressedToMe) reasons.push('addressed directly to you')
  if (s.asksQuestion) reasons.push('asks a question')
  if (s.unread) reasons.push('unread')
  return { important: true, reasons }
}

// Cheap, allocation-free signal extractors shared by the server preview builder. Kept here
// beside the scorer so the definition of each signal lives in one place.

/** True when `me` (the account's own lowercased address) appears in a raw To header value. */
export function isAddressedToMe(toHeader: string, me: string): boolean {
  if (!me) return false
  return toHeader.toLowerCase().includes(me)
}

/** True when a literal '?' appears in either the subject or the message snippet. */
export function asksQuestion(subject: string, snippet: string): boolean {
  return subject.includes('?') || snippet.includes('?')
}
