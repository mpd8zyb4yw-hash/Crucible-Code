/**
 * DELIBERATE FAILURE, AT EVERY SEAM THAT CAN LOSE THE SCREEN.
 *
 * There was already an injection point, and it covered exactly one thing: a
 * domain widget's render. That is the seam that was ALREADY protected, so what
 * it proved was that the protection it was testing worked — and every failure
 * actually observed on the phone happened somewhere else. Home's own render,
 * the deck that pages it, navigation, settings, the chat parser, the hydration
 * that runs before any of them: none of those could be made to fail on purpose,
 * so none of them was ever shown to survive failing.
 *
 * A boundary you have never seen catch anything is a comment.
 *
 * Every point below is a place where a throw used to be able to reach the app
 * root. The contract each one is asserting is the same, and it is the only one
 * that matters to someone holding the phone:
 *
 *   · the app is never blank;
 *   · a screen he can use survives — the previous one, or Home;
 *   · the failure is bounded, named, and recorded.
 *
 * From a console on the device:
 *
 *   __cruPoison('home')            → Home's render throws
 *   __cruPoison('nav')             → resolving a card's target throws
 *   __cruPoison('calendar')        → the Calendar renderer throws
 *   __cruPoison()                  → clear
 */

export type PoisonPoint =
  /** Home's own render — above every lane, below the app boundary. */
  | 'home'
  /** A lane's paged deck. Fails while he is swiping. */
  | 'deck'
  /** Resolving which surface a card opens. */
  | 'nav'
  /** Reading persisted state on boot, before anything has painted. */
  | 'hydrate'
  /** The settings screen, and its provider/model accordions. */
  | 'settings'
  | 'provider'
  | 'model'
  /** Turning a provider response into an assistant message. */
  | 'parser'
  /** The slot ladder that decides whether a task can run. */
  | 'task'
  /** Anything else is a widget kind: 'calendar', 'mail', 'map', … */
  | (string & {})

const POISONED = new Set<string>()

/** True when this seam has been asked to fail. Cheap; called on hot paths. */
export const poisoned = (point: PoisonPoint): boolean => POISONED.size > 0 && POISONED.has(point)

/**
 * Throw here if this seam is poisoned.
 *
 * The message names the seam, so the crash record and the bounded error state
 * both say which one it was rather than "something failed".
 */
export function failIfPoisoned(point: PoisonPoint): void {
  if (poisoned(point)) throw new Error(`poisoned: ${point}`)
}

/**
 * Run something that must not be allowed to take the app down with it.
 *
 * For the seams that are NOT React renders — resolution, hydration, parsing —
 * where there is no boundary to catch a throw because there is no component.
 * The fallback is a value, and the caller has already decided what a safe one
 * is; that decision is the recovery.
 */
export function contained<T>(point: PoisonPoint, run: () => T, fallback: T): T {
  try {
    failIfPoisoned(point)
    return run()
  } catch (e) {
    try {
      const w = globalThis as unknown as { __cruContained?: { at: string; point: string; error: string }[] }
      w.__cruContained = [
        { at: new Date().toISOString(), point: String(point), error: String((e as Error)?.message ?? e) },
        ...(w.__cruContained ?? []),
      ].slice(0, 20)
    } catch { /* never fail from the failure handler */ }
    return fallback
  }
}

/*
  `globalThis`, not `window`.

  The same modules are imported by the contract runner under Node, where there
  is no `window` — and a module that throws at import time takes the whole test
  process down before a single assertion runs. Reaching for the global at all is
  the point of this hook (it has to be callable from a phone with no tooling),
  so it reaches for the one that exists everywhere.
*/
;(globalThis as unknown as { __cruPoison: unknown }).__cruPoison = (...points: string[]) => {
  POISONED.clear()
  for (const p of points) POISONED.add(p)
  return { poisoned: [...POISONED], note: 'Re-render or interact to trigger.' }
}
