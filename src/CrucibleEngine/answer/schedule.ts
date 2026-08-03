// ============================================================================
// DETERMINISTIC SCHEDULE SOLVER — free/busy interval arithmetic, zero inference.
//
// WHY (measured 2026-08-03, `npm run dogfood:assistant`):
//   Q: "I have meetings tomorrow at 9am, 11am and 2pm, each one hour long.
//       Between 9am and 5pm, what is my longest free block?"
//   A (qwen2.5-1.5b, first run):  "8 hours 30 minutes minus 1 hour ... 7 hours 30 minutes"
//   A (second run):               "from 11am to 1pm"   <- collides with the 11am meeting
//   Correct: 2 hours (12pm-2pm and 3pm-5pm are tied).
//
// This is not a knowledge gap and not a retrieval problem — it is arithmetic over intervals,
// which is exactly the kind of thing a deterministic verifier settles and a 1.5B model
// reliably fumbles. DOCTRINE §5.1: formalize "correct" as a mechanical check first. Here we
// can go further than checking and simply COMPUTE the answer, the way directArithmetic
// (wordProblem.ts) already does for plain sums: zero model calls, exact, works offline.
//
// Scope is deliberately narrow and refuses loudly. It parses only what it can be certain of,
// and returns null the moment anything is ambiguous, so a half-understood question falls
// through to the normal reasoning path instead of getting a confident wrong table.
// ============================================================================

export interface Interval {
  /** Minutes from midnight. */
  start: number
  end: number
  label?: string
}

export interface ScheduleSolution {
  /** Busy blocks, merged and sorted. */
  busy: Interval[]
  /** Free gaps inside the window, sorted by start. */
  free: Interval[]
  /** Longest free gaps — more than one when tied. */
  longest: Interval[]
  window: Interval
  /** Rendered answer, ready to show. */
  text: string
}

const HHMM = (m: number): string => {
  const h24 = Math.floor(m / 60) % 24
  const mm = m % 60
  const suffix = h24 < 12 ? 'am' : 'pm'
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return mm === 0 ? `${h12}${suffix}` : `${h12}:${String(mm).padStart(2, '0')}${suffix}`
}

export const formatClock = HHMM

/** "9am", "9:30am", "14:00", "2 pm", "noon", "midday", "midnight". Minutes from midnight. */
export function parseClock(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/\./g, '')
  if (/^(noon|midday)$/.test(s)) return 12 * 60
  if (/^midnight$/.test(s)) return 0
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(s)
  if (!m) return null
  let h = parseInt(m[1], 10)
  const min = m[2] ? parseInt(m[2], 10) : 0
  const mer = m[3]
  if (min > 59) return null
  if (mer) {
    if (h < 1 || h > 12) return null
    if (mer === 'am') h = h === 12 ? 0 : h
    else h = h === 12 ? 12 : h + 12
  } else {
    // No meridiem: only accept an unambiguous 24-hour reading.
    if (h > 23) return null
  }
  return h * 60 + min
}

/** Spelled-out counts. People write "each one hour long" far more often than "each 1 hour". */
const WORD_NUM: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
}
/** Alternation of every accepted duration phrasing, for reuse in the question regexes. */
export const DURATION_RE_SRC =
  String.raw`(?:half\s+an?\s+hour|(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours|m|min|mins|minute|minutes))`

/** "an hour", "one hour", "90 minutes", "1.5 hours", "45 mins", "half an hour". Minutes. */
export function parseDuration(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, ' ')
  if (/^half an? hour$/.test(s)) return 30
  if (/^(?:an?|one) hour$/.test(s)) return 60
  const m = /^([a-z]+|\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)$/.exec(s)
  if (!m) return null
  const n = /^\d/.test(m[1]) ? parseFloat(m[1]) : WORD_NUM[m[1]]
  if (!Number.isFinite(n) || !n || n <= 0) return null
  return /^h/.test(m[2]) ? Math.round(n * 60) : Math.round(n)
}

/** Merge overlapping/adjacent intervals. */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a.start - b.start || a.end - b.end)
  const out: Interval[] = []
  for (const iv of sorted) {
    const last = out[out.length - 1]
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end)
    else out.push({ ...iv })
  }
  return out
}

/** Gaps inside `window` not covered by `busy`. */
export function freeGaps(window: Interval, busy: Interval[]): Interval[] {
  const clipped = mergeIntervals(
    busy
      .map(b => ({ start: Math.max(b.start, window.start), end: Math.min(b.end, window.end) }))
      .filter(b => b.end > b.start),
  )
  const gaps: Interval[] = []
  let cursor = window.start
  for (const b of clipped) {
    if (b.start > cursor) gaps.push({ start: cursor, end: b.start })
    cursor = Math.max(cursor, b.end)
  }
  if (cursor < window.end) gaps.push({ start: cursor, end: window.end })
  return gaps
}

