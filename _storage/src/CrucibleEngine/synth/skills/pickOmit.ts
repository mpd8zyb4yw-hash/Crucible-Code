// Verified Tier-1A primitive: pick and omit keys from an object.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible — pick/omit object keys.
export function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k]
  }
  return out
}

export function omit<T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> {
  const out = { ...obj } as T
  for (const k of keys) delete out[k]
  return out as Omit<T, K>
}
`

registerSkill({
  id: 'pick-omit',
  summary: 'Pick a subset of keys from an object; omit a set of keys from an object.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bpick\b/i) && s.has(/\bomit\b/i)) sc += 0.65
    if (s.has(/\bpick\b.*\bkeys?\b|\bkeys?\b.*\bpick\b/i)) sc += 0.4
    if (s.has(/\bpick\b/i) && !s.has(/\bomit\b/i)) sc += 0.35
    if (s.has(/select.*subset.*keys?|subset.*object.*keys?/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/pick.ts', content: IMPL }]
  },
})
