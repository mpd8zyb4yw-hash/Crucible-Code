// Context manager — tracks token budget per active model and triggers
// compression before the transcript exhausts the context window.
// Sits transparently between the agent loop and model calls.
//
// At 85% of a model's token budget → compress current context
// After compression → runs contextAnchor.diffAgainstAnchor on the output
// Discrepancy patches injected back before handoff
// Model switches use rosterRotation + modelHunter to select fallback
// All events emitted to debugBus
//
// Handoff format: { taskGoal, compressedState, discrepancyPatches, currentPosition, nextExpectedOutput }

import { validateCompression, diffAgainstAnchor } from './contextAnchor'
import { getBenchedIds } from './rosterRotation'
import { debugBus } from './debug/bus'

// Token budget per model family (conservative estimates for free-tier models)
const MODEL_TOKEN_LIMITS: Record<string, number> = {
  'llama':        8_000,
  'mistral':      8_000,
  'gemma':        8_000,
  'qwen':        32_000,
  'deepseek':    32_000,
  'phi':          4_000,
  'falcon':       4_000,
  'default':      8_000,
}

function getTokenLimit(modelId: string): number {
  const lower = modelId.toLowerCase()
  for (const [key, limit] of Object.entries(MODEL_TOKEN_LIMITS)) {
    if (lower.includes(key)) return limit
  }
  return MODEL_TOKEN_LIMITS.default
}

function estimateTokens(text: string): number {
  // Rough estimate: 1 token ≈ 4 chars
  return Math.ceil(text.length / 4)
}

function estimateMessageTokens(messages: Array<Record<string, unknown>>): number {
  return messages.reduce((s, m) => {
    const content = m.content
    if (typeof content === 'string') return s + estimateTokens(content)
    if (content == null) return s
    return s + estimateTokens(JSON.stringify(content))
  }, 0)
}

// Per-session budget tracking
const budgets = new Map<string, { modelId: string; tokenLimit: number; tokensUsed: number }>()

export interface BudgetState {
  modelId: string
  tokenLimit: number
  tokensUsed: number
  percentUsed: number
  shouldCompress: boolean
}

export function initBudget(sessionId: string, modelId: string): void {
  budgets.set(sessionId, {
    modelId,
    tokenLimit: getTokenLimit(modelId),
    tokensUsed: 0,
  })
}

export function updateBudget(sessionId: string, messages: Array<Record<string, unknown>>): BudgetState {
  const budget = budgets.get(sessionId) ?? { modelId: 'default', tokenLimit: MODEL_TOKEN_LIMITS.default, tokensUsed: 0 }
  budget.tokensUsed = estimateMessageTokens(messages)
  budgets.set(sessionId, budget)
  const percentUsed = budget.tokensUsed / budget.tokenLimit
  return {
    ...budget,
    percentUsed,
    shouldCompress: percentUsed >= 0.85,
  }
}

export function getBudgetState(sessionId: string): BudgetState | null {
  const b = budgets.get(sessionId)
  if (!b) return null
  const percentUsed = b.tokensUsed / b.tokenLimit
  return { ...b, percentUsed, shouldCompress: percentUsed >= 0.85 }
}

export function deleteBudget(sessionId: string): void {
  budgets.delete(sessionId)
}

// Select a fallback model for handoff — excludes benched models
export function selectHandoffModel(
  currentModelId: string,
  availableModels: Array<{ id: string; label?: string }>,
  projectDir: string,
): { id: string; label?: string } | null {
  const benched = getBenchedIds(projectDir)
  const candidates = availableModels.filter(m => m.id !== currentModelId && !benched.has(m.id))
  if (!candidates.length) return null
  // Prefer models with larger context windows (Qwen/DeepSeek)
  const preferred = candidates.find(m => {
    const lower = m.id.toLowerCase()
    return lower.includes('qwen') || lower.includes('deepseek')
  })
  return preferred ?? candidates[0]
}

// Build the structured handoff prompt
export interface HandoffContext {
  taskGoal: string
  compressedState: string
  discrepancyPatches: string[]
  currentPosition: string     // what step the agent was on when compression fired
  nextExpectedOutput: string  // what the agent should produce next
}

