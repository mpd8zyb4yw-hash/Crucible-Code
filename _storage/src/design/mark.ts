// ── design/mark — self-authored identity marks ───────────────────────────────
//
// House rule 2: no stock or external imagery, and no external asset requests at
// runtime. Anywhere the UI wants a per-thing picture (a favicon, a video
// thumbnail, an avatar), it derives one from the thing's own text instead of
// fetching one. Deterministic: the same string always yields the same mark, so
// a domain or a card keeps its identity across renders and sessions.
//
// Two call sites depend on this, both of which were remote-image bugs:
//   - chat/MessageList SourceMark   (was a Google favicon service; fixed 2026-08-03)
//   - agentic/SurfaceRenderer tiles (was a model-supplied thumbnail URL)
// Do not reintroduce a remote image service at either, keyless or not.

/** Stable hue from any string, so the same input always gets the same mark. */
export function markHue(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return h
}

/** Two-stop gradient for a mark's field, per the design's monogram spec. */
export function markGradient(s: string, alpha = 0.85): string {
  const hue = markHue(s)
  return `linear-gradient(140deg, hsla(${hue},62%,58%,${alpha}), hsla(${(hue + 40) % 360},62%,44%,${alpha}))`
}

/** Two letters from a hostname: the registrable name, not the TLD. */
export function hostMonogram(host: string): string {
  const bare = host.replace(/^www\./, '')
  const name = bare.split('.')[0] || bare
  return (name.slice(0, 2) || '??').toUpperCase()
}

/** Two letters from a title: initials of the first two words, else its first two letters. */
export function titleMonogram(title: string): string {
  const words = (title ?? '').trim().split(/\s+/).filter(w => /[a-z0-9]/i.test(w))
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  const one = words[0] ?? ''
  return (one.slice(0, 2) || '??').toUpperCase()
}
