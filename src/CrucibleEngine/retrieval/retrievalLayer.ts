// Internet Retrieval Layer — Tier 1.3 (mission). The PRIMARY grounding mechanism
// for the local FM's knowledge gaps.
//
// The internet is fully permitted, but accessed DIRECTLY by Crucible's own tooling
// (node `https`, the same way webGrounding/academicRetrieval already work) — never
// routed through an external model, never a paid API. The FM never sees a raw
// search-result dump: retrieved content runs through a pre-processing pipeline
// (strip boilerplate → extract code blocks + type signatures → rank by relevance →
// fit to a hard context budget) before it reaches the spec window.
//
// This directly attacks hallucinated imports, wrong API signatures, stale type
// knowledge, and framework-entangled specs the FM was previously flying blind on.
//
// Failure is always graceful: every network path is wrapped so a timeout or a dead
// host yields empty results, never a thrown error into the synthesis pipeline.

import https from 'https'
import http from 'http'
import type { RouterTask } from '../router/capabilityRouter'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SearchResult {
  url: string
  title: string
  snippet: string
}

export interface CodeBlock {
  code: string
  lang?: string
  source?: string
}

export interface RankedResult<T> {
  item: T
  /** Relevance score in [0, 1] against the task. */
  score: number
}

/** Everything retrieval surfaces for one task, pre-processed and budget-fit. */
export interface RetrievalBundle {
  /** Clean block ready to prepend to the FM spec. Empty if nothing useful found. */
  block: string
  /** URLs consulted, for the audit trail / honest sourcing. */
  sources: string[]
  codeBlocks: CodeBlock[]
  typeSignatures: string[]
}

// ── Session cache ────────────────────────────────────────────────────────────────
// Process-lifetime cache keyed by request, so repeated fetches within a session
// (common: the same package's d.ts referenced by several DAG nodes) hit memory.

const pageCache = new Map<string, string>()
const searchCache = new Map<string, SearchResult[]>()
const typeDefCache = new Map<string, string>()

/** Clear all caches (test isolation / long-running sessions). */
export function clearCache(): void {
  pageCache.clear(); searchCache.clear(); typeDefCache.clear()
}

// ── Low-level fetch (direct https/http, redirect-following, timeout) ─────────────

const UA = 'Crucible/1.0 (+offline-first grounding)'
// Search engines and many docs sites reject non-browser User-Agents (this is why the
// DuckDuckGo HTML endpoint returned nothing on burst requests — the "Crucible/1.0" UA
// got challenged/blocked). Web search + page fetch present as a real browser; internal
// keyless APIs (unpkg, wikipedia) keep the honest Crucible UA.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
const MAX_BODY = 1_500_000  // 1.5 MB cap per page — defends against pathological dumps

function rawGet(url: string, timeout = 6000, redirectsLeft = 4, ua = UA): Promise<string> {
  return new Promise((resolve, reject) => {
    let mod: typeof https | typeof http
    try { mod = url.startsWith('http://') ? http : https } catch { reject(new Error('bad url')); return }
    const headers: Record<string, string> = {
      'User-Agent': ua,
      'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    }
    const req = mod.get(url, { headers }, res => {
      const status = res.statusCode ?? 0
      // Follow redirects (npm/unpkg/DefinitelyTyped all redirect heavily).
      if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        resolve(rawGet(next, timeout, redirectsLeft - 1, ua))
        return
      }
      if (status < 200 || status >= 300) { res.resume(); reject(new Error(`HTTP ${status}`)); return }
      let body = ''
      res.setEncoding('utf-8')
      res.on('data', chunk => {
        body += chunk
        if (body.length > MAX_BODY) { req.destroy(); resolve(body.slice(0, MAX_BODY)) }
      })
      res.on('end', () => resolve(body))
    })
    req.on('error', reject)
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')) })
  })
}

// ── Capability: web search ───────────────────────────────────────────────────────
// Multi-backend, keyless, graceful. The single-backend DDG-HTML design blocked on
// burst (non-browser UA) and fell back to Wikipedia — which returns off-topic garbage
// for non-encyclopedic queries (a React question surfaced "Firefighting"). This engine:
//   1. presents a real browser UA (unblocks DDG),
//   2. tries several independent backends until one yields RELEVANT results,
//   3. relevance-gates every backend (drops a whole backend whose results share no
//      salient query token — the firefighting case),
//   4. only falls to Wikipedia for NON-coding factual queries (right corpus).

