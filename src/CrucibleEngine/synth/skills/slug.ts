// Verified Tier-1A primitive: URL-safe slug generation.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible — URL-safe slug generator.
export function slug(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\\s-]/g, '')
    .replace(/\\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}
`

registerSkill({
  id: 'slug',
  summary: 'URL-safe slug: lowercase, trim, strip non-alphanumeric, collapse hyphens.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bslug\b/i)) sc += 0.6
    if (s.has(/url[- ]?safe|url[- ]?slug/i)) sc += 0.3
    if (s.has(/kebab[- ]?case/i)) sc += 0.2
    if (s.has(/\bslugify\b/i)) sc += 0.5
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/slug.ts', content: IMPL }]
  },
})
