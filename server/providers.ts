/**
 * Provider registry.
 *
 * The brain is provider-agnostic on purpose: the open question is whether a
 * free or cheap tier is smart enough to do whole-life synthesis, and that is
 * only answerable by swapping models behind a fixed interface and comparing.
 * Everything above this file talks in terms of `chat()`.
 */

export interface Provider {
  id: string
  label: string
  /** Where to get a key, shown in settings. */
  hint: string
  /** Free tier worth testing? Shown as a badge. */
  free: boolean
  models: string[]
  defaultModel: string
}

export const providers: Provider[] = [
  {
    id: 'gemini',
    label: 'Google Gemini',
    hint: 'aistudio.google.com/apikey',
    free: true,
    // Fallback only — `listModels` asks the provider what this key can actually
    // reach. A baked-in list goes stale the moment a provider ships a model.
    models: ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-flash-latest'],
    defaultModel: 'gemini-3.6-flash',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    hint: 'console.anthropic.com',
    free: false,
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    defaultModel: 'claude-sonnet-5',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    hint: 'platform.openai.com/api-keys',
    free: false,
    models: ['gpt-4o', 'gpt-4o-mini'],
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    hint: 'console.x.ai',
    free: false,
    models: ['grok-4', 'grok-3-mini'],
    defaultModel: 'grok-3-mini',
  },
  {
    id: 'groq',
    label: 'Groq',
    hint: 'console.groq.com/keys',
    free: true,
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    defaultModel: 'llama-3.3-70b-versatile',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    hint: 'openrouter.ai/keys',
    free: true,
    models: ['deepseek/deepseek-chat-v3.1:free', 'meta-llama/llama-3.3-70b-instruct:free'],
    defaultModel: 'deepseek/deepseek-chat-v3.1:free',
  },
]

/**
 * Ask the provider which models this key can actually reach.
 *
 * Baked-in model lists are a bug with a delay fuse: the registry above already
 * shipped stale (it listed Gemini 2.5 for a key with access to 3.x). Providers
 * all expose a list endpoint; use it and fall back to the static list only if
 * the call fails.
 */
export async function listModels(id: string, key: string): Promise<string[] | null> {
  try {
    if (id === 'gemini') {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
        headers: { 'x-goog-api-key': key },
      })
      if (!r.ok) return null
      const b: any = await r.json()
      return (b.models ?? [])
        .filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
        .map((m: any) => String(m.name).replace('models/', ''))
        .filter((n: string) => !/embedding|tts|image|robotics|lyria|computer-use/.test(n))
    }
    if (id === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      })
      if (!r.ok) return null
      const b: any = await r.json()
      return (b.data ?? []).map((m: any) => String(m.id))
    }
    const base = OPENAI_COMPATIBLE[id]
    if (!base) return null
    const r = await fetch(base.replace('/chat/completions', '/models'), {
      headers: { authorization: `Bearer ${key}` },
    })
    if (!r.ok) return null
    const b: any = await r.json()
    const ids = (b.data ?? []).map((m: any) => String(m.id))
    // OpenRouter lists thousands; without credits only :free ones are usable.
    const free = id === 'openrouter' ? ids.filter((n: string) => n.endsWith(':free')) : ids
    return free.filter(canChat)
  } catch {
    return null
  }
}

/**
 * A model list is not a chat menu.
 *
 * `/v1/models` returns everything the key can touch, which includes things that
 * cannot hold a conversation at all: safety classifiers, embedders, speech and
 * image models. The picker offered them anyway, and the one selected on the
 * hosted app was `llama-prompt-guard-2-86m` — a prompt-injection CLASSIFIER. It
 * cannot answer a question, so every single pass failed and the home screen was
 * blank no matter which settings were touched. Nothing that cannot chat should
 * ever be offered as the thing the app thinks with.
 */
const NOT_A_CHAT_MODEL =
  /guard|moderation|embed|embedding|whisper|tts|text-to-speech|speech|audio|transcribe|rerank|vision-encoder|image|dall-e|imagen|veo|nano-banana|safety|classifier/i

export function canChat(id: string): boolean {
  return !NOT_A_CHAT_MODEL.test(id)
}

