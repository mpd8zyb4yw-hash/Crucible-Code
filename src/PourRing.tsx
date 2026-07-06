// PourRing — the final 3-phase "molten pour" animation for a Crucible reply card.
//
// Wraps a reply card. Drives a canvas overlay that traces the card's rounded border and a
// molten stream from an anchor point (the crucible mark in the composer sits below, but the
// stream visually originates at the card's top-center spout point). Phases, per the FINAL
// spec (do not re-derive):
//
//   A) idle/thinking — before the first token. The card border sits at its default dark
//      color; no molten fill. (The crucible mark itself does the idle tilt-loop; that's the
//      composer's CrucibleMark, not this ring.)
//   B) pouring — first token arrived → streaming. A molten stream drops from the top-center
//      spout to the top border, then molten glow fills BOTH the left and right edges
//      simultaneously, corners rounded, converging toward the bottom-center of the CURRENT
//      content edge (tracks live/growing height via ResizeObserver). Everything poured so far
//      stays lit. Fill progress eases toward a target driven by real stream progress but is
//      clamped to a minimum duration floor so it always reads fluid.
//   C) complete — streaming ended. The border cools top→bottom (top cools first), over a
//      minimum floor duration, while the molten leading edge finishes. Concurrent with the
//      crucible mark's upright-fade in the composer.
//
// Progress is fed in via `streamProgress` (0..1, monotonic-ish, from token/char counts) but
// all visible motion is routed through an eased current→target animator with min-duration
// floors, so choppy token streams still look smooth.

import { useEffect, useRef } from 'react'

export type PourPhase = 'idle' | 'pouring' | 'done'

interface PourRingProps {
  phase: PourPhase
  /** 0..1 estimate of how much of the response has arrived. Optional; motion is smoothed. */
  streamProgress?: number
  children: React.ReactNode
  /** Border radius of the wrapped card, px. Must match the card's own radius. */
  radius?: number
}

const MOLTEN_STOPS = ['#f59e0b', '#f8b34d', '#f87171', '#f59e0b']
const DEFAULT_BORDER = 'rgba(255,255,255,0.09)'
const POUR_MIN_MS = 1350 // minimum fill duration floor (spec: ~1.2–1.5s)
const COOL_MIN_MS = 1000 // minimum cool-sweep duration floor (spec: ~0.8–1.2s)

