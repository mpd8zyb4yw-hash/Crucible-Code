// Molten pour animation — ported nearly verbatim from the Crucible v3 reference
// implementation's MoltenPour.tsx (drawPour/drawHalf/roundRectPoints/moltenColor/drawVessel,
// themselves lifted from the v3.dc.html prototype). One <canvas> absolutely positioned over
// the live streaming reply card (left:-24, top:-70, sized to card rect + padding).
//
// Phases, hooked to the REAL stream lifecycle (never a fixed timer):
//   thinking (sent, no token yet: crucible vessel tilt-loops)
//   → pouring (first token: full tilt, molten stream spout→border, border fills both edges
//     toward bottom-center of the LIVE card height, min fill floor 1350ms)
//   → finishing (stream ended: fill runs to 1)
//   → cooling (border cools top→bottom over ≥1000ms while the vessel eases upright + fades)
//
// The parent only supplies 'thinking' | 'pouring' | 'done' + a 0..1 progress estimate;
// finishing/cooling are internal because the FILL progress (not the network event) is what
// has to complete before the glow may cool.

import { useEffect, useRef } from 'react'

export type MoltenPhase = 'thinking' | 'pouring' | 'done'

const MIN_FILL_MS = 1350
const MIN_COOL_MS = 1000

export default function MoltenPour({ phase, progress, wrapRef }: {
  phase: MoltenPhase
  /** 0..1 estimate of how much of the reply has arrived (chars-based). */
  progress: number
  wrapRef: React.RefObject<HTMLDivElement | null>
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Animator internals — refs, not state, so the RAF loop never re-subscribes.
  const fill = useRef(0)
  const cool = useRef(0)
  const angle = useRef(0)
  const cruOp = useRef(1)
  const pourStart = useRef(0)
  const coolStart = useRef(0)
  const cooled = useRef(false)
  const ext = useRef({ phase, progress })
  ext.current = { phase, progress }

  useEffect(() => {
    let raf = 0

    const roundRectPoints = (x: number, y: number, w: number, h: number, r: number, N: number) => {
      const pts: [number, number][] = []
      const seg = (fn: (t: number) => [number, number], steps: number) => {
        for (let i = 0; i <= steps; i++) pts.push(fn(i / steps))
      }
      const lerp = (a: [number, number], b: [number, number], t: number): [number, number] =>
        [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
      const arc = (cx: number, cy: number, a0: number, a1: number, t: number): [number, number] =>
        [cx + r * Math.cos(a0 + (a1 - a0) * t), cy + r * Math.sin(a0 + (a1 - a0) * t)]
      const lineSteps = Math.floor(N / 8)
      const arcSteps = Math.floor(N / 16)
      seg((t) => lerp([x + r, y], [x + w - r, y], t), lineSteps)
      seg((t) => arc(x + w - r, y + r, -Math.PI / 2, 0, t), arcSteps)
      seg((t) => lerp([x + w, y + r], [x + w, y + h - r], t), lineSteps)
      seg((t) => arc(x + w - r, y + h - r, 0, Math.PI / 2, t), arcSteps)
      seg((t) => lerp([x + w - r, y + h], [x + r, y + h], t), lineSteps)
      seg((t) => arc(x + r, y + h - r, Math.PI / 2, Math.PI, t), arcSteps)
      seg((t) => lerp([x, y + h - r], [x, y + r], t), lineSteps)
      seg((t) => arc(x + r, y + r, Math.PI, Math.PI * 1.5, t), arcSteps)
      return pts
    }

    const moltenColor = (s: number, t: number, alpha: number) => {
      const n = 0.5 + 0.5 * Math.sin(s * 0.55 + t * 0.0022) * Math.cos(s * 0.21 - t * 0.0031)
      return `rgba(255,${Math.round(70 + n * 110)},${Math.round(10 + n * 60)},${alpha})`
    }

    const drawHalf = (ctx: CanvasRenderingContext2D, pts: [number, number][], frac: number, t: number) => {
      if (frac <= 0 || pts.length < 2) return
      let total = 0
      const cum = [0]
      for (let i = 1; i < pts.length; i++) {
        total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
        cum.push(total)
      }
      const lim = total * Math.min(1, frac)

      ctx.save()
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.shadowColor = 'rgba(255,120,20,0.9)'
      ctx.shadowBlur = 14
      ctx.strokeStyle = 'rgba(255,110,26,0.16)'
      ctx.lineWidth = 6
      ctx.beginPath()
      ctx.moveTo(pts[0][0], pts[0][1])
      for (let i = 1; i < pts.length && cum[i] <= lim; i++) ctx.lineTo(pts[i][0], pts[i][1])
      ctx.stroke()
      ctx.restore()

      ctx.save()
      ctx.lineCap = 'round'
      for (let i = 1; i < pts.length && cum[i] <= lim; i++) {
        const shimmer = 0.72 + 0.28 * Math.sin(cum[i] * 0.32 - t * 0.006 + Math.sin(cum[i] * 0.07 + t * 0.002) * 2)
        const nearEdge = lim - cum[i] < 26 ? 1.25 : 1
        ctx.strokeStyle = moltenColor(cum[i], t, Math.min(1, shimmer * nearEdge))
        ctx.lineWidth = 1.8
        ctx.beginPath()
        ctx.moveTo(pts[i - 1][0], pts[i - 1][1])
        ctx.lineTo(pts[i][0], pts[i][1])
        ctx.stroke()
      }
      ctx.restore()
    }

    const drawVessel = (ctx: CanvasRenderingContext2D, alpha: number) => {
      ctx.strokeStyle = `rgba(232,232,242,${alpha})`
      ctx.lineWidth = 2
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath(); ctx.moveTo(-11, -8); ctx.lineTo(-6.5, 9.5); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(11, -8); ctx.lineTo(6.5, 9.5); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(-6.5, 9.5); ctx.quadraticCurveTo(0, 14, 6.5, 9.5); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(-11, -8); ctx.lineTo(11, -8); ctx.stroke()
    }

    let last = performance.now()

    const frame = (now: number) => {
      const dtf = Math.min(50, now - last) / 16.67
      last = now

      const canvas = canvasRef.current
      const wrap = wrapRef.current
      if (canvas && wrap && !cooled.current) {
        const rect = wrap.getBoundingClientRect()
        const PAD = 24
        const TOP = 70
        const W = rect.width + PAD * 2
        const H = rect.height + TOP + 14
        const DPR = window.devicePixelRatio || 1
        if (canvas.width !== Math.round(W * DPR) || canvas.height !== Math.round(H * DPR)) {
          canvas.width = Math.round(W * DPR)
          canvas.height = Math.round(H * DPR)
          canvas.style.width = `${W}px`
          canvas.style.height = `${H}px`
        }
        const ctx = canvas.getContext('2d')!
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
        ctx.clearRect(0, 0, W, H)

        // Internal phase: external 'done' means finish the fill, then cool.
        const e = ext.current
        const ph: 'thinking' | 'pouring' | 'finishing' | 'cooling' =
          e.phase === 'thinking' ? 'thinking'
          : e.phase === 'pouring' ? 'pouring'
          : fill.current < 0.995 ? 'finishing'
          : 'cooling'

        if ((ph === 'pouring' || ph === 'finishing') && !pourStart.current) pourStart.current = now
        if (ph === 'cooling' && !coolStart.current) coolStart.current = now

        const cardX = PAD
        const cardY = TOP
        const cardW = rect.width
        const cardH = rect.height
        const rad = 15

        // ── crucible tilt ──
        if (ph === 'thinking') {
          const targetAngle = 0.42 * (0.5 - 0.5 * Math.cos(now * 0.0016))
          angle.current += (targetAngle - angle.current) * 0.12 * dtf
        } else if (ph === 'pouring' || ph === 'finishing') {
          angle.current += (1.02 - angle.current) * 0.06 * dtf
        } else {
          angle.current += (0 - angle.current) * 0.07 * dtf
        }

        // ── fill: real chars-received fraction, smoothed, min-duration floor ──
        if (ph === 'pouring' || ph === 'finishing') {
          const elapsed = now - pourStart.current
          const cap = elapsed / MIN_FILL_MS
          const raw = ph === 'finishing' ? 1 : e.progress
          const target = Math.min(1, raw, cap)
          const delta = target - fill.current
          let stepv = delta * 0.055 * dtf
          const maxStep = 0.03 * dtf
          if (stepv > maxStep) stepv = maxStep
          if (delta > 0.001 && stepv < 0.0012 * dtf) stepv = 0.0012 * dtf
          fill.current = Math.min(1, fill.current + Math.max(0, stepv))
        }

        // ── cooling sweep + vessel fade, concurrent, min floor ──
        if (ph === 'cooling') {
          cool.current = Math.min(1, (now - coolStart.current) / MIN_COOL_MS)
          cruOp.current = Math.max(0, 1 - cool.current * 1.05)
          if (cool.current >= 1) {
            cooled.current = true
            ctx.clearRect(0, 0, W, H)
            raf = requestAnimationFrame(frame)
            return
          }
        }

        // ── border molten fill ──
        const landingX = cardX + cardW / 2
        if (fill.current > 0 && ph !== 'thinking') {
          const pts = roundRectPoints(cardX, cardY, cardW, cardH, rad, 480)
          let startIdx = 0
          let best = 1e9
          for (let i = 0; i < pts.length; i++) {
            const d = Math.abs(pts[i][0] - landingX) + Math.abs(pts[i][1] - cardY) * 4
            if (pts[i][1] < cardY + rad && d < best) { best = d; startIdx = i }
          }
          const loop = pts.slice(startIdx).concat(pts.slice(0, startIdx))
          let botIdx = 0
          best = 1e9
          for (let i = 0; i < loop.length; i++) {
            const d = Math.abs(loop[i][0] - (cardX + cardW / 2)) + Math.abs(loop[i][1] - (cardY + cardH)) * 4
            if (d < best) { best = d; botIdx = i }
          }
          const right = loop.slice(0, botIdx + 1)
          const leftHalf = [loop[0]].concat(loop.slice(botIdx + 1).reverse())
          drawHalf(ctx, right, fill.current, now)
          drawHalf(ctx, leftHalf, fill.current, now)

          if (cool.current > 0) {
            const eased = cool.current < 0.5 ? 2 * cool.current * cool.current : 1 - Math.pow(-2 * cool.current + 2, 2) / 2
            const coolY = eased * (cardY + cardH + 30)
            ctx.save()
            ctx.globalCompositeOperation = 'destination-out'
            const g = ctx.createLinearGradient(0, coolY - 46, 0, coolY)
            g.addColorStop(0, 'rgba(0,0,0,1)')
            g.addColorStop(1, 'rgba(0,0,0,0)')
            ctx.fillStyle = 'rgba(0,0,0,1)'
            ctx.fillRect(0, 0, W, coolY - 46)
            ctx.fillStyle = g
            ctx.fillRect(0, coolY - 46, W, 46)
            ctx.restore()
          }
        }

        // ── molten stream from spout to border top ──
        const cruX = landingX - 16
        const cruY = 26
        if ((ph === 'pouring' || ph === 'finishing') && cruOp.current > 0) {
          const cos = Math.cos(angle.current)
          const sin = Math.sin(angle.current)
          const spoutX = cruX + 11 * cos - -8 * sin
          const spoutY = cruY + 11 * sin + -8 * cos
          const strength = Math.min(1, (now - pourStart.current) / 350)
          ctx.save()
          ctx.shadowColor = 'rgba(255,120,20,0.85)'
          ctx.shadowBlur = 12
          for (let l = 0; l < 3; l++) {
            const wob = Math.sin(now * 0.004 + l * 2.1) * (1.2 + l * 0.5)
            ctx.strokeStyle = moltenColor(l * 40 + now * 0.05, now, (0.55 - l * 0.14) * strength)
            ctx.lineWidth = 2.6 - l * 0.7
            ctx.beginPath()
            ctx.moveTo(spoutX, spoutY)
            ctx.quadraticCurveTo(landingX + wob + 3, (spoutY + cardY) / 2, landingX + wob * 0.4, cardY + 1)
            ctx.stroke()
          }
          ctx.restore()
        }

        // ── crucible vessel ──
        if (cruOp.current > 0.01 || ph === 'thinking') {
          ctx.save()
          ctx.globalAlpha = ph === 'cooling' ? cruOp.current : 1
          ctx.translate(cruX, cruY)
          ctx.rotate(angle.current)
          drawVessel(ctx, ph === 'thinking' ? 0.75 : 0.9)
          ctx.restore()
        }
      }

      raf = requestAnimationFrame(frame)
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'absolute', left: -24, top: -70, zIndex: 3, pointerEvents: 'none' }}
    />
  )
}
