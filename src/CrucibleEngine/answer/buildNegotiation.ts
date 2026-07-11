// Deterministic build-negotiation resolver — carries a build request's ACCUMULATING spec
// across turns and, on an explicit greenlight, hands a CONCRETE goal to the real builder.
//
// Why this exists (2026-07-11 bug): after the first "make me a game" clarify, every follow-up
// ("can it be something different?", "a simple fps game?", "battle royale", "i trust you, do
// your thing", "build the game") fell to the weak on-device FM, which role-played a planning
// assistant — "Great choice! Here's a basic outline: Game Setup, Player Movement…" — and NEVER
// built anything. Each turn was judged in isolation: no state tracked the topic being refined,
// and greenlight phrases ("do your thing", "build the game") triggered no build. The result was
// an infinite clarify/outline loop.
//
// The fix, doctrine-aligned: the SYSTEM owns the negotiation deterministically. It reconstructs
// the topic + refinements from history, and when the user greenlights, it ASSEMBLES a concrete,
// buildable, HONEST spec (downscoping asks that a weak on-device model plainly cannot build —
// a full 3D battle-royale FPS becomes a runnable browser mini-game, with the downscope stated
// out loud) and routes it to the actual builder. No FM role-play, un-poisonable, instant.

export interface BuildTurn {
  /** 'build' → route to the real builder with `spec`; 'clarify' → answer a mid-negotiation
   * refinement turn deterministically with `text` (do NOT let the weak FM role-play); 'passthrough'
   * → not our turn, leave it to the existing paths. */
  action: 'build' | 'clarify' | 'passthrough'
  /** The concrete, assembled build instruction handed to the agent loop (action === 'build'). */
  spec?: string
  /** The deterministic reply to a mid-negotiation refinement turn (action === 'clarify'). */
  text?: string
  /** A user-facing honesty note when we scoped the request down to something buildable. */
  note?: string
  /** The genre/topic we resolved, for logging. */
  topic?: string
}

// A message whose ENTIRE content is a go-ahead: hand control to the builder. Kept anchored and
// short so real content ("build a snake game that eats apples") is never mistaken for a bare
// greenlight — those carry their own spec and flow to the builder through the normal path.
const GREENLIGHT_PHRASES: RegExp[] = [
  /i\s+trust\s+you/, /do\s+your\s+thing/, /do\s+it/, /go\s+ahead/, /go\s+for\s+it/,
  /make\s+it(?:\s+happen)?/, /build\s+it/, /build\s+the\s+\w+/, /build\s+that/,
  /you\s+(?:decide|choose|pick)/, /your\s+call/, /whatever\s+you\s+(?:think|want|like)/,
  /surprise\s+me/, /sounds?\s+good/, /let'?s\s+(?:do|go|build)/, /just\s+(?:build|do|make)\s+it/,
  /proceed/, /start\s+building/, /get\s+(?:started|building)/, /go\s+build/,
]
// Bare affirmations that ONLY mean "yes, proceed" when a topic is already on the table.
const BARE_AFFIRM = /^\s*(?:yes|yeah|yep|yup|ok|okay|sure|sure thing|please do|absolutely|definitely|of course|go|do)\b[\s!.,]*$/i

function isGreenlight(message: string): boolean {
  const m = (message ?? '').trim().toLowerCase()
  if (!m || m.length > 80) return false
  if (BARE_AFFIRM.test(m)) return true
  // A short message that consists mainly of a greenlight phrase (+ minor filler).
  const words = m.split(/\s+/).length
  if (words > 12) return false
  return GREENLIGHT_PHRASES.some(rx => rx.test(m))
}

// ── Topic / genre extraction ──────────────────────────────────────────────────

const ARTIFACT_RX = /\b(game|app|application|web\s?site|web\s?page|site|tool|program|dashboard|widget|simulator|simulation|visuali[sz]ation|animation|quiz|puzzle|clone)\b/i

// Recognisable game genres, longest/most-specific first so "battle royale" wins over "royale".
const GENRES = [
  'battle royale', 'text adventure', 'tower defense', 'first person shooter', 'first-person shooter',
  'tic tac toe', 'space invaders', 'endless runner', 'point and click', 'first person', 'first-person',
  'snake', 'tetris', 'pong', 'breakout', 'flappy', 'platformer', 'shooter', 'fps', 'rpg', 'adventure',
  'racing', 'maze', 'clicker', 'idle', 'asteroids', 'minesweeper', 'solitaire', 'sudoku', 'chess',
  'checkers', 'memory match', 'memory', 'match three', 'match-3', 'roguelike', 'sandbox', 'survival',
  'stealth', 'shoot em up', 'brick breaker', '2048', 'wordle', 'hangman', 'trivia',
]

// Genres/qualifiers that a weak on-device model plainly cannot deliver as a real, running build.
// We keep the SPIRIT but scope down to a browser mini-game — and say so.
const OVER_SCOPE = /\b(battle\s*royale|fps|first[-\s]?person|3d|three[-\s]?d|multiplayer|mmo|open\s*world|aaa|photorealistic|ray[-\s]?trac|vr|augmented reality)\b/i