export default function PourRing({ phase, streamProgress = 0, children, radius = 16 }: PourRingProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  // Mutable animation state kept out of React so the RAF loop never re-subscribes.
  const stRef = useRef({
    phase: 'idle' as PourPhase,
    target: 0, // desired fill fraction 0..1
    fill: 0, // eased actual fill fraction
    pourStart: 0, // ts when pouring began (for the min-duration floor)
    cool: 0, // 0..1 cool-sweep progress
    coolStart: 0, // ts when done began
    streamProgress: 0,
  })
  stRef.current.phase = phase
  stRef.current.streamProgress = streamProgress

  useEffect(() => {
    const canvas = canvasRef.current
    const card = cardRef.current
    if (!canvas || !card) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const DPR = window.devicePixelRatio || 1
    let dims = { w: 0, h: 0 }
    const measure = () => {
      const r = card.getBoundingClientRect()
      dims = { w: r.width, h: r.height }
      canvas.width = Math.max(1, Math.round(dims.w * DPR))
      canvas.height = Math.max(1, Math.round(dims.h * DPR))
      canvas.style.width = dims.w + 'px'
      canvas.style.height = dims.h + 'px'
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(card)

    let anim = 0
    let hueShift = 0

    // Build the rounded-rect border path (clockwise from top-center) so lineDash reveals
    // symmetrically down both edges toward the bottom-center.
    const buildPath = (w: number, h: number, rad: number): Path2D => {
      const pad = 1
      const p = new Path2D()
      const iw = w - pad * 2
      const ih = h - pad * 2
      const rr = Math.min(rad, iw / 2, ih / 2)
      p.moveTo(pad + iw, pad + ih - rr) // start; we rotate reveal via two mirrored dashes instead
      // We actually stroke via two half-paths below, so this full path is only used for the
      // ambient "already poured" glow.
      p.moveTo(pad + rr, pad)
      p.arcTo(pad + iw, pad, pad + iw, pad + ih, rr)
      p.arcTo(pad + iw, pad + ih, pad, pad + ih, rr)
      p.arcTo(pad, pad + ih, pad, pad, rr)
      p.arcTo(pad, pad, pad + iw, pad, rr)
      p.closePath()
      return p
    }

    // Two mirrored half-border paths, each starting at top-center and ending at
    // bottom-center — so dashing them by the same fraction fills both edges together.
    const buildHalfPaths = (w: number, h: number, rad: number): { left: Path2D; right: Path2D; halfLen: number } => {
      const pad = 1
      const iw = w - pad * 2
      const ih = h - pad * 2
      const rr = Math.min(rad, iw / 2, ih / 2)
      const cx = pad + iw / 2
      // Right half: top-center → top-right corner → down right edge → bottom-right → bottom-center
      const right = new Path2D()
      right.moveTo(cx, pad)
      right.lineTo(pad + iw - rr, pad)
      right.arcTo(pad + iw, pad, pad + iw, pad + rr, rr)
      right.lineTo(pad + iw, pad + ih - rr)
      right.arcTo(pad + iw, pad + ih, pad + iw - rr, pad + ih, rr)
      right.lineTo(cx, pad + ih)
      // Left half: top-center → top-left corner → down left edge → bottom-left → bottom-center
      const left = new Path2D()
      left.moveTo(cx, pad)
      left.lineTo(pad + rr, pad)
      left.arcTo(pad, pad, pad, pad + rr, rr)
      left.lineTo(pad, pad + ih - rr)
      left.arcTo(pad, pad + ih, pad + rr, pad + ih, rr)
      left.lineTo(cx, pad + ih)
      const halfLen = iw / 2 - rr + rr * (Math.PI / 2) + (ih - rr * 2) + rr * (Math.PI / 2) + iw / 2 - rr
      return { left, right, halfLen }
    }

    let last = 0
    const draw = (ts: number) => {
      const s = stRef.current
      if (!last) last = ts
      const dt = Math.min(64, ts - last)
      last = ts
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
      ctx.clearRect(0, 0, dims.w, dims.h)

      if (dims.w > 4 && dims.h > 4) {
        const molten = molgrad()

        if (s.phase === 'pouring') {
          if (!s.pourStart) { s.pourStart = ts; s.fill = 0; s.cool = 0; s.coolStart = 0 }
          // Target fill: real stream progress, but never let the pour "complete" before the
          // minimum floor has elapsed — so an instant response still reads fluid.
          const elapsedFrac = Math.min(1, (ts - s.pourStart) / POUR_MIN_MS)
          s.target = Math.min(streamCap(s.streamProgress), Math.max(0.06, elapsedFrac))
          // Ease actual fill toward target.
          s.fill += (s.target - s.fill) * Math.min(1, dt / 140)
          renderPour(ctx, dims, radius, molten, s.fill, hueShift, buildHalfPaths, buildPath)
        } else if (s.phase === 'done') {
          if (!s.coolStart) { s.coolStart = ts; s.fill = Math.max(s.fill, 0.9) }
          // Finish any remaining fill quickly, then cool top→bottom over the floor duration.
          s.fill += (1 - s.fill) * Math.min(1, dt / 120)
          s.cool = Math.min(1, (ts - s.coolStart) / COOL_MIN_MS)
          renderCool(ctx, dims, radius, molten, s.cool, hueShift, buildHalfPaths)
          if (s.cool >= 1) {
            // Fully cooled → clear overlay; the card's own default border shows through.
            ctx.clearRect(0, 0, dims.w, dims.h)
          }
        } else {
          // idle — reset, draw nothing (default border shows through).
          s.pourStart = 0; s.fill = 0; s.target = 0; s.cool = 0; s.coolStart = 0
        }
      }
      hueShift = (hueShift + dt * 0.03) % 360
      anim = requestAnimationFrame(draw)
    }
    anim = requestAnimationFrame(draw)
    return () => { cancelAnimationFrame(anim); ro.disconnect() }
  }, [radius])

  return (
    <div ref={cardRef} style={{ position: 'relative', width: '100%' }}>
      <canvas ref={canvasRef} aria-hidden style={{ position: 'absolute', inset: 0, zIndex: 3, pointerEvents: 'none' }} />
      {children}
    </div>
  )
}

// Stream progress asymptotes toward ~0.92 so the bar never visually "finishes" until the
// stream actually ends (done phase drives it to 1).
function streamCap(p: number): number {
  const x = Math.max(0, Math.min(1, p))
  return 0.92 * (1 - Math.pow(1 - x, 1.6))
}

function molgrad() {
  return MOLTEN_STOPS
}

function renderPour(
  ctx: CanvasRenderingContext2D,
  dims: { w: number; h: number },
  radius: number,
  _stops: string[],
  fill: number,
  hueShift: number,
  buildHalfPaths: (w: number, h: number, rad: number) => { left: Path2D; right: Path2D; halfLen: number },
  buildPath: (w: number, h: number, rad: number) => Path2D,
) {
  const { w, h } = dims
  const { left, right, halfLen } = buildHalfPaths(w, h, radius)
  // Molten stream from top-center spout down to the top border (a short bright drop).
  const cx = w / 2
  ctx.save()
  const streamGrad = ctx.createLinearGradient(cx, -10, cx, 6)
  streamGrad.addColorStop(0, 'rgba(248,179,77,0)')
  streamGrad.addColorStop(1, 'rgba(248,179,77,0.9)')
  ctx.strokeStyle = streamGrad
  ctx.lineWidth = 2.4
  ctx.lineCap = 'round'
  ctx.shadowColor = 'rgba(245,158,11,0.8)'
  ctx.shadowBlur = 8
  ctx.beginPath()
  ctx.moveTo(cx, -8)
  ctx.lineTo(cx, 2)
  ctx.stroke()
  ctx.restore()

  // Ambient: everything poured so far keeps a soft molten glow (faint full-perimeter wash
  // masked by the reveal fraction via the two half dashes below getting a wide glow pass).
  const glow = (lineWidth: number, alpha: number, blur: number) => {
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.lineWidth = lineWidth
    ctx.lineCap = 'round'
    ctx.strokeStyle = mottled(ctx, w, h, hueShift)
    ctx.shadowColor = 'rgba(245,158,11,0.55)'
    ctx.shadowBlur = blur
    ctx.setLineDash([halfLen * fill, halfLen])
    ctx.stroke(left)
    ctx.stroke(right)
    ctx.restore()
  }
  // Soft outward bloom, then the crisp molten leading line on top.
  glow(5, 0.18, 14)
  glow(2.6, 0.5, 8)
  glow(1.4, 0.95, 3)
  void buildPath
}

function renderCool(
  ctx: CanvasRenderingContext2D,
  dims: { w: number; h: number },
  radius: number,
  _stops: string[],
  cool: number,
  hueShift: number,
  buildHalfPaths: (w: number, h: number, rad: number) => { left: Path2D; right: Path2D; halfLen: number },
) {
  const { w, h } = dims
  const { left, right, halfLen } = buildHalfPaths(w, h, radius)
  // Cool sweep top→bottom: the molten portion recedes from the top as `cool` grows. We keep
  // the fully-poured border lit from the current cool line down to bottom-center, so the top
  // cools first. Implement by offsetting the dash so the lit segment starts at `cool`.
  const litStart = halfLen * cool
  const litLen = halfLen - litStart
  const glow = (lineWidth: number, alpha: number, blur: number) => {
    ctx.save()
    ctx.globalAlpha = alpha * (1 - cool * 0.15)
    ctx.lineWidth = lineWidth
    ctx.lineCap = 'round'
    ctx.strokeStyle = mottled(ctx, w, h, hueShift)
    ctx.shadowColor = 'rgba(245,158,11,0.5)'
    ctx.shadowBlur = blur
    ctx.lineDashOffset = -litStart
    ctx.setLineDash([litLen, halfLen])
    ctx.stroke(left)
    ctx.stroke(right)
    ctx.restore()
  }
  if (litLen > 0.5) {
    glow(4.5, 0.16, 12)
    glow(2.4, 0.46, 7)
    glow(1.3, 0.9, 3)
  }
}

// A mottled/uneven molten gradient (not flat orange) with a subtle animated hue drift so the
// pour reads as living liquid rather than a solid bar.
function mottled(ctx: CanvasRenderingContext2D, w: number, h: number, hueShift: number): CanvasGradient {
  const g = ctx.createLinearGradient(0, 0, w, h)
  const base = 28 + Math.sin(hueShift * 0.02) * 8 // amber-ish hue with slight drift
  g.addColorStop(0, `hsl(${base + 6}, 92%, 58%)`)
  g.addColorStop(0.28, `hsl(${base - 4}, 95%, 52%)`)
  g.addColorStop(0.5, `hsl(${base + 12}, 90%, 62%)`)
  g.addColorStop(0.72, `hsl(${base - 2}, 96%, 50%)`)
  g.addColorStop(1, `hsl(${base + 8}, 92%, 58%)`)
  return g
}

export { DEFAULT_BORDER }
