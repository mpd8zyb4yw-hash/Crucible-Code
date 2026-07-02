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
const MAX_BODY = 1_500_000  // 1.5 MB cap per page — defends against pathological dumps

function rawGet(url: string, timeout = 6000, redirectsLeft = 4): Promise<string> {
  return new Promise((resolve, reject) => {
    let mod: typeof https | typeof http
    try { mod = url.startsWith('http://') ? http : https } catch { reject(new Error('bad url')); return }
    const req = mod.get(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/json,*/*' } }, res => {
      const status = res.statusCode ?? 0
      // Follow redirects (npm/unpkg/DefinitelyTyped all redirect heavily).
      if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        resolve(rawGet(next, timeout, redirectsLeft - 1))
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
// Multi-tier search: tries DuckDuckGo HTML first (keyless), falls back to
// Wikipedia search API (also keyless). Both are graceful — failures yield [].

export async function search(query: string): Promise<SearchResult[]> {
  const key = query.trim().toLowerCase()
  const cached = searchCache.get(key)
  if (cached) return cached

  // Tier A: DuckDuckGo HTML endpoint (keyless, no API key)
  let results: SearchResult[] = []
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    const html = await rawGet(url, 7000)
    results = parseDuckResults(html)
  } catch { results = [] }

  // Tier B: Wikipedia search API fallback (always keyless, very reliable)
  if (results.length === 0) {
    try {
      results = await searchWikipedia(query)
    } catch { results = [] }
  }

  searchCache.set(key, results)
  return results
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

// DDG wraps real URLs in a redirect (/l/?uddg=<encoded>). Unwrap when present.
function decodeDuckUrl(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/)
  if (m) { try { return decodeURIComponent(m[1]) } catch { /* fall through */ } }
  return href.startsWith('//') ? `https:${href}` : href
}

// Wikipedia search API — keyless, structured JSON, very reliable for factual queries.
// Uses full-text search (action=query&list=search) so it finds content not just titles.
async function searchWikipedia(query: string): Promise<SearchResult[]> {
  // Full-text search — finds articles containing the query, even if title differs
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&utf8=1&srlimit=5`
  const raw = await rawGet(searchUrl, 7000)
  const data = JSON.parse(raw) as any
  const hits = data?.query?.search ?? []
  if (hits.length === 0) return []

  const results: SearchResult[] = []
  for (const hit of hits.slice(0, 5)) {
    const title = hit.title ?? ''
    const snippet = stripTags(hit.snippet ?? '')
    const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`
    results.push({ url, title, snippet })
  }

  // Eagerly fetch the intro extract for the top result and cache it so
  // the subsequent fetch() call hits in-memory cache instead of doing another request.
  if (results[0]) {
    try {
      const extractUrl = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&titles=${encodeURIComponent(results[0].title)}&format=json&redirects=1&exchars=3000`
      const extractRaw = await rawGet(extractUrl, 7000)
      const extractData = JSON.parse(extractRaw) as any
      const pages = extractData?.query?.pages ?? {}
      const page = Object.values(pages)[0] as any
      if (page?.extract) {
        const text = stripTags(page.extract)
        if (!pageCache.has(results[0].url)) {
          pageCache.set(results[0].url, text)
        }
        // Richer snippet from the actual intro extract
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
  try { body = await rawGet(url, 7000) } catch { body = '' }
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

  // Fetch + parse the top pages (ranked by snippet relevance to the task).
  const ranked = rankByRelevance(hits, task, h => `${h.title} ${h.snippet}`).slice(0, maxPages)
  for (const { item } of ranked) {
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

  // Rank extracted artifacts against the task; keep the most relevant.
  codeBlocks = rankByRelevance(codeBlocks, task, c => c.code).map(r => r.item).slice(0, 6)
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
    lines.push('Reference code:')
    for (const c of bundle.codeBlocks) {
      lines.push(`  // ${c.lang ? `[${c.lang}] ` : ''}${c.source ?? ''}`)
      lines.push(c.code.split('\n').map(l => `  ${l}`).join('\n'))
    }
  }
  if (bundle.sources.length) lines.push(`Sources: ${[...new Set(bundle.sources)].join(', ')}`)
  return lines.join('\n')
}

function budgetFit(block: string, budget: number): string {
  if (block.length <= budget) return block
  return block.slice(0, budget).replace(/\n[^\n]*$/, '') + '\n  … (truncated to context budget)'
}
