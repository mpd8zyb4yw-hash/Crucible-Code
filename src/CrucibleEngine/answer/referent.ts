// Referent resolution — deciding WHAT a question is about, before deciding how to answer it.
//
// WHY THIS FILE EXISTS (cont.118). Five logged bugs are one shape:
//
//   "who made you"          → web search → AC/DC's "Who Made Who", cited as Crucible's origin
//   "what's your IQ"        → web search → "Test Your I.Q." → "I am Madsen Pirie"
//   "are you made in china" → web search → pages about goods manufactured in China   ← observed
//
// Each was closed by adding another arm to an enumeration (`SELF_REF_RX`, `matchMeta`'s CREATOR).
// The last one shipped because the enumeration had `are you made BY <x>` and not `are you made
// IN <x>`. The gap between working and broken was ONE PREPOSITION.
//
// The gate those patterns feed (`answerEngine.ts`, the `!isSelfReferential` veto on web
// grounding) is ARCHITECTURALLY CORRECT and stays. What was wrong is the classifier: it asked an
// OPEN question — "does this message match one of the ways people phrase a self-question?" — which
// has an infinite tail no regex ever finishes enumerating.
//
// THE UNIVERSAL FORM. The right question is CLOSED and grammatical:
//
//     What is the REFERENT of this question's subject?
//
// English marks person with a tiny closed class of pronouns. If the subject of the matrix clause
// is second-person, the question is ABOUT THE ASSISTANT — whatever is predicated of it. "made in
// china", "assembled in taiwan", "owned by google", "trained on reddit", "spying on me", "cheaper
// than chatgpt" all resolve identically, and so does every phrasing nobody has thought of yet.
// That is the difference between a rule and a list.
//
// DOCTRINE. `crucible-no-templates-universal-fix`: correctness comes from a general mechanism,
// never from patching the one phrasing observed failing. Adding `made in` to CREATOR would have
// been whack-a-mole with a doctrine sticker on it.

/** What a question is fundamentally about. Drives corpus selection, not answer content. */
export type Referent =
  /** The assistant itself — answer from the self-model, NEVER the web. */
  | 'self'
  /** The person asking — answer from their own world (memory, mail, calendar, files). */
  | 'user'
  /** Everything else. Normal retrieval tiers apply. */
  | 'world'

export interface ReferentResolution {
  referent: Referent
  /** Which rule fired. Carried into telemetry so a misroute is diagnosable, not mysterious. */
  reason: string
  /** The clause the subject was read from, after frame-stripping. */
  nucleus: string
}

// ── Frames ────────────────────────────────────────────────────────────────────
// English wraps questions in frames whose subject is "you" but whose TOPIC is what follows.
// Strip these or every framed question wrongly resolves to 'self'. Both classes below are CLOSED
// and are stripped at most twice, so this widens nothing — it only removes wrapper text.

// (a) EMBEDDED-QUESTION frames. The giveaway is a following complementizer: a wh-word, "if", or
//     "whether". "do you know WHO won" is about the World Cup. Requiring the complementizer is
//     what keeps this from eating "can you see my screen", which has no embedded question and IS
//     a question about the assistant.
const FRAME_EMBEDDED = new RegExp(
  '^\\s*(?:hey|hi|hello|ok(?:ay)?|so|and|but|also|please)?[,\\s]*' +
  '(?:' +
    '(?:do|does|did|can|could|would|will)\\s+(?:you|u)\\s+' +
      '(?:happen\\s+to\\s+)?(?:know|recall|remember|tell\\s+me|say|find\\s+out|look\\s+up|check)\\s+' +
    '|(?:please\\s+)?(?:tell|remind|show)\\s+me\\s+' +
    '|i\\s+(?:was\\s+|am\\s+|\'m\\s+)?(?:wonder(?:ing)?|want(?:ed)?\\s+to\\s+know|would\\s+like\\s+to\\s+know|need\\s+to\\s+know)\\s+' +
  ')' +
  '(?=(?:what|who|whom|whose|which|where|when|why|how|if|whether)\\b)',
  'i',
)

// (b) REQUEST frames. A modal + second-person + action verb is an IMPERATIVE IN DISGUISE — the
//     user is asking for the action, not asking about the assistant. "could you look up the price
//     of bitcoin" is about bitcoin. Note this class REQUIRES a modal: "ARE you looking at my
//     screen" keeps its second-person subject and stays a question about the assistant.
const FRAME_REQUEST = new RegExp(
  '^\\s*(?:hey|hi|hello|ok(?:ay)?|so|and|but|also|please)?[,\\s]*' +
  '(?:can|could|would|will)\\s+(?:you|u)\\s+(?:please\\s+)?' +
  '(?:look\\s+up|search\\s+for|search|find|fetch|get\\s+me|get|check|tell\\s+me\\s+about|show\\s+me|give\\s+me|explain|describe|summar[iy][sz]e|list|write|make|build|create)\\s+',
  'i',
)