// A creation intent anywhere in a user turn — the marker that a BUILD (not a factual chat) was
// what the conversation was about. Shared by the greenlight and refinement paths.
const CREATE_VERB = /\b(build|make|create|write|code|develop|design|generate|whip\s+up|put\s+together)\b/i

// Explicit "let's change/adjust the plan" markers on the CURRENT turn. A refinement that names a
// concrete genre doesn't need one of these (the genre itself is the signal); a CONTENTLESS
// refinement ("can it be something different?") relies on them so we don't hijack an unrelated turn.
const REFINE_CONNECTIVE = /\b(instead|rather|actually|different|something\s+else|what\s+else|anything\s+else|change\s+it|how\s+about|what\s+about|can\s+it\s+be|can\s+you\s+make\s+it|not\s+that|other\s+than)\b/i

// A pure acknowledgement — the ENTIRE turn is gratitude/approval with no request. Mid-negotiation
// these still fell to the weak FM, which role-played a planning assistant ("I'd be happy to help
// you create a game! 1. Board Game … use Unity or Unreal Engine"). We answer with a warm, honest
// nudge instead. Anchored whole-message + short so a real request that merely opens with "cool" or
// "thanks for the …" is never swallowed. ("ok"/"okay"/"sounds good" are already greenlights.)
const BARE_ACK = /^\s*(?:thanks?(?:\s+you)?|thank\s+you|thx|ty|cool|nice|great|awesome|sweet|perfect|neat|got\s+it|makes\s+sense|good\s+(?:to\s+know|stuff)|that\s+helps?|helpful)(?:[\s,!.]+(?:thanks?|that\s+helps?|cool|nice|great|man|though))?[\s!.,]*$/i

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

/** Pull every genre mentioned across the negotiation, most-recent-turn last. */
function extractGenres(texts: string[]): string[] {
  const found: string[] = []
  for (const t of texts) {
    const low = (t ?? '').toLowerCase()
    for (const g of GENRES) {
      if (low.includes(g) && !found.includes(g)) found.push(g)
    }
  }
  return found
}

function extractArtifact(texts: string[]): string | null {
  for (let i = texts.length - 1; i >= 0; i--) {
    const m = ARTIFACT_RX.exec(texts[i] ?? '')
    if (m) return m[1].toLowerCase().replace(/\s+/g, '')
  }
  return null
}

/**
 * Resolve a build-negotiation turn. `history` is the prior conversation ({user, assistant} per
 * turn). Two outcomes the SYSTEM owns deterministically (never the weak FM):
 *  - action 'build' — the CURRENT message is a greenlight AND the conversation established a build
 *    topic → assemble a concrete spec and hand it to the real builder.
 *  - action 'clarify' — the CURRENT message REFINES a build already under discussion (names a genre,
 *    or asks for a different direction) but isn't yet a greenlight → a deterministic negotiation
 *    reply (confirm + honest scope + invite a one-word go-ahead) instead of FM role-play.
 * Otherwise 'passthrough'.
 */
export function resolveBuildTurn(
  message: string,
  history: Array<{ user?: string; assistant?: string }> = [],
): BuildTurn {
  // Only the recent window counts — a build discussed 20 turns ago must not make a later
  // unrelated "yes" build (or a stray genre word clarify) something stale.
  const recent = history.slice(-6)
  const userTurns = recent.map(h => h?.user ?? '').filter(Boolean)
  if (isGreenlight(message)) return resolveGreenlight(message, userTurns)
  return resolveRefinement(message, userTurns)
}

/** A greenlight ("do your thing", "build it") after a build was under discussion → assemble + build. */
function resolveGreenlight(message: string, userTurns: string[]): BuildTurn {
  const allUserText = [...userTurns, message]

  // A build must actually have been under discussion: an artifact noun or a game genre appeared,
  // AND at least one user turn expressed a creation intent. A bare "yes" to a factual Q&A must
  // never build.
  const artifact = extractArtifact(allUserText)
  const genres = extractGenres(allUserText)
  const wantedBuild = allUserText.some(t => CREATE_VERB.test(t))
  if ((!artifact && genres.length === 0) || !wantedBuild) return { action: 'passthrough' }

  const genre = genres[genres.length - 1] || null // most-recent wins
  const kind = artifact ?? (genre ? 'game' : 'app')
  const isGame = kind === 'game' || genres.length > 0

  // Over-scope → build the closest thing that actually runs on-device, and say so.
  if (isGame && OVER_SCOPE.test(allUserText.join(' '))) {
    const spirit = genre ? `a scoped-down take on ${genre}` : 'a scoped-down take on that idea'
    return {
      action: 'build',
      topic: genre ?? 'game',
      note:
        `A full ${genre ?? '3D/FPS'} game is beyond what I can build and run entirely on-device — ` +
        `so I'm building ${spirit} that actually works: a browser mini-game you can play right now.`,
      spec:
        'Build a complete, playable browser game in a single self-contained HTML file ' +
        '(HTML + CSS + vanilla JS on a <canvas>): a top-down arena survival shooter — ' +
        'the player moves with WASD/arrow keys, aims and shoots with the mouse at enemies that ' +
        'spawn and close in, survive as long as possible while the score climbs, with a clear ' +
        'game-over screen and a restart control. Keep it dependency-free so it opens and runs in any browser.',
    }
  }

  if (isGame) {
    const g = genre ?? 'arcade'
    return {
      action: 'build',
      topic: g,
      spec:
        `Build a complete, playable ${g} game in a single self-contained HTML file ` +
        '(HTML + CSS + vanilla JS on a <canvas> where it fits): keyboard/mouse controls, a visible ' +
        'score or win condition, and a game-over/restart. Dependency-free so it opens and runs in any browser.',
    }
  }

  // Non-game artifact (app/tool/site/…): assemble from the artifact noun.
  const label = kind === 'website' || kind === 'webpage' || kind === 'site' ? 'website' : kind
  return {
    action: 'build',
    topic: label,
    spec:
      `Build a complete, working ${label} as a single self-contained HTML file ` +
      '(HTML + CSS + vanilla JS, dependency-free) that opens and runs in any browser, ' +
      'based on what we discussed. Make it functional, not a mock-up.',
  }
}

