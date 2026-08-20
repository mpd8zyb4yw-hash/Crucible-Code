/**
 * The one set of numbers the whole product is built from.
 *
 * Every connector was inventing its own spacing — 15px here, 14px there, a
 * 26px radius on Home and a 15px radius inside a surface — so the app read as
 * six things that happened to share a colour scheme. These exist so a new
 * surface has nothing to decide: it picks a spacing step and a type size, and
 * it already matches everything else.
 *
 * The rule the sizes encode: MAXIMUM USEFUL INFORMATION PER PIXEL, MINIMUM
 * PERMANENT CHROME. Anything permanently on screen has to earn its height, so
 * controls are deliberately smaller than content and secondary actions are not
 * given a resting place at all.
 */

/** Spacing steps. Nothing between them; if a gap needs 7px it needs 6 or 8. */
export const S = {
  hair: 2,
  tight: 4,
  snug: 6,
  base: 10,
  gap: 14,
  section: 18,
} as const

/**
 * THE LEFT EDGE. ONE NUMBER.
 *
 * Home's context row was inset 20, its cards 18, the composer 16, a settings
 * row 18+4, a surface header 20 — five edges within four pixels of each other,
 * which is the worst possible amount: too small to read as deliberate, too
 * large to look like a straight line. The screenshots showed text drifting
 * horizontally between Home, an opened app and Settings, and no component was
 * wrong on its own; they simply never agreed.
 *
 * Everything that presents content at the edge of the screen uses `page`. The
 * exception is deliberate and singular: a control with its own rounded
 * background sits at `page` too, so its BACKGROUND aligns with the text above
 * it rather than its label doing so.
 */
export const INSET = {
  /** Every content edge, on every screen. */
  page: 18,
  /** Inside a card, from its own edge to its content. */
  card: 14,
} as const

export const RADIUS = {
  chip: 999,
  card: 15,
  panel: 20,
  hero: 24,
} as const

/**
 * Type scale. Four sizes for content, two for chrome — a fifth content size
 * always turns out to be one of these four with extra opinions.
 *
 * IN `rem`, AND THAT IS THE ACCESSIBILITY CONTRACT.
 *
 * These were px, and px type does not respond to the browser's default-font-size
 * setting — which IS the text-size control on the web. So "test at the largest
 * supported accessibility text size" was unanswerable: there was no size to set.
 * Every number below is the old px value over 16, so at the default root size
 * the rendering is byte-identical and the change is purely that it now scales.
 *
 * Layout stays in px on purpose. A card is its tier's height whatever the text
 * does; larger text is absorbed by the reduction ladder (see CLAMP and
 * `useCardRoom`), never by a taller card and never by a scrollbar.
 */
const rem = (px: number) => `${(px / 16).toFixed(4)}rem`

export const TYPE = {
  /** Section eyebrows, provenance, counts. */
  micro: rem(10.5),
  /** Chrome: chips, toolbars, metadata. */
  small: rem(11.5),
  /** Body. */
  body: rem(13),
  /** Card titles. */
  title: rem(15.5),
  /** The one thing a card is about. */
  headline: rem(19),
  /** Surface titles only. */
  display: rem(25),
} as const

/**
 * THE LARGEST TEXT THIS PRODUCT SUPPORTS.
 *
 * Declared rather than discovered, because "we test at whatever the phone
 * happened to be set to" is how a screen ships that is correct at one size and
 * broken at every other. 1.5× is 24px root — the top of the range a browser's
 * font-size preference offers before the UA hands over to full page zoom, which
 * scales layout too and is therefore not a text-size problem at all.
 *
 * `scripts/shots.mjs` runs the whole Home matrix at 1 and at this number.
 */
export const TEXT_SCALE_MAX = 1.5

/**
 * HOW MANY LINES A THING GETS.
 *
 * Written down once because the failure was never a component choosing badly —
 * it was six components each choosing, so a long subject clipped in Mail,
 * ellipsised on Home and wrapped in a preview. Critical content is not in this
 * table: critical content is not clamped, it is BUDGETED (see the copy budget in
 * `server/homeCopy.ts`) and then it fits.
 */
