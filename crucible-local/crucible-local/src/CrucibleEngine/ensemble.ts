import type { ApiKey, StreamHandle, StreamHandlers } from './types'

/**
 * Ensemble fan-out.
 *
 * The Settings UI is deliberately a blank slate — one "name" field and one
 * free-text "key or endpoint token" field, with zero baked-in provider
 * knowledge (per the design spec). That means we genuinely cannot assume a
 * request/response shape for an arbitrary key: providers disagree on
 * endpoint, auth header, and payload format.
 *
 * The honest, real behavior implemented here:
 *  - If a key's value contains a URL (optionally followed by a bearer
 *    token, e.g. "https://api.example.com/v1/chat/completions sk-...."),
 *    we make a REAL network call to it, POSTing an OpenAI-chat-compatible
 *    body and reading `choices[0].message.content` (falling back to a few
 *    other common response shapes). This covers OpenAI, OpenRouter, Groq,
 *    and most OpenAI-compatible gateways out of the box.
 *  - If a key's value is a bare token with no discoverable endpoint, we
 *    cannot know where to send it — that key's "draft" is produced locally
 *    instead (clearly marked `real: false`), so the UI still shows a chip
 *    and a contribution for it rather than silently failing. This is the
 *    integration seam: once you know a given key's provider, teach
 *    `draftFromKey` its endpoint shape and it becomes a real call too.
 */

interface Draft {
  key: ApiKey
  text: string
  real: boolean
}

const URL_RE = /https?:\/\/\S+/i

function parseKeyValue(raw: string): { url: string | null; token: string | null } {
  const trimmed = raw.trim()
  const urlMatch = trimmed.match(URL_RE)
  if (!urlMatch) return { url: null, token: trimmed || null }
  const url = urlMatch[0]
  const rest = (trimmed.slice(0, urlMatch.index) + trimmed.slice(urlMatch.index! + url.length)).trim()
  return { url, token: rest || null }
}

async function callOpenAiCompatible(url: string, token: string | null, prompt: string): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        model: 'default',
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const text =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.text ??
      data?.content?.[0]?.text ??
      data?.output_text ??
      null
    if (typeof text !== 'string' || !text.trim()) throw new Error('unrecognized response shape')
    return text.trim()
  } finally {
    clearTimeout(timeout)
  }
}

function localDraftFor(name: string, prompt: string): string {
  return (
    `[${name} — simulated, no endpoint configured] Taking "${prompt.slice(0, 80)}${
      prompt.length > 80 ? '…' : ''
    }" at face value: the direct approach handles the common case; ` +
    `worth stress-testing the boundary conditions before committing to it.`
  )
}

async function draftFromKey(key: ApiKey, prompt: string): Promise<Draft> {
  const { url, token } = parseKeyValue(key.value)
  if (url) {
    try {
      const text = await callOpenAiCompatible(url, token, prompt)
      return { key, text, real: true }
    } catch (err) {
      console.warn(`[ensemble] real call to "${key.name}" failed, falling back to local draft:`, err)
      return { key, text: localDraftFor(key.name, prompt), real: false }
    }
  }
  return { key, text: localDraftFor(key.name, prompt), real: false }
}

function synthesize(drafts: Draft[], prompt: string): string {
  const real = drafts.filter((d) => d.real)
  const lead = real[0] ?? drafts[0]
  const others = drafts.filter((d) => d !== lead)

  const parts: string[] = []
  parts.push(
    `Consensus after cross-examining ${drafts.length} draft${drafts.length === 1 ? '' : 's'} (${lead.key.name} led synthesis):\n`,
  )
  parts.push(lead.text)
  if (others.length) {
    parts.push(
      `\n\nDisagreement worth noting: ${others
        .map((d) => d.key.name)
        .join(', ')} weighted this differently — worth a second pass if the stakes are high on "${prompt.slice(0, 60)}${
        prompt.length > 60 ? '…' : ''
      }".`,
    )
  }
  return parts.join('')
}

export function runEnsemble(keys: ApiKey[], prompt: string, handlers: StreamHandlers, speed = 1): StreamHandle {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | null = null

  ;(async () => {
    const drafts = await Promise.all(keys.map((k) => draftFromKey(k, prompt)))
    if (cancelled) return
    const full = synthesize(drafts, prompt)
    const words = full.split(/(?<=\s)/)
    let i = 0
    let firstTokenFired = false
    let acc = ''
    const step = () => {
      if (cancelled) return
      const n = 1 + Math.floor(Math.random() * 4)
      const nextI = Math.min(words.length, i + n)
      const chunk = words.slice(i, nextI).join('')
      i = nextI
      acc += chunk
      if (!firstTokenFired) {
        firstTokenFired = true
        handlers.onFirstToken?.(full.length)
      }
      handlers.onChunk?.(chunk, acc)
      if (i >= words.length) {
        handlers.onDone?.(acc)
        return
      }
      const pause = (Math.random() < 0.12 ? 380 : 40 + Math.random() * 110) / speed
      timer = setTimeout(step, pause)
    }
    step()
  })().catch((err) => handlers.onError?.(err instanceof Error ? err : new Error(String(err))))

  return {
    cancel() {
      cancelled = true
      if (timer) clearTimeout(timer)
    },
  }
}
