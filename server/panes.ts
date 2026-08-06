import type { Need } from './think.js'
import type { Observation, World } from './world.js'

/**
 * The panes that do not need a model.
 *
 * The home feed was built entirely out of synthesis, which meant that the whole
 * screen — every pane, the whole reason to open the app — was downstream of one
 * LLM call. Sign in with Google, connect four sources, and still get a blank
 * page, because the free tier was spent or the selected model could not chat.
 * That is the wrong dependency: what is on his calendar this week is a FACT the
 * app already holds. It should be on screen whether or not anything is thinking.
 *
 * So: connected sources render themselves, deterministically, from the
 * observations already in the world model. Synthesis then adds what only a
 * model can add — the hero and ember cards that connect facts across sources —
 * and sits ABOVE these rather than replacing them.
 *
 * These are quiet-tier rows by design. They are the standing state of his life,
 * not something demanding attention; the design reserves hero and ember for
 * things that actually need him, and a calendar pane that shouts every day
 * would burn out the one signal that means "look at this".
 */

/** How each known source presents itself. Order is the order on screen. */
const SOURCES: {
  key: string
  title: string
  accent: string
  glyph: 'dots' | 'lines' | 'bars'
  /** The one line under the title, from the source's own observations. */
  line: (obs: Observation[]) => string
  /** Up to two numbers worth showing beside it. */
  stats?: (obs: Observation[]) => { l: string; v: string }[]
}[] = [
  {
    key: 'calendar',
    title: 'Calendar',
    accent: 'teal',
    glyph: 'lines',
    // Sorted by the date the event happens, not the order the API returned:
    // "next" has to mean next, or the pane is worse than no pane.
    line: (o) => {
      const next = [...o].sort((a, b) => a.at.localeCompare(b.at))[0]
      return next ? next.text : 'Nothing on the next seven days.'
    },
    stats: (o) => [{ l: 'Next 7 days', v: String(o.length) }],
  },
  {
    key: 'email',
    title: 'Mail',
    accent: 'amber',
    glyph: 'dots',
    line: (o) => {
      const from = new Set(o.map((x) => senderOf(x.text)).filter(Boolean))
      const newest = [...o].sort((a, b) => b.at.localeCompare(a.at))[0]
      return newest
        ? `${o.length} in the last week from ${from.size} ${from.size === 1 ? 'sender' : 'senders'}. Newest: ${subjectOf(newest.text)}`
        : 'Nothing in the last week.'
    },
    stats: (o) => [{ l: 'This week', v: String(o.length) }],
  },
  {
    key: 'health',
    title: 'Activity',
    accent: 'lime',
    glyph: 'bars',
    line: (o) => o[0]?.text ?? 'No step data yet.',
    stats: (o) => {
      const avg = firstNumber(o[0]?.text ?? '', /average\s+([\d,]+)/i)
      return avg ? [{ l: 'Steps/day', v: avg }] : []
    },
  },
  {
    key: 'youtube',
    title: 'YouTube',
    accent: 'violet',
    glyph: 'bars',
    line: (o) => o[0]?.text ?? 'Nothing watched recently.',
  },
]

/**
 * Anything else that turns up gets a pane too.
 *
 * A source is not a fixed list of four. When a new connector lands, or a track
 * starts filing observations under a name of its own, the app must be able to
 * show it without a code change and without anything hardcoded about what it
 * means — a title from the source name, the newest line it has, and the count.
 * The known four above are only there because they can say something better
 * than the generic version, not because they are the only ones allowed.
 */
function genericPane(key: string, obs: Observation[]): Need | null {
  const newest = [...obs].sort((a, b) => b.at.localeCompare(a.at))[0]
  if (!newest) return null
  return row({
    key,
    title: titleCase(key),
    accent: 'teal',
    glyph: 'dots',
    line: newest.text,
    stats: [{ l: 'Known', v: String(obs.length) }],
    count: obs.length,
  })
}

/** Sources that are not connectors and must never become panes of their own. */
const NOT_A_SOURCE = new Set(['user', 'seed', 'research', 'note'])

export function sourcePanes(world: World): Need[] {
  const on = (s: string) => world.sources?.[s] !== false
  const by = new Map<string, Observation[]>()
  for (const o of world.observations ?? []) {
    if (!by.has(o.source)) by.set(o.source, [])
    by.get(o.source)!.push(o)
  }

  const out: Need[] = []
  for (const s of SOURCES) {
    const obs = by.get(s.key) ?? []
    // A source he switched off is not a source. A source that is on but has
    // nothing yet still gets its pane, saying so — "connected and quiet" and
    // "not connected" are different states and the screen has to tell them
    // apart, which a missing pane cannot do.
    if (!on(s.key) || !by.has(s.key)) continue
    out.push(row({
      key: s.key,
      title: s.title,
      accent: s.accent,
      glyph: s.glyph,
      line: s.line(obs),
      stats: s.stats?.(obs) ?? [],
      count: obs.length,
    }))
  }

  for (const [key, obs] of by) {
    if (SOURCES.some((s) => s.key === key) || NOT_A_SOURCE.has(key)) continue
    if (!on(key)) continue
    const pane = genericPane(key, obs)
    if (pane) out.push(pane)
  }
  return out
}

/**
 * The one pane the app shows when it cannot think.
 *
 * Previously this was the readLine — 19px of raw error text where the day's
 * summary goes, with nothing to do about it. It is a card like everything else
 * now, and tapping it goes to the place where the problem is actually fixable.
 */
export function noticePane(message: string): Need {
  return {
    id: 'notice-brain',
    tier: 'quiet',
    heat: 'hot',
    heatLabel: 'needs you · now',
    title: 'I can’t think right now',
    sub: message,
    status: '',
    opening: message,
    stats: null,
    chips: [],
    gauges: null,
    meter: null,
    glyph: { kind: 'dots', values: [0.9, 0.35, 0.15] },
    accent: 'amber',
    action: { label: 'Open settings', done: 'Opening…' },
    proposes: null,
    basis: [],
    asks: false,
  }
}

/** Is this the card that opens settings rather than a thread? */
export const isNotice = (n: Need) => n.id === 'notice-brain'

function row(x: {
  key: string
  title: string
  accent: string
  glyph: 'dots' | 'lines' | 'bars'
  line: string
  stats: { l: string; v: string }[]
  count: number
}): Need {
  return {
    id: `src-${x.key}`,
    tier: 'quiet',
    heat: 'quiet',
    heatLabel: 'quiet · standing',
    title: x.title,
    sub: clip(x.line, 150),
    status: '',
    opening: clip(x.line, 400),
    stats: x.stats.length ? x.stats : null,
    chips: [],
    gauges: null,
    meter: null,
    // The tile is a shape, not a chart: three bars scaled against the busiest
    // source on screen would need cross-pane state, so it reads its own count.
    glyph: { kind: x.glyph, values: spark(x.count) },
    accent: x.accent,
    action: null,
    proposes: null,
    basis: [`source:${x.key}`],
    asks: false,
  }
}

/** Three values that rise with how much is there, without pretending to be data. */
function spark(n: number): number[] {
  const f = Math.min(1, n / 12)
  return [0.35 + f * 0.5, 0.2 + f * 0.7, 0.5 + f * 0.4].map((v) => Math.round(v * 100) / 100)
}

const senderOf = (t: string) => t.match(/^Email from ([^—]+)—/)?.[1]?.trim() ?? ''
const subjectOf = (t: string) => t.match(/"([^"]+)"/)?.[1] ?? clip(t, 60)
const firstNumber = (t: string, re: RegExp) => t.match(re)?.[1] ?? ''
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