export function buildHandoffPrompt(ctx: HandoffContext): string {
  const parts: string[] = [
    `[CONTEXT HANDOFF]`,
    `Task goal: ${ctx.taskGoal.slice(0, 300)}`,
    ``,
    `Compressed state:`,
    ctx.compressedState,
  ]

  if (ctx.discrepancyPatches.length > 0) {
    parts.push(``, `Discrepancy patches (entities/requirements recovered from anchor):`)
    ctx.discrepancyPatches.forEach(p => parts.push(p))
  }

  parts.push(
    ``,
    `Current position: ${ctx.currentPosition}`,
    `Next expected output: ${ctx.nextExpectedOutput}`,
    ``,
    `Continue from the above state. Preserve all decisions made. The task goal is authoritative.`,
  )

  return parts.join('\n')
}

// ── Compression result ────────────────────────────────────────────────────────

export interface CompressionResult {
  messages: Array<Record<string, unknown>>
  compressed: boolean
  anchorBlock: string        // the produced summary block (for anchor validation)
  tokensReclaimed: number    // approximate tokens freed
}

const KEEP_RECENT_TURNS = 6

function buildStructuralSummary(goal: string, oldMessages: Array<Record<string, unknown>>): string {
  const assistantSentences = oldMessages
    .filter(m => m.role === 'assistant' && m.content)
    .map(m => String(m.content).replace(/\n+/g, ' ').trim().slice(0, 280))
    .filter(s => s.length > 20)

  const toolSummaries = oldMessages
    .filter(m => m.role === 'tool' && m.content)
    .slice(-4)
    .map(m => String(m.content).trim().slice(0, 180))

  const parts: string[] = [
    `[CONTEXT HANDOFF — ${oldMessages.length} prior turns compressed]`,
    `Original task: ${goal.slice(0, 200)}`,
  ]

  if (assistantSentences.length) {
    parts.push(`\nReasoning summary (${assistantSentences.length} turns):`)
    const picks: string[] = []
    if (assistantSentences.length > 0) picks.push(assistantSentences[0])
    if (assistantSentences.length > 2) picks.push(assistantSentences[Math.floor(assistantSentences.length / 2)])
    if (assistantSentences.length > 1) picks.push(assistantSentences[assistantSentences.length - 1])
    picks.forEach((s, i) => parts.push(`  ${i + 1}. ${s}`))
  }

  if (toolSummaries.length) {
    parts.push(`\nRecent observations:`)
    toolSummaries.forEach(s => parts.push(`  - ${s}`))
  }

  parts.push(`\nContinue from here — the above summarises completed work. Preserve all decisions made.`)
  return parts.join('\n')
}

function findCutoff(nonSystem: Array<Record<string, unknown>>): number {
  let exchanges = 0
  for (let i = nonSystem.length - 1; i >= 0; i--) {
    const role = String(nonSystem[i].role ?? '')
    if (role === 'user') exchanges++
    if (exchanges >= KEEP_RECENT_TURNS) return i
  }
  return 0
}

