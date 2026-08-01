/**
 * LADDER BUDGET SELFCHECK — 0 model calls, 0 network.
 *
 * The tier-3 starvation this guards against was found in a LIVE run (numberToWords, 2026-08-01:
 * tiers 0-1 took ~200s of the ceiling and tier 3 opened with 3 calls), and a live run is a bad
 * regression test — it costs minutes, needs a loaded head, and its numbers move for reasons that
 * have nothing to do with allocation. The allocation itself is pure arithmetic, so it is checked
 * here instead: what tiers 0-2 may spend, and what the carve is guaranteed to still have.
 *
 * Run: npx tsx src/CrucibleEngine/reasoning/__ladder_budget_selfcheck.ts
 */
import { ladderReserve } from './solve'

let failures = 0
function check(label: string, got: unknown, want: unknown): void {
  const ok = got === want
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} — got ${String(got)}, want ${String(want)}`)
}

// ── no-ops: the reserve must never touch a path it was not written for ───────────
check('no carve reachable → reserve 0', ladderReserve(false, 24, 40), 0)
check('unbounded ceiling → reserve 0', ladderReserve(true, undefined, 40), 0)
check('infinite ceiling → reserve 0', ladderReserve(true, Infinity, 40), 0)

// ── the two clamps ──────────────────────────────────────────────────────────────
// Half the ceiling binds when the carve wants more than half.
check('carve wants more than half → half the ceiling', ladderReserve(true, 24, 40), 12)
// The carve's own appetite binds when it is the smaller number — reserving 32 of a 64 ceiling for
// a carve that can only spend 8 would starve the cheap tiers to no one's benefit.
check('carve wants less than half → the carve\'s appetite', ladderReserve(true, 64, 8), 8)
check('exact tie', ladderReserve(true, 20, 10), 10)

// ── the measured failure, on the axis it actually happened on ───────────────────
// 600s ceiling, carve wants 180s: tiers 0-2 get 420s and the carve is GUARANTEED 180s. Under the
// old code the reserve did not exist, tiers 0-1 ran to ~200s+ unbounded, and the carve got the
// remainder — on the bad draw, three calls' worth.
const CEILING_MS = 600_000, CARVE_MS = 180_000
const wallReserve = ladderReserve(true, CEILING_MS, CARVE_MS)
check('600s ceiling / 180s carve → 180s reserved', wallReserve, 180_000)
check('cheap tiers still get the rest', CEILING_MS - wallReserve, 420_000)

// A carve whose wall budget EXCEEDS the ceiling cannot take the whole clock: half is the floor
// under the cheap tiers, and tier 0 is the tier that solves most tasks outright.
check('carve wants more than the whole ceiling → still only half', ladderReserve(true, 120_000, 420_000), 60_000)

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall ladder budget checks passed')
process.exit(failures ? 1 : 0)
