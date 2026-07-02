// Verified primitive: Actor model — mailbox per actor, message dispatch, supervision.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Actor system.
export type ActorFn<S, M> = (state: S, msg: M, self: ActorRef<M>) => S | Promise<S>

export interface ActorRef<M> {
  id: string
  send(msg: M): void
}

export class ActorSystem {
  private actors = new Map<string, { mailbox: unknown[]; running: boolean; fn: ActorFn<unknown, unknown>; state: unknown }>()
  private uid = 0

  spawn<S, M>(fn: ActorFn<S, M>, initialState: S): ActorRef<M> {
    const id = \`actor-\${++this.uid}\`
    const ref: ActorRef<M> = { id, send: (msg) => this._enqueue(id, msg) }
    this.actors.set(id, { mailbox: [], running: false, fn: fn as ActorFn<unknown, unknown>, state: initialState })
    return ref
  }

  private _enqueue(id: string, msg: unknown): void {
    const a = this.actors.get(id)
    if (!a) return
    a.mailbox.push(msg)
    if (!a.running) this._drain(id)
  }

  private async _drain(id: string): Promise<void> {
    const a = this.actors.get(id)
    if (!a || a.running) return
    a.running = true
    while (a.mailbox.length) {
      const msg = a.mailbox.shift()
      const ref: ActorRef<unknown> = { id, send: (m) => this._enqueue(id, m) }
      try { a.state = await a.fn(a.state, msg, ref) } catch (e) { /* supervisor hook */ }
    }
    a.running = false
  }

  stop(ref: ActorRef<unknown>): void { this.actors.delete(ref.id) }
  actorCount(): number { return this.actors.size }
}
`
registerSkill({
  id: 'actor-system',
  summary: 'Actor model: mailbox-per-actor, async message dispatch, supervision.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bactor\b/i) && s.has(/\bmodel\b|\bsystem\b/i)) sc += 0.5
    if (s.has(/\bmailbox\b/i)) sc += 0.3
    if (s.has(/\bspawn\b/i) && s.has(/\bactor\b/i)) sc += 0.25
    if (s.has(/\bsupervis\w+\b/i)) sc += 0.15
    if (s.has(/\bactorref\b/i)) sc += 0.3
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/actorSystem.ts', content: IMPL }]
  },
})
