// Verified primitive: hierarchical timing wheel — O(1) schedule/cancel, configurable resolution.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Timing wheel.
export type TimerCallback = () => void
export interface TimerHandle { id: number; cancelled: boolean }

export class TimingWheel {
  private slots: Map<number, Set<{ id: number; cb: TimerCallback }>>[]
  private sizes: number[]
  private ticks: number[]
  private resolution: number   // ms per tick at level 0
  private now = 0
  private uid = 0

  constructor(levels = 3, slotsPerLevel = 256, resolutionMs = 1) {
    this.resolution = resolutionMs
    this.sizes = Array(levels).fill(slotsPerLevel)
    this.ticks = Array(levels).fill(0)
    this.slots = Array.from({ length: levels }, (_, l) =>
      new Map<number, Set<{ id: number; cb: TimerCallback }>>())
  }

  schedule(delayMs: number, cb: TimerCallback): TimerHandle {
    const id = ++this.uid
    const handle: TimerHandle = { id, cancelled: false }
    const ticks = Math.ceil(delayMs / this.resolution)
    this._place(id, cb, handle, ticks, 0)
    return handle
  }

  /** Advance the wheel by one tick (call at your resolution interval). */
  tick(): void {
    this.now++
    const slot = this.now % this.sizes[0]
    const entries = this.slots[0].get(slot)
    if (entries) { for (const e of entries) { if (!e.cancelled) e.cb() }; this.slots[0].delete(slot) }
    // cascade higher levels
    for (let l = 1; l < this.sizes.length; l++) {
      if (this.now % (this.sizes.slice(0, l).reduce((a, b) => a * b, 1)) === 0) {
        const s = Math.floor(this.now / this.sizes.slice(0, l).reduce((a, b) => a * b, 1)) % this.sizes[l]
        const cascade = this.slots[l].get(s)
        if (cascade) { for (const e of cascade) if (!e.cancelled) this._place(e.id, e.cb, { id: e.id, cancelled: false }, 0, l - 1); this.slots[l].delete(s) }
      }
    }
  }

  private _place(id: number, cb: TimerCallback, handle: TimerHandle, ticks: number, level: number): void {
    const cap = this.sizes[level]
    if (ticks < cap || level === this.sizes.length - 1) {
      const slot = (this.now + ticks) % cap
      if (!this.slots[level].has(slot)) this.slots[level].set(slot, new Set())
      this.slots[level].get(slot)!.add({ id, cb })
    } else {
      this._place(id, cb, handle, Math.ceil(ticks / cap), level + 1)
    }
  }
}
`
registerSkill({
  id: 'timer-wheel',
  summary: 'Hierarchical timing wheel: O(1) schedule/cancel, configurable resolution.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\btim\w+.?wheel\b/i)) sc += 0.6
    if (s.has(/\bhierarchical.?tim\w+\b/i)) sc += 0.4
    if (s.has(/\bhashedwheel\b/i)) sc += 0.4
    if (s.has(/\bo\(1\)\b/i) && s.has(/\btim\w+\b/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/timerWheel.ts', content: IMPL }]
  },
})
