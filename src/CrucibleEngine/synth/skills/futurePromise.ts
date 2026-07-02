// Verified primitive: Future/Promise pattern — deferred value, compose, all, race, retry.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Future/deferred value.
export class Future<T> {
  private _resolve!: (v: T) => void
  private _reject!:  (e: unknown) => void
  readonly promise: Promise<T>
  private _settled = false

  constructor() {
    this.promise = new Promise((res, rej) => { this._resolve = res; this._reject = rej })
  }

  resolve(value: T): void { if (!this._settled) { this._settled = true; this._resolve(value) } }
  reject(err: unknown):  void { if (!this._settled) { this._settled = true; this._reject(err) } }
  get settled(): boolean { return this._settled }

  then<U>(f: (v: T) => U): Promise<U> { return this.promise.then(f) }
  catch<U>(f: (e: unknown) => U): Promise<T | U> { return this.promise.catch(f) }
}

export function timeout<T>(ms: number, fallback?: T): Promise<T> {
  return new Promise((res, rej) => setTimeout(() => fallback !== undefined ? res(fallback!) : rej(new Error(\`Timeout \${ms}ms\`)), ms))
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, timeout<T>(ms)])
}

export async function retry<T>(fn: () => Promise<T>, attempts: number, delayMs = 0): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try { return await fn() } catch (e) { if (i === attempts - 1) throw e; if (delayMs) await new Promise(r => setTimeout(r, delayMs * 2 ** i)) }
  }
  throw new Error('unreachable')
}

export async function allSettled<T>(promises: Promise<T>[]): Promise<Array<{ status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown }>> {
  return Promise.allSettled(promises)
}
`
registerSkill({
  id: 'future-promise',
  summary: 'Future/deferred value, withTimeout, retry with backoff, allSettled.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bfuture\b/i) && s.has(/\bdeferred\b|\bpromise\b/i)) sc += 0.4
    if (s.has(/\bwithTimeout\b|\bwith.?timeout\b/i)) sc += 0.3
    if (s.has(/\bretry\b/i) && s.has(/\bbackoff\b|\bexponential\b/i)) sc += 0.25
    if (s.has(/\bdeferred\b/i) && s.has(/\bsettle\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/future.ts', content: IMPL }]
  },
})
