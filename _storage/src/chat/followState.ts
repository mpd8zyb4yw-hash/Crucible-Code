// The auto-follow state machine for the message scroller, as a pure function of geometry.
//
// WHY THIS IS ITS OWN FILE. It used to live inline in App.tsx as three refs and four handlers,
// and it was wrong for a long time in a way nobody could test: the only way to exercise it was to
// stream a real answer into a real window and watch. The failure it hid —
//
//     while an answer streams, the first attempt to scroll up is swallowed and the view snaps
//     back to the bottom
//
// — is a two-line logic bug that any unit test would have caught. So the decision logic moves
// here, where it is a pure transition over numbers, and App.tsx keeps only the DOM plumbing
// (reading scrollTop, writing scrollTop, subscribing to events). Same split as src/server/jwt.ts.
//
// THE BUG THIS REPLACES. The old code distinguished our own scroll writes from the user's with a
// boolean latch: set `programmatic = true` before writing scrollTop, and let the next scroll
// event clear it. The latch leaks, because
//
//     a write that does not MOVE the element fires no scroll event.
//
// With the view already pinned to the bottom — the normal case during streaming — nearly every
// write is that no-op. MEASURED: 28 follow attempts in a single turn, each re-arming a latch that
// nothing disarmed. The next scroll event to actually arrive was the USER'S, and it was consumed
// as "ours". First gesture eaten, follow never released, next commit yanks the view back down.
//
// The replacement compares POSITIONS rather than counting events: we remember the scroll offset
// we last asked for, and any event reporting a different offset came from the user. It needs no
// event to clear itself, so a no-op write cannot poison it.

/** How close to the bottom still counts as "at the bottom", in px. */
export const BOTTOM_SLACK = 80

/** Tolerance for "this is the offset we wrote" — sub-pixel layout makes exact equality unsafe. */
const SAME_POSITION = 2

export interface FollowState {
  /** True while the view should track the bottom as content arrives. */
  following: boolean
  /**
   * The scroll offset we last asked the element to sit at, or -1 if we never have.
   *
   * Recorded even when the resulting write is a no-op: it describes where we INTEND the view to
   * be, and a stale reference would make the next genuine user scroll compare against the wrong
   * number — which is the original bug wearing a different hat.
   */
  lastWrittenTop: number
}

export interface Geometry {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export const initialFollowState = (): FollowState => ({ following: true, lastWrittenTop: -1 })

/** Distance from the bottom of the scrollable range. */
export const distanceFromBottom = (g: Geometry): number =>
  g.scrollHeight - g.scrollTop - g.clientHeight

/**
 * A scroll event arrived. Decide whether the user is reading back.
 *
 * NOTE the asymmetry, which is the whole point: returning to the bottom re-enables following on
 * position alone, but LEAVING the bottom only disables it when the position is one we did not
 * write. Content growing under a pinned view fires no scroll event at all, so this is never
 * asked to distinguish growth from a gesture — only our own scrolling from the user's.
 */
export function onScroll(state: FollowState, g: Geometry): FollowState {
  if (distanceFromBottom(g) <= BOTTOM_SLACK) {
    // At the bottom. Whether the user scrolled back down or we put them there, the meaning is the
    // same, and this position becomes the new reference.
    return { following: true, lastWrittenTop: g.scrollTop }
  }
  if (state.following && Math.abs(g.scrollTop - state.lastWrittenTop) > SAME_POSITION) {
    // Away from the bottom, at an offset we never asked for: a scrollbar drag, a PageUp, a
    // programmatic scroll from elsewhere. None of these emit wheel or touch events, so this is
    // the only branch that catches them.
    return { ...state, following: false }
  }
  return state
}

/** An explicit gesture to read back — wheel up, or a finger dragging content down. */
export const onReadBackGesture = (state: FollowState): FollowState =>
  state.following ? { ...state, following: false } : state

/** The user asked to return to the bottom, or sent a new message. */
export const onResumeFollow = (state: FollowState): FollowState => ({ ...state, following: true })

/**
 * Compute the follow write for the current geometry.
 *
 * Returns the offset to write and the next state, or `null` when following is off. The caller
 * performs the DOM write; keeping it out of here is what makes the machine testable.
 */
export function followTarget(state: FollowState, g: Geometry): { top: number; state: FollowState } | null {
  if (!state.following) return null
  const top = g.scrollHeight - g.clientHeight
  return { top, state: { ...state, lastWrittenTop: top } }
}
