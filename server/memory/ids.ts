/**
 * EVERY ID IN THIS DIRECTORY IS A FUNCTION OF ITS CONTENT.
 *
 * Not a nicety — it is what makes the replay acceptance test possible at all.
 * The test deletes every derived row, rebuilds from the untouched ledger, and
 * asserts the result is the same. With random or sequential ids that comparison
 * would have to canonicalise away the identity of everything it compares, which
 * in practice means comparing summaries of summaries and losing the ability to
 * notice that two entities were swapped.
 *
 * With content-derived ids the assertion is the strong one: byte-for-byte equal.
 * Any behavioural difference between the first build and the rebuild shows up as
 * a diff, including differences in what got MERGED with what.
 *
 * The second reason is idempotence. Every writer in this directory is an upsert
 * keyed by id, so "assemble the same episode twice" has to produce the same id
 * or the second pass silently doubles his history. Deriving the id from the
 * episode's own start, type and participants means that is true by construction
 * rather than by each caller remembering to look first.
 *
 * NOTHING HERE CALLS `Date.now()` OR `Math.random()`. A clock inside an id is a
 * clock inside a comparison, and the rebuild would differ from the build for no
 * reason anyone could see.
 */

/**
 * FNV-1a, the same one `store.ts` uses for the world document's CAS token.
 *
 * Not cryptographic and does not need to be: the question is "is this the same
 * thing", the inputs are all produced by this app, and there is no adversary
 * trying to collide two of his episodes. Reused rather than reinvented so there
 * is one hash in the codebase and one place to look when a collision is ever
 * suspected.
 */
export function hash(raw: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/**
 * A readable, stable fragment for an id.
 *
 * Readable matters more than it sounds: these ids appear in evidence chains, in
 * test failures and in the developer dump, and `epi:errand:2026-03-07:coop` can
 * be reasoned about at a glance where a hash cannot. Length is capped so one
 * absurd calendar title cannot produce an id longer than the row it names.
 */
export function slug(raw: string, max = 40): string {
  const s = raw
    .toLowerCase()
    .normalize('NFKD')
    // Accents are stripped rather than transliterated: "Cinzia" and "Cínzia"
    // must produce one slug, and a full transliteration table is a liability
    // for names in languages nobody here reads.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!s) return 'x'
  if (s.length <= max) return s
  // Truncation alone would collide two long titles sharing a prefix, which for
  // recurring events is the common case rather than the rare one.
  return `${s.slice(0, max)}-${hash(s)}`
}

/** Joined with `:` because every id in this directory reads `kind:part:part`. */
export const idOf = (...parts: (string | number)[]): string => parts.map((p) => String(p)).join(':')

/**
 * A set of strings in a fixed order, for ids and for comparison.
 *
 * Participants arrive in whatever order the attendee array had, and an episode
 * whose id depended on that order would fork on the day Google reordered it.
 */
export const canonical = (values: string[]): string[] => [...new Set(values)].sort()
