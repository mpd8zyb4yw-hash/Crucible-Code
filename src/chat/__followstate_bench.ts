// Bench for the message-scroller follow state machine. Run:
//   npx tsx src/chat/__followstate_bench.ts
//
// THE LIVE REPORT (2026-07-29): "scrolling is and has been broken for a very long time please dig
// in and fix it decisively". Two independent defects were behind it, and this bench pins both.
//
//   1. AUTO-FOLLOW DEPENDED ON A PAINT. The follow was scheduled only as
//      `requestAnimationFrame(followBottom)`, so a page that is not painting never follows.
//      MEASURED in a hidden page: the effect ran 28 times in one turn, followBottom ran ZERO
//      times, content grew 672px → 1119px in a 672px viewport and scrollTop stayed at 0. That
//      one is fixed in App.tsx by calling followBottom directly as well, and is verified there.
//
//   2. THE PROGRAMMATIC-SCROLL LATCH LEAKED. A boolean armed before every scrollTop write and
//      cleared by the next scroll event. A write that does not move the element fires no event,
//      so the latch stayed armed and ate the user's next real scroll. That is this file.
//
// Both directions are tested. A follow machine that never follows and a follow machine that
// never lets go are the same bug pointed opposite ways, and only checking one of them is how
// this survived (crucible-verifier-two-failure-directions).
import {
  initialFollowState, onScroll, onReadBackGesture, onResumeFollow, followTarget,
  type FollowState, type Geometry,
} from './followState'

let pass = 0, fail = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'OK ' : 'XX '} ${name}${ok ? '' : ` — ${detail}`}`)
  ok ? pass++ : fail++
}

const g = (scrollTop: number, scrollHeight: number, clientHeight = 672): Geometry =>
  ({ scrollTop, scrollHeight, clientHeight })

/** Drive a follow write the way App.tsx does: compute the target, then apply it to the geometry. */
function applyFollow(state: FollowState, geo: Geometry): { state: FollowState; geo: Geometry } {
  const t = followTarget(state, geo)
  if (!t) return { state, geo }
  return { state: t.state, geo: { ...geo, scrollTop: t.top } }
}

console.log('  — following the bottom as content arrives —')
{
  let s = initialFollowState()
  let geo = g(0, 672)
  // Content streams in, one commit at a time.
  for (const h of [672, 900, 1119, 1400, 1656]) {
    geo = { ...geo, scrollHeight: h }
    ;({ state: s, geo } = applyFollow(s, geo))
  }
  check('view is pinned to the bottom after streaming',
    s.following && geo.scrollTop === 1656 - 672, `scrollTop=${geo.scrollTop} expected=${1656 - 672}`)
}

console.log('  — THE SHIPPED BUG: a no-op write must not eat the next user scroll —')
{
  let s = initialFollowState()
  let geo = g(0, 672)
  // Pin to the bottom, then run MANY follow attempts against unchanged geometry. Every one of
  // these is a no-op write that fires no scroll event — the exact condition that armed the old
  // latch 28 times in a turn with nothing to disarm it.
  geo = { ...geo, scrollHeight: 1656 }
  ;({ state: s, geo } = applyFollow(s, geo))
  for (let i = 0; i < 28; i++) ({ state: s, geo } = applyFollow(s, geo))
  check('28 no-op follow writes leave the view at the bottom',
    geo.scrollTop === 984, `scrollTop=${geo.scrollTop}`)

  // NOW the user drags the scrollbar up. Under the old latch this event was consumed as "ours"
  // and follow stayed on; the next commit yanked them back down.
  geo = { ...geo, scrollTop: 120 }
  s = onScroll(s, geo)
  check('a user scroll after those no-ops turns following OFF',
    s.following === false, `following=${s.following} lastWrittenTop=${s.lastWrittenTop}`)

  // And it must STAY off while more content arrives.
  geo = { ...geo, scrollHeight: 2400 }
  ;({ state: s, geo } = applyFollow(s, geo))
  check('the view is not yanked back while the user reads',
    geo.scrollTop === 120 && !s.following, `scrollTop=${geo.scrollTop} following=${s.following}`)
}

console.log('  — growth alone never unfollows —')
{
  let s = initialFollowState()
  let geo = g(0, 672)
  geo = { ...geo, scrollHeight: 1656 }
  ;({ state: s, geo } = applyFollow(s, geo))
  // Our own write lands at the bottom and produces a scroll event reporting exactly that offset.
  s = onScroll(s, geo)
  check('our own follow write does not read as a user scroll', s.following === true)
}

console.log('  — explicit gestures —')
{
  let s = initialFollowState()
  s = onReadBackGesture(s)
  check('a wheel-up turns following off', s.following === false)
  let geo = g(120, 2400)
  ;({ state: s, geo } = applyFollow(s, geo))
  check('a gesture-unfollowed view is never written to', geo.scrollTop === 120, `scrollTop=${geo.scrollTop}`)
}

console.log('  — returning to the bottom resumes following —')
{
  let s: FollowState = { following: false, lastWrittenTop: 984 }
  // User scrolls back down to within the slack band.
  s = onScroll(s, g(2400 - 672 - 40, 2400))
  check('scrolling back to the bottom turns following on', s.following === true)
  // Explicit button.
  let s2: FollowState = { following: false, lastWrittenTop: 984 }
  check('the scroll-to-bottom button resumes following', onResumeFollow(s2).following === true)
}

console.log('  — the reference offset must survive a no-op write —')
{
  // The regression that would reintroduce the bug: recording lastWrittenTop only when the write
  // actually moves the element. Then a pinned view keeps a stale reference and a user scroll to
  // that stale offset would be misread as ours.
  let s = initialFollowState()
  let geo = g(0, 672)
  geo = { ...geo, scrollHeight: 1200 }
  ;({ state: s, geo } = applyFollow(s, geo))          // writes 528
  const firstRef = s.lastWrittenTop
  geo = { ...geo, scrollHeight: 1656 }
  ;({ state: s, geo } = applyFollow(s, geo))          // writes 984
  check('the reference tracks the latest target',
    s.lastWrittenTop === 984 && firstRef === 528, `ref=${s.lastWrittenTop} first=${firstRef}`)
  // A user scroll to the OLD reference is still a user scroll.
  s = onScroll(s, { ...geo, scrollTop: 528 })
  check('scrolling to a stale reference offset still unfollows', s.following === false)
}

console.log(`\nTOTAL: ${pass}/${pass + fail}`)
if (fail) process.exit(1)