export const byId = (id: string) => providers.find((p) => p.id === id)

/**
 * Prove a model actually answers on this key, before it is made the one the
 * app thinks with.
 *
 * Listing a model is not the same as being allowed to run it: providers list
 * their paid tiers to every key, so a free key could select a pro model in
 * settings and the next home-feed synthesis would fail outright, with the
 * provider's quota error as the whole screen. One tiny call up front turns that
 * into a sentence in settings, at the moment of choosing, where it can be acted
 * on. Returns null when the model works, or the provider's own reason.
 */
export async function probe(id: string, model: string, key: string): Promise<string | null> {
  try {
    /**
     * The ceiling has to clear the model's thinking budget, not just its answer.
     *
     * This asked for four tokens until it was measured: gemini-3.6-flash spends
     * ~75 tokens thinking before emitting the single token "ok", so a four-token
     * ceiling returns MAX_TOKENS and empty text. Every current Gemini model
     * failed this check, which meant pasting a perfectly good key was rejected
     * with "that model answered with nothing".
     */
    const out = await chat({ providerId: id, model, key, prompt: 'Reply with: ok', maxTokens: 512 })
    return out.text.trim() ? null : 'That model answered with nothing.'
  } catch (e) {
    return (e as Error).message || 'That model would not answer.'
  }
}

export interface ChatRequest {
  providerId: string
  model: string
  key: string
  system?: string
  prompt: string
  /** Ask the provider for strict JSON back. */
  json?: boolean
  /**
   * Ground the answer in a live web search. Providers that cannot do this
   * ignore it — callers must treat `sources` being empty as "unverified",
   * never as "confirmed".
   */
  search?: boolean
  maxTokens?: number
}

export interface ChatResult {
  text: string
  /** Where a grounded answer came from. Empty when the answer is ungrounded. */
  sources?: { title: string; uri: string }[]
  /** Provider-reported usage, when available. */
  usage?: { in?: number; out?: number }
  /** What the provider said about the budget, read off the response headers. */
  limits?: RateSnapshot
}

/**
 * What a provider tells us about our remaining budget, for free.
 *
 * Every OpenAI-compatible endpoint returns its rate-limit state in the headers
 * of the response we already asked for. We were throwing them away on success
 * and only reading them on failure, which meant the app could not see a limit
 * coming — it could only report one it had already hit, at the moment it broke
 * something. Reading them costs nothing: no extra call, no extra token, and the
 * numbers are the provider's own rather than our estimate of them.
 */
export interface RateSnapshot {
  /** Requests left in the current window, as the provider counts them. */
  requestsLeft?: number
  requestLimit?: number
  /** Tokens left in the current window. */
  tokensLeft?: number
  tokenLimit?: number
  /** When the window resets, epoch ms. */
  resetsAt?: number
  /** When this was read. */
  at: number
  /** True when these came from the provider; false when we inferred them. */
  measured: true
}

/** Providers state resets as "1m30s", "45s", "2000ms" or plain seconds. */
function duration(v: string | null): number | undefined {
  if (!v) return undefined
  const t = v.trim()
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(parseFloat(t) * 1000)
  let ms = 0
  let hit = false
  for (const [, n, unit] of t.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/gi)) {
    const x = parseFloat(n)
    hit = true
    ms += unit.toLowerCase() === 'ms' ? x
      : unit.toLowerCase() === 's' ? x * 1000
      : unit.toLowerCase() === 'm' ? x * 60_000
      : unit.toLowerCase() === 'h' ? x * 3_600_000
      : x * 86_400_000
  }
  return hit ? Math.round(ms) : undefined
}