export function humanDuration(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h && m) return `${h} hour${h === 1 ? '' : 's'} ${m} minute${m === 1 ? '' : 's'}`
  if (h) return `${h} hour${h === 1 ? '' : 's'}`
  return `${m} minute${m === 1 ? '' : 's'}`
}

// ── Question recognition ─────────────────────────────────────────────────────

const ASKS_FREE = /\b(free|available|open|gap|spare|unbooked|not\s+busy|longest\s+block|free\s+block|free\s+time)\b/i
const HAS_MEETING = /\b(meeting|meetings|call|calls|appointment|appointments|event|events|booked|busy|class|classes|session|sessions|interview|interviews)\b/i

/** Times listed as "at 9am, 11am and 2pm" or "9-10am". Returns minutes-from-midnight starts. */
function extractStartTimes(text: string): number[] {
  const out: number[] = []
  const re = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2}|noon|midday|midnight)\b/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const v = parseClock(m[1])
    if (v !== null) out.push(v)
  }
  return out
}

/**
 * Solve a free/busy question deterministically, or return null.
 *
 * Handles the common shape: a list of start times, one shared duration ("each one hour"),
 * and an enclosing window ("between 9am and 5pm"). Anything else -> null, on purpose.
 */
export function solveSchedule(message: string): ScheduleSolution | null {
  if (typeof message !== 'string') return null
  const text = message.trim()
  if (!text || !ASKS_FREE.test(text) || !HAS_MEETING.test(text)) return null

  // Window: "between X and Y" / "from X to Y".
  const winMatch = /\b(?:between|from)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midday|midnight)\s*(?:and|to|until|till|-|–)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midday|midnight)\b/i.exec(text)
  if (!winMatch) return null
  const wStart = parseClock(winMatch[1])
  const wEnd = parseClock(winMatch[2])
  if (wStart === null || wEnd === null || wEnd <= wStart) return null
  const window: Interval = { start: wStart, end: wEnd }

  // Shared duration: "each one hour long", "each 30 minutes", "all an hour".
  const durMatch =
    new RegExp(String.raw`\b(?:each|every|all|both)\s+(?:lasting\s+|running\s+|for\s+)?(?:about\s+)?(` + DURATION_RE_SRC + String.raw`)\b`, 'i').exec(text)
    ?? new RegExp(String.raw`\b(` + DURATION_RE_SRC + String.raw`)\s+(?:long|each|apiece)\b`, 'i').exec(text)
  if (!durMatch) return null
  const dur = parseDuration(durMatch[1])
  if (dur === null || dur <= 0) return null

  // Meeting starts: every clock time in the text EXCEPT the two window bounds.
  const windowSpan = winMatch[0]
  const withoutWindow = text.replace(windowSpan, ' ')
  const starts = [...new Set(extractStartTimes(withoutWindow))].sort((a, b) => a - b)
  if (starts.length === 0) return null

  const busy = mergeIntervals(starts.map(s => ({ start: s, end: s + dur })))
  const free = freeGaps(window, busy)
  if (free.length === 0) {
    return {
      busy, free, longest: [], window,
      text: `You have no free time between ${HHMM(window.start)} and ${HHMM(window.end)} — the meetings cover the whole window.`,
    }
  }
  const maxLen = Math.max(...free.map(f => f.end - f.start))
  const longest = free.filter(f => f.end - f.start === maxLen)

  const gapList = free.map(f => `${HHMM(f.start)}–${HHMM(f.end)} (${humanDuration(f.end - f.start)})`)
  const longestList = longest.map(f => `${HHMM(f.start)}–${HHMM(f.end)}`)
  const head = longest.length === 1
    ? `Your longest free block is **${longestList[0]}** — ${humanDuration(maxLen)}.`
    : `Your longest free blocks are tied at ${humanDuration(maxLen)}: **${longestList.join('** and **')}**.`

  return {
    busy, free, longest, window,
    text:
      `${head}\n\n` +
      `All free gaps between ${HHMM(window.start)} and ${HHMM(window.end)}:\n` +
      gapList.map(g => `- ${g}`).join('\n') + '\n\n' +
      `Busy: ${busy.map(b => `${HHMM(b.start)}–${HHMM(b.end)}`).join(', ')}.`,
  }
}