// Coding / docs queries — Wikipedia is the wrong corpus for these; keep them on the
// general web backends (which surface MDN / StackOverflow / official docs).
const CODING_QUERY = /\b(function|method|class(?:es)?|api|sdk|library|framework|npm|yarn|pnpm|package|import|export|module|usestate|useeffect|hook|component|prop|jsx|tsx|async|await|promise|callback|regex|regexp|array|string|object|integer|boolean|typescript|javascript|python|rust|go(?:lang)?|java|kotlin|swift|c\+\+|c#|react|vue|angular|svelte|next\.?js|node|deno|express|django|flask|css|scss|html|dom|sql|query|schema|migration|error|exception|stack ?trace|traceback|compile|syntax|variable|const|let|var|def|lambda|closure|iterator|generator|decorator|annotation|type ?hint|interface|enum|struct|pointer|null|undefined|nan|git|docker|kubernetes|webpack|vite|eslint|pytest|jest)\b/i

export function isCodingQuery(q: string): boolean {
  return CODING_QUERY.test(q)
}

// Salient tokens = query words that carry topic meaning (drop interrogatives/stopwords).
const REL_STOP = new Set(
  ('what is are how does do did why who whom when where the of for a an in on at to with ' +
   'was were be been being and or vs versus than then explain describe tell me about give ' +
   'show list which that this it its their there here can could would should will may might ' +
   'must do i you we they he she into from as by not no yes some any all more most much many ' +
   'good best better right now please help need want get make use using used one two').split(/\s+/),
)
function salientTokens(query: string): string[] {
  const toks = (query.toLowerCase().match(/[a-z0-9][a-z0-9.+#_-]{1,}/g) ?? [])
    .filter(t => t.length >= 3 && !REL_STOP.has(t))
  return [...new Set(toks)]
}

// Reject an entire backend result set that shares no salient token with the query
// (off-topic garbage). Keep every result carrying ≥1 salient token; if none carry any
// but SOME backend token overlap exists, keep the set (broad/entity queries score low).
function relevanceGate(results: SearchResult[], query: string): SearchResult[] {
  const sal = salientTokens(query)
  if (sal.length === 0 || results.length === 0) return results
  const scored = results.map(r => {
    const hay = `${r.title} ${r.snippet} ${r.url}`.toLowerCase()
    return { r, hits: sal.filter(t => hay.includes(t)).length }
  })
  const maxHits = Math.max(...scored.map(s => s.hits))
  if (maxHits === 0) return []            // whole backend is off-topic → discard it
  return scored.filter(s => s.hits >= 1).map(s => s.r)
}

// A backend that returned an anti-scrape challenge / empty shell should be treated as a
// miss so the next backend gets a turn.
async function ddgHtml(query: string): Promise<SearchResult[]> {
  const html = await rawGet(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, 8000, 4, BROWSER_UA)
  return parseDuckResults(html)
}
async function ddgLite(query: string): Promise<SearchResult[]> {
  const html = await rawGet(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, 8000, 4, BROWSER_UA)
  return parseDuckLite(html)
}
async function bing(query: string): Promise<SearchResult[]> {
  const html = await rawGet(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en&count=10`, 8000, 4, BROWSER_UA)
  return parseBing(html)
}

function isPackageQuery(q: string): boolean {
  return /\b(npm|yarn|pnpm|package|library|module|install|dependency|dependencies)\b/i.test(q)
}

export async function search(query: string): Promise<SearchResult[]> {
  const key = query.trim().toLowerCase()
  const cached = searchCache.get(key)
  if (cached) return cached

  const coding = isCodingQuery(query)
  let results: SearchResult[] = []

  // Domain-routed structured APIs FIRST (keyless, reliable, structured — SERP scraping
  // is dead: DDG/Bing/Mojeek/SearXNG all return 202/403/429/JS-shells to a server IP).
  if (coding) {
    try { results = await searchStackExchange(query) } catch { results = [] }
    if (isPackageQuery(query)) {
      try { results = dedupeByUrl([...results, ...await searchNpm(query)]) } catch { /* keep SE */ }
    }
    // Implementation-shaped queries ("build/clone/game/example X") want a WORKING codebase, not a
    // Q&A snippet. GitHub's repo-search API is a keyless, star-ranked, deterministic code corpus —
    // far more reliable than SERP scraping (which returns 202/JS-shells to a server IP) and the
    // only source that consistently surfaces full reference implementations. Repos lead so that
    // fetchGithubCode (raw file bodies) grounds the proposer with real code. See fetchGithubCode.
    if (wantsImplementation(query)) {
      try { results = dedupeByUrl([...await searchGithubRepos(query), ...results]) } catch { /* keep SE */ }
    }
  }
  // Wikipedia REST — the general/factual catch-all (huge index, structured, keyless).
  if (results.length === 0) {
    try { results = await searchWikipediaRest(query) } catch { results = [] }
  }
  // Best-effort open-web scrapers LAST — usually blocked, but free when they work. The
  // relevance gate discards anti-bot challenge shells (202 pages with no result markup).
  if (results.length === 0) {
    for (const backend of [ddgHtml, bing, ddgLite]) {
      try {
        const rel = relevanceGate(await backend(query), query)
        if (rel.length > 0) { results = rel; break }
      } catch { /* next backend */ }
    }
  }

  results = relevanceGate(results, query)
  searchCache.set(key, results)
  return results
}

function dedupeByUrl(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>()
  return results.filter(r => (seen.has(r.url) ? false : (seen.add(r.url), true)))
}

/** Whether a coding query wants a full working codebase (a repo) rather than a Q&A answer. */
function wantsImplementation(query: string): boolean {
  return /\b(build|make|create|implement|clone|game|full|example|project|app|boilerplate|starter|from scratch|demo)\b/i.test(query)
}

// GitHub repository-search API — a keyless, star-ranked, deterministic code corpus. For
// implementation-shaped queries this reliably surfaces real reference codebases that SERP
// scraping misses; fetchGithubCode then pulls their raw file bodies for grounding.
async function searchGithubRepos(query: string): Promise<SearchResult[]> {
  const api = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=6`
  const raw = await rawGet(api, 8000, 4, BROWSER_UA)
  const data = JSON.parse(raw) as any
  const items: any[] = data?.items ?? []
  return items.slice(0, 6).map(r => ({
    url: r.html_url,
    title: r.full_name ?? '',
    snippet: stripTags(r.description ?? '').slice(0, 300),
  }))
}

// StackExchange (StackOverflow) API — the right corpus for programming questions.
// Keyless; returns structured Q&A. We eager-fetch the highest-voted answer bodies for
// the top questions and cache them under the question URL so downstream fetch() returns
// the actual answer text, not a scraped (and often bot-blocked) SO page.
async function searchStackExchange(query: string): Promise<SearchResult[]> {
  const api = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=6&filter=withbody`
  const raw = await rawGet(api, 8000, 4, BROWSER_UA)
  const data = JSON.parse(raw) as any
  const items: any[] = data?.items ?? []
  if (items.length === 0) return []
  const results: SearchResult[] = items.slice(0, 6).map(it => ({
    url: it.link,
    title: decodeEntities(it.title ?? ''),
    snippet: stripTags(it.body ?? '').slice(0, 300),
  }))
  // Eager-cache top answers so fetch() has real content.
  const answerable = items.filter(i => (i.answer_count ?? 0) > 0).slice(0, 3)
  if (answerable.length) {
    try {
      const ids = answerable.map(i => i.question_id).join(';')
      const ansRaw = await rawGet(`https://api.stackexchange.com/2.3/questions/${ids}/answers?order=desc&sort=votes&site=stackoverflow&pagesize=6&filter=withbody`, 8000, 4, BROWSER_UA)
      const ansItems: any[] = (JSON.parse(ansRaw) as any)?.items ?? []
      const topByQ = new Map<number, string>()
      for (const a of ansItems) {
        if (!topByQ.has(a.question_id)) topByQ.set(a.question_id, stripBoilerplate(a.body ?? ''))
      }
      for (const it of answerable) {
        const ans = topByQ.get(it.question_id)
        if (ans && !pageCache.has(it.link)) {
          pageCache.set(it.link, `${decodeEntities(it.title ?? '')}\n\n${ans}`.slice(0, 8000))
        }
      }
    } catch { /* answers are a bonus; question excerpts already populate snippets */ }
  }
  return results
}

// npm registry search — for "what package does X" / dependency questions.
async function searchNpm(query: string): Promise<SearchResult[]> {
  const text = query.replace(/\b(npm|package|library|module|install|for|the|a|an|best|good)\b/gi, ' ').replace(/\s+/g, ' ').trim()
  const api = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text || query)}&size=5`
  const raw = await rawGet(api, 8000, 4, BROWSER_UA)
  const objs: any[] = (JSON.parse(raw) as any)?.objects ?? []
  return objs.slice(0, 5).map(o => {
    const p = o.package ?? {}
    return {
      url: p.links?.npm ?? `https://www.npmjs.com/package/${p.name}`,
      title: `${p.name}${p.version ? ` @${p.version}` : ''}`,
      snippet: `${p.description ?? ''}${p.keywords?.length ? ` (${p.keywords.slice(0, 6).join(', ')})` : ''}`.slice(0, 300),
    }
  })
}

