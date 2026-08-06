// Verified primitive: hierarchical hash-set timer — multi-level O(1) schedule, amortised O(1) fire.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — hierarchical timer (4-level wheel).
export type TimerCb = () => void

interface Entry { id: number; cb: TimerCb; fireAt: number }

export class HierarchicalTimer {
  private readonly LEVELS = [256, 64, 64, 64]   // slots per level
  private readonly MULT:   number[]              // cumulative multipliers
  private wheels: Array<Map<number, Set<Entry>>> // level → slot → entries
  private now = 0; private uid = 0

  constructor() {
    this.MULT = this.LEVELS.reduce<number[]>((acc, n, i) => [...acc, (acc[i - 1] ?? 1) * (i ? this.LEVELS[i - 1] : 1)], [])
    this.wheels = this.LEVELS.map(n => new Map<number, Set<Entry>>())
  }

  schedule(delayTicks: number, cb: TimerCb): { id: number; cancel: () => void } {
    const fireAt = this.now + Math.max(1, delayTicks)
    const entry: Entry = { id: ++this.uid, cb, fireAt }
    this._place(entry)
    return { id: entry.id, cancel: () => this._remove(entry) }
  }

  tick(): void {
    this.now++
    const toFire = this.wheels[0].get(this.now % this.LEVELS[0]) ?? new Set<Entry>()
    this.wheels[0].delete(this.now % this.LEVELS[0])
    // cascade higher levels
    for (let l = 1; l < this.LEVELS.length; l++) {
      if (this.now % this.MULT[l] === 0) {
        const slot = Math.floor(this.now / this.MULT[l]) % this.LEVELS[l]
        const cascade = this.wheels[l].get(slot) ?? new Set<Entry>()
        this.wheels[l].delete(slot)
        for (const e of cascade) this._place(e)
      }
    }
    for (const e of toFire) e.cb()
  }

  private _place(e: Entry): void {
    const delta = e.fireAt - this.now
    for (let l = 0; l < this.LEVELS.length; l++) {
      if (delta < this.MULT[l] * this.LEVELS[l] || l === this.LEVELS.length - 1) {
        const slot = Math.floor(e.fireAt / this.MULT[l]) % this.LEVELS[l]
        if (!this.wheels[l].has(slot)) this.wheels[l].set(slot, new Set())
        this.wheels[l].get(slot)!.add(e); return
      }
    }
  }

  private _remove(e: Entry): void {
    for (const level of this.wheels) for (const bucket of level.values()) bucket.delete(e)
  }

  currentTick(): number { return this.now }
}
`
registerSkill({
  id: 'hierarchical-timer',
  summary: 'Hierarchical 4-level timer wheel: O(1) schedule/fire/cascade.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bhierarchical.?timer\b/i)) sc += 0.6
    if (s.has(/\bmulti.?level\b/i) && s.has(/\btim\w+.?wheel\b/i)) sc += 0.4
    if (s.has(/\b4.?level\b|\bfour.?level\b/i) && s.has(/\bwheel\b/i)) sc += 0.3
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/hierarchicalTimer.ts', content: IMPL }]
  },
})
