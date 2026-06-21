// Driver tier — the orchestrator model that runs the agent loop.
// Picks the strongest tool-capable free model and falls back across providers
// on quota/transport errors, tripping circuit breakers as it goes.
// The worker tier stays the parallel ensemble (exposed as the ensemble_solve tool).

import Groq from 'groq-sdk'
import { Mistral } from '@mistralai/mistralai'
import {
  selectDriverCandidates, tripCircuitBreaker, parseRetryDelay,
  recordProviderCall, recordModelFailure,
} from '../../../modelRegistry'
import type { ModelEntry } from '../../../modelRegistry'
import { toOpenAITools, fromOpenAIToolCalls } from '../tools/protocol'
import type { ToolCall, ToolDef } from '../tools/protocol'
import type { DriveTurn, DriveTurnResult } from './loop'
import { debugBus } from '../debug/bus'

let _groq: Groq | null = null
let _mistral: Mistral | null = null
const groq = () => (_groq ??= new Groq({ apiKey: process.env.VITE_GROQ_API_KEY ?? 'missing' }))
const mistral = () => (_mistral ??= new Mistral({ apiKey: process.env.VITE_MISTRAL_API_KEY ?? 'missing' }))

const stripThink = (t: string) => t.replace(/<think>[\s\S]*?<\/think>/g, '').trim()

export function currentDriverLabel(): string {
  return selectDriverCandidates()[0]?.label ?? '(none)'
}

/** Back-compat export — resolved dynamically per turn now. */
export const DRIVER_MODEL = 'auto (driver tier)'

const DRIVER_TURN_TIMEOUT_MS = 25_000

function withDriverTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('Driver turn timed out after 25s')), DRIVER_TURN_TIMEOUT_MS)
    ),
  ])
}

async function turnOnModel(
  m: ModelEntry,
  messages: Array<Record<string, unknown>>,
  tools: ToolDef[],
): Promise<DriveTurnResult> {
  recordProviderCall(m.provider)
  const modelId = m.id.replace(/^[a-z]+\//, '')

  if (m.provider === 'groq') {
    const res = await groq().chat.completions.create({
      model: modelId, messages: messages as any,
      ...(tools.length ? { tools: toOpenAITools(tools) as any, tool_choice: 'auto' } : {}),
      temperature: 0.2,
    } as any)
    const msg = res.choices[0]?.message
    return { text: stripThink(msg?.content ?? ''), toolCalls: fromOpenAIToolCalls(msg) }
  }

  if (m.provider === 'mistral') {
    const res = await mistral().chat.complete({
      model: modelId, messages: sanitizeForMistral(messages) as any,
      ...(tools.length ? { tools: toOpenAITools(tools) as any, toolChoice: 'auto' as any } : {}),
      temperature: 0.2,
    })
    const msg: any = res.choices?.[0]?.message
    const toolCalls: ToolCall[] = (msg?.toolCalls ?? []).map((c: any, i: number) => ({
      id: c.id ?? `call_${i}`,
      name: c.function?.name ?? '',
      args: typeof c.function?.arguments === 'string'
        ? (JSON.parse(c.function.arguments || '{}'))
        : (c.function?.arguments ?? {}),
    })).filter((c: ToolCall) => c.name)
    const text = typeof msg?.content === 'string' ? msg.content : ''
    return { text: stripThink(text), toolCalls }
  }

  if (m.provider === 'openrouter') {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.VITE_OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://crucible.local',
        'X-Title': 'Crucible',
      },
      body: JSON.stringify({
        model: modelId, messages,
        ...(tools.length ? { tools: toOpenAITools(tools), tool_choice: 'auto' } : {}),
        temperature: 0.2,
      }),
    })
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`)
    const data = await res.json()
    const msg = data.choices?.[0]?.message
    return { text: stripThink(msg?.content ?? ''), toolCalls: fromOpenAIToolCalls(msg) }
  }

  throw new Error(`Provider ${m.provider} not supported as driver`)
}

function isQuotaError(e: any): boolean {
  const s = String(e?.message ?? e)
  return /429|rate.?limit|quota|exceeded|insufficient/i.test(s)
}

function isTokenSizeError(e: any): boolean {
  const s = String(e?.message ?? e)
  return /413|request.?too.?large|context.?length|maximum.?context|token.*limit|exceeds.*model|too many tokens/i.test(s)
}

/** Sanitize messages for Mistral: replace null content on assistant messages with '' to avoid 400s. */
function sanitizeForMistral(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return messages.map(m => {
    if (m.role === 'assistant' && (m.content === null || m.content === undefined)) {
      return { ...m, content: '' }
    }
    return m
  })
}

/**
 * One driver turn with cross-provider fallback. Tries driver candidates in
 * quality order; quota/transport failures trip the circuit and move on.
 */
export const nativeDriveTurn: DriveTurn = async (messages, tools, _signal) => {
  const candidates = selectDriverCandidates()
  if (!candidates.length) throw new Error('No tool-capable driver models available (all circuits tripped).')
  let lastErr: unknown
  for (const m of candidates) {
    try {
      return await withDriverTimeout(turnOnModel(m, messages, tools))
    } catch (e: any) {
      lastErr = e
      recordModelFailure(m.id)
      if (isQuotaError(e)) {
        tripCircuitBreaker(m.id, parseRetryDelay(String(e?.message ?? ''), m.provider), 'quota-429')
      } else if (isTokenSizeError(e)) {
        // Context too large for this model — trip with a short cooldown so it isn't
        // retried on every subsequent iteration while the transcript is still large.
        tripCircuitBreaker(m.id, 300, 'token-size-413')
        debugBus.emit('agent', 'token_size_trip', { model: m.id, error: String(e?.message ?? e).slice(0, 120) }, { severity: 'warn' })
      }
      console.warn(`[Driver] ${m.label} failed (${String(e?.message ?? e).slice(0, 120)}) — falling back`)
    }
  }
  throw lastErr
}

/** Plain text completion on the driver tier (planner, summaries) — same fallback. */
export async function driverComplete(messages: Array<{ role: string; content: string }>): Promise<string> {
  const result = await nativeDriveTurn(messages as Array<Record<string, unknown>>, [])
  return result.text
}
