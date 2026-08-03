// ═══════════════════════════════════════════════════════════════════════════════
// Answer engine — PRIVATE-FACT SCOPE GATE
// ═══════════════════════════════════════════════════════════════════════════════
//
// MEASURED 2026-08-03, on the live path, reproducibly:
//
//   "What did I have for breakfast yesterday?"
//     -> "Joy (dog) — en.wikipedia.org/wiki/Joy_(dog) ... Was eating breakfast with everyone
//         in the tent."
//   "Where did I go on holiday last year?"
//     -> "Based on the evidence, you went on holiday to Los Angeles. In the first film,
//         'I Know What You Did Last Summer', Julie returns home from college..."
//
// Nothing was broken in retrieval or in grounding. The defect is one of SCOPE: a question
// about the user's own life was routed to a general web search, the search returned articles
// that share its vocabulary, and the answer path did what it is built to do — narrate the
// evidence. The result is a confident, specific, entirely invented assertion about the user's
// private history, which is the worst failure this product can produce. A wrong fact about
// tungsten is a wrong fact; a wrong fact about the user's holiday is the assistant lying to
// someone about their own life, and it is unfalsifiable to them in the moment.
//
// The web CANNOT answer these questions. That is decidable from the question alone, before any
// retrieval runs. So this gate:
//   • recognises a first-person question about the asker's own life, and
//   • answers it ONLY from what the conversation actually recorded, and
//   • otherwise refuses explicitly, naming what it would need.
//
// It deliberately does not try to be clever about recall — buildRecallContext already surfaces
// earlier turns, and if the answer is in the history the normal path handles it. This gate only
// fires when the history is silent, which is exactly the case that was being fabricated.
// ═══════════════════════════════════════════════════════════════════════════════

// Two turn shapes reach this file and they are NOT the same. The engine's internal ConvTurn is
// {role, content}; the CLIENT posts {user, assistant} pairs (src/App.tsx:1253, and server.ts
// passes req.body.history through). MEASURED 2026-08-03 in the running UI: the gate read only
// .content, saw an empty transcript, and refused "Where did I go on holiday last year?" one turn
// after the user answered it with "I went to Lisbon on holiday last year" -- breaking the exact
// promise the refusal text makes. A gate that cannot read the conversation is a gate that
// refuses everything.
export interface ConvTurnLike {
  role?: string; content?: string
  user?: string; assistant?: string
}

/** Flatten either turn shape to the text it contributed to the conversation. */
export function turnText(t: ConvTurnLike | undefined): string {
  if (!t) return ''
  return [t.content, t.user, t.assistant].filter(x => typeof x === 'string').join(' \n ')
}

// A first-person possessive or subject pronoun referring to the ASKER. "my", "I", "me", "mine".
const FIRST_PERSON = /\b(my|mine|i|me|myself)\b/i

// The question is about a fact of the asker's own life/possessions/history — not about the
// world, and not a request to DO something. "What did I have", "where did I go", "who is my",
// "when is my", "what's my", "how old is my".
const PRIVATE_ASK = new RegExp(
  String.raw`\b(what|where|when|who|which|whose|how (?:old|many|much|long))\b[^?.!]{0,60}\b(my|i|me)\b`,
  'i',
)

// Requests to act, not to recall, must pass straight through: "summarize my email",
// "add my meeting", "write my commit message", "fix my code". These are the product's whole
// point and they are not claims about the user's history.
const IMPERATIVE = /\b(summari[sz]e|draft|write|send|schedule|book|add|create|delete|remove|update|reply|forward|open|find|search|list|show|fix|refactor|rename|explain|translate|convert|rewrite|check|run|build|make)\b/i

// Questions about the ASSISTANT's own capabilities read as first-person but are answerable and
// are already served deterministically by the meta lane.
const META = /\b(you|your|crucible)\b.*\b(do|can|are|capable|able)\b|\bwhat can you\b/i

// A message that STATES its own facts before asking is self-contained — "I have meetings at
// 9am and 2pm, when am I free?" is interval arithmetic over data the user just supplied, not a
// question about unrecorded history. Refusing it for lack of a record would be absurd.
const SELF_SUPPLIED = /\b(i have|i've|i had|i am|i'm|my \w+ is|my \w+ are|there(?:'s| is| are))\b[^?]*,/i

/** True iff this question asks for a fact about the asker's private life. */
export function isPrivateFactQuestion(message: string): boolean {
  const m = (message ?? '').trim()
  if (!m) return false
  if (!/\?/.test(m) && !/^\s*(what|where|when|who|which|whose|how)\b/i.test(m)) return false
  if (META.test(m)) return false
  if (IMPERATIVE.test(m)) return false
  if (SELF_SUPPLIED.test(m)) return false
  if (!FIRST_PERSON.test(m)) return false
  return PRIVATE_ASK.test(m)
}

/** Content words of the question, for checking whether the conversation ever discussed it. */
function keywords(m: string): string[] {
  const STOP = new Set(['what', 'where', 'when', 'who', 'which', 'whose', 'how', 'did', 'do', 'does', 'is', 'are', 'was', 'were', 'the', 'a', 'an', 'my', 'i', 'me', 'mine', 'myself', 'have', 'had', 'has', 'go', 'went', 'on', 'in', 'at', 'to', 'for', 'of', 'and', 'or', 'last', 'this', 'that', 'it', 'be', 'been'])
  return Array.from(new Set(
    m.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)),
  ))
}

/**
 * Refuse a private-fact question the conversation never recorded an answer to.
 *
 * Returns null — meaning "not my business, carry on" — when the question is not private, or
 * when the conversation DID discuss the subject, in which case the ordinary recall path is
 * better placed to answer it than a keyword gate is.
 */
export function refusePrivateFact(
  message: string,
  history: ConvTurnLike[] | undefined,
): { text: string } | null {
  if (!isPrivateFactQuestion(message)) return null

  const kws = keywords(message)
  if (kws.length) {
    const hay = (history ?? []).map(turnText).join(' \n ').toLowerCase()
    // Any content word of the question appearing in the transcript means the conversation
    // plausibly holds the answer; defer rather than refuse over something already said.
    if (kws.some(k => hay.includes(k))) return null
  }

  return {
    text: [
      "I don't have that — it's a fact about your life, and nothing in this conversation records it.",
      '',
      "I won't search the web for it either: no public source knows it, and searching returns articles that merely share the question's wording — which is exactly how an assistant ends up inventing a confident answer about your own life.",
      '',
      'Tell me and I\'ll remember it for the rest of our conversation — or point me at a source of yours (your calendar, your email, a note) and I can read it there.',
    ].join('\n'),
  }
}
