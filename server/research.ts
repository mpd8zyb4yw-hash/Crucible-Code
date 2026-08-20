import { chat, canSearch } from './providers.js'
import { route } from './router.js'
import { renderWorld, type World, type Observation } from './world.js'
import { parseLoose } from './think.js'
import { looksLikeProtocol } from './reply.js'
import { search as legacySearch } from './legacy/retrievalLayer.js'

/**
 * Curiosity.
 *
 * Being useful to someone requires knowing two very different kinds of thing,
 * and they have different sources:
 *
 *   - Things only HE can answer: whether he is trying to eat better, which
 *     shop he actually uses, whether he minds the bus. Asking is the only way.
 *   - Things the WORLD can answer: which days that village holds its market,
 *     what that chain is known for charging, when the last bus runs. Asking
 *     him is a waste of his time and he may well be wrong.
 *
 * Routing each gap to the right source is the difference between an assistant
 * that interrogates you and one that does its homework. The useful advice
 * usually needs one of each: knowing he wants to eat better is worthless
 * without knowing the market is on Monday, and vice versa.
 */

export interface Gap {
  question: string
  /** Who can answer this: him, or the open web. */
  who: 'user' | 'world'
  /** Why this matters — what advice would change if it were answered. */
  why: string
}

export interface Creds {
  providerId: string
  model: string
  key: string
}

const GAPS_SYSTEM = `You are the curiosity of a personal assistant. You are shown everything currently known about one person. Your job is to work out what you most need to learn next in order to give them advice they could not have reached alone.

Split what you want to know into two kinds:
- "user": only this person can answer. Preferences, intentions, constraints, habits, feelings, plans. Things with no public answer.
- "world": the open web can answer, and asking the person would be a waste of their time or would get an unreliable answer. Opening hours, market days, transport timetables, what a shop chain is known for, prices, local geography, regulations, deadlines.

Rules:
- Prefer questions whose answer would CHANGE your advice. Ignore trivia.
- A "world" question must be specific and searchable. "What is the local area like" is useless; "which days is the weekly market held in <place>" is answerable.
- If you know where someone lives, shops, works or travels, there is almost always something worth looking up about it. Be genuinely curious about their actual surroundings.
- Never ask the person something the web can tell you.
- At most 6 gaps. Return ONLY JSON: {"gaps":[{"question":"...","who":"user|world","why":"..."}]}`

const RESEARCH_SYSTEM = `You research the real world for a personal assistant. You are given one specific question and some context about whose life it concerns.

Search, then answer in 1-3 sentences of plain fact. Be concrete: name days, times, prices, distances, streets. If sources disagree or the answer is uncertain, say so rather than picking one. If you genuinely cannot find it, say "Not found" and nothing else — a confident wrong answer is far worse than an admission.

Do not give advice. Do not mention the person. State only what is true about the world.`

export async function proposeGaps(world: World, _creds?: Creds): Promise<Gap[]> {
  const out = await route('curiosity', {
    system: GAPS_SYSTEM,
    prompt: `${renderWorld(world)}\n\nToday is ${new Date().toISOString().slice(0, 10)}.\n\nWhat do you most need to learn next?`,
    json: true,
    maxTokens: 2048,
  })
  const parsed = parseLoose(out.text)
  return (Array.isArray(parsed?.gaps) ? parsed.gaps : [])
    .map((g: any) => ({
      question: String(g?.question ?? '').trim().slice(0, 200),
      who: g?.who === 'world' ? 'world' : 'user',
      why: String(g?.why ?? '').trim().slice(0, 200),
    }))
    .filter((g: Gap) => g.question)
    .slice(0, 6)
}

/**
 * Raw web results from a dedicated search API.
 *
 * Gemini's own grounding is the nicest path but is not on the free tier (it
 * returns 429 while ungrounded calls on the same key return 200), so research
 * must not be welded to one provider. Any of these keys makes it work; with
 * none of them the assistant simply reports questions as unanswered, which is
 * the correct degradation — never a guess dressed up as a finding.
 */
