// Goal specification — turning "make me X" into something buildable, or into the ONE question
// that makes it buildable (cont.118).
//
// MEASURED LIVE. "make me a set of flash cards to study from https://en.wikipedia.org/wiki/…"
// returned:
//
//     "I'm sorry, but I don't have access to the Wikipedia page you provided. Could you please
//      provide me with the specific information or details you want to include on the flashcards?"
//
// Two failures in one sentence, and the second is the worse one:
//
//  1. A false capability claim — the page was perfectly reachable, there was simply no tool that
//     returned page text (fixed separately: `read_url`).
//  2. It asked the user to DO THE WORK. "Provide me the specific information to include on the
//     flashcards" is the entire task handed back. That is the opposite of an assistant.
//
// THE REQUIREMENT, stated generally: given an arbitrary goal, ask for the MINIMUM VIABLE
// information only the user can supply, fill in everything else yourself, and build it. It must
// hold for any deliverable and any source — never a per-deliverable script.
//
// THE UNIVERSAL FORM. Every creation goal is underspecified along the same small set of
// DIMENSIONS. What varies between "flash cards", "a landing page" and "a quiz" is not which
// dimensions exist — it is what a sensible DEFAULT is for each:
//
//     SUBJECT      what is it about
//     SOURCE       where the material comes from
//     QUANTITY     how much of it
//     DEPTH        how hard / how detailed
//     FORMAT       what artifact, and where it lands
//     ACCESS       whether the source can actually be reached
//
// So the slot list is universal and the defaults are derived. That split is what keeps this from
// being the template pile `crucible-no-templates-universal-fix` bans.
//
// THE ACTUAL INSIGHT IS THE BLOCKING RULE. A slot is worth asking about **iff it cannot be
// derived AND guessing it wrong wastes the whole build.** Subject is blocking — twenty cards on
// the wrong topic is a total loss. Quantity is not: twenty is fine, and if it is wrong you say
// "make it forty". Depth is not. Applying that rule honestly leaves one or two questions on a
// typical goal, which is the difference between an assistant and an interrogation.

import type { ItemShape, ArtifactExpectation } from './artifactVerify'

export type SlotKey = 'subject' | 'source' | 'quantity' | 'depth' | 'format' | 'access'

export interface Slot {
  key: SlotKey
  /** Resolved value, when it could be derived or defaulted. */
  value?: string
  /** Where the value came from — 'missing' is the only state that can produce a question. */
  source: 'stated' | 'derived' | 'default' | 'missing'
  /** Asked only when missing AND blocking. */
  question?: string
  /** Concrete choices, so the user picks rather than composes. */
  options?: string[]
  recommended?: string
  /**
   * True when only the user can supply this and a wrong guess wastes the build.
   * This flag, not the slot list, is what makes the elicitation minimal.
   */
  blocking: boolean
}

export interface GoalSpec {
  /** The thing being made, as the user named it. */
  deliverable: string
  slots: Slot[]
  /** The minimum viable questions — blocking and unfilled. Usually 0–2. */
  ask: Slot[]
  /** Everything filled in without asking, for the "here's what I assumed" line. */
  assumed: Slot[]
  ready: boolean
  /** What `artifactVerify` will hold the finished artifact to. Derived, never asked about. */
  expectation: ArtifactExpectation
}

// ── Deliverable detection ─────────────────────────────────────────────────────
// An open noun capture rather than a closed list: whatever follows the creation verb IS the
// deliverable. A closed list is exactly the enumeration that produced this session's other bugs.
const CREATE_VERB =
  /\b(?:make|build|create|generate|write|design|produce|put\s+together|whip\s+up|draft|prepare|compile|assemble)\b/i

/**
 * The one closed class of words that can join a deliverable to its topic or its source.
 *
 * Shared by `deliverableOf`'s terminator and `statedSubject`, deliberately: when they disagreed,
 * "build me a quiz CONTAINING world war 2 dates" parsed as no deliverable at all, and
 * "...flashcard set WITH italian terms" parsed as having no subject. One list, two readers.
 */
const CONNECTOR_WORDS =
  'to|for|from|about|on|using|with|that|which|in|based|containing|covering|comprising|including|featuring|regarding|concerning|around'

