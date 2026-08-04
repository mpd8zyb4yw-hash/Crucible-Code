// ============================================================================
// Committed bench for src/server/captureTune.ts — the Remote Brain adaptive
// bitrate control law. Proves: congestion backs off, a clean link creeps back up,
// the mid band holds, both bounds are respected, a too-small window is ignored,
// and the loop actually CONVERGES instead of oscillating.
// Run: npx tsx src/server/__captureTune_bench.ts
// ============================================================================
import {
  nextCaptureTuning, tuningChanged, LinkMonitor,
  DEFAULT_TUNING, TUNING_FLOOR, TUNING_CEIL,
  type CaptureTuning,
} from './captureTune'

const checks: Array<{ name: string; pass: boolean }> = []
const ok = (name: string, pass: boolean) => checks.push({ name, pass })

// ── The three bands ─────────────────────────────────────────────────────────
const congested = nextCaptureTuning(DEFAULT_TUNING, { offered: 100, dropped: 40 })
ok('congested link backs off on all three axes',
  congested.fps < DEFAULT_TUNING.fps &&
  congested.maxW < DEFAULT_TUNING.maxW &&
  congested.quality < DEFAULT_TUNING.quality)

const clean = nextCaptureTuning(DEFAULT_TUNING, { offered: 100, dropped: 0 })
ok('clean link creeps back up on all three axes',
  clean.fps > DEFAULT_TUNING.fps &&
  clean.maxW > DEFAULT_TUNING.maxW &&
  clean.quality > DEFAULT_TUNING.quality)

const mid = nextCaptureTuning(DEFAULT_TUNING, { offered: 100, dropped: 8 })
ok('link at capacity (between thresholds) holds steady',
  mid.fps === DEFAULT_TUNING.fps && mid.maxW === DEFAULT_TUNING.maxW && mid.quality === DEFAULT_TUNING.quality)

// ── Backoff must be faster than recovery, or the loop oscillates ────────────
ok('backoff is multiplicative and recovery additive (backoff moves fps further)',
  (DEFAULT_TUNING.fps - congested.fps) > (clean.fps - DEFAULT_TUNING.fps))

// ── Evidence gate ───────────────────────────────────────────────────────────
ok('a window with too few frames changes nothing, even at 100% drops',
  nextCaptureTuning(DEFAULT_TUNING, { offered: 3, dropped: 3 }) === DEFAULT_TUNING)
ok('a zero-frame window (paused stream) changes nothing',
  nextCaptureTuning(DEFAULT_TUNING, { offered: 0, dropped: 0 }) === DEFAULT_TUNING)

// ── Bounds hold under sustained pressure in either direction ────────────────
let t: CaptureTuning = DEFAULT_TUNING
for (let i = 0; i < 60; i++) t = nextCaptureTuning(t, { offered: 100, dropped: 90 })
ok('sustained congestion converges to the floor and never goes below it',
  t.fps === TUNING_FLOOR.fps && t.maxW === TUNING_FLOOR.maxW && t.quality === TUNING_FLOOR.quality)

let u: CaptureTuning = DEFAULT_TUNING
for (let i = 0; i < 200; i++) u = nextCaptureTuning(u, { offered: 100, dropped: 0 })
ok('a sustained clean link converges to the ceiling and never goes above it',
  u.fps === TUNING_CEIL.fps && u.maxW === TUNING_CEIL.maxW && u.quality === TUNING_CEIL.quality)

// ── Convergence: a link with a real capacity should settle, not flap ────────
// Model a link that can carry ~7 fps. Offer `t.fps` frames a window; anything
// above capacity is dropped. A correct controller parks near capacity.
const CAPACITY = 7
let v: CaptureTuning = TUNING_CEIL
const fpsTrace: number[] = []
for (let i = 0; i < 80; i++) {
  const offered = Math.max(v.fps, 10)   // relay offers per viewer per frame
  const dropped = Math.max(0, Math.round(offered * (1 - CAPACITY / Math.max(v.fps, 1))))
  v = nextCaptureTuning(v, { offered, dropped })
  fpsTrace.push(v.fps)
}
const tail = fpsTrace.slice(-20)
const spread = Math.max(...tail) - Math.min(...tail)
ok(`controller settles near link capacity (final fps ${v.fps}, capacity ${CAPACITY})`,
  v.fps <= CAPACITY + 3 && v.fps >= TUNING_FLOOR.fps)
ok(`settled state does not flap (fps spread over last 20 windows = ${spread})`, spread <= 3)

// ── Change detection ────────────────────────────────────────────────────────
ok('an identical tuning is not reported as changed',
  !tuningChanged(DEFAULT_TUNING, { ...DEFAULT_TUNING }))
ok('a quality-only nudge below the epsilon is not reported as changed',
  !tuningChanged(DEFAULT_TUNING, { ...DEFAULT_TUNING, quality: DEFAULT_TUNING.quality + 0.004 }))
ok('a real change is reported',
  tuningChanged(DEFAULT_TUNING, { ...DEFAULT_TUNING, fps: DEFAULT_TUNING.fps - 1 }))

// ── LinkMonitor accounting ──────────────────────────────────────────────────
const m = new LinkMonitor()
for (let i = 0; i < 10; i++) m.offer(i < 3)
const w1 = m.take()
ok('monitor counts offered and dropped in a window', w1.offered === 10 && w1.dropped === 3)
ok('take() resets the window', m.take().offered === 0)

const pass = checks.filter(c => c.pass).length
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'} — ${c.name}`)
console.log(`\n${pass}/${checks.length} passed`)
if (pass !== checks.length) process.exit(1)
