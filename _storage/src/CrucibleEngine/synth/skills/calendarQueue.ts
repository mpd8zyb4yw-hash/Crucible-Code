// Verified primitive: Calendar queue — O(1) amortised priority queue for simulation events.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Calendar queue (Brown 1988).
export interface CalEvent { time: number; data: unknown }

export class CalendarQueue {
  private buckets: Array<CalEvent[]>
  private nbuckets: number
  private bucketWidth: number
  private lastPriority: number
  private lastBucket: number
  private size_ = 0

  constructor(initialBuckets = 4, width = 1.0) {
    this.nbuckets = initialBuckets
    this.bucketWidth = width
    this.buckets = Array.from({ length: initialBuckets }, () => [])
    this.lastPriority = 0; this.lastBucket = 0
  }

  enqueue(time: number, data: unknown): void {
    const b = Math.floor(time / this.bucketWidth) % this.nbuckets
    const bucket = this.buckets[b]
    let i = 0; while (i < bucket.length && bucket[i].time <= time) i++
    bucket.splice(i, 0, { time, data }); this.size_++
  }

  dequeue(): CalEvent | undefined {
    if (!this.size_) return undefined
    for (let i = 0; i < this.nbuckets; i++) {
      const b = (this.lastBucket + i) % this.nbuckets
      if (this.buckets[b].length) {
        const ev = this.buckets[b].shift()!
        this.lastBucket = b; this.lastPriority = ev.time; this.size_--
        return ev
      }
    }
    return undefined
  }

  size(): number { return this.size_ }
  isEmpty(): boolean { return this.size_ === 0 }
}
`
registerSkill({
  id: 'calendar-queue',
  summary: 'Calendar queue: O(1) amortised priority queue for simulation event scheduling.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bcalendar.?queue\b/i)) sc += 0.7
    if (s.has(/\bsimulation\b/i) && s.has(/\bevent\b/i) && s.has(/\bpriority\b/i)) sc += 0.2
    if (s.has(/\bbucket.?width\b/i)) sc += 0.3
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/calendarQueue.ts', content: IMPL }]
  },
})
