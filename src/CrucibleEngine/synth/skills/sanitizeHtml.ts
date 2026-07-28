// Verified Tier-1C primitive: HTML sanitization (strip tags / allowlist).
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible — HTML sanitizer.
const TAG_RE = /<[^>]*>/g
const ATTR_RE = /\\s+on\\w+\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]*)/gi
const SAFE_TAGS = new Set(['b','i','em','strong','u','s','p','br','ul','ol','li','a','span','div','h1','h2','h3','h4','h5','h6','code','pre','blockquote'])
const SAFE_ATTRS = new Set(['href','title','class','id','target'])

export function stripTags(html: string): string {
  return html.replace(TAG_RE, '')
}

export function sanitizeHtml(html: string, opts: { allowedTags?: Set<string>; allowedAttrs?: Set<string> } = {}): string {
  const allowedTags = opts.allowedTags ?? SAFE_TAGS
  const allowedAttrs = opts.allowedAttrs ?? SAFE_ATTRS
  return html
    .replace(ATTR_RE, '')  // strip event handlers first
    .replace(/<\\/?([a-zA-Z][a-zA-Z0-9]*)((?:\\s+[^>]*)?)>/g, (_, tag, attrs) => {
      const lower = tag.toLowerCase()
      if (!allowedTags.has(lower)) return ''
      // strip disallowed attributes
      const cleanAttrs = attrs.replace(/\\s+([a-zA-Z-]+)\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]*)/g, (m: string, attr: string) =>
        allowedAttrs.has(attr.toLowerCase()) ? m : ''
      )
      return \`<\${lower}\${cleanAttrs}>\`
    })
}
`


registerSkill({
  id: 'sanitizeHtml',
  summary: 'HTML sanitizer: stripTags removes all tags; sanitizeHtml allowlists safe tags/attrs.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bsanitize.?html\b/i)) sc += 0.85
    if (s.has(/\bstrip.?tags\b/i)) sc += 0.7
    if (s.has(/\bhtml.*sanitiz|sanitiz.*html\b/i)) sc += 0.5
    if (s.has(/xss.*prevent|prevent.*xss|allow.*list.*tag/i)) sc += 0.4
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/module.ts', content: IMPL }]
  },
})