// Main entry point — call after squashOldObservations in the agent loop.
// Now also checks the 85% budget threshold.
// Returns the original messages array unchanged if no compression is needed.
export async function maybeCompressMessages(
  messages: Array<Record<string, unknown>>,
  goal: string,
  callModel: ((messages: Array<{ role: string; content: string }>) => Promise<string>) | null,
  force?: boolean,
  anchorId?: string,
  sessionId?: string,
  requestId?: string,
): Promise<CompressionResult> {
  // Check budget threshold first (85%), fall back to char-count heuristic
  const shouldCompressByBudget = sessionId
    ? (updateBudget(sessionId, messages).shouldCompress)
    : false

  const totalChars = messages.reduce((s, m) => {
    const c = m.content
    return s + (typeof c === 'string' ? c.length : c != null ? JSON.stringify(c).length : 0)
  }, 0)
  const shouldCompressByChars = totalChars >= 60_000

  if (!force && !shouldCompressByBudget && !shouldCompressByChars) {
    return { messages, compressed: false, anchorBlock: '', tokensReclaimed: 0 }
  }

  const systemMsg = messages.find(m => m.role === 'system')
  const nonSystem = messages.filter(m => m.role !== 'system')
  const cutoff = findCutoff(nonSystem)

  if (cutoff < 4) {
    return { messages, compressed: false, anchorBlock: '', tokensReclaimed: 0 }
  }

  const oldMessages = nonSystem.slice(0, cutoff)
  const recentMessages = nonSystem.slice(cutoff)

  const triggerReason = shouldCompressByBudget ? 'budget_85pct' : 'char_limit'

  debugBus.emit('agent', 'context_compression_start', {
    triggerReason,
    totalChars,
    oldTurnCount: oldMessages.length,
    anchorId,
    requestId,
  }, { severity: 'info', requestId })

  let anchorBlock = ''

  // Attempt model-assisted summarisation
  if (callModel) {
    try {
      const promptTurns = oldMessages
        .map(m => `[${m.role}] ${String(m.content ?? '').slice(0, 400)}`)
        .join('\n\n')
        .slice(0, 4000)

      const summary = await Promise.race([
        callModel([
          {
            role: 'system',
            content: 'You are a context compressor for an AI agent session. Write a dense, structured summary of completed work. Preserve: entity names, file paths, numbers, key decisions made, and the current state. 5-8 sentences maximum. No filler phrases.',
          },
          {
            role: 'user',
            content: `Original task: ${goal.slice(0, 300)}\n\nCompleted turns to summarise:\n${promptTurns}`,
          },
        ]),
        new Promise<string>((_, rej) => setTimeout(() => rej(new Error('compress timeout')), 7000)),
      ])

      if (summary && summary.length > 40) {
        anchorBlock = `[COMPRESSED CONTEXT — ${oldMessages.length} prior turns]\n${summary.trim()}`
      }
    } catch { /* fall through to structural */ }
  }

  if (!anchorBlock) {
    anchorBlock = buildStructuralSummary(goal, oldMessages)
  }

  const tokensReclaimed = Math.ceil(
    oldMessages.reduce((s, m) => s + String(m.content ?? '').length, 0) / 4
  )

  // Run anchor diff if we have an anchorId
  let patches: string[] = []
  let discrepancyAction = 'ignore'
  if (anchorId) {
    const report = validateCompression(anchorId, anchorBlock)
    discrepancyAction = report.action
    if (report.patch) patches = [report.patch]

    debugBus.emit('agent', 'context_compressed', {
      tokensReclaimed,
      discrepancyAction: report.action,
      discrepancies: report.discrepancies,
      entityCount: report.missingEntities.length,
      requirementCount: report.missingRequirements.length,
      semanticDrift: report.semanticDrift,
      anchorId,
      requestId,
    }, { severity: report.action === 'ignore' ? 'info' : 'warn', requestId })
  } else {
    debugBus.emit('agent', 'context_compressed', {
      tokensReclaimed,
      discrepancyAction: 'no_anchor',
      requestId,
    }, { severity: 'info', requestId })
  }

  // Build handoff block with patches
  let handoffContent = anchorBlock
  if (patches.length > 0) {
    handoffContent = buildHandoffPrompt({
      taskGoal: goal,
      compressedState: anchorBlock,
      discrepancyPatches: patches,
      currentPosition: `turn ${nonSystem.length}`,
      nextExpectedOutput: 'continue task from compressed state',
    })
  }

  const newMessages: Array<Record<string, unknown>> = [
    ...(systemMsg ? [systemMsg] : []),
    { role: 'user', content: handoffContent },
    ...recentMessages,
  ]

  // Update budget after compression
  if (sessionId) updateBudget(sessionId, newMessages)

  return { messages: newMessages, compressed: true, anchorBlock, tokensReclaimed }
}

// Transparently switch models, logging to debugBus.
// Returns the new model entry or the original if no switch is possible.
export function transparentModelSwitch(
  currentModel: { id: string; label?: string },
  availableModels: Array<{ id: string; label?: string }>,
  projectDir: string,
  reason: string,
  requestId?: string,
): { id: string; label?: string } {
  const next = selectHandoffModel(currentModel.id, availableModels, projectDir)
  if (!next) {
    debugBus.emit('agent', 'model_switch_failed', {
      currentModel: currentModel.id,
      reason,
      requestId,
    }, { severity: 'warn', requestId })
    return currentModel
  }

  debugBus.emit('agent', 'model_switch', {
    from: currentModel.id,
    to: next.id,
    fromLabel: currentModel.label,
    toLabel: next.label,
    reason,
    requestId,
  }, { severity: 'info', requestId })

  return next
}
