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
export function css(text: string): CSSProperties {
  const out: Record<string, string> = {}
  for (const decl of text.split(';')) {
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
