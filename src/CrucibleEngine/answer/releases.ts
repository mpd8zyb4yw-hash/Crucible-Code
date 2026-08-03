// ============================================================================
// DETERMINISTIC RELEASE / LIFECYCLE SOLVER — "what version of X", answered exactly.
//
// WHY (measured 2026-08-03, `npm run dogfood:assistant`):
//   Q: "What is the current Long Term Support (LTS) version of Node.js?"
//   A: abstained — "no source answered the question", on BOTH runs.
// That abstention was honest but useless, and it was not a reasoning failure: none of the
// keyless sources we federate (encyclopedia, dictionary, entity graph, papers, forum) carries
// release data. The whole question class — "current version", "is X still supported", "when
// does Y reach end of life" — had no ground truth to stand on.
//
// This is DOCTRINE §5.1 applied one rung further than usual. For most questions we can only
// CHECK an answer mechanically; here we can COMPUTE it. endoflife.date publishes a keyless,
// structured, per-product release table (462 products), and every question in the class is a
// pure function of that table plus today's date:
//
//   current LTS      = highest cycle whose `lts` has arrived and whose `eol` has not
//   latest version   = `latest` of the newest cycle
//   end of life      = `eol` of the named cycle
//   still supported? = today < eol
//
// So there is no model call, no prose to hallucinate, and the answer carries the exact
// release table row it came from. A 1.5B model cannot know today's Node LTS; nothing can,
// parametrically — it changes every six months. This is the canonical case where retrieval
// must win and where a stale confident answer is strictly worse than an abstention.
//
// Refuses loudly, like every other solver here: unknown product, ambiguous question, or a
// dead API all return null so the question falls through to the normal path rather than
// getting a confident wrong table.
// ============================================================================

/** One release line as published by endoflife.date. Fields are famously heterogeneous: */
interface Cycle {
  /** Release line: "24", "3.12", "22.04". Always present. */
  cycle: string
  /** false | true | an ISO date the line BECAME lts. Absent on products without LTS lines. */
  lts?: boolean | string
  /** false | true | an ISO date the line reaches EOL. `true` means already EOL. */
  eol?: boolean | string
  /** Newest patch on this line, e.g. "24.18.1". */
  latest?: string
  releaseDate?: string
  latestReleaseDate?: string
  support?: boolean | string
  discontinued?: boolean | string
}

export type ReleaseAsk = 'lts' | 'latest' | 'eol' | 'supported'

export interface ReleaseQuery {
  ask: ReleaseAsk
  /**
   * Every plausible product name in the question, longest n-gram first. The resolver tries
   * them in order and takes the first that hits the catalogue, so "spring framework" is
   * preferred over the bare "spring" it contains.
   */
  candidates: string[]
  /** A specific line the user named, e.g. "20" in "is Node 20 still supported". */
  cycle?: string
}

export interface ReleaseSolution {
  text: string
  /** The exact table row(s) the answer was computed from — provenance, not decoration. */
  evidence: Cycle[]
  product: string
  slug: string
  sourceUrl: string
  ask: ReleaseAsk
}

// ── Question parsing (deterministic, no model) ───────────────────────────────

/**
 * Words that are never part of a product name.
 *
 * MEASURED: the first cut of this parser SUBTRACTED these from the question and resolved
 * whatever prose was left. That is fragile in exactly the way you would expect — "when does
 * Node 24 reach end of life" left "when node reach", which resolves to nothing, and "whats
 * the node lts version" died on a missing apostrophe. The product is now found by scanning
 * the question's n-grams against the real 462-entry catalogue instead, so an unrecognised
 * filler word costs nothing. This list only has to keep obvious English words from being
 * TRIED as products; it no longer has to be exhaustive for correctness.
 */
const NON_PRODUCT = new Set([
  'what', 'whats', 'which', 'the', 'current', 'currently', 'latest', 'newest', 'most', 'recent',
  'now', 'today', 'active', 'still', 'does', 'do', 'did', 'is', 'are', 'was', 'has', 'have',
  'of', 'for', 'a', 'an', 'in', 'on', 'at', 'to', 'use', 'using', 'be', 'been', 'version',
  'versions', 'release', 'released', 'releases', 'line', 'branch', 'long', 'term', 'support',
  'supported', 'lts', 'end', 'life', 'eol', 'maintained', 'maintenance', 'security', 'update',
  'updates', 'available', 'out', 'number', 'when', 'reach', 'reaches', 'get', 'gets', 'getting',
  'receiving', 'receive', 'my', 'i', 'you', 'we', 'it', 'its', 'and', 'or', 'right', 'moment',
  'these', 'days', 'please', 'thanks', 'me', 'tell', 'know', 'there', 'any', 'that', 'this',
  'deprecated', 'stable', 'run', 'running', 'about', 'expire', 'expires', 'die', 'until',
])

