// ============================================================================
// KEYLESS SOURCE FEDERATION — the fix for "the assistant only knows Wikipedia".
//
// WHY THIS EXISTS (measured 2026-08-03, `npm run dogfood:assistant`):
// `retrievalLayer.search()` routes coding queries to StackExchange/GitHub/npm and
// EVERYTHING ELSE to a single backend: Wikipedia REST. The open-web scrapers behind it
// (DDG/Bing) are dead — the file says so itself: "SERP scraping is dead: DDG/Bing/Mojeek/
// SearXNG all return 202/403/429/JS-shells to a server IP". So one keyless encyclopedia was
// the entire factual substrate of the product. Three measured consequences:
//
//   1. "What can you do for me?" was full-text searched against Wikipedia and answered with
//      a Utah Saints single and a Willie Nelson album — reported as verified.
//   2. researchDag abstained on BOTH research probes ("no source answered the question"):
//      a ~1.2k-char encyclopedia summary cannot support a specific technical claim.
//   3. Whole categories were simply unanswerable — weather, current events, papers,
//      dictionary definitions, live entity facts.
//
// THE SHAPE OF THE FIX (DOCTRINE §3.1 — manufacture quality, don't buy it): more and better
// GROUND TRUTH, not a bigger model. Every source here is keyless and free, so this costs
// nothing per call and is compliant with DOCTRINE §4 (no paid-tier or ToS-encumbered
// dependency in the base path).
//
// DESIGN RULES:
// - Every source is independent and fails CLOSED to an empty array, never a throw. One dead
//   API must never take down retrieval — that is exactly how we ended up Wikipedia-only.
// - Sources declare `when(query)` so the router can run only what is plausibly relevant.
//   Running eight APIs for "what is 2+2" is waste, not thoroughness.
// - `tier` records how directly the source answers, so the verifier downstream can weigh a
//   structured API fact above a prose snippet. Provenance is a doctrine obligation (§6.5).
// - Sources return `text` (full body) whenever the API gives it, not just a snippet. The
//   abstentions above were caused by thin bodies, not by missing results.
// ============================================================================

/** How directly a source answers. Higher binds tighter in the verifier. */
export type SourceTier =
  | 'structured'   // a typed API answering the question directly (weather, entity facts)
  | 'reference'    // curated encyclopedic/dictionary prose
  | 'scholarly'    // papers and abstracts
  | 'community'    // forum/news discussion — real signal, lower authority
  | 'web'          // open-web prose

export interface SourceDoc {
  url: string
  title: string
  /** Short preview. Always populated. */
  snippet: string
  /** Full body when the API provides one. This is what makes claims verifiable. */
  text?: string
  tier: SourceTier
  sourceId: string
  /** ISO date when the source exposes one — lets recency break ties. */
  date?: string
}

export interface Source {
  id: string
  tier: SourceTier
  /** Cheap predicate: is this source plausibly relevant to the query? */
  when: (q: string, intent: QueryIntent) => boolean
  run: (q: string, intent: QueryIntent) => Promise<SourceDoc[]>
}

// ── Query intent classification (deterministic, no model call) ────────────────

export type QueryIntent =
  | 'weather'
  | 'definition'
  | 'entity_fact'
  | 'academic'
  | 'tech_current'
  | 'geography'
  | 'general'

const RE = {
  weather: /\b(weather|forecast|temperature|rain|raining|snow|humidity|wind speed|how (?:hot|cold|warm))\b/i,
  definition: /\b(define|definition of|meaning of|what does .{1,40} mean|etymology)\b/i,
  academic: /\b(paper|papers|study|studies|research on|journal|doi|arxiv|preprint|meta-analysis|clinical trial|peer[- ]reviewed)\b/i,
  techCurrent: /\b(release|released|version|changelog|deprecated|latest|roadmap|benchmark|vulnerability|CVE)\b/i,
  geography: /\b(population of|capital of|currency of|area of|located in|borders|time ?zone)\b/i,
  entityFact: /\b(who is|who was|born|died|founded|net worth|CEO of|headquarters)\b/i,
}

