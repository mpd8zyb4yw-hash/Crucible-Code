// Deterministic conversational meta-handler — the identity/greeting/capability layer the
// weak on-device FM must NOT be trusted with.
//
// Why this exists (2026-07-11 bug): given a bare opener like "test", the FM invents a task
// framing ("Sure, I'd be happy to help you with your test! What subject are you studying?"),
// and that fabrication then POISONS every later turn — "who are you" came back "I am an AI
// assistant designed to help you with your studies", and "tell me a joke" came back "I'm
// studying English literature…​" (the model role-playing as the USER). A conversation cannot
// have contextual understanding if turn 1's hallucination becomes the persona.
//
// The fix, doctrine-aligned: the SYSTEM owns what it can answer deterministically. Crucible's
// own identity, a greeting, and its capabilities are FIXED FACTS — there is nothing for a
// model to reason about, so we answer them from here (fast, un-poisonable, and correct even
// when the FM daemon is down) and only defer to the model for genuine content.

export type MetaKind = 'greeting' | 'identity' | 'capability'

export interface MetaMatch {
  kind: MetaKind
  text: string
}

// A bare probe/greeting: "hi", "hello", "test", "testing", "you there?", "ping" — a message
// whose entire content is a salutation or a connectivity check, with no actual request.
const GREETING = /^\s*(?:hi+|hey+|hello+|hiya|howdy|heya|yo|sup|wassup|what'?s up|greetings|good\s+(?:morning|afternoon|evening|day)|g'?day|hey\s+there|hi\s+there|test(?:ing)?(?:\s+test)?|ping|is\s+(?:this|it|anyone|anybody)\s+(?:there|on|working)|are\s+you\s+(?:there|on(?:line)?|up|working|alive|ready)|you\s+(?:there|up|online))[\s!.?,…]*$/i

// "who are you", "what are you", "what's your name", "introduce yourself", "tell me about
// yourself". Anchored to the whole message so it never swallows "who are you voting for".
const IDENTITY = /^\s*(?:who\s+(?:are|r)\s+(?:you|u)|what\s+are\s+you|what'?s\s+your\s+name|what\s+is\s+your\s+name|introduce\s+yourself|tell\s+me\s+about\s+yourself|are\s+you\s+(?:an?\s+)?(?:ai|bot|robot|human|chatgpt|gpt|claude|llm|language\s+model))\b[\s?.!]*$/i

// "what can you do", "what do you do", "how can you help", "what are you capable of".
const CAPABILITY = /^\s*(?:what\s+can\s+you\s+(?:do|help(?:\s+with)?)|what\s+do\s+you\s+do|what\s+are\s+you\s+(?:capable\s+of|able\s+to\s+do)|how\s+(?:can|do)\s+you\s+help|what\s+(?:can|could)\s+you\s+help\s+(?:me\s+)?with|help)\b[\s?.!]*$/i

const GREETING_TEXT =
  "Hi — I'm Crucible, a private assistant running entirely on your device. " +
  "Ask me a question, hand me a problem to reason through, or ask me to build something. " +
  'What would you like to do?'

const IDENTITY_TEXT =
  "I'm Crucible — an AI assistant that runs entirely on your own device. Everything happens " +
  'locally: no cloud, no account, nothing leaves your machine. I can answer questions and ' +
  'explain things, reason through problems step by step and check my own work, and write, ' +
  'build, and run code. What can I help you with?'

const CAPABILITY_TEXT =
  'A few things, all on-device:\n\n' +
  '- **Answer questions and explain concepts** — from a quick fact to a deep walkthrough.\n' +
  '- **Reason through problems** — math, logic, multi-step questions — and I check my own work before answering.\n' +
  '- **Write, build, and run code** — from a one-off snippet to a working, runnable app.\n\n' +
  'What would you like to start with?'

/**
 * If the message is a pure greeting, identity question, or capability question, return the
 * canonical deterministic answer. Otherwise null (the caller runs the normal model path).
 *
 * Conservative by construction: every pattern is anchored to the ENTIRE message, so a real
 * question that merely contains "hi" or "who" ("who won the 1998 World Cup", "which airport
 * is closest") never matches and is left for the reasoning path.
 */
export function matchMeta(message: string): MetaMatch | null {
  const m = (message ?? '').trim()
  if (!m || m.length > 60) return null // long messages are never bare meta-openers
  if (IDENTITY.test(m)) return { kind: 'identity', text: IDENTITY_TEXT }
  if (CAPABILITY.test(m)) return { kind: 'capability', text: CAPABILITY_TEXT }
  if (GREETING.test(m)) return { kind: 'greeting', text: GREETING_TEXT }
  return null
}

// ── Underspecified build requests ────────────────────────────────────────────
// "build me a game" routed into the agent, which — with no spec to build from —
// let the weak FM free-associate off stale conversation history and emit a recycled
// greeting while falsely reporting "build complete". A generic creation verb + a
// generic artifact noun and NOTHING else is not a buildable spec; it's a request for
// a conversation. Answer it like a capable collaborator: name concrete options and ask
// the one question that unblocks the build. Deterministic → un-poisonable, instant.

// create-verb + optional filler + a GENERIC artifact noun + end-of-message. A qualifier
// (adjective, name, tech, feature, "that <does X>") makes it specific → we do NOT match,
// and it flows to the real builder ("build a snake game", "make a todo app in react").
const BARE_BUILD = /^(?:can\s+you\s+|please\s+|could\s+you\s+)?(?:build|make|create|write|code|develop|design|generate|whip\s+up|put\s+together)\s+(?:me\s+)?(?:a|an|some|me\b)?\s*(game|app|application|web\s?site|web\s?page|site|program|tool|script|project|dashboard|widget|demo|prototype|something)\s*(?:for\s+me)?[.!?]*$/i

const BUILD_CLARIFY: Record<string, string> = {
  game:
    'Happy to build you a game — what kind? A few I can put together quickly and run for you:\n\n' +
    '- **Snake** — classic arrow-key snake\n' +
    '- **Memory match** — flip-the-cards pairs game\n' +
    '- **Number guessing** — I pick a number, you guess with hi/lo hints\n\n' +
    'Tell me which one (or describe your own), and whether you want it to run in the **browser** or the **terminal**.',
  app:
    'Glad to — what should the app do? For example a **to-do list**, a **notes** app, a **timer/stopwatch**, ' +
    'or a **unit converter**. Tell me the purpose and whether you want it in the **browser** or the **terminal**, ' +
    'and I\'ll build and run it.',
  website:
    'Sure — what\'s the site for? A **personal landing page**, a **portfolio**, a **product page**, or a **blog**? ' +
    'Give me the purpose and a rough style (minimal, playful, dark, …) and I\'ll build it.',
}

export function clarifyBuild(message: string): string | null {
  const m = (message ?? '').trim()
  if (!m || m.length > 60) return null
  const match = BARE_BUILD.exec(m)
  if (!match) return null
  const noun = match[1].toLowerCase().replace(/\s+/g, '')
  if (noun === 'game') return BUILD_CLARIFY.game
  if (noun === 'app' || noun === 'application') return BUILD_CLARIFY.app
  if (noun === 'website' || noun === 'webpage' || noun === 'site') return BUILD_CLARIFY.website
  // Generic artifacts ("program", "tool", "something", "project", …) → one focused ask.
  const label = noun === 'something' ? 'something' : `a ${noun}`
  return (
    `Happy to build ${label} — I just need a bit more to go on. What should it **do**, ` +
    'and do you want it to run in the **browser** or the **terminal**? ' +
    'Give me a sentence or two and I\'ll build and run it for you.'
  )
}