export const CLAMP = {
  /** A card's primary title. One on Home; the whole value is one tap away. */
  title: 1,
  /** Preview, secondary explanation, descriptive context. */
  secondary: 2,
  /** Provenance, counts, times. */
  meta: 1,
} as const

/**
 * Permanent chrome heights.
 *
 * Fixed rather than content-derived, because these are the pixels the user
 * pays for on every screen forever. A toolbar that grows by 4px when a filter
 * label gets longer is 4px taken from the thing they actually came to see.
 */
export const CHROME = {
  control: 28,
  toolbar: 34,
  composer: 52,
} as const

/**
 * THE BOTTOM EDGE. The one number the geometry gate fails the build over.
 *
 * "The composer sits at the bottom of the screen" is not a matter of taste and
 * cannot be left to each surface: an inch of black under it is the single
 * defect that has been reported most, and every time it was a different
 * component paying for the same band twice. So the allowance is written down
 * ONCE, here, and `scripts/geometry.mjs` measures the real distance from the
 * composer to the bottom of the usable viewport against it on every capture in
 * every simulated iOS environment. Larger than this, and the build fails.
 *
 * `margin` is the design gap between the composer pill and the usable bottom —
 * the home-indicator inset is NOT part of it, because that inset is outside the
 * usable rectangle by then (see ViewportShell). `slack` is what platform
 * rounding, sub-pixel layout and a border-radius are allowed to add.
 */
export const BOTTOM = {
  margin: 12,
  slack: 6,
} as const

/**
 * HOME GEOMETRY.
 *
 * The per-card density table and the old rail heights lived here. They are gone
 * with the rails: a deck shows exactly one card, and that card fills its lane's
 * frame, so a card no longer has a size of its own to choose from a menu. What
 * remains is the lane geometry below, which is the only place any of it is
 * decided now.
 */

/**
 * THE THREE BANDS.
 *
 * Fixed heights, and this is deliberate and final — it supersedes the earlier
 * content-driven sizing. A band does not grow for a long title, a loading state,
 * an error, twenty items rather than three, or a card that has more to say.
 * Content adapts to its frame; the frame does not adapt to content.
 *
 * WHAT CHANGED, AND WHY IT IS NOT A RESKIN. Home used to be four lanes named
 * after where things came from — apps, saved panes, tasks, insights. That is a
 * filing system, and it made the reader do the triage: four equal rails, and the
 * question he actually has ("is anything on fire?") answered only by reading all
 * of them. Meanwhile the server had grown a real attention model that knew the
 * answer and had nowhere to put it.
 *
 * The bands are that answer, given room:
 *
 *   now         blocked on him, or close enough that waiting costs him
 *   next        context for what is coming
 *   background  true, quiet, safe to ignore today
 *
 * THE SIX SYSTEM APPLICATIONS ARE NOT ON HOME AT ALL. They were a lane, then a
 * strip of tiles at the foot of the screen, and the strip is now gone too. Both
 * were the same mistake at different sizes: an integration earning permanent
 * pixels for existing. A source reaches Home when it has something to say, as a
 * card, ranked against everything else — and when it has nothing to say it is
 * absent, which is the honest picture. See docs/ui-contract.md.
 *
 * `pager` is the row under each deck. It is part of the band's fixed budget
 * rather than an extra row, so a band with one card and a band with twenty
 * occupy identical space.
 */
