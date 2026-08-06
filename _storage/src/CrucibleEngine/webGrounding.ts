// Live web-state injection (Track A3) — detects time-sensitive queries and
// injects a DuckDuckGo Instant Answer as a grounding block before Stage 1.
// Uses the free DDG /api.php endpoint — no API key, no rate limit signup.
// Tags synthesis as "grounded [date]" vs "from training data."

import https from 'https'

export const TIME_DEPENDENT_PATTERNS = [
  /\b(latest|current|now|today|this year|recent|newest|updated?)\b/i,
  /\b(price|cost|worth|value)\b.*\b(of|for)\b/i,
  /\b(who is|who are)\s+(the\s+)?(current|new|acting)\b/i,
  /\b(version|release|changelog|update)\b/i,
  /\bweather\b/i,
  /\b(is .* still|does .* still|are .* still)\b/i,
  /\b(ceo|president|prime minister|cto|head of)\b/i,
]

export function isTimeDependent(query: string): boolean {
  return TIME_DEPENDENT_PATTERNS.some(p => p.test(query))
}

export interface GroundingResult {
  summary: string    // 1-3 sentence DDG abstract
  source: string     // URL or source name
  grounded: boolean
}

// Fetch DuckDuckGo Instant Answer (zero-click API)
function ddgFetch(query: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(query)
    const url = `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`
    const req = https.get(url, { headers: { 'User-Agent': 'Crucible/1.0' } }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch { reject(new Error('DDG parse error')) }
      })
    })
    req.on('error', reject)
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('DDG timeout')) })
  })
}

// Run a grounding lookup. Returns null if nothing useful found.
export async function groundQuery(query: string): Promise<GroundingResult | null> {
  if (!isTimeDependent(query)) return null
  try {
    const data = await ddgFetch(query)
    // DDG returns AbstractText for article results, Answer for direct answers
    const text = data.Answer || data.AbstractText || ''
    const source = data.AnswerSource || data.AbstractSource || data.AbstractURL || 'DuckDuckGo'
    if (!text || text.length < 20) return null
    return {
      summary: text.slice(0, 300),
      source,
      grounded: true,
    }
  } catch {
    return null
  }
}

// Build the grounding block injected into Stage 1 prompts
export function buildGroundingBlock(result: GroundingResult, queryDate: string): string {
  return `[LIVE CONTEXT — ${queryDate}]\n${result.summary}\nSource: ${result.source}\n\nUse this as current ground truth where relevant. Your training data may be outdated.`
}
