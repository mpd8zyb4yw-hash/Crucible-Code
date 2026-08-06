// ============================================================================
// Adaptive capture tuning for Remote Brain's JPEG fallback path.
//
// The capture window used to encode at fixed defaults (900px / 15fps / q0.42 ≈
// 5 Mbit/s). That is a guess about the link, and a guess is wrong in both
// directions: on a congested hotspot it overshoots and frames queue until
// glass-to-glass latency is measured in seconds; on good WiFi it undershoots and
// the picture is needlessly soft.
//
// The server already knows the truth. `relay()` skips any viewer whose socket
// still has bytes buffered, so the ratio of skipped-to-offered frames IS the
// observed link headroom — no probing, no extra traffic. This module turns that
// ratio into a capture setting with a plain AIMD loop: back off hard when the
// link is dropping, creep back up when it is clean.
//
// Kept as a PURE function of (current, stats) so the control law can be proven
// on a bench instead of eyeballed against a phone. See __captureTune_bench.ts.
// ============================================================================

export interface CaptureTuning {
  maxW: number      // longest edge of the encoded frame, px
  fps: number
  quality: number   // JPEG quality, 0..1
}

/** Encode settings when nothing is known yet — the previous hardcoded defaults. */
export const DEFAULT_TUNING: CaptureTuning = { maxW: 900, fps: 15, quality: 0.42 }

/** The controller never goes outside these — a floor that is still legible, and
 *  a ceiling that stays under the ~18 Mbit/s that overwhelmed ordinary WiFi. */
export const TUNING_FLOOR: CaptureTuning = { maxW: 480, fps: 6,  quality: 0.30 }
export const TUNING_CEIL:  CaptureTuning = { maxW: 1280, fps: 24, quality: 0.60 }

export interface LinkStats {
  /** Frames relay() offered to viewers in this window (across all JPEG viewers). */
  offered: number
  /** Of those, how many were skipped because the viewer's socket was backed up. */
  dropped: number
}

/** Drop ratio above which we treat the link as congested and back off. */
const CONGESTED = 0.15
/** Drop ratio below which we treat the link as clean and creep back up. */
const CLEAN = 0.02
/** Minimum frames in a window before its ratio means anything — a 3-frame window
 *  that happened to drop 1 is noise, not congestion. */
const MIN_SAMPLES = 8

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const round2 = (v: number) => Math.round(v * 100) / 100

/**
 * One control step. Multiplicative decrease on congestion (fast — latency is
 * already growing by the time we see drops), additive increase on a clean window
 * (slow — so we do not oscillate straight back into congestion).
 *
 * Returns `current` unchanged when the window is too small to judge, so a paused
 * or just-started stream never ratchets the quality down on no evidence.
 */
export function nextCaptureTuning(current: CaptureTuning, stats: LinkStats): CaptureTuning {
  if (stats.offered < MIN_SAMPLES) return current
  const ratio = stats.dropped / stats.offered

  if (ratio >= CONGESTED) {
    // Shed bytes where it costs the least perceived quality first: frame rate and
    // resolution before quality, since a soft blocky image reads worse than a
    // slightly slower clean one.
    return {
      maxW:    clamp(Math.round(current.maxW * 0.8), TUNING_FLOOR.maxW, TUNING_CEIL.maxW),
      fps:     clamp(Math.round(current.fps * 0.7), TUNING_FLOOR.fps, TUNING_CEIL.fps),
      quality: clamp(round2(current.quality - 0.04), TUNING_FLOOR.quality, TUNING_CEIL.quality),
    }
  }

  if (ratio <= CLEAN) {
    return {
      maxW:    clamp(current.maxW + 60, TUNING_FLOOR.maxW, TUNING_CEIL.maxW),
      fps:     clamp(current.fps + 1, TUNING_FLOOR.fps, TUNING_CEIL.fps),
      quality: clamp(round2(current.quality + 0.02), TUNING_FLOOR.quality, TUNING_CEIL.quality),
    }
  }

  // Between the two thresholds the link is working at about its capacity. Hold.
  return current
}

/** True when two tunings differ enough to be worth a message to the capture
 *  window — stops a 1px width creep from spamming the producer every window. */
export function tuningChanged(a: CaptureTuning, b: CaptureTuning): boolean {
  return a.maxW !== b.maxW || a.fps !== b.fps || Math.abs(a.quality - b.quality) >= 0.01
}

/**
 * Rolling drop-ratio accounting for the relay loop. `offer()` is called once per
 * viewer per frame with whether that viewer was skipped; `take()` returns the
 * window and resets it.
 */
export class LinkMonitor {
  private offered = 0
  private dropped = 0
  offer(wasDropped: boolean): void {
    this.offered++
    if (wasDropped) this.dropped++
  }
  take(): LinkStats {
    const s = { offered: this.offered, dropped: this.dropped }
    this.offered = 0; this.dropped = 0
    return s
  }
}