export const LANE = {
  /** Header row: date, place, and the state of the app. */
  context: 30,
  /** The pager strip under a deck. */
  pager: 20,
  /** Gap between lanes. */
  gap: 10,
  /** Top padding above the context row. */
  padTop: 6,
  /**
   * THE STATUS ROW, RESERVED WHETHER OR NOT THERE IS ANYTHING TO SAY.
   *
   * It used to be `position:absolute` over the bottom of the last lane, on the
   * theory that a transient line should not cost permanent height. What that
   * actually bought was a line printed ON TOP of a card: dismiss something, and
   * "undo" landed across the content of whatever lane was underneath it.
   *
   * A row it cannot escape is 24px. Reserving it always — rather than only when
   * a status exists — is the other half: lane geometry must not move because a
   * message appeared, or every dismissal would shuffle the whole screen.
   *
   * 24 AND NOT 20, WHICH IS A DEFECT THE NEW GATE FOUND. `SurfaceStatus` is
   * `5px + ~15px + 4px` = 24px and the row was 20px with `overflow:hidden`, so
   * every status Home ever printed was clipped by four pixels along its bottom
   * edge — the descenders of "undo" cut off. Invisible to every previous
   * assertion because nothing measured inside a fixed row; found immediately by
   * the stranded-content check once it was pointed at Home.
   */
  status: 24,
  /**
   * AN EMPTY BAND, COLLAPSED.
   *
   * One unboxed line, and nothing else. This overturns the previous rule — an
   * empty band used to keep its ENTIRE budget, frame and pager included, on the
   * theory that fixed Y positions matter more than the space. What that bought,
   * on a quiet morning, was a quarter of the screen spent on a bordered
   * rectangle containing the words "Nothing needs you", which reads as the app
   * being broken rather than as the day being calm.
   *
   * The geometry is still not content-driven: a band is its tier, or it is this,
   * and there is nothing in between. What varies is whether the band has
   * anything in it at all, which is the one thing the screen is FOR.
   */
  empty: 22,
  /**
   * The shortest CARD a band may hold before it stops being a card.
   *
   * Only reachable on a window too short to hold the tier table — a landscape
   * phone, or a desktop browser dragged to a slit. There the tiers shrink
   * proportionally to this floor and Home clips, which is the honest failure:
   * legible bands and a cut, rather than three unreadable slivers.
   */
  minCard: 84,
} as const

/**
 * THE THREE APPROVED CARD HEIGHTS. THERE IS NO FOURTH.
 *
 * A Home card's height comes from this table and from nowhere else — not from
 * its kind, not from its content, and (this is what changed) not from the
 * device. Device-derived heights were the previous answer and they were right
 * about one thing and wrong about the rule: right that a constant cannot fill
 * two phones, wrong that filling the phone is the goal. What the screen owes him
 * is the one or two things that deserve pixels now; the rest of the glass is
 * allowed to be empty, and on a quiet day it should be.
 *
 * `tall` IS THE MAXIMUM. Nothing on Home may exceed it, for any reason, in any
 * text size, in any data state. `scripts/shots.mjs` measures every card against
 * this table on every capture.
 */
export const CARD_TIER = {
  compact: 112,
  standard: 168,
  tall: 224,
} as const

export type CardTier = keyof typeof CARD_TIER

/** No card, anywhere on Home, is taller than this. */
export const MAX_CARD_HEIGHT = CARD_TIER.tall

export type LaneId = 'now' | 'next' | 'background'

export const LANE_ORDER: LaneId[] = ['now', 'next', 'background']

/** What each band is called on screen, and the promise it makes. */
export const LANE_LABEL: Record<LaneId, string> = {
  now: 'needs you',
  next: 'coming up',
  background: 'quietly true',
}

/**
 * WHICH TIER EACH BAND GETS.
 *
 * NOT EQUAL, and the inequality is the argument the screen exists to make. The
 * thing that is blocked on him has to be legible from across a room; the thing
 * that is quietly true only has to be findable. A screen where "your two sources
 * disagree" and "you walked slightly less this week" occupy identical boxes is a
 * screen that has declined to have an opinion.
 */
export const LANE_TIER: Record<LaneId, CardTier> = {
  now: 'tall', next: 'standard', background: 'compact',
}

export interface LaneGeometry {
  now: number
  next: number
  background: number
  /** What the three bands plus their gaps and pagers consume. */
  total: number
  /**
   * The glass below the last band. Deliberate, and not a bug.
   *
   * Named and returned so the gate can assert it is non-negative rather than
   * assert it is zero — "the bands fill Home" was the OLD rule, and it is what
   * made an empty band worth a quarter of a screen.
   */
  slack: number
}

