// Which KIND of single-file HTML artifact is the goal asking for? (cont.79e)
//
// Why this exists: the HTML write path was game-shaped end-to-end — every `.html` goal got a
// canvas game shell, the game system prompt, and the GAME runtime gate. That gate REQUIRES a
// <canvas> and keydown handlers, so a perfectly correct non-game app was rejected:
//
//     runtimeVerifyHtml(<a working todo app>) === 'no <canvas> element present at runtime'
//
// and — worse — that string is fed back as REPAIR FEEDBACK for 6 attempts, so the loop actively
// pushed the model to bolt a canvas onto a todo list before failing. Non-game interactive HTML
// wasn't merely unverified; it was mis-verified into corruption. Splitting the KIND is what lets
// each path carry invariants that are true for it.
//
// DEFAULT IS 'app', deliberately. The two misclassifications are not symmetric:
//   - app misread as game  → forced canvas + keyboard demands → corrupts a correct artifact (the
//                            bug this module exists to kill).
//   - game misread as app  → keeps the universal checks (no errors, responds to input), loses only
//                            the game-specific ones. Weaker, never wrong.
// So only an AFFIRMATIVE game signal selects 'game'; silence means 'app'.

export type HtmlGoalKind = 'game' | 'app'

// Affirmative game signals: the word itself, the act of playing, or a named game whose shape is
// unambiguously arcade. Kept to titles that are games in ~every context — "puzzle", "board" and
// "cards" are intentionally ABSENT (a "puzzle" can be a jigsaw UI, a "board" can be a dashboard).
const GAME_RX = new RegExp([
  // explicit
  /\bgames?\b/, /\bgameplay\b/, /\barcade\b/, /\bplayable\b/,
  /\blet(?:'s)?\s+play\b/, /\bplay(?:er|ers)?\b/,
  // named arcade titles
  /\bsnake\b/, /\bpong\b/, /\btetris\b/, /\bbreakout\b/, /\bbrick[\s-]?breaker\b/, /\barkanoid\b/,
  /\bflappy\b/, /\bspace\s*invaders?\b/, /\binvaders?\b/, /\basteroids?\b/, /\bpac[\s-]?man\b/,
  /\bfrogger\b/, /\bdoodle\s*jump\b/, /\b2048\b/, /\bminesweeper\b/, /\bsolitaire\b/,
  /\btic[\s-]?tac[\s-]?toe\b/, /\bconnect[\s-]?four\b/, /\bgal(?:aga|axian)\b/, /\bcentipede\b/,
  // genre words
  /\bplatformer\b/, /\bshoot(?:er|ing)\b/, /\brogue[\s-]?like\b/, /\bendless\s+runner\b/,
  /\bmaze\b/, /\bdodge\b/,
].map(r => r.source).join('|'), 'i')

/** Deterministic, zero-model. Returns 'game' only on an affirmative game signal; else 'app'. */
export function classifyHtmlGoal(goal: string): HtmlGoalKind {
  return GAME_RX.test(goal || '') ? 'game' : 'app'
}
