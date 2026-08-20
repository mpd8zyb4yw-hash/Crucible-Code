/**
 * What the app actually costs him, measured rather than asserted.
 *
 * Every number here is a real mark taken on a real load. None of it is
 * computed, estimated, or carried over from a previous run — a performance
 * claim that is not a measurement from this session is worse than no claim,
 * because it survives the regression that makes it false.
 *
 * All times are milliseconds since navigation start, so they line up with what
 * the browser's own timeline shows.
 */

export type Mark =
  /** React has mounted and the frame is on screen. */
  | 'shell'
  /** The persisted workspace is painted — layout, panes, last-known contents. */
  | 'persisted'
  /** Something genuinely useful is readable, from any source including cache. */
  | 'useful'
  /** Authoritative data has landed and replaced or confirmed the cache. */
  | 'fresh'

export interface Timings {
  shell?: number
  persisted?: number
  useful?: number
  fresh?: number
  /** Whether the first paint came from persisted state or from nothing. */
  cache: 'hit' | 'miss' | 'unknown'
  /** How long the background revalidation took, once it finished. */
  refreshMs?: number
  /** Round-trip of the call that produced authoritative data. */
  connectorMs?: number
  /** Every mark, in order, for anything that wants the detail. */
  log: { mark: string; at: number }[]
}

const t: Timings = { cache: 'unknown', log: [] }

const now = () =>
  Math.round(performance.now())

export function mark(m: Mark | string, value = now()) {
  const bag = t as unknown as Record<string, unknown>
  // First write wins. "Time to first useful content" is the FIRST time, and a
  // later repaint must not be allowed to overwrite it with a worse number.
  if (bag[m] === undefined) bag[m] = value
  t.log.push({ mark: m, at: value })
}

export function cache(kind: 'hit' | 'miss') {
  if (t.cache === 'unknown') t.cache = kind
}

export function measure(key: 'refreshMs' | 'connectorMs', ms: number) {
  t[key] = Math.round(ms)
}

export const timings = (): Timings => ({ ...t, log: [...t.log] })

/**
 * One line, printed once, when the picture is complete.
 *
 * Exposed on `window` as well because that is how it gets read from a browser
 * session against the real app rather than from a test harness that measures a
 * different thing.
 */
export function report() {
  const line =
    `crucible: shell ${t.shell ?? '—'}ms · persisted ${t.persisted ?? '—'}ms · useful ${t.useful ?? '—'}ms · ` +
    `fresh ${t.fresh ?? '—'}ms · cache ${t.cache}` +
    (t.refreshMs !== undefined ? ` · refresh ${t.refreshMs}ms` : '') +
    (t.connectorMs !== undefined ? ` · connector ${t.connectorMs}ms` : '')
  // eslint-disable-next-line no-console
  console.info(line)
  return line
}

declare global {
  interface Window { __cruTimings?: () => Timings }
}

if (typeof window !== 'undefined') window.__cruTimings = timings