/**
 * Classify the ask and extract the product. Returns null unless the question is
 * unmistakably about a software release line — this must not intercept "what is Node.js".
 */
export function parseReleaseQuery(raw: string): ReleaseQuery | null {
  const q = String(raw ?? '').trim()
  if (!q || q.length > 200) return null

  // The question must be about versions/lifecycle at all. "What is Node.js?" has none of
  // these and correctly falls through to the encyclopedia path.
  const mentionsLifecycle =
    /\b(lts|long[- ]term support|end[- ]of[- ]life|end of life|eol|version|release|supported|maintained|deprecat)/i.test(q)
  if (!mentionsLifecycle) return null

  // A "how do I upgrade / what changed in" question is not a lookup — leave it alone.
  if (/\b(how (?:do|to)|upgrade|migrate|install|changelog|what'?s new|difference between|compare|vs\.?)\b/i.test(q)) return null

  let ask: ReleaseAsk
  if (/\b(lts|long[- ]term support)\b/i.test(q)) ask = 'lts'
  else if (/\b(end[- ]of[- ]life|end of life|eol|when does .* (?:die|expire)|until when)\b/i.test(q)) ask = 'eol'
  else if (/\b(still (?:supported|maintained|getting|receiving)|is .* supported|out of support|security updates)\b/i.test(q)) ask = 'supported'
  else if (/\b(latest|current|newest|most recent|what version)\b/i.test(q)) ask = 'latest'
  else return null

  // A named line: "Node 20", "Python 3.9", "Ubuntu 22.04". Captured BEFORE the ask words are
  // stripped, because stripping can glue a number onto the wrong token.
  const cycleMatch = /\b(?:v|version\s+)?(\d+(?:\.\d+)?)\b/.exec(
    q.replace(/\b(http|ipv|utf|x)\s*\/?\d/gi, ' '),
  )

  // Tokens that could name a product: everything that is not obvious English filler and not
  // a bare version number. Keeps dots and pluses so "node.js" and "c++" survive intact.
  const tokens = q
    .toLowerCase()
    .replace(/\?+/g, ' ')
    .replace(/[^\w.+#\s-]/g, ' ')
    .split(/\s+/)
    .map(t => t.replace(/^[-.]+|[-.]+$/g, ''))
    .filter(t => t && !NON_PRODUCT.has(t) && !/^v?\d+(\.\d+)*$/.test(t))

  if (!tokens.length) return null

  // n-grams up to 3 words, longest first: "spring framework" must beat "spring".
  const candidates: string[] = []
  for (const size of [3, 2, 1]) {
    for (let i = 0; i + size <= tokens.length; i++) candidates.push(tokens.slice(i, i + size).join(' '))
  }

  return { ask, candidates: [...new Set(candidates)], cycle: cycleMatch ? cycleMatch[1] : undefined }
}

// ── Product resolution against the live catalogue ────────────────────────────

/** Hand-written aliases for names the slug list spells differently. Kept small on purpose:
 *  fuzzy matching covers the rest, and a long alias table is a maintenance liability. */
const ALIASES: Record<string, string> = {
  node: 'nodejs',
  'node.js': 'nodejs',
  nodejs: 'nodejs',
  java: 'oracle-jdk',
  jdk: 'oracle-jdk',
  openjdk: 'redhat-build-of-openjdk',
  '.net': 'dotnet',
  dotnet: 'dotnet',
  postgres: 'postgresql',
  k8s: 'kubernetes',
  docker: 'docker-engine',
  rails: 'rails',
  golang: 'go',
  'c#': 'dotnet',
  osx: 'macos',
  'mac os': 'macos',
  iphone: 'ios',
  'spring boot': 'spring-boot',
  vuejs: 'vue',
  'vue.js': 'vue',
  'next.js': 'nextjs',
  el: 'rhel',
  rhel: 'rhel',
}

const CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000
let catalogue: { at: number; slugs: string[] } | null = null

const productCache = new Map<string, { at: number; cycles: Cycle[] | null }>()
const PRODUCT_TTL_MS = 6 * 60 * 60 * 1000

async function getJson<T>(url: string, timeoutMs = 7000): Promise<T | null> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'Crucible/1.0 (local assistant)', Accept: 'application/json' },
    })
    if (!r.ok) return null
    return (await r.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

async function slugList(): Promise<string[]> {
  if (catalogue && Date.now() - catalogue.at < CATALOGUE_TTL_MS) return catalogue.slugs
  const slugs = await getJson<string[]>('https://endoflife.date/api/all.json', 9000)
  if (!Array.isArray(slugs) || slugs.length === 0) return catalogue?.slugs ?? []
  catalogue = { at: Date.now(), slugs }
  return slugs
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

/**
 * Map a user-written product name onto a catalogue slug.
 *
 * Exact/alias first, then normalized equality, then a guarded prefix match. The guard
 * matters: a bare `includes` maps "go" onto "google-kubernetes-engine" and "django" onto
 * nothing sensible. Only whole-segment matches count.
 */
export async function resolveProduct(nameRaw: string, slugs: string[]): Promise<string | null> {
  const name = nameRaw.toLowerCase().trim()
  if (ALIASES[name] && slugs.includes(ALIASES[name])) return ALIASES[name]

  const n = norm(name)
  if (!n) return null

  const exact = slugs.find(s => norm(s) === n)
  if (exact) return exact

  // Whole-segment match: "spring framework" -> "spring-framework"; "amazon eks" -> "amazon-eks".
  const words = name.split(/[\s.-]+/).filter(Boolean).map(norm).filter(Boolean)
  if (words.length > 1) {
    const joined = words.join('')
    const seg = slugs.find(s => norm(s) === joined)
    if (seg) return seg
  }

  // Last resort: a slug whose segments START with the name and which is not wildly longer.
  // "postgres" -> "postgresql" passes; "go" -> "google-..." is rejected by the length guard.
  const near = slugs
    .filter(s => norm(s).startsWith(n) && norm(s).length <= n.length + 4)
    .sort((a, b) => a.length - b.length)
  return near[0] ?? null
}

async function cyclesFor(slug: string): Promise<Cycle[] | null> {
  const hit = productCache.get(slug)
  if (hit && Date.now() - hit.at < PRODUCT_TTL_MS) return hit.cycles
  const data = await getJson<Cycle[]>(`https://endoflife.date/api/${encodeURIComponent(slug)}.json`, 9000)
  const cycles = Array.isArray(data) && data.length ? data : null
  productCache.set(slug, { at: Date.now(), cycles })
  return cycles
}

// ── The computation: pure functions of the table and today ───────────────────

/** endoflife.date encodes "no/never/already" as booleans and everything else as ISO dates. */
function dateFlag(v: boolean | string | undefined, today: string): { reached: boolean; date?: string } {
  if (v === undefined || v === null) return { reached: false }
  if (v === true) return { reached: true }
  if (v === false) return { reached: false }
  const d = String(v)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { reached: false }
  return { reached: d <= today, date: d }
}

const fmtDate = (d: string) => {
  const [y, m, day] = d.split('-')
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December']
  return `${MONTHS[Number(m) - 1]} ${Number(day)}, ${y}`
}

/** Cycles sort numerically-by-segment, newest first. "3.10" must outrank "3.9". */
function byCycleDesc(a: Cycle, b: Cycle): number {
  const seg = (c: string) => c.split('.').map(x => parseInt(x, 10) || 0)
  const [sa, sb] = [seg(a.cycle), seg(b.cycle)]
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const d = (sb[i] ?? 0) - (sa[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

const pretty = (slug: string) =>
  ({ nodejs: 'Node.js', dotnet: '.NET', php: 'PHP', ios: 'iOS', macos: 'macOS', rhel: 'RHEL',
     postgresql: 'PostgreSQL', mysql: 'MySQL', nginx: 'nginx', go: 'Go' } as Record<string, string>)[slug]
  ?? slug.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ')

export interface SolveOpts {
  /** ISO date to evaluate against. Injectable so the bench is hermetic. */
  today?: string
  /** Injectable table, so the bench never touches the network. */
  fetchCycles?: (slug: string) => Promise<Cycle[] | null>
  fetchSlugs?: () => Promise<string[]>
}

/**
 * Answer a release/lifecycle question exactly, or return null.
 *
 * Every branch renders the concrete table row it used. That is the difference between this
 * and a model guess: the answer and its evidence are the same object.
 */
export async function solveRelease(raw: string, opts: SolveOpts = {}): Promise<ReleaseSolution | null> {
  const parsed = parseReleaseQuery(raw)
  if (!parsed) return null

  const today = opts.today ?? new Date().toISOString().slice(0, 10)
  const slugs = await (opts.fetchSlugs ?? slugList)()
  if (!slugs.length) return null

  let slug: string | null = null
  for (const cand of parsed.candidates) {
    slug = await resolveProduct(cand, slugs)
    if (slug) break
  }
  if (!slug) return null

  const cycles = await (opts.fetchCycles ?? cyclesFor)(slug)
  if (!cycles || !cycles.length) return null

  const name = pretty(slug)
  const sourceUrl = `https://endoflife.date/${slug}`
  const sorted = [...cycles].sort(byCycleDesc)
  const base = { product: name, slug, sourceUrl, ask: parsed.ask }

  // A line the user named explicitly ("is Node 20 still supported").
  const named = parsed.cycle
    ? sorted.find(c => c.cycle === parsed.cycle)
      // "Node 20" should also match a "20.x"-style cycle string.
      ?? sorted.find(c => c.cycle.split('.')[0] === parsed.cycle!.split('.')[0])
    : undefined

  if (parsed.ask === 'supported' || (parsed.ask === 'eol' && named)) {
    if (!named) return null
    const eol = dateFlag(named.eol, today)
    const line = `${name} ${named.cycle}`
    if (parsed.ask === 'eol') {
      const text = eol.date
        ? `**${line}** reaches end of life on **${fmtDate(eol.date)}**${eol.reached ? ' — that date has passed, so it is no longer supported.' : '.'}`
        : eol.reached
          ? `**${line}** is already **end of life** and no longer supported.`
          : `**${line}** has no published end-of-life date yet.`
      return { ...base, text: `${text}\n\nSource: ${sourceUrl}`, evidence: [named] }
    }
    const text = eol.reached
      ? `No — **${line}** is **end of life**${eol.date ? ` (since ${fmtDate(eol.date)})` : ''} and no longer receives updates.`
      : `Yes — **${line}** is still supported${eol.date ? `, until **${fmtDate(eol.date)}**` : ''}.${named.latest ? ` The current release on that line is **${named.latest}**.` : ''}`
    return { ...base, text: `${text}\n\nSource: ${sourceUrl}`, evidence: [named] }
  }

  if (parsed.ask === 'lts') {
    // Active LTS: the LTS flag has arrived AND end of life has not.
    const active = sorted.filter(c => dateFlag(c.lts, today).reached && !dateFlag(c.eol, today).reached)
    if (!active.length) {
      // Distinguish "this product has no LTS concept" from "we could not tell" — the first is
      // a real answer, the second must abstain.
      const hasLtsConcept = cycles.some(c => c.lts !== undefined && c.lts !== false)
      if (!hasLtsConcept) {
        return { ...base, text: `**${name}** does not publish long-term-support release lines.\n\nSource: ${sourceUrl}`, evidence: [] }
      }
      return null
    }
    const cur = active[0]
    const eol = dateFlag(cur.eol, today)
    // Some products (Ubuntu) publish `latest` identical to the cycle, so naming both reads
    // as "the 26.04 line, whose newest release is 26.04". Only add it when it says something.
    const showLatest = cur.latest && cur.latest !== cur.cycle
    const bits = [
      `The current **${name} LTS** line is **${cur.cycle}**${showLatest ? `, and the newest release on it is **${cur.latest}**` : ''}.`,
    ]
    if (eol.date) bits.push(`It is supported until **${fmtDate(eol.date)}**.`)
    const older = active.slice(1).map(c => c.cycle)
    if (older.length) bits.push(`Still-maintained older LTS line${older.length > 1 ? 's' : ''}: ${older.join(', ')}.`)
    // The newest line overall, when it is NOT the LTS one, is the single most common
    // follow-up question — answering it here costs nothing and prevents a wrong upgrade.
    const newest = sorted[0]
    if (newest && newest.cycle !== cur.cycle && !dateFlag(newest.eol, today).reached) {
      bits.push(`(${name} ${newest.cycle} is newer but not LTS${newest.latest ? `; latest ${newest.latest}` : ''}.)`)
    }
    return { ...base, text: `${bits.join(' ')}\n\nSource: ${sourceUrl}`, evidence: [cur] }
  }

  // ask === 'latest'
  const live = sorted.filter(c => !dateFlag(c.eol, today).reached)
  const cur = live[0] ?? sorted[0]
  if (!cur) return null
  const eol = dateFlag(cur.eol, today)
  const bits = [
    cur.latest
      ? `The latest **${name}** release is **${cur.latest}** (the ${cur.cycle} line).`
      : `The latest **${name}** release line is **${cur.cycle}**.`,
  ]
  if (cur.latestReleaseDate) bits.push(`Released ${fmtDate(cur.latestReleaseDate)}.`)
  if (eol.date) bits.push(`Supported until **${fmtDate(eol.date)}**.`)
  return { ...base, text: `${bits.join(' ')}\n\nSource: ${sourceUrl}`, evidence: [cur] }
}