// (c) IMPERATIVE topic frames — no subject at all, the topic follows directly.
const FRAME_IMPERATIVE = new RegExp(
  '^\\s*(?:hey|hi|hello|ok(?:ay)?|so|and|but|also)?[,\\s]*' +
  '(?:please\\s+)?(?:tell\\s+me\\s+about|explain|describe|look\\s+up|search\\s+for|find\\s+out\\s+about|summar[iy][sz]e)\\s+',
  'i',
)

// (d) INSTRUCTIONAL frames — "how do I …", "how do you …", "how does one …". English uses both
//     first- and second-person pronouns GENERICALLY here: "how do you make bread" is a recipe
//     question, not a question about the assistant, and "how do I reverse a linked list" is a
//     programming question, not a question about the user. Both are about the WORLD.
//
//     The discriminator is whether the verb takes an object. "how do you WORK" and "how do you
//     REASON" name no object — those are genuinely about the assistant and must not be stripped.
//     "how do you MAKE BREAD" carries one. The lookahead requires at least two words after the
//     frame, which is exactly that distinction without needing a verb inventory.
const FRAME_INSTRUCTIONAL = new RegExp(
  '^\\s*(?:how|where|when|what\'?s?\\s+the\\s+best\\s+way)\\s+' +
  '(?:do|does|can|could|should|would|might|would)\\s+(?:i|we|you|u|one|someone|somebody)\\s+' +
  '(?=\\S+\\s+\\S+)',
  'i',
)

// (e) Bare conversational openers, stripped on their own.
const FRAME_OPENER = /^\s*(?:hey|hi|hello|ok(?:ay)?|so|and|but|also|um+|uh+)[,\s]+/i

function stripFrames(m: string): string {
  let out = m.trim()
  for (let i = 0; i < 2; i++) {
    const before = out
    out = out
      .replace(FRAME_EMBEDDED, '')
      .replace(FRAME_REQUEST, '')
      .replace(FRAME_INSTRUCTIONAL, '')
      .replace(FRAME_IMPERATIVE, '')
      .replace(FRAME_OPENER, '')
      .trim()
    if (out === before) break
  }
  return out
}

// ── Person marking (closed classes — the entire point of this file) ───────────