function parseDuckResults(html: string): SearchResult[] {
  const out: SearchResult[] = []
  const anchorRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  const snippets: string[] = []
  let s: RegExpExecArray | null
  while ((s = snippetRe.exec(html)) !== null) snippets.push(stripTags(s[1]))
  let m: RegExpExecArray | null
  let i = 0
  while ((m = anchorRe.exec(html)) !== null && out.length < 10) {
    out.push({ url: decodeDuckUrl(m[1]), title: stripTags(m[2]), snippet: snippets[i] ?? '' })
    i++
  }
  return out
}

// DuckDuckGo Lite — a stripped table layout with a different result markup than the
// HTML endpoint, so it survives markup changes / blocks on the primary.
function parseDuckLite(html: string): SearchResult[] {
  const out: SearchResult[] = []
  const linkRe = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snipRe = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g
  const snips: string[] = []
  let s: RegExpExecArray | null
  while ((s = snipRe.exec(html)) !== null) snips.push(stripTags(s[1]))
  let m: RegExpExecArray | null
  let i = 0
  while ((m = linkRe.exec(html)) !== null && out.length < 10) {
    const url = decodeDuckUrl(m[1])
    if (/^https?:/.test(url)) { out.push({ url, title: stripTags(m[2]), snippet: snips[i] ?? '' }); i++ }
  }
  return out
}

