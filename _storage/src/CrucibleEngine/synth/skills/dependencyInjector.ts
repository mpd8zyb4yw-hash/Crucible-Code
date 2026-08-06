import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Dependency injection container: singleton, transient, factory, scoped.
type Factory<T> = (c: Container) => T
type Lifetime = 'singleton' | 'transient' | 'scoped'
interface Registration<T> { factory: Factory<T>; lifetime: Lifetime; instance?: T }
export class Container {
  private registry = new Map<string, Registration<unknown>>()
  private scopeCache = new Map<string, unknown>()
  register<T>(token: string, factory: Factory<T>, lifetime: Lifetime = 'transient'): this {
    this.registry.set(token, { factory, lifetime })
    return this
  }
  singleton<T>(token: string, factory: Factory<T>): this { return this.register(token, factory, 'singleton') }
  resolve<T>(token: string): T {
    const reg = this.registry.get(token) as Registration<T> | undefined
    if (!reg) throw new Error(\`Not registered: \${token}\`)
    if (reg.lifetime === 'singleton') { if (!reg.instance) reg.instance = reg.factory(this); return reg.instance as T }
    if (reg.lifetime === 'scoped') {
      if (!this.scopeCache.has(token)) this.scopeCache.set(token, reg.factory(this))
      return this.scopeCache.get(token) as T
    }
    return reg.factory(this)
  }
  createScope(): Container {
    const child = new Container()
    this.registry.forEach((reg, k) => child.registry.set(k, reg.lifetime === 'scoped' ? { ...reg, instance: undefined } : reg))
    return child
  }
  has(token: string): boolean { return this.registry.has(token) }
}
`
registerSkill({
  id: 'dependency-injection',
  summary: 'DI container: singleton, transient, scoped lifetimes, child scope.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bdependency.?inject\w+\b|\bdi.?container\b/i)) sc += 0.6
    if (s.has(/\bsingleton\b/i) && s.has(/\btransient\b/i)) sc += 0.3
    if (s.has(/\bscoped\b/i) && s.has(/\blifetime\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/container.ts', content: IMPL }]
  },
})