export function classifyIntent(q: string): QueryIntent {
  if (RE.weather.test(q)) return 'weather'
  if (RE.definition.test(q)) return 'definition'
  if (RE.academic.test(q)) return 'academic'
  if (RE.geography.test(q)) return 'geography'
  if (RE.entityFact.test(q)) return 'entity_fact'
  if (RE.techCurrent.test(q)) return 'tech_current'
  return 'general'
}

// ── HTTP helper: keyless, timeout-bounded, never throws upward ────────────────
//
// MEASURED 2026-08-03: the Wikimedia family (Wikipedia + Wikidata) returns **HTTP 429** to
// this box under quite modest load. Because the old helper collapsed every non-200 into
// `null`, a 429 was indistinguishable from "the web has no answer" — so the product's ONLY
// factual source could vanish mid-session and the research DAG would dutifully report
// "no source answered the question". That is not a test artifact; it is a live defect that
// silently empties the assistant's knowledge base. Three things fix it, all required:
//
//   1. A descriptive User-Agent. Wikimedia's API etiquette asks for an identifying UA with a
//      contact; generic UAs get throttled hardest. Set CRUCIBLE_CONTACT to a real URL/email
//      when deploying — the default is honest about being unset.
//   2. Per-host request SERIALIZATION with a minimum interval. Bursting eight concurrent
//      calls at one host is what trips the limiter in the first place.
//   3. Retry with backoff on 429/503, and a shared response cache so a retried or repeated
//      question costs nothing (DOCTRINE §3.3 — cache like it's the product).

const CONTACT = process.env.CRUCIBLE_CONTACT || 'contact-not-configured'
const UA = `Crucible/1.0 (local assistant; ${CONTACT})`

/** Hosts that demand politeness. Requests to these are serialized per host. */
const POLITE_HOSTS = /(^|\.)(wikipedia|wikidata|wiktionary|wikimedia)\.org$/i
const MIN_INTERVAL_MS = 220

const hostQueue = new Map<string, Promise<unknown>>()
const lastHit = new Map<string, number>()

/** Serialize + space out requests to a polite host. Other hosts pass straight through. */
function scheduled<T>(host: string, fn: () => Promise<T>): Promise<T> {
  if (!POLITE_HOSTS.test(host)) return fn()
  const prev = hostQueue.get(host) ?? Promise.resolve()
  const next = prev.then(async () => {
    const since = Date.now() - (lastHit.get(host) ?? 0)
    if (since < MIN_INTERVAL_MS) await sleep(MIN_INTERVAL_MS - since)
    try { return await fn() } finally { lastHit.set(host, Date.now()) }
  })
  // Keep the chain alive even when a link rejects, or one failure wedges the host forever.
  hostQueue.set(host, next.catch(() => undefined))
  return next as Promise<T>
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

const RESPONSE_TTL_MS = 10 * 60 * 1000
const responseCache = new Map<string, { at: number; body: string | null }>()

const BACKOFF_MS = [400, 1200, 3000]

/** Raw GET with retry/backoff, politeness scheduling and caching. Returns null, never throws. */
async function getRaw(url: string, timeoutMs = 7000): Promise<string | null> {
  const cached = responseCache.get(url)
  if (cached && Date.now() - cached.at < RESPONSE_TTL_MS) return cached.body

  let host = ''
  try { host = new URL(url).host } catch { return null }

  const body = await scheduled(host, async () => {
    for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), timeoutMs)
      try {
        const r = await fetch(url, {
          signal: ac.signal,
          headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
        })
        // 429/503 are transient by definition — back off rather than reporting "no answer".
        if ((r.status === 429 || r.status === 503) && attempt < BACKOFF_MS.length) {
          const retryAfter = Number(r.headers.get('retry-after')) * 1000
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter, 5000)
            : BACKOFF_MS[attempt])
          continue
        }
        if (!r.ok) return null
        return await r.text()
      } catch {
        if (attempt < BACKOFF_MS.length) { await sleep(BACKOFF_MS[attempt]); continue }
        return null
      } finally {
        clearTimeout(t)
      }
    }
    return null
  })

  // Cache misses too (short TTL) so a hard-down host isn't hammered by every leaf question.
  responseCache.set(url, { at: Date.now(), body })
  if (responseCache.size > 500) responseCache.delete(responseCache.keys().next().value as string)
  return body
}