const SECOND_SUBJ = /^(?:you|u|yourself|crucible)\b/i
const FIRST_SUBJ = /^(?:i|i'?m|i'?ve|we|we'?re|me)\b/i

// Fronted interrogative material. English questions front the wh-word and/or an auxiliary, so the
// subject sits AFTER it. Rather than parse English, strip the fronted run and read what remains.
// Degrades safely: anything unstrippable falls through to the inversion tests below, then 'world'.
const FRONTED = new RegExp(
  '^(?:' +
    '(?:what|who|whom|whose|which|where|when|why|how)' +
    "(?:'?s|'?re|'?ll)?" +
    // A modifier run: "how MUCH", "how SMART", "what KIND OF", "how MANY".
    '(?:\\s+(?:much|many|old|long|far|smart|intelligent|clever|capable|powerful|good|bad|advanced|' +
      'reliable|accurate|fast|slow|big|small|dumb|stupid|well|often|exactly|really|' +
      'kind\\s+of|type\\s+of|sort\\s+of|version\\s+of))*' +
    // Optional auxiliary AFTER the modifier run: "how smart ARE you", "what model ARE you".
    '(?:\\s+(?:is|are|was|were|am|do|does|did|have|has|had|can|could|will|would|should))?' +
  '|(?:are|is|was|were|am|do|does|did|have|has|had|can|could|will|would|should|shall|may|might|must))' +
  '\\s+',
  'i',
)

// SUBJECT-AUXILIARY INVERSION with the subject late in the clause: "how smart are YOU",
// "what model are YOU", "how many emails do I have". FRONTED cannot always reach these because an
// arbitrary noun phrase can sit between the wh-word and the auxiliary ("what KIND OF MODEL are
// you"). Testing for the inverted subject directly covers the whole shape in one rule.
const INVERTED_SECOND = /\b(?:are|is|was|were|do|does|did|have|has|had|can|could|will|would|should)\s+(?:you|u|crucible)\b/i
const INVERTED_FIRST = /\b(?:are|am|was|were|do|does|did|have|has|had|can|could|will|would|should)\s+(?:i|we)\b/i

// The assistant as OBJECT or COMPLEMENT rather than subject: "who made you", "who pays FOR you",
// "is anything smarter THAN you". A preposition or transitive verb immediately before a
// second-person pronoun marks it as the thing being talked about.
const SECOND_OBJECT = new RegExp(
  '\\b(?:' +
    'made|built|created|designed|developed|programmed|coded|invented|trained|wrote|writes?|' +
    'owns?|runs?|funds?|controls?|sells?|licen[cs]es?|pays?|powers?|hosts?|maintains?|ships?|' +
    'for|to|with|about|behind|from|of|like|than|against|toward|towards|regarding|concerning' +
  ')\\s+(?:you|u|crucible)\\b',
  'i',
)

// Possessive NPs mark a property OF their owner. "what is your context window" is about the
// assistant; "what is on my calendar" is about the user.
const SECOND_POSS = /\byour?s?\b/i
const FIRST_POSS = /\b(?:my|mine|our|ours)\b/i

// TEMPORAL DEIXIS overrides person. "are you free tomorrow for the meeting" has a textbook
// second-person subject, and it is NOT a question about the assistant — it is a scheduling
// question, and the right corpus is the user's calendar.
//
// The principle is general, not a carve-out for the word "free": THE SELF-MODEL IS TIME-INVARIANT.
// Nothing about what Crucible is varies by Thursday. So a second-person question carrying a
// time adjunct cannot be asking about identity — it is asking about a schedule, and schedules
// live in the user's world. This generalises to "what are you doing later", "are you around on
// friday", "can you make it at 3" without any of them being enumerated.
//
// Found by `__abstention_bench.ts`, which already pinned this as a must-not-match case before
// this file existed (`crucible-verifier-two-failure-directions` earning its keep).
const TEMPORAL_DEIXIS = new RegExp(
  '\\b(?:' +
    'today|tomorrow|tonight|yesterday|later|soon|now|currently|' +
    'this\\s+(?:morning|afternoon|evening|week|month|weekend)|' +
    'next\\s+(?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|' +
    '(?:on\\s+)?(?:mon|tues|wednes|thurs|fri|satur|sun)day|' +
    'at\\s+\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?|' +
    '\\d{1,2}(?::\\d{2})\\s*(?:am|pm)' +
  ')\\b',
  'i',
)

// Scheduling/availability predicates — the other half of the same signal. "are you busy",
// "are you available" without a date still concerns a schedule rather than an identity.
const AVAILABILITY = /\b(?:free|busy|available|around|booked|open)\b/i

/**
 * Resolve what a message is fundamentally about.
 *
 * TOTAL by construction: every input returns a resolution, defaulting to 'world'. That default is
 * the conservative direction — 'world' is exactly today's behaviour for anything unrecognised, so
 * a miss here can only fail to IMPROVE routing, never break what already works.
 *
 * Rule order is load-bearing and is asserted by `__referent_bench.ts`. Subject beats object beats
 * possessive, because "what did I tell you" has a first-person SUBJECT (a question about the
 * conversation) even though the assistant appears as its object.
 */
export function resolveReferent(message: string): ReferentResolution {
  const raw = (message ?? '').trim()
  if (!raw) return { referent: 'world', reason: 'empty', nucleus: '' }

  const nucleus = stripFrames(raw)
  if (!nucleus) return { referent: 'world', reason: 'frame-only', nucleus: '' }

  const afterFronting = nucleus.replace(FRONTED, '').trim()

  // 0. TEMPORAL OVERRIDE — checked before person, because it disqualifies the self-model
  //    outright. The self-model has no facts that vary by date, so a scheduling question can
  //    never be answered from it no matter whose pronoun is in the subject.
  const scheduling = TEMPORAL_DEIXIS.test(nucleus) && AVAILABILITY.test(nucleus)
  if (scheduling) return { referent: 'user', reason: 'scheduling-question', nucleus }

  // 1. SUBJECT — the strongest signal.
  if (SECOND_SUBJ.test(afterFronting)) return { referent: 'self', reason: 'second-person-subject', nucleus }
  if (FIRST_SUBJ.test(afterFronting)) return { referent: 'user', reason: 'first-person-subject', nucleus }

  // 2. INVERTED SUBJECT — same signal, subject displaced by a fronted noun phrase.
  if (INVERTED_SECOND.test(nucleus)) return { referent: 'self', reason: 'second-person-inverted', nucleus }
  if (INVERTED_FIRST.test(nucleus)) return { referent: 'user', reason: 'first-person-inverted', nucleus }

  // 3. OBJECT / COMPLEMENT — "who made you", "who pays for you", "smarter than you".
  if (SECOND_OBJECT.test(nucleus)) return { referent: 'self', reason: 'second-person-object', nucleus }

  // 4. POSSESSIVE — a property of its owner. Second-person first: a question mentioning both
  //    ("what did you do with my file") is about the assistant's action.
  if (SECOND_POSS.test(nucleus)) return { referent: 'self', reason: 'second-person-possessive', nucleus }
  if (FIRST_POSS.test(nucleus)) return { referent: 'user', reason: 'first-person-possessive', nucleus }

  return { referent: 'world', reason: 'no-personal-subject', nucleus }
}

/**
 * Is this question about the assistant itself?
 *
 * Drop-in replacement for `isSelfReferential` with a strictly larger true-set on self-questions
 * and no new false positives on world questions — both directions pinned by `__referent_bench.ts`
 * (`crucible-verifier-two-failure-directions`: a classifier tested in one direction is half-tested).
 */
export function isAboutSelf(message: string): boolean {
  return resolveReferent(message).referent === 'self'
}

/** Is this question about the user — routing it to their own world rather than the web? */
export function isAboutUser(message: string): boolean {
  return resolveReferent(message).referent === 'user'
}

/**
 * The property that actually protects against the bug class: a personal question must never be
 * answered by searching the open web for its literal text. Used as the web-grounding veto.
 */
export function isPersonalQuestion(message: string): boolean {
  return resolveReferent(message).referent !== 'world'
}