const num = (v: string | null): number | undefined => {
  if (v === null) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Read the budget off a response. Returns null when the provider said nothing,
 * which is itself information — Gemini reports no headers at all, so its
 * numbers have to be modelled from our own ledger and must never be presented
 * as though the provider had confirmed them.
 */
export function parseRateHeaders(h: Headers): RateSnapshot | null {
  const s: RateSnapshot = { at: Date.now(), measured: true }
  s.requestsLeft = num(h.get('x-ratelimit-remaining-requests'))
  s.requestLimit = num(h.get('x-ratelimit-limit-requests'))
  s.tokensLeft = num(h.get('x-ratelimit-remaining-tokens'))
  s.tokenLimit = num(h.get('x-ratelimit-limit-tokens'))

  const reset =
    duration(h.get('x-ratelimit-reset-requests')) ??
    duration(h.get('x-ratelimit-reset-tokens')) ??
    duration(h.get('retry-after'))
  if (reset !== undefined) s.resetsAt = Date.now() + reset

  const any =
    s.requestsLeft !== undefined || s.tokensLeft !== undefined ||
    s.requestLimit !== undefined || s.tokenLimit !== undefined
  return any ? s : null
}

/**
 * What a provider told us about the budget when it refused.
 *
 * Refusals are not all the same shape and treating them as one is what made the
 * app unusable: Groq's daily token budget and Gemini's twenty-requests-a-day are
 * both "429", but one frees up in half an hour and the other not until tomorrow.
 * Resting both for a fixed minute meant every retry spent more of the budget
 * that was already gone.
 */
export interface Quota {
  /** How long the provider itself says to wait, in ms. */
  retryAfterMs?: number
  /** What ran out, in that provider's words, short enough to show him. */
  what?: string
  limit?: number
  used?: number
  /** True when this is a daily ceiling rather than a per-minute burst. */
  daily?: boolean
}

/** A refusal that carried budget information, so the router can act on it. */
export class ProviderError extends Error {
  quota?: Quota
  constructor(message: string, quota?: Quota) {
    super(message)
    this.name = 'ProviderError'
    if (quota) this.quota = quota
  }
}

const DURATION = /(?:try again in|retry in)\s*(?:(\d+)h)?(?:(\d+)m)?([\d.]+)?s?/i

/**
 * Read the budget out of a refusal. Every provider writes this differently and
 * none of it is structured, so this is deliberately forgiving: anything it
 * cannot parse simply returns nothing and the caller falls back to a guess.
 */
export function readQuota(message: string): Quota | null {
  if (!message) return null
  const q: Quota = {}

  const d = DURATION.exec(message)
  if (d) {
    const [, h, m, s] = d
    const ms = (Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0)) * 1000
    if (ms > 0) q.retryAfterMs = Math.round(ms)
  }

  // Groq: "on tokens per day (TPD): Limit 100000, Used 98497, Requested 3812"
  const groq = /\bon ([a-z ]+?)\s*\((TPD|RPD|TPM|RPM)\):\s*Limit (\d+),\s*Used (\d+)/i.exec(message)
  if (groq) {
    q.what = groq[1].trim()
    q.limit = Number(groq[3])
    q.used = Number(groq[4])
    q.daily = /D$/i.test(groq[2])
  }

  // Gemini: "Quota exceeded for metric: …/generate_content_free_tier_requests,
  // limit: 20". Its structured details are better and are read in geminiChat;
  // this is the fallback for when only the prose survives.
  const gem = /Quota exceeded for metric:\s*\S*?([a-z_]+),\s*limit:\s*(\d+)/i.exec(message)
  if (gem && q.limit === undefined) {
    q.limit = Number(gem[2])
    q.what = gem[1].replace(/_/g, ' ').replace(/^generate content /, '').trim()
  }

  return Object.keys(q).length ? q : null
}

/** Which providers can actually check the world, rather than recall it. */
export const canSearch = (id: string) => id === 'gemini'

const OPENAI_COMPATIBLE: Record<string, string> = {
  openai: 'https://api.openai.com/v1/chat/completions',
  xai: 'https://api.x.ai/v1/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
}

/** One call shape for every provider. Throws with the provider's own message. */
export async function chat(req: ChatRequest): Promise<ChatResult> {
  const { providerId } = req
  if (providerId === 'gemini') return geminiChat(req)
  if (providerId === 'anthropic') return anthropicChat(req)
  if (OPENAI_COMPATIBLE[providerId]) return openaiChat(req, OPENAI_COMPATIBLE[providerId])
  throw new Error(`Unknown provider: ${providerId}`)
}

