// Verified Tier-1A primitive: escape/unescape HTML entities.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible — HTML entity escape/unescape.
const TO_HTML: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}
const FROM_HTML: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
}

export function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, c => TO_HTML[c])
}

export function unescapeHtml(str: string): string {
  return str.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, e => FROM_HTML[e])
}
`

registerSkill({
  id: 'escape-html',
  summary: 'Escape and unescape HTML entities (&, <, >, ", \').',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/escape.*html|html.*escape/i)) sc += 0.7
    if (s.has(/\bescapeHtml\b|\bunescapeHtml\b/)) sc += 0.3
    if (s.has(/&amp;|&lt;|&gt;|html.*entit/i)) sc += 0.25
    if (s.has(/xss.*prevent|prevent.*xss/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/escapeHtml.ts', content: IMPL }]
  },
})
