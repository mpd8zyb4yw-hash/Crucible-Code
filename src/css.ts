import type { CSSProperties } from 'react'

/**
 * Parse a raw CSS declaration string into a React style object.
 *
 * This exists so the UI can carry the style strings from the Claude Design
 * handoff (Crucibleuioverhaul8-5) VERBATIM, instead of hand-converting each
 * one to camelCase. The design is ground truth and must not drift by a pixel;
 * a transcription typo in a box-shadow or gradient is invisible in review but
 * visible on screen. Paste the declaration, don't retype it.
 */
/**
 * Split on `;`, but not on a `;` that is INSIDE a url(), a quote or a paren.
 *
 * A plain `text.split(';')` is right until a value legitimately contains one,
 * and then it is wrong silently. `url("data:image/svg+xml;utf8,…")` was cut
 * after `svg+xml`, which is still a syntactically valid URL, so the browser
 * fetched it, failed, and painted nothing — a black rectangle where a video
 * thumbnail should be, with no error anywhere. Real image URLs carry `;` in
 * their query strings too, so this is not only about data URIs.
 */
function declarations(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quote) { if (c === quote && text[i - 1] !== '\\') quote = null; continue }
    if (c === '"' || c === "'") quote = c
    else if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (c === ';' && depth === 0) { out.push(text.slice(start, i)); start = i + 1 }
  }
  out.push(text.slice(start))
  return out
}

export function css(text: string): CSSProperties {
  const out: Record<string, string> = {}
  for (const decl of declarations(text)) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    const prop = decl.slice(0, i).trim()
    const value = decl.slice(i + 1).trim()
    if (!prop || !value) continue
    // Custom properties keep their literal name; everything else is camelCased.
    out[prop.startsWith('--') ? prop : prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value
  }
  return out as CSSProperties
}

/** css() with interpolation, for declarations that carry a dynamic value. */
export function cssv(strings: TemplateStringsArray, ...values: Array<string | number>): CSSProperties {
  let text = ''
  strings.forEach((s, i) => {
    text += s + (i < values.length ? String(values[i]) : '')
  })
  return css(text)
}