/**
 * A mid-negotiation REFINEMENT turn (not a greenlight, not the first bare build). The bug this
 * fixes (2026-07-11): turns like "a simple fps game?", "battle royale", "can it be something
 * different?" fell to the weak FM, which role-played a planning assistant and built nothing. We
 * answer them deterministically: confirm what we heard, downscope honestly when the ask exceeds
 * what runs on-device, and invite a one-word go-ahead. Conservative by construction — fires ONLY
 * when a build was already established in PRIOR turns (the FIRST bare build is owned by
 * clarifyBuild) AND the current turn actually refines it.
 */
function resolveRefinement(message: string, userTurns: string[]): BuildTurn {
  // A build must already have been under discussion in earlier turns — never hijack a fresh
  // conversation, and never double-handle the first bare "make me a game" (clarifyBuild owns it).
  const priorGenres = extractGenres(userTurns)
  const establishedInHistory =
    (extractArtifact(userTurns) != null || priorGenres.length > 0) && userTurns.some(t => CREATE_VERB.test(t))
  if (!establishedInHistory) return { action: 'passthrough' }

  const cur = (message ?? '').trim()
  if (!cur || cur.split(/\s+/).length > 14) return { action: 'passthrough' }
  const curLow = cur.toLowerCase()

  // A bare acknowledgement ("thanks, that helps", "cool") — keep the door open deterministically
  // instead of letting the FM role-play. Checked before the refinement signals: it has neither a
  // genre nor a connective, so it would otherwise pass through to the FM.
  if (BARE_ACK.test(cur)) {
    return {
      action: 'clarify',
      topic: priorGenres[priorGenres.length - 1] ?? 'game',
      text:
        `Anytime. Whenever you want, just say "go" (or name the game you'd like) and I'll build ` +
        `and run it for you right here — or keep tossing ideas around with me first.`,
    }
  }

  // The current turn must POSITIVELY refine the build: it names a concrete genre, or it uses an
  // explicit "change direction" marker. An unrelated aside ("what time is it?") passes through.
  const curGenres = extractGenres([cur])
  const refined = curGenres.length > 0 || REFINE_CONNECTIVE.test(curLow)
  if (!refined) return { action: 'passthrough' }

  // Named a concrete genre → confirm it (honestly downscoping over-ambitious asks) and offer to build.
  if (curGenres.length > 0) {
    const g = curGenres[curGenres.length - 1]
    if (OVER_SCOPE.test(curLow)) {
      return {
        action: 'clarify',
        topic: g,
        note: `downscoped ${g}`,
        text:
          `A full ${g} game isn't something I can build and run entirely on-device — but I can build ` +
          `a browser mini-game that captures the spirit: a fast top-down arena shooter you actually ` +
          `play (WASD to move, mouse to aim, survive as long as you can). Want me to build that? ` +
          `Just say "go" (or "do your thing") and I'll start — or point me in another direction.`,
      }
    }
    return {
      action: 'clarify',
      topic: g,
      text:
        `${capitalize(g)} — I can build that as a playable browser game and run it for you. ` +
        `Want me to go ahead? Say "go" and I'll build it, or tell me more about how it should play.`,
    }
  }

  // Contentless refinement ("something different", "not that", "what else?") → concrete options.
  return {
    action: 'clarify',
    topic: priorGenres[priorGenres.length - 1] ?? 'game',
    text:
      `Sure — we can go a different direction. A few I can build and run right now:\n\n` +
      `- **Snake** — classic arrow-key snake\n` +
      `- **Breakout** — bounce a ball to smash the bricks\n` +
      `- **Asteroids** — fly and shoot in open space\n\n` +
      `Tell me which one (or describe your own) and I'll build it — or say "you pick" and I'll choose.`,
  }
}
