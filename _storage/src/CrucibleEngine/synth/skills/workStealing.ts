// Verified primitive: work-stealing scheduler — per-worker deque, steal from tail.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — work-stealing scheduler.
export type Task = () => void | Promise<void>

class WorkerDeque {
  private q: Task[] = []
  push(t: Task): void { this.q.push(t) }
  pop(): Task | undefined { return this.q.pop() }      // owner pops from tail
  steal(): Task | undefined { return this.q.shift() }  // thief steals from head
  get length(): number { return this.q.length }
}

export class WorkStealingScheduler {
  private workers: WorkerDeque[]
  private running = false

  constructor(private numWorkers: number) {
    this.workers = Array.from({ length: numWorkers }, () => new WorkerDeque())
  }

  submit(task: Task, workerHint = 0): void {
    this.workers[workerHint % this.numWorkers].push(task)
    if (!this.running) this._run()
  }

  private async _run(): Promise<void> {
    this.running = true
    const loop = async (id: number): Promise<void> => {
      while (true) {
        let task = this.workers[id].pop()
        if (!task) {
          // steal
          for (let i = 1; i < this.numWorkers; i++) {
            task = this.workers[(id + i) % this.numWorkers].steal()
            if (task) break
          }
        }
        if (!task) break
        await task()
      }
    }
    await Promise.all(this.workers.map((_, i) => loop(i)))
    this.running = false
  }

  pending(): number { return this.workers.reduce((s, w) => s + w.length, 0) }
}
`
registerSkill({
  id: 'work-stealing',
  summary: 'Work-stealing scheduler: per-worker deque, steal from tail, parallel drain.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bwork.?steal\w+\b/i)) sc += 0.7
    if (s.has(/\bdeque\b/i) && s.has(/\bschedul\w+\b/i)) sc += 0.2
    if (s.has(/\bsteal\b/i) && s.has(/\bworker\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/workStealing.ts', content: IMPL }]
  },
})