/**
 * "make me a set of flash cards to study from X" → "set of flash cards".
 *
 * Skips determiners AND a leading count/adjective run, because the count and difficulty are
 * separate slots: "build me 30 hard flash cards" must yield "flash cards", not fail to parse.
 * The trailing lookahead includes `of` so "write a summary of <url>" terminates correctly.
 */
function deliverableOf(msg: string): string | null {
  const m = msg.match(
    new RegExp(
      CREATE_VERB.source +
      // determiners
      '\\s+(?:me\\s+|us\\s+|a\\s+|an\\s+|some\\s+|the\\s+)*' +
      // an optional count and up to two adjectives ("30 hard", "ten short")
      '(?:\\d{1,4}\\s+)?(?:(?:hard|easy|simple|basic|advanced|short|long|quick|detailed|difficult|beginner|intermediate|expert)\\s+){0,2}' +
      '([a-z][\\w-]*(?:\\s+(?:of\\s+)?[a-z][\\w-]*){0,3}?)' +
      // `of` terminates ONLY before a source ("summary of https://…"); inside a noun phrase it
      // belongs to the deliverable and is absorbed above ("set OF flash cards" must stay whole).
      '(?=\\s+(?:' + CONNECTOR_WORDS + ')\\b|\\s+of\\s+https?:|[.,!?]|$)',
      'i',
    ),
  )
  const raw = m?.[1]?.trim()
  if (!raw) return null
  // Trim a trailing filler word the lazy capture may have taken.
  return raw.replace(new RegExp(`\\s+(?:${CONNECTOR_WORDS}|of)$`, 'i'), '').trim() || null
}

// ── Derivation helpers ────────────────────────────────────────────────────────