// Bing organic results — independent index, more lenient to scraping than DDG on burst.
function parseBing(html: string): SearchResult[] {
  const out: SearchResult[] = []
  const blockRe = /<li class="b_algo"[\s\S]*?<h2>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>([\s\S]*?)<\/li>/g
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(html)) !== null && out.length < 10) {
    const url = m[1]
    if (!/^https?:/.test(url)) continue
    const snipM = m[3].match(/<p[^>]*>([\s\S]*?)<\/p>/)
    out.push({ url, title: stripTags(m[2]), snippet: snipM ? stripTags(snipM[1]) : '' })
  }
  return out
}

// DDG wraps real URLs in a redirect (/l/?uddg=<encoded>). Unwrap when present.
function decodeDuckUrl(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/)
  if (m) { try { return decodeURIComponent(m[1]) } catch { /* fall through */ } }
  return href.startsWith('//') ? `https:${href}` : href
}

// Wikipedia REST search — keyless, structured JSON. The REST search/page endpoint ranks
// on relevance far better than the legacy list=search full-text API (which returned
// "Air cycle machine" for "water cycle"). We eager-fetch a fuller plaintext extract for
// the top result so downstream fetch() returns real article content, not just an intro.
// Interrogative preamble ("how does … work", "what is …") dilutes Wikipedia's ranker so
// it matches on the wrong noun ("how does the water cycle WORK" ranked "Air cycle
// machine" over "Water cycle"). Reduce to the topical noun phrase for the encyclopedia
// lookup; StackOverflow (natural-language ranked) keeps the full query.
function encyclopedicQuery(q: string): string {
  const reduced = q
    .replace(/^\s*(how (?:do(?:es)?|did|can|would)|what(?:'s| is| are| was| were)|why (?:do(?:es)?|did|is|are|was|were)|when (?:did|does|do|is|was|were)|where (?:is|are|was|were)|who (?:is|was|are|were)|explain|describe|tell me about|give me|define|overview of)\b/i, '')
    .replace(/\b(work|works|working|happen|happens|explained|basics|exactly|actually|really)\b\s*\??\s*$/i, '')
    .replace(/\?+/g, ' ')
    .replace(/\b(the|a|an)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return reduced.length >= 3 ? reduced : q
}

async function searchWikipediaRest(query: string): Promise<SearchResult[]> {
  const q = encyclopedicQuery(query)
  const searchUrl = `https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(q)}&limit=6`
  const raw = await rawGet(searchUrl, 7000)
  const data = JSON.parse(raw) as any
  const pages: any[] = data?.pages ?? []
  if (pages.length === 0) return []

  const results: SearchResult[] = pages.slice(0, 6).map(p => {
    const title = p.title ?? ''
    const key = p.key ?? title.replace(/ /g, '_')
    return {
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(key)}`,
      title,
      snippet: stripTags(p.excerpt ?? p.description ?? ''),
    }
  })

  if (results[0]) {
    try {
      const extractUrl = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext&titles=${encodeURIComponent(pages[0].title)}&format=json&redirects=1&exchars=6000`
      const extractRaw = await rawGet(extractUrl, 7000)
      const extractData = JSON.parse(extractRaw) as any
      const pageObjs = extractData?.query?.pages ?? {}
      const page = Object.values(pageObjs)[0] as any
      if (page?.extract) {
        const text = stripTags(page.extract)
        if (!pageCache.has(results[0].url)) pageCache.set(results[0].url, text)
        results[0].snippet = text.slice(0, 300)
      }
    } catch { /* graceful */ }
  }
  return results
}

// ── Capability: page fetch ───────────────────────────────────────────────────────

export async function fetch(url: string): Promise<string> {
  const cached = pageCache.get(url)
  if (cached !== undefined) return cached
  let body = ''
  try { body = await rawGet(url, 8000, 4, BROWSER_UA) } catch { body = '' }
  pageCache.set(url, body)
  return body
}

// ── Capability: parse / extract ─────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&nbsp;': ' ',
}
function decodeEntities(s: string): string {
  return s.replace(/&(?:lt|gt|amp|quot|nbsp|#39|#x27);/g, e => ENTITIES[e] ?? e)
}
function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

/** Remove boilerplate (script/style/nav/header/footer) and return readable text. */
export function stripBoilerplate(html: string): string {
  const cleaned = html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  return stripTags(cleaned)
}

/** Extract code blocks from fetched HTML, boilerplate stripped, lang detected. */
export function extractCodeBlocks(html: string, source?: string): CodeBlock[] {
  const blocks: CodeBlock[] = []
  // <pre>…<code class="language-ts">…</code></pre> and bare <pre>/<code>.
  const preRe = /<pre[^>]*>([\s\S]*?)<\/pre>/gi
  let m: RegExpExecArray | null
  while ((m = preRe.exec(html)) !== null) {
    const inner = m[1]
    const langMatch = inner.match(/class="[^"]*language-([a-z0-9]+)/i) || m[0].match(/class="[^"]*language-([a-z0-9]+)/i)
    const code = stripTags(inner.replace(/<\/?code[^>]*>/gi, ''))
    if (code.length >= 12) blocks.push({ code, lang: langMatch?.[1]?.toLowerCase(), source })
  }
  return blocks
}

const EXT_LANG: Record<string, string> = { js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript', html: 'html', css: 'css', py: 'python' }

/**
 * GitHub-aware code extraction. A github.com repo/blob URL renders its code in a JS-built file
 * tree, so extractCodeBlocks (which only sees <pre>) gets NOTHING from the fetched shell — the
 * exact reason reference-implementation grounding was silently inert for "space invaders" (a repo)
 * and every other query whose best source is a repo. This resolves the URL to RAW file content
 * instead: a /blob/ URL maps directly to raw.githubusercontent.com; a repo root goes through the
 * keyless contents API, picks the largest real source files (skipping min/config/vendor noise),
 * and fetches their raw bodies. Best-effort — any failure returns []. Keyless GitHub API is
 * rate-limited (~60/hr/IP); results ride the same pageCache so repeats are free.
 */
export async function fetchGithubCode(url: string, maxFiles = 2): Promise<CodeBlock[]> {
  const langOf = (name: string) => EXT_LANG[(name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase()]
  const blob = url.match(/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+?)(?:[?#].*)?$/i)
  if (blob) {
    const raw = `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}/${blob[4]}`
    const code = await fetch(raw)
    return code && code.length >= 40 ? [{ code, lang: langOf(blob[4]), source: url }] : []
  }
  const repo = url.match(/github\.com\/([^/]+)\/([^/?#]+)/i)
  if (!repo) return []
  const owner = repo[1], name = repo[2].replace(/\.git$/i, '')

  type Entry = { type: string; name: string; size?: number; download_url?: string; url?: string }
  const listDir = async (apiUrl: string): Promise<Entry[]> => {
    try { const p = JSON.parse(await fetch(apiUrl)); return Array.isArray(p) ? p : [] } catch { return [] }
  }
  const sourceFiles = (items: Entry[]) => items
    .filter(f => f.type === 'file' && /\.(js|ts|jsx|tsx|html|py)$/i.test(f.name) && !/\.min\.|webpack|rollup|\.config\.|package(-lock)?\.json|vite/i.test(f.name))
    .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))

  const root = await listDir(`https://api.github.com/repos/${owner}/${name}/contents/`)
  let files = sourceFiles(root)
  // Many repos keep the real game in a source subdir (src/js/game/…), so a root listing yields
  // only a tiny loader or nothing. When root is thin, descend ONE level into the first common
  // source directory (one extra API call, best-effort) rather than grounding on a stub.
  const rootBest = files[0]?.size ?? 0
  if (rootBest < 1200) {
    const dir = root.find(f => f.type === 'dir' && /^(src|js|scripts|game|public|app|assets)$/i.test(f.name) && f.url)
    if (dir?.url) {
      const sub = sourceFiles(await listDir(dir.url))
      if ((sub[0]?.size ?? 0) > rootBest) files = sub
    }
  }

  const out: CodeBlock[] = []
  for (const f of files.slice(0, maxFiles)) {
    if (!f.download_url) continue
    const code = await fetch(f.download_url)
    if (code && code.length >= 40) out.push({ code, lang: langOf(f.name), source: `${url}/${f.name}` })
  }
  return out
}

/**
 * Extract TypeScript-style type signatures from text/d.ts content. These are the
 * highest-value grounding for fixing wrong API signatures — interfaces, type
 * aliases, function/declare signatures, exported class shapes.
 */
export function extractTypeSignatures(text: string): string[] {
  const sigs = new Set<string>()
  const patterns = [
    /export\s+(?:declare\s+)?interface\s+\w+[^{]*\{[^}]{0,400}\}/g,
    /export\s+(?:declare\s+)?type\s+\w+\s*=\s*[^;]{0,300};/g,
    /export\s+declare\s+function\s+\w+\s*\([^)]{0,300}\)\s*:\s*[^;{]{0,120}/g,
    /export\s+(?:declare\s+)?(?:abstract\s+)?class\s+\w+[^{]{0,200}/g,
    /declare\s+function\s+\w+\s*\([^)]{0,300}\)\s*:\s*[^;{]{0,120}/g,
  ]
  for (const p of patterns) {
    for (const m of text.matchAll(p)) {
      const sig = m[0].replace(/\s+/g, ' ').trim()
      if (sig.length >= 12) sigs.add(sig)
      if (sigs.size >= 40) break
    }
  }
  return [...sigs]
}

// ── Capability: npm / DefinitelyTyped type-definition pulling ────────────────────
// For any project dependency, pull its .d.ts so the FM sees real signatures. Tries
// the package's own bundled types first, then @types/<pkg> (DefinitelyTyped), via
// unpkg (keyless CDN, redirects to the latest version). Returns the raw d.ts text.

export async function fetchTypeDefs(pkg: string): Promise<string> {
  const cached = typeDefCache.get(pkg)
  if (cached !== undefined) return cached
  let dts = ''
  try {
    // 1. Package's own types: read package.json for the "types"/"typings" entry.
    const metaRaw = await rawGet(`https://unpkg.com/${pkg}/package.json`, 6000)
    let typesPath: string | null = null
    try { const meta = JSON.parse(metaRaw); typesPath = meta.types || meta.typings || null } catch { /* ignore */ }
    if (typesPath) {
      dts = await rawGet(`https://unpkg.com/${pkg}/${typesPath.replace(/^\.\//, '')}`, 6000).catch(() => '')
    }
    // 2. Fall back to DefinitelyTyped @types/<pkg>.
    if (!dts) {
      const scoped = pkg.startsWith('@') ? pkg.slice(1).replace('/', '__') : pkg
      dts = await rawGet(`https://unpkg.com/@types/${scoped}/index.d.ts`, 6000).catch(() => '')
    }
  } catch { dts = '' }
  typeDefCache.set(pkg, dts)
  return dts
}

// ── Pre-processing: relevance ranking ────────────────────────────────────────────

function tokenize(text: string): Map<string, number> {
  const vec = new Map<string, number>()
  const toks = (text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])
  for (const t of toks) vec.set(t, (vec.get(t) ?? 0) + 1)
  return vec
}
function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0, na = 0, nb = 0
  for (const [k, w] of a) { na += w * w; const bw = b.get(k); if (bw) dot += w * bw }
  for (const w of b.values()) nb += w * w
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

/**
 * Structural-quality score for a code snippet in [0, 1], independent of task relevance.
 * Pure token-cosine can rank a one-line import or a console-echo fragment above a real
 * function body (short strings share the query's few tokens densely). This rewards a
 * snippet that actually looks like a usable implementation: real definition structure,
 * a body, a sane length; it penalises fragments, prose-in-<pre>, and giant dumps.
 */
export function snippetQuality(code: string, lang?: string): number {
  const c = (code ?? '').trim()
  if (!c) return 0
  let q = 0
  // Definition structure — the strongest signal of a usable reference.
  if (/\b(function|const|let|var|class|def|async|export|public|private|fn)\b/.test(c)) q += 0.30
  if (/=>|\bfunction\b|\bdef\b/.test(c)) q += 0.15               // has a callable
  if (/\breturn\b|\byield\b/.test(c)) q += 0.15                  // produces a value
  if (/[{}();]/.test(c)) q += 0.10                               // code punctuation, not prose
  // Length sweet spot: enough to be a real impl, not a page dump. Peak ~40–1200 chars.
  const n = c.length
  if (n >= 40 && n <= 1200) q += 0.20
  else if (n < 40) q += n / 40 * 0.10                            // tiny fragment → partial
  else q += Math.max(0, 0.20 - (n - 1200) / 6000)               // decay past 1200
  // Language bonus: the code-editing path wants TS/JS references.
  if (lang && /^(ts|tsx|js|jsx|javascript|typescript)$/.test(lang)) q += 0.10
  // Prose-in-<pre> penalty: mostly words with sentence punctuation, little code.
  const wordish = (c.match(/\b[a-z]{3,}\b/gi) ?? []).length
  const symbolish = (c.match(/[{}();=<>[\]]/g) ?? []).length
  if (wordish > 8 && symbolish < wordish / 4) q -= 0.35
  // Stub penalty: a definition keyword with no body (no call, arrow, or block) is a
  // declaration/import line, not a usable reference — don't let the keyword bonus carry it.
  if (/\b(function|const|let|var|class|def)\b/.test(c) && !/[({]|=>/.test(c)) q -= 0.30
  return Math.max(0, Math.min(1, q))
}

/**
 * Pick the single most useful reference snippet for a task: combined task-relevance
 * (token cosine) and structural quality. Returns null when nothing clears a minimum
 * usefulness bar (so grounding leads with a real reference or none — never noise).
 */
export function selectBestSnippet(blocks: CodeBlock[], task: RouterTask): CodeBlock | null {
  if (!blocks.length) return null
  const ranked = rankByRelevance(blocks, task, b => b.code)
  let best: CodeBlock | null = null
  let bestScore = 0
  for (const { item, score } of ranked) {
    // Relevance and quality both matter; multiply so a snippet must be BOTH on-topic and
    // well-formed. A relevant fragment (high cosine, low quality) loses to a relevant impl.
    const combined = (0.35 + 0.65 * score) * snippetQuality(item.code, item.lang)
    if (combined > bestScore) { bestScore = combined; best = item }
  }
  return bestScore >= 0.12 ? best : null
}

/** Rank candidates by relevance to the task, highest first. Never throws. */
export function rankByRelevance<T>(
  results: T[],
  task: RouterTask,
  textOf: (item: T) => string = String,
): RankedResult<T>[] {
  const q = tokenize(`${task.goal} ${(task.targetFiles ?? []).join(' ')}`)
  return results
    .map(item => ({ item, score: cosine(q, tokenize(textOf(item))) }))
    .sort((a, b) => b.score - a.score)
}

// ── Orchestration: retrieve for a task, budget-fit, ready to inject ──────────────

export interface RetrieveOptions {
  /** Hard ceiling on the injected block size (chars). Default 3000. */
  budget?: number
  /** Max pages to fetch+parse. Default 3. */
  maxPages?: number
  /** Project dependencies whose type defs should be pulled (npm/DefinitelyTyped). */
  dependencies?: string[]
}

/**
 * Full retrieval for one task: search → fetch top pages → extract code blocks +
 * type signatures → pull dependency type defs → rank against the task → fit to the
 * FM context budget. Returns a clean, sourced block. The FM never sees a raw dump.
 */
export async function retrieveForTask(task: RouterTask, opts: RetrieveOptions = {}): Promise<RetrievalBundle> {
  const budget = opts.budget ?? 3000
  const maxPages = opts.maxPages ?? 3
  const empty: RetrievalBundle = { block: '', sources: [], codeBlocks: [], typeSignatures: [] }

  const hits = await search(task.goal)
  const sources: string[] = []
  let codeBlocks: CodeBlock[] = []
  let typeSignatures: string[] = []

  // Fetch + parse the top pages (ranked by snippet relevance to the task), but FETCH-PRIORITIZE
  // hosts we can reliably extract code from. Relevance ranking alone floats JS-gated tutorial
  // hosts (codepen, dev.to) whose fetched HTML is an empty shell to the top — so with a small
  // maxPages the GitHub repos that DO yield raw code never get fetched. A stable partition keeps
  // relevance order within each group while pulling extractable sources forward.
  const EXTRACTABLE_HOST = /github\.com\/|githubusercontent\.com\/|gist\.github\.com\/|stackoverflow\.com\/|api\.stackexchange/i
  const relevanceRanked = rankByRelevance(hits, task, h => `${h.title} ${h.snippet}`).map(r => r.item)
  const ranked = [
    ...relevanceRanked.filter(u => EXTRACTABLE_HOST.test(u.url)),
    ...relevanceRanked.filter(u => !EXTRACTABLE_HOST.test(u.url)),
  ].slice(0, maxPages).map(item => ({ item }))
  for (const { item } of ranked) {
    // GitHub repo/blob URLs render their code in a JS file tree, invisible to <pre> extraction —
    // resolve them to raw file bodies instead (the highest-signal reference source for "build X").
    if (/github\.com\//i.test(item.url)) {
      const gh = await fetchGithubCode(item.url)
      if (gh.length) { sources.push(item.url); codeBlocks.push(...gh); continue }
    }
    const html = await fetch(item.url)
    if (!html) continue
    sources.push(item.url)
    codeBlocks.push(...extractCodeBlocks(html, item.url))
    typeSignatures.push(...extractTypeSignatures(stripBoilerplate(html)))
  }

  // Pull dependency type defs directly (highest-signal grounding).
  for (const dep of opts.dependencies ?? []) {
    const dts = await fetchTypeDefs(dep)
    if (dts) {
      typeSignatures.push(...extractTypeSignatures(dts))
      sources.push(`npm:${dep}`)
    }
  }

  // Rank extracted artifacts against the task by COMBINED relevance × structural quality, so a
  // real function body leads over a same-token one-line fragment. The single best snippet is
  // surfaced first (weak proposers do best with one sharp reference, not a top-6 dump).
  codeBlocks = rankByRelevance(codeBlocks, task, c => c.code)
    .map(r => ({ item: r.item, score: (0.35 + 0.65 * r.score) * snippetQuality(r.item.code, r.item.lang) }))
    .sort((a, b) => b.score - a.score)
    .map(r => r.item)
    .slice(0, 6)
  typeSignatures = [...new Set(rankByRelevance(typeSignatures.map(s => ({ s })), task, x => x.s).map(r => r.item.s))].slice(0, 12)

  if (!codeBlocks.length && !typeSignatures.length) return { ...empty, sources }

  const block = budgetFit(buildRetrievalBlock({ block: '', sources, codeBlocks, typeSignatures }), budget)
  return { block, sources: [...new Set(sources)], codeBlocks, typeSignatures }
}

/** Compose a structured, FM-ready block from pre-processed artifacts. */
export function buildRetrievalBlock(bundle: Omit<RetrievalBundle, 'block'>): string {
  const lines: string[] = ['RETRIEVED CONTEXT (fetched directly from the internet, pre-processed — not a raw dump):']
  if (bundle.typeSignatures.length) {
    lines.push('Type signatures:')
    for (const s of bundle.typeSignatures) lines.push(`  ${s}`)
  }
  if (bundle.codeBlocks.length) {
    lines.push('Reference code (most relevant first — adapt the primary reference, do not copy blindly):')
    bundle.codeBlocks.forEach((c, i) => {
      const label = i === 0 ? 'PRIMARY REFERENCE' : 'additional'
      lines.push(`  // [${label}] ${c.lang ? `[${c.lang}] ` : ''}${c.source ?? ''}`)
      lines.push(c.code.split('\n').map(l => `  ${l}`).join('\n'))
    })
  }
  if (bundle.sources.length) lines.push(`Sources: ${[...new Set(bundle.sources)].join(', ')}`)
  return lines.join('\n')
}

function budgetFit(block: string, budget: number): string {
  if (block.length <= budget) return block
  return block.slice(0, budget).replace(/\n[^\n]*$/, '') + '\n  … (truncated to context budget)'
}