async function webSearch(query: string, keys: SearchKeys): Promise<{ text: string; sources: { title: string; uri: string }[] } | null> {
  try {
    // Keyless first: salvaged from the previous build's retrieval layer
    // (DuckDuckGo + Bing, graceful on every network path). Costs nothing and
    // needs no account, so it is the default rather than the fallback.
    const hits = await legacySearch(query)
    if (hits.length) {
      return {
        text: hits
          .slice(0, 6)
          .map((h: any) => `${h.title ?? ''}: ${String(h.snippet ?? h.description ?? '').replace(/\s+/g, ' ')}`)
          .join('\n'),
        sources: hits.slice(0, 6).map((h: any) => ({ title: String(h.title ?? ''), uri: String(h.url ?? h.link ?? '') })),
      }
    }
  } catch {
    /* fall through to keyed providers */
  }
  try {
    if (keys.brave) {
      const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`, {
        headers: { accept: 'application/json', 'x-subscription-token': keys.brave },
      })
      if (r.ok) {
        const b: any = await r.json()
        const hits = (b?.web?.results ?? []).slice(0, 5)
        if (hits.length) {
          return {
            text: hits.map((h: any) => `${h.title}: ${String(h.description ?? '').replace(/<[^>]*>/g, '')}`).join('\n'),
            sources: hits.map((h: any) => ({ title: String(h.title ?? ''), uri: String(h.url ?? '') })),
          }
        }
      }
    }
    if (keys.tavily) {
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: keys.tavily, query, max_results: 5, include_answer: true }),
      })
      if (r.ok) {
        const b: any = await r.json()
        const hits = (b?.results ?? []).slice(0, 5)
        const text = [b?.answer, ...hits.map((h: any) => `${h.title}: ${h.content}`)].filter(Boolean).join('\n')
        if (text) return { text, sources: hits.map((h: any) => ({ title: String(h.title ?? ''), uri: String(h.url ?? '') })) }
      }
    }
  } catch {
    /* fall through to unanswered */
  }
  return null
}

export interface SearchKeys {
  brave?: string
  tavily?: string
}

/**
 * Answer a world-gap by actually looking. Returns null when nothing can search
 * or the answer could not be found — an unanswered question is a fine outcome,
 * an invented answer is not.
 */
export async function researchGap(
  gap: Gap,
  world: World,
  /**
   * Only needed for provider-side grounded search. Both callers legitimately
   * have none, and dereferencing it threw a TypeError that the surrounding
   * catch swallowed as "not found" — so every lookup silently failed.
   */
  creds: Creds | undefined,
  searchKeys: SearchKeys = {}
): Promise<Observation | null> {
  const grounded = creds ? canSearch(creds.providerId) : false
  // Keyless web search is always available, so research is never disabled.
  const hasFallback = true
  void searchKeys

  const where = world.beliefs
    .map((b) => b.statement)
    .filter((s) => /live|based|home|village|town|city|work|shop/i.test(s))
    .slice(0, 4)
    .join(' ')

  const ctx = where ? `Context: ${where}\n\n` : ''
  let text = ''
  let sources: { title: string; uri: string }[] = []

  if (grounded && creds) {
    try {
      const out = await chat({ ...creds, system: RESEARCH_SYSTEM, prompt: `${ctx}Question: ${gap.question}`, search: true, maxTokens: 1024 })
      text = out.text.trim()
      sources = out.sources ?? []
    } catch {
      // Grounding unavailable (e.g. free-tier 429) — fall through to search API.
    }
  }

  if (!text && hasFallback) {
    const hits = await webSearch(gap.question, searchKeys)
    if (!hits) return null
    // The model reads the results; it never answers from memory here.
    // Summarising search results is easy, high-volume work — cheap model.
    const out = await route('research', {
      system: RESEARCH_SYSTEM,
      prompt: `${ctx}Question: ${gap.question}\n\nSearch results:\n${hits.text}\n\nAnswer using ONLY these results.`,
      maxTokens: 1024,
    })
    text = out.text.trim()
    sources = hits.sources
  }

  if (!text || /^not found\b/i.test(text)) return null
  /*
    A research answer becomes an OBSERVATION — evidence the synthesis pass reads
    and quotes back to him. So the same boundary applies here as in chat: a
    model that returned its envelope instead of an answer has not answered, and
    filing protocol as a fact about his life is how it later gets read out as
    one. Nothing found beats something malformed.
  */
  if (looksLikeProtocol(text)) return null

  const now = new Date()
  const cites = sources.slice(0, 3).map((s) => s.title).filter(Boolean)
  return {
    id: `res-${now.getTime().toString(36)}-${Math.abs(hash(gap.question)).toString(36).slice(0, 4)}`,
    source: 'research',
    at: now.toISOString().slice(0, 10),
    // The question is kept with the answer; a bare fact with no question
    // attached is much harder to judge the relevance of later.
    text: `Looked up "${gap.question}" — ${text}${cites.length ? ` [sources: ${cites.join('; ')}]` : ' [ungrounded — no sources returned]'}`,
  }
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}