async function getJson<T = any>(url: string, timeoutMs = 7000): Promise<T | null> {
  const raw = await getRaw(url, timeoutMs)
  if (raw === null) return null
  try { return JSON.parse(raw) as T } catch { return null }
}

async function getText(url: string, timeoutMs = 7000): Promise<string | null> {
  return getRaw(url, timeoutMs)
}

const enc = encodeURIComponent

/** Strip the leading interrogative so encyclopedic indexes match on the SUBJECT.
 *  Kept local (retrievalLayer has its own) so this module stands alone. */
export function subjectOf(q: string): string {
  const reduced = q
    .replace(/^\s*(what(?:'s| is| are| was| were)|who (?:is|was|are|were)|when (?:did|does|do|is|was|were)|where (?:is|are|was|were)|why (?:do(?:es)?|did|is|are)|how (?:do(?:es)?|did|can|much|many)|tell me about|explain|define|describe)\b/i, '')
    .replace(/\?+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return reduced.length >= 3 ? reduced : q.replace(/\?+/g, ' ').trim()
}

// ── Wikipedia: full-text search + REAL article bodies for the top N ───────────
// The prior implementation extracted a body for results[0] ONLY, capped at 6000 chars.
// Every other result reached the verifier as a bare title, which is unverifiable by
// construction. Now the top 3 get full plaintext extracts, in parallel.

/**
 * Distinctive tokens worth trying as literal article titles: technical identifiers
 * (HTTP/3, Node.js, C++, IPv6) and capitalised proper nouns. Wikipedia's full-text search
 * ranks these poorly — measured, "main differences between HTTP/2 and HTTP/3" returned
 * "Transport Layer Security" and "URL redirection" ahead of the HTTP/3 article itself.
 * Boosting exact title matches is what puts the right article first.
 */
function titleCandidates(q: string): string[] {
  const out: string[] = []
  const technical = q.match(/\b[A-Za-z][\w.+#-]*(?:\/[\dx.]+|\.[a-z]{2,3}|\+\+|\d)\b/g) ?? []
  for (const t of technical) if (t.length >= 3) out.push(t)
  const proper = q.match(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*\b/g) ?? []
  for (const p of proper) if (!/^(What|Who|When|Where|Why|How|The|This|That)\b/.test(p)) out.push(p)
  return [...new Set(out)].slice(0, 4)
}

/** Full plaintext of one article. NEVER pass exchars — see the comment below. */
async function wikiExtract(title: string): Promise<string> {
  // MEASURED 2026-08-03: `exchars` is capped at **1,200** by the API, and exceeding it is a
  // WARNING, not an error — the request succeeds and silently returns a truncated body.
  // The pre-existing code asked for exchars=6000 and had been receiving 1,200 chars all
  // along, which is why researchDag abstained with "no source answered the question": a
  // 1.2k encyclopedia stub cannot support a specific technical claim. Omitting exchars
  // returns the WHOLE article (HTTP/3 -> 5.2k, Node.js -> 15.7k), and the HTTP/3 body then
  // contains both "QUIC" and "head-of-line blocking" — the exact evidence that was missing.
  // Do not reintroduce exchars, exintro or exsentences on this path.
  const ex = await getJson<any>(
    `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=${enc(title)}`,
    9000,
  )
  const page: any = Object.values(ex?.query?.pages ?? {})[0]
  return page?.extract ? String(page.extract) : ''
}

const wikipedia: Source = {
  id: 'wikipedia',
  tier: 'reference',
  when: () => true,
  run: async (q) => {
    const subject = subjectOf(q)
    const data = await getJson<any>(
      `https://en.wikipedia.org/w/rest.php/v1/search/page?q=${enc(subject)}&limit=6`,
    )
    const pages: any[] = data?.pages ?? []
    const candidates = titleCandidates(q)

    const docs: SourceDoc[] = pages.map((p) => ({
      url: `https://en.wikipedia.org/wiki/${enc(p.key ?? String(p.title ?? '').replace(/ /g, '_'))}`,
      title: String(p.title ?? ''),
      snippet: stripHtml(String(p.excerpt ?? p.description ?? '')),
      tier: 'reference' as const,
      sourceId: 'wikipedia',
    }))

    // Any distinctive token that search did NOT surface is tried as a literal title.
    for (const c of candidates) {
      if (docs.some(d => d.title.toLowerCase() === c.toLowerCase())) continue
      docs.push({
        url: `https://en.wikipedia.org/wiki/${enc(c.replace(/ /g, '_'))}`,
        title: c,
        snippet: '',
        tier: 'reference',
        sourceId: 'wikipedia',
      })
    }

    // Rank exact/near title matches for distinctive tokens first.
    const score = (d: SourceDoc) => {
      const t = d.title.toLowerCase()
      if (candidates.some(c => t === c.toLowerCase())) return 0
      if (candidates.some(c => t.includes(c.toLowerCase()))) return 1
      return 2
    }
    docs.sort((a, b) => score(a) - score(b))

    // Bodies for the top 3 only. Each is one Wikimedia call, and the politeness queue
    // serializes them — more than three turns a 1s query into a 429 storm.
    const top = docs.slice(0, 3)
    await Promise.all(top.map(async (d) => {
      const text = await wikiExtract(d.title)
      if (text) {
        d.text = text
        if (!d.snippet) d.snippet = text.slice(0, 300)
      }
    }))

    // A title guess that resolved to nothing is noise — drop it.
    return docs.filter(d => d.text || d.snippet)
  },
}

// ── Wiktionary: real definitions, not an encyclopedia article about the word ──

const wiktionary: Source = {
  id: 'wiktionary',
  tier: 'reference',
  when: (_q, intent) => intent === 'definition',
  run: async (q) => {
    const word = subjectOf(q).split(/\s+/).slice(0, 3).join(' ').replace(/[^\w' -]/g, '')
    if (!word) return []
    const data = await getJson<any>(
      `https://en.wiktionary.org/api/rest_v1/page/definition/${enc(word)}`,
    )
    if (!data || typeof data !== 'object') return []
    const out: string[] = []
    for (const [lang, entries] of Object.entries<any>(data)) {
      if (lang !== 'en') continue
      for (const e of entries ?? []) {
        for (const d of e.definitions ?? []) {
          const def = stripHtml(String(d.definition ?? ''))
          if (def) out.push(`(${e.partOfSpeech ?? '?'}) ${def}`)
        }
      }
    }
    if (!out.length) return []
    return [{
      url: `https://en.wiktionary.org/wiki/${enc(word)}`,
      title: `${word} — definition`,
      snippet: out[0].slice(0, 300),
      text: out.join('\n'),
      tier: 'reference',
      sourceId: 'wiktionary',
    }]
  },
}

// ── Wikidata: typed entity facts, the highest-authority tier we can get keyless ──

const wikidata: Source = {
  id: 'wikidata',
  tier: 'structured',
  when: (_q, intent) => intent === 'entity_fact' || intent === 'geography' || intent === 'general',
  run: async (q) => {
    const subject = subjectOf(q)
    const found = await getJson<any>(
      `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${enc(subject)}&language=en&format=json&limit=3&origin=*`,
    )
    const hits: any[] = found?.search ?? []
    if (!hits.length) return []
    return hits.slice(0, 3).map((h) => ({
      url: String(h.concepturi ?? `https://www.wikidata.org/wiki/${h.id}`),
      title: String(h.label ?? h.id),
      snippet: String(h.description ?? ''),
      text: [h.label, h.description].filter(Boolean).join(' — '),
      tier: 'structured' as const,
      sourceId: 'wikidata',
    })).filter(d => d.snippet || d.text)
  },
}

// ── Open-Meteo: weather. Keyless, no attribution burden, genuinely useful. ─────
// Weather was previously UNANSWERABLE — an extremely common assistant request.

const openMeteo: Source = {
  id: 'open-meteo',
  tier: 'structured',
  when: (_q, intent) => intent === 'weather',
  run: async (q) => {
    // Pull the place name: the token(s) after "in"/"for"/"at", else the trailing subject.
    const m = /\b(?:in|for|at)\s+([A-Za-z .'-]{2,40})/i.exec(q)
    const place = (m?.[1] ?? subjectOf(q).replace(RE.weather, '')).trim().replace(/\s+/g, ' ')
    if (!place) return []
    const geo = await getJson<any>(
      `https://geocoding-api.open-meteo.com/v1/search?name=${enc(place)}&count=1&language=en&format=json`,
    )
    const loc = geo?.results?.[0]
    if (!loc) return []
    const wx = await getJson<any>(
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,wind_speed_10m` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&forecast_days=3&timezone=auto`,
    )
    if (!wx?.current) return []
    const c = wx.current, u = wx.current_units ?? {}
    const label = [loc.name, loc.admin1, loc.country].filter(Boolean).join(', ')
    const lines = [
      `Current conditions for ${label} (${wx.timezone ?? 'local time'}), observed ${c.time}:`,
      `temperature ${c.temperature_2m}${u.temperature_2m ?? '°C'} (feels like ${c.apparent_temperature}${u.apparent_temperature ?? '°C'})`,
      `relative humidity ${c.relative_humidity_2m}${u.relative_humidity_2m ?? '%'}`,
      `precipitation ${c.precipitation}${u.precipitation ?? 'mm'}`,
      `wind speed ${c.wind_speed_10m}${u.wind_speed_10m ?? 'km/h'}`,
    ]
    const d = wx.daily
    if (d?.time?.length) {
      lines.push('Forecast:')
      for (let i = 0; i < d.time.length; i++) {
        lines.push(`  ${d.time[i]}: high ${d.temperature_2m_max[i]}, low ${d.temperature_2m_min[i]}, precipitation ${d.precipitation_sum[i]}`)
      }
    }
    return [{
      url: `https://open-meteo.com/?lat=${loc.latitude}&lon=${loc.longitude}`,
      title: `Weather for ${label}`,
      snippet: `${c.temperature_2m}${u.temperature_2m ?? '°C'}, feels like ${c.apparent_temperature}${u.apparent_temperature ?? '°C'}`,
      text: lines.join('\n'),
      tier: 'structured',
      sourceId: 'open-meteo',
      date: String(c.time ?? ''),
    }]
  },
}

// ── REST Countries: REMOVED 2026-08-03 ────────────────────────────────────────
// restcountries.com/v3.1 is DEPRECATED and now answers HTTP 200 with
// {"success":false,"errors":[{"message":"This API version has been deprecated..."}]}.
// A 200-with-an-error-body is the nastiest shape of dead dependency: every naive
// `if (!res.ok)` check passes it through. Geography is served by Wikipedia article
// bodies + Wikidata instead. Do not re-add a source without a live probe proving it
// returns real data — see __sources_probe.ts.

// ── Hacker News (Algolia): keyless, strong for tech currency and real opinions ──

const hackernews: Source = {
  id: 'hackernews',
  tier: 'community',
  when: (_q, intent) => intent === 'tech_current' || intent === 'general',
  run: async (q) => {
    // Algolia ANDs every term, so a full natural-language question matches nothing —
    // measured: "latest Node.js LTS version" returned 0 hits while "Node.js LTS" returned 5.
    // Keep the most distinctive few words and drop generic filler.
    const terms = subjectOf(q)
      .replace(/[^\w.#+\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !/^(the|and|for|with|what|how|why|latest|current|new|best|good|does|are|was)$/i.test(w))
      .slice(0, 4)
      .join(' ')
    if (!terms) return []
    const data = await getJson<any>(
      `https://hn.algolia.com/api/v1/search?query=${enc(terms)}&tags=story&hitsPerPage=5`,
    )
    const hits: any[] = data?.hits ?? []
    return hits
      .filter(h => h.title && (h.url || h.objectID))
      .map(h => ({
        url: String(h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`),
        title: String(h.title),
        snippet: `${h.points ?? 0} points, ${h.num_comments ?? 0} comments${h.created_at ? ` — ${String(h.created_at).slice(0, 10)}` : ''}`,
        text: String(h.story_text ?? h._highlightResult?.title?.value ?? h.title ?? '').replace(/<[^>]+>/g, ''),
        tier: 'community' as const,
        sourceId: 'hackernews',
        date: h.created_at ? String(h.created_at).slice(0, 10) : undefined,
      }))
  },
}

// ── arXiv: keyless scholarly preprints (Atom XML) ─────────────────────────────

const arxiv: Source = {
  id: 'arxiv',
  tier: 'scholarly',
  when: (_q, intent) => intent === 'academic',
  run: async (q) => {
    const xml = await getText(
      `http://export.arxiv.org/api/query?search_query=all:${enc(subjectOf(q))}&start=0&max_results=5`,
      9000,
    )
    if (!xml) return []
    const entries = xml.split('<entry>').slice(1)
    return entries.map((e) => {
      const pick = (tag: string) => {
        const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(e)
        return m ? stripHtml(m[1]) : ''
      }
      const idm = /<id>([\s\S]*?)<\/id>/.exec(e)
      return {
        url: idm ? idm[1].trim() : 'https://arxiv.org',
        title: pick('title'),
        snippet: pick('summary').slice(0, 300),
        text: pick('summary'),
        tier: 'scholarly' as const,
        sourceId: 'arxiv',
        date: pick('published').slice(0, 10) || undefined,
      }
    }).filter(d => d.title)
  },
}

// ── Crossref: keyless bibliographic metadata for published work ───────────────

const crossref: Source = {
  id: 'crossref',
  tier: 'scholarly',
  when: (_q, intent) => intent === 'academic',
  run: async (q) => {
    const data = await getJson<any>(
      `https://api.crossref.org/works?query=${enc(subjectOf(q))}&rows=5&select=title,abstract,URL,issued,container-title,author`,
    )
    const items: any[] = data?.message?.items ?? []
    return items.map((it) => {
      const title = Array.isArray(it.title) ? it.title[0] : String(it.title ?? '')
      const journal = Array.isArray(it['container-title']) ? it['container-title'][0] : ''
      const year = it.issued?.['date-parts']?.[0]?.[0]
      const abstract = stripHtml(String(it.abstract ?? ''))
      return {
        url: String(it.URL ?? ''),
        title,
        snippet: [journal, year].filter(Boolean).join(', ') || abstract.slice(0, 200),
        text: abstract || [title, journal, year].filter(Boolean).join(' — '),
        tier: 'scholarly' as const,
        sourceId: 'crossref',
        date: year ? String(year) : undefined,
      }
    }).filter(d => d.title && d.url)
  },
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export const SOURCES: Source[] = [
  wikidata, openMeteo, wiktionary, wikipedia, hackernews, arxiv, crossref,
]

export interface FederatedResult {
  intent: QueryIntent
  docs: SourceDoc[]
  /** Per-source outcome — visible so a dead backend is never silently invisible again. */
  ran: Array<{ id: string; count: number; ms: number }>
}

const TIER_RANK: Record<SourceTier, number> = {
  structured: 0, reference: 1, scholarly: 2, community: 3, web: 4,
}

/**
 * Run every applicable source concurrently and merge. Never throws.
 *
 * Ordering is by TIER first (a typed API fact outranks forum prose), then by whether the doc
 * carries a real body — a doc with no `text` cannot support a verified claim, so it sorts last
 * regardless of where it came from. That ordering is the whole reason the research DAG
 * abstained: it was handed title-only docs and correctly refused to certify them.
 */
export async function federatedSearch(
  query: string,
  opts: { maxDocs?: number; timeoutMs?: number } = {},
): Promise<FederatedResult> {
  const intent = classifyIntent(query)
  const maxDocs = opts.maxDocs ?? 12
  const applicable = SOURCES.filter((s) => {
    try { return s.when(query, intent) } catch { return false }
  })

  const settled = await Promise.all(
    applicable.map(async (s) => {
      const t0 = Date.now()
      try {
        const docs = await s.run(query, intent)
        return { id: s.id, docs: Array.isArray(docs) ? docs : [], ms: Date.now() - t0 }
      } catch {
        return { id: s.id, docs: [] as SourceDoc[], ms: Date.now() - t0 }
      }
    }),
  )

  const seen = new Set<string>()
  const docs: SourceDoc[] = []
  for (const r of settled) {
    for (const d of r.docs) {
      const key = d.url || `${d.sourceId}:${d.title}`
      if (seen.has(key)) continue
      seen.add(key)
      docs.push(d)
    }
  }

  docs.sort((a, b) => {
    const body = (d: SourceDoc) => (d.text && d.text.length > 80 ? 0 : 1)
    return (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (body(a) - body(b))
  })

  return {
    intent,
    docs: docs.slice(0, maxDocs),
    ran: settled.map(r => ({ id: r.id, count: r.docs.length, ms: r.ms })),
  }
}