/**
 * THE TIER TABLE, AND WHAT AN EMPTY BAND COSTS INSTEAD.
 *
 * Two rules, and every number here comes out of one of them:
 *
 *   A band with something in it is `CARD_TIER[LANE_TIER[band]]` plus its pager.
 *   Nothing about its content changes that — not a long title, not twenty cards,
 *   not an error, not the text size.
 *
 *   A band with nothing in it is `LANE.empty`. It does not keep the geometry it
 *   would have had if it were full, because reserving a card's worth of screen
 *   for the sentence "Nothing coming up" is the app spending his glass on its own
 *   filing system.
 *
 * What is left over is left over. Home is allowed to be mostly empty, and on a
 * quiet day that is the correct picture of a quiet day.
 *
 * THE ONE CASE THAT SCALES. A window too short for the tier table — landscape, a
 * keyboard up, a browser dragged to a slit — shrinks the CARDS proportionally to
 * `LANE.minCard`. That is still not content-driven: the result is a function of
 * the window and of which bands are empty, and of nothing else. Two feeds on the
 * same phone always produce the same numbers.
 */
export function laneHeights(
  available: number,
  empty: Record<LaneId, boolean> = { now: false, next: false, background: false },
): LaneGeometry {
  // The pager is INSIDE a band's height, not an extra row beneath it — that is
  // what makes a one-card band and a twenty-card band the same size.
  const chrome = LANE.padTop + LANE.context + LANE.gap * (LANE_ORDER.length + 1)
  const budget = available - chrome

  const filled = LANE_ORDER.filter((id) => !empty[id])
  const fixed = LANE_ORDER.filter((id) => empty[id]).length * LANE.empty
    + filled.length * LANE.pager
  const wanted = filled.reduce((s, id) => s + CARD_TIER[LANE_TIER[id]], 0)

  // ≤ 1 in the ordinary case, so the tiers are used verbatim and the remainder
  // is space. Below 1 only on a window that cannot hold them.
  const k = wanted > 0 ? Math.min(1, (budget - fixed) / wanted) : 1

  const out = {} as Record<LaneId, number>
  let spent = 0
  for (const id of LANE_ORDER) {
    const h = empty[id]
      ? LANE.empty
      : Math.max(LANE.minCard, Math.floor(CARD_TIER[LANE_TIER[id]] * k)) + LANE.pager
    out[id] = h
    spent += h
  }

  return { ...out, total: spent + chrome, slack: budget - spent }
}

/**
 * The card box inside a band, which is what the tier is actually about.
 *
 * The band carries the pager; the CARD is what the height contract names, so
 * this is the number the gate measures against `CARD_TIER`.
 */
export const cardHeight = (bandHeight: number): number => bandHeight - LANE.pager

/**
 * TAP VS SWIPE, as tokens rather than per-renderer guesses.
 *
 * Every deck arbitrates the same way, so the gesture is learned once and tuned
 * once. A card control gets taps normally below the intent threshold; past it,
 * and only when the movement is clearly horizontal, the lane takes over paging
 * and cancels the card activation that was otherwise about to happen.
 */
export const GESTURE = {
  /** CSS px of travel before a drag is an intent rather than a jittery tap. */
  dragIntentThreshold: 11,
  /** How much horizontal has to dominate vertical to be a page rather than a scroll. */
  horizontalDominance: 1.25,
  /** Fraction of card width that commits a page on release. */
  commitFraction: 0.3,
  /** px/ms of release velocity that commits regardless of distance. */
  commitVelocity: 0.45,
  /** Above this many cards, dots become a numeric position. */
  dotsMax: 5,
} as const

/**
 * COLOUR SEMANTICS.
 *
 * Colour says what STATE a thing is in. It never says how highly it ranked —
 * rank is expressed by which card is in front, and a palette that also encoded
 * it would be two languages competing in the same pixels. One vocabulary, used
 * by all four lanes, deliberately restrained: most things are neutral.
 */
export type StateTone =
  | 'urgent' | 'changed' | 'active' | 'warning' | 'timeSensitive' | 'neutral' | 'resolved'

export const TONE: Record<StateTone, string> = {
  /** Needs an action from him. */
  urgent: '#F0736B',
  /** New or changed since he last looked. */
  changed: '#A98FE0',
  /** Running right now. */
  active: '#7FB3D5',
  /** Blocked, or failed and retryable. */
  warning: '#E7B24C',
  /** Imminent but healthy. */
  timeSensitive: '#F0A56B',
  neutral: 'rgba(237,238,241,.34)',
  resolved: '#5FC9A6',
} as const
