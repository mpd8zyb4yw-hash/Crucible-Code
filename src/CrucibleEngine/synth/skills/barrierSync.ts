// Verified primitive: CyclicBarrier — N workers wait at barrier, release together, reusable.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — CyclicBarrier.
export class CyclicBarrier {
  private count: number
  private waiting = 0
  private resolvers: Array<() => void> = []

  constructor(parties: number) { this.count = parties }

  /** Arrive and wait; resolves when all parties have arrived. */
  async await_(): Promise<void> {
    this.waiting++
    if (this.waiting >= this.count) {
      const r = this.resolvers.slice()
      this.resolvers = []; this.waiting = 0
      r.forEach(f => f())
      return
    }
    return new Promise(resolve => this.resolvers.push(resolve))
  }

  parties(): number { return this.count }
  getNumberWaiting(): number { return this.waiting }
  reset(): void { const r = this.resolvers.slice(); this.resolvers = []; this.waiting = 0; r.forEach(f => f()) }
}

export class CountDownLatch {
  private count: number
  private resolvers: Array<() => void> = []
  constructor(count: number) { this.count = count }
  countDown(): void { if (--this.count <= 0) { const r = this.resolvers.splice(0); r.forEach(f => f()) } }
  async await_(): Promise<void> { if (this.count <= 0) return; return new Promise(r => this.resolvers.push(r)) }
  getCount(): number { return this.count }
}
`
registerSkill({
  id: 'barrier-sync',
  summary: 'CyclicBarrier + CountDownLatch: N-party synchronisation primitives.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bbarrier\b/i)) sc += 0.4
    if (s.has(/\bcyclic.?barrier\b/i)) sc += 0.4
    if (s.has(/\bcount.?down.?latch\b/i)) sc += 0.4
    if (s.has(/\bparties\b/i) && s.has(/\bwait\b/i)) sc += 0.2
    if (s.has(/\bsynchroni[sz]\w+\b/i) && s.has(/\bworker\b/i)) sc += 0.1
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/barrier.ts', content: IMPL }]
  },
})
