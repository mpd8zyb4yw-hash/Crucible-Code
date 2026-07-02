// Driver tier — the orchestrator model that runs the agent loop.
// Picks the strongest tool-capable free model and falls back across providers
// on quota/transport errors, tripping circuit breakers as it goes.
// The worker tier stays the parallel ensemble (exposed as the ensemble_solve tool).

import Groq from 'groq-sdk'
import { Mistral } from '@mistralai/mistralai'
import {
  selectDriverCandidates, tripCircuitBreaker, parseRetryDelay,
  recordProviderCall, recordModelFailure, resetCircuitBreaker, msUntilDriverRecovery,
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

// The strongest free coder model (GPT-OSS-120B) is the ONLY capable driver once a coding
// context grows (the smaller fallbacks 429 or 413 on a large transcript). At 25s — and even
// 60s — it timed out on every turn, leaving no capable model and killing the task. 90s lets
// it actually finish a turn on a big context. (Env-overridable for tuning.)
const DRIVER_TURN_TIMEOUT_MS = Number(process.env.CRUCIBLE_DRIVER_TURN_TIMEOUT_MS ?? 90_000)

function withDriverTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Driver turn timed out after ${Math.round(DRIVER_TURN_TIMEOUT_MS / 1000)}s`)), DRIVER_TURN_TIMEOUT_MS)
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
      model: modelId, messages: sanitizeMessages(messages) as any,
      ...(tools.length ? { tools: toOpenAITools(tools) as any, tool_choice: 'auto' } : {}),
      temperature: 0.2,
    } as any)
    const msg = res.choices[0]?.message
    return { text: stripThink(msg?.content ?? ''), toolCalls: fromOpenAIToolCalls(msg) }
  }

  if (m.provider === 'mistral') {
    const res = await mistral().chat.complete({
      model: modelId, messages: sanitizeMessages(messages) as any,
      ...(tools.length ? { tools: toOpenAITools(tools) as any, toolChoice: 'auto' as any } : {}),
      temperature: 0.2,
    })
    const msg: any = res.choices?.[0]?.message
    const toolCalls: ToolCall[] = (msg?.toolCalls ?? []).map((c: any, i: number) => ({
      id: (c.id && String(c.id).trim()) || `call_${i}`,   // empty id → fallback (error 3051)
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
        model: modelId, messages: sanitizeMessages(messages),
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

/**
 * Sanitize the message array so no assistant turn is rejected by the provider. Every
 * provider enforces "an assistant message must have content OR tool_calls, not neither"
 * (groq error 3240, code 400). A turn where the model returned empty text AND no tool
 * calls — or a resumed-history message with null content — would otherwise hard-fail the
 * whole agent loop (this killed a baseline coding run mid-task). Universal + defensive,
 * so it is correct for every provider (groq / mistral / openrouter / strict :free models):
 *  - assistant WITH tool_calls: content is coerced null/undefined → '' (never left null —
 *    strict upstream models reject null content even alongside tool_calls, error 3240).
 *  - assistant with NO tool_calls and empty/whitespace/null content: inject a minimal
 *    non-empty placeholder so the message is valid ("content present").
 *  - an empty `tool_calls: []` array is dropped (some providers reject it outright).
 */
export function sanitizeMessages(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return messages.map(m => {
    if (m.role !== 'assistant') return m
    const tcs = (m as any).tool_calls
    const hasToolCalls = Array.isArray(tcs) && tcs.length > 0
    const content = (m as any).content
    const out: Record<string, unknown> = { ...m }
    // Drop an empty tool_calls array — some providers reject `tool_calls: []`.
    if (Array.isArray(tcs) && tcs.length === 0) delete out.tool_calls
    if (hasToolCalls) {
      // content may be null in the OpenAI spec, but strict upstream :free models (via
      // OpenRouter) reject null content even alongside tool_calls (error 3240). '' is
      // universally accepted (OpenAI/groq/mistral), so coerce null/undefined → ''.
      if (content === null || content === undefined) out.content = ''
      return out
    }
    // No tool calls → content MUST be a non-empty string ("content or tool_calls, not none").
    const isEmpty = content === null || content === undefined || (typeof content === 'string' && content.trim() === '')
    if (isEmpty) out.content = '(continuing)'
    return out
  })
}

/**
 * One driver turn with cross-provider fallback. Tries driver candidates in
 * quality order; quota/transport failures trip the circuit and move on.
 */
// Cap on how long a single turn will wait for a fully-tripped pool to recover before
// giving up. Bounded so a genuinely dead pool still fails the task in reasonable time,
// generous enough to ride out the common 60s rate-limit cooldown.
const MAX_POOL_WAIT_MS = Number(process.env.CRUCIBLE_MAX_POOL_WAIT_MS ?? 75_000)

export const nativeDriveTurn: DriveTurn = async (messages, tools, signal, turnClass) => {
  // selectDriverCandidates already excludes Mistral (it 400s on our message shape) and
  // includes recovering 'probing' models, so a fresh call reflects the live pool state.
  const pickCandidates = () => selectDriverCandidates(turnClass ?? 'hard')

  // Wait out a transient FULL trip rather than instant-failing the task. The whole free
  // pool routinely trips together under rate-limit pressure; cooldowns floor at 60s, so a
  // short wait recovers it. This is the difference between a task surviving a pool blip and
  // dying on it ("error-free always" depends on it). Bounded by MAX_POOL_WAIT_MS.
  let waited = 0
  while (!pickCandidates().length) {
    if (signal?.aborted) throw new Error('Aborted while waiting for driver pool to recover.')
    const recover = msUntilDriverRecovery()
    const step = Math.min(Math.max(recover, 2_000), 15_000)
    if (waited + step > MAX_POOL_WAIT_MS) {
      throw new Error('No tool-capable driver models available (all circuits tripped; waited for recovery).')
    }
    debugBus.emit('agent', 'pool_wait', { recoverMs: recover, waitedMs: waited }, { severity: 'warn' })
    await new Promise(r => setTimeout(r, step))
    waited += step
  }

  let lastErr: unknown
  for (const m of pickCandidates()) {
    try {
      const result = await withDriverTimeout(turnOnModel(m, messages, tools))
      // Success on a probing model (or any model) confirms it healthy → restore to active
      // so the self-healing path doesn't leave it stuck in probing forever.
      resetCircuitBreaker(m.id)
      return result
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

/** Plain text completion on the driver tier (planner, summaries). Defaults to the fast
 *  'glue' tier — planning/summarizing/judging doesn't need the top coder and is the bulk
 *  of latency-tolerant calls; pass 'hard' to force the strongest model. */
export async function driverComplete(
  messages: Array<{ role: string; content: string }>,
  turnClass: 'glue' | 'hard' = 'glue',
): Promise<string> {
  const result = await nativeDriveTurn(messages as Array<Record<string, unknown>>, [], undefined, turnClass)
  return result.text
}