const URL_RE = /https?:\/\/[^\s<>"')]+/i

/** Sites that will not serve useful text without an authenticated session. */
const AUTH_WALLED =
  /\b(?:mail\.google|drive\.google|docs\.google|outlook|linkedin|facebook|instagram|x\.com|twitter\.com|notion\.so|slack\.com|canvas|blackboard|moodle|coursera|udemy|chegg|quizlet)\b/i

/** A stated count anywhere in the message: "20 cards", "30 hard flash cards", "five slides". */
function statedQuantity(msg: string): string | null {
  // Adjectives may sit between the number and the noun — "30 hard flash cards".
  const digits = msg.match(/\b(\d{1,4})\s+(?:[a-z-]+\s+){0,3}?(?:cards?|questions?|items?|slides?|pages?|sections?|entries|terms?|rows?)\b/i)
  if (digits) return digits[1]
  const words: Record<string, string> = {
    ten: '10', dozen: '12', twenty: '20', thirty: '30', fifty: '50', hundred: '100',
    five: '5', three: '3', four: '4', six: '6', eight: '8',
  }
  const w = msg.match(/\b(ten|dozen|twenty|thirty|fifty|hundred|five|three|four|six|eight)\b/i)
  return w ? words[w[1].toLowerCase()] : null
}

const STATED_DEPTH =
  /\b(beginner|introductory|basic|simple|easy|intermediate|advanced|expert|hard|difficult|challenging|graduate|undergrad(?:uate)?|gcse|a-?level|high\s+school)\b/i

/**
 * Connectors that can join a deliverable to what it is ABOUT.
 *
 * A CLOSED grammatical class — prepositions plus a few complementiser phrases. That is what makes
 * listing them sound, where listing SUBJECTS never could be: the things a flashcard set can cover
 * are unbounded, but the ways English attaches a topic to a noun are not.
 */
const SUBJECT_CONNECTOR =
  /^\s*(?:with|of|about|on|for|from|covering|containing|comprising|including|featuring|using|around|based\s+on|regarding|concerning|to\s+(?:learn|study|revise|practi[cs]e|memori[sz]e)|that\s+(?:covers?|contains?|has|have|includes?|teach(?:es)?))\b/i

/** An occasion, not a subject: "for my exam", "for tomorrow". */
const OCCASION =
  /^(?:(?:my|the|an?)\s+)?(?:exam|test|quiz|midterm|final|revision|study|class|homework|interview|tomorrow|monday)\s*$/i

/** Nouns that HOLD things — their `of` complement is the contents, not a topic. */
const CONTAINER_NOUN = /\b(?:set|deck|pack|bunch|pile|collection|series|batch|stack|group|list)\b/i

/**
 * The SUBJECT, when the user stated it in prose.
 *
 * Returns null when the only subject signal is a source — a URL is a SOURCE, and the subject is
 * then derivable by reading it, which is work the system should do rather than ask about.
 *
 * TWO ways of stating it, because relying on the first alone shipped a live failure (cont.119):
 * "build me a quizlet flashcard set WITH simple grammatical italian terms" was answered with
 * "What should the flashcard set cover?" — the subject was right there, joined by a preposition
 * that happened not to be in the list. Exactly the cont.118 shape, where the gap between working
 * and broken was one preposition, and exactly the place NOT to add another word to a list.
 *
 * So the second way is structural: `deliverableOf` already knows where the deliverable phrase
 * ENDS (its terminator lookahead is this same closed connector class), and whatever follows it
 * across a connector IS the subject. No topic vocabulary is enumerated anywhere.
 */
function statedSubject(msg: string, deliverable?: string | null): string | null {
  // 1. An explicit topic preposition, wherever it appears ("flash cards about the Krebs cycle").
  const m = msg.match(/\b(?:about|on the topic of|covering|regarding|concerning|for(?: my)?(?: upcoming)?)\s+([^.,!?]{3,80})/i)
  const explicit = m?.[1]?.trim()
  if (explicit && !URL_RE.test(explicit) && !OCCASION.test(explicit)) return explicit

  // 2. "<deliverable> OF <topic>" — the `of` complement, when it names a topic rather than the
  //    deliverable's own contents. "set of flash cards" is a container naming what it holds and
  //    must stay whole; "flashcards of italian grammar" is a deliverable naming its subject.
  //    The head noun decides, which is a structural test rather than a topic vocabulary.
  if (deliverable) {
    const ofSplit = deliverable.match(/^(.*?)\s+of\s+(.+)$/i)
    if (ofSplit && SUBJECT_CRITICAL.test(ofSplit[1]) && !CONTAINER_NOUN.test(ofSplit[1])) {
      const s = ofSplit[2].trim()
      if (s.length >= 3 && !URL_RE.test(s) && !OCCASION.test(s)) return s
    }
  }

  // 3. The residue after the deliverable, joined by any connector.
  if (deliverable) {
    const idx = msg.toLowerCase().indexOf(deliverable.toLowerCase())
    if (idx !== -1) {
      const after = msg.slice(idx + deliverable.length)
      // A connector is REQUIRED. Without one, trailing words are not a topic — they are a
      // separate clause, and grabbing them would invent a subject the user never gave.
      if (SUBJECT_CONNECTOR.test(after)) {
        const s = after.replace(SUBJECT_CONNECTOR, '').split(/[.,!?;]/)[0]
          .replace(/\s+/g, ' ').trim().replace(/^(?:a|an|the|some)\s+/i, '')
        if (s.length >= 3 && s.length <= 80 && !URL_RE.test(s) && !OCCASION.test(s)) return s
      }
    }
  }
  return null
}

// ── Defaults ──────────────────────────────────────────────────────────────────
// Keyed on the deliverable NOUN, and only ever supplying a value the user did not state. This is
// the one place a deliverable's shape matters, and getting it wrong costs a regeneration, not a
// wasted build — which is precisely why these are defaults and not questions.
function defaultsFor(deliverable: string): { quantity: string; depth: string; format: string; shape: ItemShape } {
  const d = deliverable.toLowerCase()
  // `shape` is what `artifactVerify` checks against. Naming a structural shape is all a NEW
  // deliverable needs to inherit verification — there is no per-deliverable checker.
  if (/card|flashcard/.test(d)) return { quantity: '20', depth: 'intermediate', format: 'a two-sided Q:/A: deck, one pair per item', shape: 'pair' }
  if (/quiz|test|exam/.test(d)) return { quantity: '10', depth: 'intermediate', format: 'question and answer pairs', shape: 'pair' }
  if (/glossary|vocab|definition/.test(d)) return { quantity: '20', depth: 'intermediate', format: 'term and definition pairs', shape: 'pair' }
  if (/summar|brief|digest|essay|report/.test(d)) return { quantity: '1', depth: 'intermediate', format: 'a structured summary with headings', shape: 'prose' }
  if (/slide|deck|presentation/.test(d)) return { quantity: '10', depth: 'intermediate', format: 'a title and body per slide', shape: 'block' }
  if (/outline|plan|syllabus|curriculum|checklist|list/.test(d)) return { quantity: '10', depth: 'intermediate', format: 'one item per line', shape: 'bullet' }
  if (/note|cheat\s*sheet|study\s+guide/.test(d)) return { quantity: '1', depth: 'intermediate', format: 'a single reference document', shape: 'prose' }
  return { quantity: '10', depth: 'intermediate', format: 'a titled section per item', shape: 'block' }
}

/** Deliverables whose whole purpose is to be ABOUT something — subject is load-bearing.
 *  Plurals matter: `\bcard\b` does not match "cards", which silently let "make me some flash
 *  cards" default its subject to "a general treatment" instead of asking the one question that
 *  needed asking. */
const SUBJECT_CRITICAL =
  /\b(cards?|flashcards?|quiz(?:zes)?|tests?|exams?|questions?|summar(?:y|ies)|notes?|study|guides?|outlines?|slides?|decks?|presentations?|essays?|reports?|briefs?|syllabus|curriculum|cheat)\b/i

/**
 * Build a spec for a creation goal.
 *
 * Returns null when the message is not a creation goal at all — every other path is untouched.
 */
export function specForGoal(message: string, ctx: { hasAttachment?: boolean } = {}): GoalSpec | null {
  const msg = (message ?? '').trim()
  if (!msg || msg.length > 2000) return null
  if (!CREATE_VERB.test(msg)) return null
  const deliverable = deliverableOf(msg)
  if (!deliverable) return null
  // A code/app build has its own planner and its own verifiers; this is for content deliverables.
  if (/\b(app|application|website|site|page|game|server|api|script|program|component|function|clone|dashboard|tool)\b/i.test(deliverable)) return null

  const def = defaultsFor(deliverable)
  const url = msg.match(URL_RE)?.[0] ?? null
  const subject = statedSubject(msg, deliverable)
  const quantity = statedQuantity(msg)
  const depth = msg.match(STATED_DEPTH)?.[1] ?? null

  const slots: Slot[] = []

  // ── SOURCE. A URL or an attachment IS the source; otherwise the system's own knowledge is a
  //    legitimate source and needs no permission. Never blocking.
  slots.push(
    url
      ? { key: 'source', value: url, source: 'stated', blocking: false }
      : ctx.hasAttachment
        ? { key: 'source', value: 'the file you attached', source: 'derived', blocking: false }
        : { key: 'source', value: 'what I already know about the topic', source: 'default', blocking: false },
  )

  // ── SUBJECT. Blocking ONLY when there is no source to derive it from. With a URL in hand the
  //    subject is a `read_url` away, and asking for it is the "provide me the information you
  //    want on the flashcards" failure — handing the task back to the user.
  const subjectDerivable = !!url || !!ctx.hasAttachment
  if (subject) {
    slots.push({ key: 'subject', value: subject, source: 'stated', blocking: false })
  } else if (subjectDerivable) {
    slots.push({ key: 'subject', value: `whatever ${url ? 'that page' : 'that file'} covers`, source: 'derived', blocking: false })
  } else if (SUBJECT_CRITICAL.test(deliverable)) {
    slots.push({
      key: 'subject', source: 'missing', blocking: true,
      question: `What should the ${deliverable} cover? A topic, a paste of the material, or a link — any of those work.`,
    })
  } else {
    slots.push({ key: 'subject', value: 'a general treatment', source: 'default', blocking: false })
  }

  // ── ACCESS. Blocking only when the named source genuinely cannot be reached. NOTE: the
  //    resolution is for the USER to connect the account themselves — this never asks anyone to
  //    type a password into a chat box, which would put a live credential in a transcript.
  if (url && AUTH_WALLED.test(url)) {
    slots.push({
      key: 'access', source: 'missing', blocking: true,
      question: `That link sits behind a login, so I can't read it directly. Connect the account in Connections and I'll pull it, or paste the text here and I'll work from that — don't send me a password.`,
      options: ['I\'ll connect the account', 'I\'ll paste the text instead', 'Use a public source instead'],
      recommended: 'I\'ll paste the text instead',
    })
  } else {
    slots.push({ key: 'access', value: 'reachable', source: 'derived', blocking: false })
  }

  // ── QUANTITY / DEPTH / FORMAT. Never blocking. A wrong guess costs a regeneration, not a
  //    wasted build, and that is exactly the test for whether something deserves a question.
  slots.push(quantity
    ? { key: 'quantity', value: quantity, source: 'stated', blocking: false }
    : { key: 'quantity', value: def.quantity, source: 'default', blocking: false })
  slots.push(depth
    ? { key: 'depth', value: depth, source: 'stated', blocking: false }
    : { key: 'depth', value: def.depth, source: 'default', blocking: false })
  slots.push({ key: 'format', value: def.format, source: 'default', blocking: false })

  const ask = slots.filter(s => s.blocking && s.source === 'missing')
  const resolvedCount = Number(slots.find(s => s.key === 'quantity')?.value ?? def.quantity) || 1
  return {
    deliverable,
    slots,
    ask,
    assumed: slots.filter(s => s.source === 'default'),
    ready: ask.length === 0,
    // The contract the artifact will be held to. Built from the SAME resolved slots the brief
    // is built from, so the thing verified is exactly the thing requested.
    expectation: { shape: def.shape, count: resolvedCount, deliverable },
  }
}

/**
 * The build brief handed to the agent once the spec is ready.
 *
 * States the resolved plan explicitly so the model executes it rather than re-deliberating, and
 * names `read_url` when there is a URL — the refusal happened partly because the model did not
 * believe it could reach the page.
 */
export function briefFor(spec: GoalSpec): string {
  const v = (k: SlotKey) => spec.slots.find(s => s.key === k)?.value ?? ''
  const src = v('source')
  const lines = [
    `Build: ${spec.deliverable}.`,
    `Subject: ${v('subject')}.`,
    `Source: ${src}.`,
    `Amount: ${v('quantity')}.`,
    `Level: ${v('depth')}.`,
    `Format: ${v('format')}.`,
  ]
  if (URL_RE.test(src)) {
    // Name the ACTION, not a tool. There are two executors with different vocabularies for the
    // same operation — the registry calls it `read_url`, `fmReact` calls it `fetch_page` — and
    // an earlier brief hardcoded `read_url`, so the model handed that executor a tool it did not
    // have and emitted PSEUDO-CODE instead of a call (`const cards = read_url(...)`, 0 tools).
    // Describing the step and listing the aliases lets whichever executor is running bind it.
    lines.push(
      `FIRST fetch the page at ${src} and read its text — use whichever page-reading tool you ` +
      `have (fetch_page or read_url) — then build the deliverable from what it returns. ` +
      `You DO have access to that page; do not say otherwise.`,
    )
  }
  lines.push('Fill in every remaining detail yourself with sensible choices. Do not ask the user for anything else; produce the finished artifact.')
  return lines.join('\n')
}

/**
 * One combined question when several slots are missing, so the user answers once rather than
 * being walked through a form. Minimal elicitation is the whole point.
 */
export function elicitation(spec: GoalSpec): { question: string; options?: string[]; recommended?: string } | null {
  if (!spec.ask.length) return null
  const assumedLine = spec.assumed.length
    ? `\n\nI'll assume ${spec.assumed.map(s => `${s.key}: ${s.value}`).join(', ')} unless you say otherwise.`
    : ''
  if (spec.ask.length === 1) {
    const a = spec.ask[0]
    return { question: `${a.question}${assumedLine}`, options: a.options, recommended: a.recommended }
  }
  return {
    question: spec.ask.map(a => `• ${a.question}`).join('\n') + assumedLine,
    options: spec.ask[0].options,
    recommended: spec.ask[0].recommended,
  }
}