async function openaiChat(req: ChatRequest, url: string): Promise<ChatResult> {
  const messages = [
    ...(req.system ? [{ role: 'system', content: req.system }] : []),
    { role: 'user', content: req.prompt },
  ]
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${req.key}` },
    body: JSON.stringify({
      model: req.model,
      messages,
      max_tokens: req.maxTokens ?? 2048,
      ...(req.json ? { response_format: { type: 'json_object' } } : {}),
    }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw fail(body, res.status, res.headers)
  return {
    text: body?.choices?.[0]?.message?.content ?? '',
    usage: { in: body?.usage?.prompt_tokens, out: body?.usage?.completion_tokens },
    limits: parseRateHeaders(res.headers) ?? undefined,
  }
}

async function anthropicChat(req: ChatRequest): Promise<ChatResult> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': req.key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: req.model,
      max_tokens: req.maxTokens ?? 2048,
      ...(req.system ? { system: req.system } : {}),
      messages: [{ role: 'user', content: req.prompt }],
    }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw fail(body, res.status, res.headers)
  const text = (body?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
  return {
    text,
    usage: { in: body?.usage?.input_tokens, out: body?.usage?.output_tokens },
    limits: parseRateHeaders(res.headers) ?? undefined,
  }
}

async function geminiChat(req: ChatRequest): Promise<ChatResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent`
  // Search grounding and strict JSON are mutually exclusive on this API, which
  // is why research and synthesis are separate passes: research goes out
  // grounded and free-form, synthesis comes back as JSON over what it found.
  const grounded = !!req.search
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': req.key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
      ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      ...(grounded ? { tools: [{ google_search: {} }] } : {}),
      generationConfig: {
        maxOutputTokens: req.maxTokens ?? 2048,
        ...(req.json && !grounded ? { responseMimeType: 'application/json' } : {}),
      },
    }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw fail(body, res.status, res.headers)
  const cand = body?.candidates?.[0]
  const text = (cand?.content?.parts ?? []).map((p: any) => p.text ?? '').join('')
  const sources = (cand?.groundingMetadata?.groundingChunks ?? [])
    .map((c: any) => ({ title: String(c?.web?.title ?? ''), uri: String(c?.web?.uri ?? '') }))
    .filter((s: any) => s.uri)
  return {
    text,
    sources,
    usage: { in: body?.usageMetadata?.promptTokenCount, out: body?.usageMetadata?.candidatesTokenCount },
  }
}

function errText(body: any, status: number): string {
  const m = body?.error?.message ?? body?.message ?? body?.error
  return typeof m === 'string' ? m : `HTTP ${status}`
}

/**
 * Turn a refusal into something the router can reason about rather than a
 * string it can only pattern-match. Structured detail is used where a provider
 * offers it, because prose lies: Gemini says "retry in 27s" when the exhausted
 * budget is a per-DAY cap of twenty requests, and only `quotaId` says so.
 */
function fail(body: any, status: number, headers?: Headers): ProviderError {
  const message = errText(body, status)
  const quota = readQuota(message) ?? (status === 429 ? {} : null)
  if (!quota) return new ProviderError(message)

  // Gemini's google.rpc.QuotaFailure — the only place the window is stated.
  for (const d of body?.error?.details ?? []) {
    for (const v of d?.violations ?? []) {
      const id = String(v?.quotaId ?? '')
      if (!id) continue
      if (/PerDay/i.test(id)) quota.daily = true
      const n = Number(v?.quotaValue)
      if (Number.isFinite(n) && quota.limit === undefined) quota.limit = n
      if (!quota.what) quota.what = /Token/i.test(id) ? 'input tokens' : 'requests'
    }
  }

  // OpenAI-compatible providers state the remaining budget in headers.
  const num = (k: string) => {
    const v = headers?.get(k)
    const n = v === null || v === undefined ? NaN : Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const remaining = num('x-ratelimit-remaining-tokens')
  if (quota.limit === undefined) quota.limit = num('x-ratelimit-limit-tokens')
  if (quota.used === undefined && quota.limit !== undefined && remaining !== undefined) {
    quota.used = quota.limit - remaining
  }

  return new ProviderError(message, Object.keys(quota).length ? quota : undefined)
}
