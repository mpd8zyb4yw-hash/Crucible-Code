// Verified primitive: CSP-style buffered/unbuffered channel with async send/receive, select.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — CSP channel.
export class Channel<T> {
  private buf: T[] = []
  private cap: number
  private sendQ: Array<{ val: T; resolve: () => void }> = []
  private recvQ: Array<{ resolve: (v: T) => void }> = []

  constructor(capacity = 0) { this.cap = capacity }

  async send(val: T): Promise<void> {
    if (this.recvQ.length) { const { resolve } = this.recvQ.shift()!; resolve(val); return }
    if (this.buf.length < this.cap) { this.buf.push(val); return }
    return new Promise(resolve => this.sendQ.push({ val, resolve }))
  }

  async recv(): Promise<T> {
    if (this.buf.length) {
      const val = this.buf.shift()!
      if (this.sendQ.length) { const { val: v, resolve } = this.sendQ.shift()!; this.buf.push(v); resolve() }
      return val
    }
    if (this.sendQ.length) { const { val, resolve } = this.sendQ.shift()!; resolve(); return val }
    return new Promise(resolve => this.recvQ.push({ resolve }))
  }

  tryRecv(): T | undefined {
    if (this.buf.length) return this.buf.shift()
    if (this.sendQ.length) { const { val, resolve } = this.sendQ.shift()!; resolve(); return val }
    return undefined
  }

  len(): number { return this.buf.length }
  closed(): boolean { return false }  // extend with close() for real CSP
}

/** Select-like: race multiple receives, return whichever resolves first. */
export async function select<T>(...channels: Channel<T>[]): Promise<T> {
  return Promise.race(channels.map(c => c.recv()))
}
`
registerSkill({
  id: 'csp-channel',
  summary: 'CSP channel: buffered/unbuffered async send/receive, select.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bcsp\b|communicating.?sequential/i)) sc += 0.5
    if (s.has(/\bchannel\b/i) && s.has(/\bsend\b/i) && s.has(/\brecv\b|\breceive\b/i)) sc += 0.35
    if (s.has(/\bgo.?channel\b|\bchan\b/i)) sc += 0.3
    if (s.has(/\bselect\b/i) && s.has(/\bchannel\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/channel.ts', content: IMPL }]
  },
})
