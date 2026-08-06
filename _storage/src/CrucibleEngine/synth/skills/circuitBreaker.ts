import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — verified circuit breaker (closed/open/half-open).
export type CBState = 'closed'|'open'|'half-open'
export class CircuitBreaker {
  private state: CBState = 'closed'
  private failures = 0
  private lastFailure = 0
  constructor(private threshold=5, private resetMs=60000, private halfOpenProbes=1, private now=Date.now) {}
  get status(): CBState { return this.state }
  async call<T>(fn: ()=>Promise<T>): Promise<T> {
    if(this.state==='open'){
      if(this.now()-this.lastFailure>=this.resetMs)this.state='half-open'
      else throw new Error('Circuit open')
    }
    try {
      const r=await fn()
      if(this.state==='half-open')this.state='closed'
      this.failures=0; return r
    } catch(e) {
      this.failures++; this.lastFailure=this.now()
      if(this.failures>=this.threshold)this.state='open'
      throw e
    }
  }
  reset(): void { this.state='closed'; this.failures=0 }
}
`
registerSkill({ id: 'circuit-breaker', summary: 'Circuit breaker with closed/open/half-open states and configurable threshold.',
  match(s: SpecFeatures) { let score = 0; if (s.has(/circuit.?breaker/i)) score += 0.8; if (s.has(/half.?open/i)) score += 0.3; if (s.has(/\bCircuitBreaker\b/)) score += 0.3; return score },
  emit(s: SpecFeatures): SynthFile[] { return [{ path: s.modulePath ?? 'src/circuitBreaker.ts', content: IMPL }] } })
