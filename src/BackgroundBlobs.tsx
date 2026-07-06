// BackgroundBlobs — the ambient animated gradient-blob backdrop from the Crucible v2
// design. Fixed, full-viewport, pointer-transparent, sits behind all chat content
// (z-index 0). Blobs drift and shift hue slowly; they brighten slightly while the app is
// working. Pure canvas, no DOM churn. Adapted from the v2.dc.html `startBg` reference.

import { useEffect, useRef } from 'react'

export default function BackgroundBlobs({ working = false }: { working?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const workingRef = useRef(working)
  workingRef.current = working

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let t = 0
    let anim = 0
    const resize = () => {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
    }
    resize()
    window.addEventListener('resize', resize)
    const draw = () => {
      t += 0.003
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const blobs = [
        { x: 0.2, y: 0.3, r: 0.32, h: 255 + Math.sin(t) * 20 },
        { x: 0.85, y: 0.6, r: 0.26, h: 195 + Math.cos(t * 1.3) * 15 },
        { x: 0.5, y: 0.85, r: 0.24, h: 300 + Math.sin(t * 0.8) * 25 },
      ]
      const alpha = workingRef.current ? 0.045 : 0.03
      for (const b of blobs) {
        const x = b.x * canvas.width
        const y = b.y * canvas.height
        const r = b.r * Math.min(canvas.width, canvas.height)
        const g = ctx.createRadialGradient(x, y, 0, x, y, r)
        g.addColorStop(0, `hsla(${b.h},70%,60%,${alpha * 2.2})`)
        g.addColorStop(1, `hsla(${b.h},70%,60%,0)`)
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fillStyle = g
        ctx.fill()
      }
      anim = requestAnimationFrame(draw)
    }
    draw()
    return () => {
      cancelAnimationFrame(anim)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none' }}
    />
  )
}
