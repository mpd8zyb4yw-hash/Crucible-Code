// Step 3 — Academic Retrieval Lane
// Parallel source lookup for math/reasoning/science queries using free, keyless APIs.
// Runs concurrently with web grounding (A3) in the pre-Stage-1 block.
//
// Sources:
//   arXiv   — free REST API (export.arxiv.org/api), no key, covers CS/math/physics/bio
//   Semantic Scholar — free public API (api.semanticscholar.org), 100 req/5min unauthed
//
// Falls through silently on any network error or empty result.

import https from 'https'

export type AcademicSource = 'arxiv' | 'semanticscholar'

export interface AcademicResult {
  title: string
  abstract: string     // truncated to 300 chars
  source: AcademicSource
  url: string
}

export interface AcademicGrounding {
  results: AcademicResult[]
  query: string
}

// Prompt types that benefit from academic grounding
const ACADEMIC_TYPES = new Set(['math', 'reasoning', 'factual'])

export function shouldGroundAcademic(promptType: string, message: string): boolean {
  if (!ACADEMIC_TYPES.has(promptType)) return false
  // Must look like a conceptual question, not a simple calculation or factoid
  return message.length > 40 && /\b(how|why|what|explain|prove|derive|theory|algorithm|approach|method|model|paper|research|study|formula|concept|principle)\b/i.test(message)
}

function httpsGet(url: string, timeout = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Crucible/1.0' } }, res => {
      let data = ''
      res.on('data', (chunk: Buffer) => { data += chunk })
      res.on('end', () => resolve(data))
    })
    req.on('error', reject)
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')) })
  })
}

// Semantic Scholar keyword search — returns top result abstract
async function fetchSemanticScholar(query: string): Promise<AcademicResult | null> {
  try {
    const encoded = encodeURIComponent(query)
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encoded}&limit=1&fields=title,abstract,url`
    const raw = await httpsGet(url, 5000)
    const data = JSON.parse(raw)
    const paper = data?.data?.[0]
    if (!paper?.abstract) return null
    return {
      title: paper.title || '',
      abstract: (paper.abstract as string).slice(0, 300),
      source: 'semanticscholar',
      url: paper.url || `https://www.semanticscholar.org/search?q=${encoded}`,
    }
  } catch {
    return null
  }
}

// arXiv Atom feed search — returns top result abstract
async function fetchArXiv(query: string): Promise<AcademicResult | null> {
  try {
    const encoded = encodeURIComponent(query)
    const url = `https://export.arxiv.org/api/query?search_query=all:${encoded}&start=0&max_results=1`
    const raw = await httpsGet(url, 5000)
    // Parse summary from Atom XML (avoid xml parser dependency — just regex)
    const titleMatch = raw.match(/<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/)
    const summaryMatch = raw.match(/<summary>([\s\S]*?)<\/summary>/)
    const idMatch = raw.match(/<id>(https?:\/\/arxiv\.org\/abs\/[^<]+)<\/id>/)
    if (!summaryMatch) return null
    const summary = summaryMatch[1].replace(/\s+/g, ' ').trim()
    if (summary.length < 30) return null
    return {
      title: titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '',
      abstract: summary.slice(0, 300),
      source: 'arxiv',
      url: idMatch ? idMatch[1] : `https://arxiv.org/search/?query=${encoded}`,
    }
  } catch {
    return null
  }
}

/**
 * Run both academic sources in parallel and return up to 2 results (one per source).
 * Returns null if nothing useful found.
 */
export async function groundAcademic(query: string, promptType: string): Promise<AcademicGrounding | null> {
  if (!shouldGroundAcademic(promptType, query)) return null

  // Trim query to a focused search phrase (first 80 chars, stop at sentence boundary)
  const searchQuery = query.slice(0, 80).replace(/[?.!]+$/, '').trim()

  const [ss, ax] = await Promise.all([
    fetchSemanticScholar(searchQuery).catch(() => null),
    fetchArXiv(searchQuery).catch(() => null),
  ])

  const results = [ss, ax].filter((r): r is AcademicResult => r !== null)
  if (results.length === 0) return null
  return { results, query: searchQuery }
}

/**
 * Build the academic context block injected into Stage 1 system prompts.
 */
export function buildAcademicBlock(grounding: AcademicGrounding): string {
  const lines = grounding.results.map(r => {
    const src = r.source === 'arxiv' ? 'arXiv' : 'Semantic Scholar'
    const title = r.title ? `"${r.title}" ` : ''
    return `[${src}] ${title}${r.abstract}...`
  })
  return (
    `[ACADEMIC CONTEXT — retrieved for this query]\n` +
    lines.join('\n\n') +
    `\n\nUse these as reference anchors where relevant. Prioritize them over training-data recall for technical claims.`
  )
}
