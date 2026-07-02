// Verified Tier-1A primitive: Base64 encode/decode (Node.js Buffer).
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible — Base64 encode/decode.
export function base64Encode(str: string): string {
  return Buffer.from(str, 'utf8').toString('base64')
}

export function base64Decode(str: string): string {
  return Buffer.from(str, 'base64').toString('utf8')
}
`

registerSkill({
  id: 'base64',
  summary: 'Base64 encode and decode strings via Node.js Buffer.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bbase64\b/i)) sc += 0.65
    if (s.has(/\bbase64Encode\b|\bbase64Decode\b/)) sc += 0.3
    if (s.has(/encode.*base64|base64.*encod/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/base64.ts', content: IMPL }]
  },
})
