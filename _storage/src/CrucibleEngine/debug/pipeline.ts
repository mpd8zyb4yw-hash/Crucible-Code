// ============================================================
// CRUCIBLE — Analysis Pipeline
// Round 4 of /api/verify: multi-model parallel attack + fix
// tournament + synthesis. Called only when Rounds 1-3 all fail.
//
// Architecture:
//   1. Context assembly  — extract function scope + intent
//   2. Parallel attack   — 4 models, 4 distinct lenses, in parallel
//   3. Fix tournament    — sandbox each candidate, score with engine
//   4. Synthesis         — best-score winner, or composite from partials
//   5. Iterative deepen  — if synthesis fails, second round with history
// ============================================================

import { debugBus } from './bus'
import type { Language, ErrorType } from '../sandbox'
import type { SelectedModel } from '../../../modelRegistry'

// ── Types ──────────────────────────────────────────────────────────────────

export interface PipelineContext {
  code: string
  language: Language
  errorMessage: string
  errorType: ErrorType | null
  errorLine: number | null
  originalPrompt: string
  requestId: string
}

export type PipelineEventType =
  | 'analysis_start'
  | 'analysis_status'
  | 'attack_start'
  | 'candidate_proposed'
  | 'candidate_tested'
  | 'candidate_scored'
  | 'synthesis_start'
  | 'analysis_fixed'
  | 'analysis_failed'
  | 'analysis_deepening'

export interface PipelineEvent {
  type: PipelineEventType
  message?: string
  code?: string
  score?: number
  lens?: string
  attempt?: number
  totalAttempts?: number
  error?: string
}

export type PipelineSend = (event: PipelineEvent) => void
export type ModelCaller = (model: SelectedModel, messages: { role: string; content: string }[]) => Promise<string>
export type SandboxRunner = (code: string, lang: Language, timeoutMs: number) => Promise<{ success: boolean; error: string | null }>
export type Scorer = (code: string, prompt: string, language: Language) => number

// ── Lens definitions — each model gets a fundamentally different angle ──────

interface Lens {
  name: string
  systemPrompt: string
  userPrompt: (ctx: PipelineContext, history: string) => string
}

const LENSES: Lens[] = [
  {
    name: 'Root Cause',
    systemPrompt: `You are a debugger that finds the true origin of bugs, not just where they surface.
The error line is a symptom. Your job is to trace backwards and find the CAUSE.
Return ONLY a corrected code block. No explanation outside the block.`,
    userPrompt: (ctx, history) => `Language: ${ctx.language}
Task: ${ctx.originalPrompt.slice(0, 300)}

Error at line ${ctx.errorLine ?? '?'}: ${ctx.errorMessage}

Code:
\`\`\`${ctx.language}
${ctx.code}
\`\`\`
${history}
Find the root cause (which may be BEFORE the error line) and fix the entire causal chain.
Return only the corrected code block.`,
  },
  {
    name: 'Minimal Patch',
    systemPrompt: `You are a surgical patcher. Make the SMALLEST possible change to fix the error.
Do NOT restructure, refactor, or improve anything. Change the fewest lines possible.
Return ONLY a corrected code block.`,
    userPrompt: (ctx, history) => `Language: ${ctx.language}
Error: ${ctx.errorMessage} (line ${ctx.errorLine ?? '?'})

Code:
\`\`\`${ctx.language}
${ctx.code}
\`\`\`
${history}
Minimal fix only — change as few lines as possible.`,
  },
  {
    name: 'Intent Restorer',
    systemPrompt: `You are an expert programmer. Forget the broken code — read the task and write a fresh,
correct implementation from scratch. You are not patching; you are writing it right.
Return ONLY a code block with no explanation.`,
    userPrompt: (ctx, history) => `Task: ${ctx.originalPrompt.slice(0, 400)}
Language: ${ctx.language}
${history ? `Previous attempts failed:\n${history}\n` : ''}
Write a complete, correct implementation.`,
  },
  {
    name: 'Adversarial',
    systemPrompt: `You are a skeptical code reviewer. The obvious fix to this error is probably WRONG.
Look for the non-obvious issue: off-by-one errors, incorrect assumptions, wrong algorithm,
missing edge case handling, wrong data structure. Fix the real problem.
Return ONLY a corrected code block.`,
    userPrompt: (ctx, history) => `Language: ${ctx.language}
Error: ${ctx.errorMessage}

Code:
\`\`\`${ctx.language}
${ctx.code}
\`\`\`

The simple fix won't work. What is the ACTUAL underlying problem?${history ? `\n\nAttempts already tried:\n${history}` : ''}
Return corrected code only.`,
  },
]

// Models picked for architectural diversity — different training, different reasoning patterns
const ATTACK_MODELS: SelectedModel[] = [
  { id: 'groq/llama-3.3-70b-versatile',                    provider: 'groq',       label: 'Llama 3.3 70B',   isWildcard: false },
  { id: 'groq/qwen/qwen3-32b',                             provider: 'groq',       label: 'Qwen3 32B',       isWildcard: false },
  { id: 'mistral/mistral-small-latest',                    provider: 'mistral',    label: 'Mistral Small',   isWildcard: false },
  { id: 'openrouter/google/gemma-3-27b-it:free',           provider: 'openrouter', label: 'Gemma 3 27B',     isWildcard: false },
]

// ── Context assembly ────────────────────────────────────────────────────────

function extractFunctionScope(code: string, errorLine: number | null, language: Language): string {
  if (!errorLine) return code
  const lines = code.split('\n')
  if (errorLine > lines.length) return code

  // Walk backwards from the error line to find the enclosing function/def
  const funcPatterns: Record<string, RegExp> = {
    javascript: /^\s*(async\s+)?function\s+\w+|^\s*(const|let|var)\s+\w+\s*=\s*(async\s*)?\(/,
    typescript: /^\s*(async\s+)?function\s+\w+|^\s*(const|let|var)\s+\w+\s*=\s*(async\s*)?\(/,
    python:     /^\s*def\s+\w+|^\s*class\s+\w+/,
    bash:       /^\w+\s*\(\s*\)\s*\{/,
  }
  const pat = funcPatterns[language] ?? funcPatterns.javascript

  let start = Math.max(0, errorLine - 2)
  for (let i = errorLine - 1; i >= 0; i--) {
    if (pat.test(lines[i])) { start = i; break }
  }

  // Walk forwards to find the end (next function or end of file)
  let end = Math.min(lines.length - 1, errorLine + 10)
  for (let i = errorLine; i < lines.length; i++) {
    if (i > errorLine && pat.test(lines[i])) { end = i - 1; break }
    end = i
  }

  return lines.slice(start, end + 1).join('\n')
}

function extractIntent(prompt: string): string {
  // Pull the first imperative sentence — usually the clearest statement of intent
  const first = prompt.split(/[.!?]/)[0]?.trim() ?? prompt.slice(0, 120)
  return first.length > 10 ? first : prompt.slice(0, 200)
}

// ── Code extraction from model response ────────────────────────────────────

const CODE_BLOCK_RE = /```(?:\w+)?\n([\s\S]*?)```/g

function extractCode(response: string, language: Language): string | null {
  // Try fenced block first
  const matches = [...response.matchAll(CODE_BLOCK_RE)]
  if (matches.length > 0) {
    // Prefer a block matching the target language
    const langMatch = matches.find(m => m[0].startsWith(`\`\`\`${language}`))
    return (langMatch ?? matches[0])[1].trim()
  }
  // Fallback: response is raw code if it looks like code
  const trimmed = response.trim()
  if (trimmed.includes('\n') && trimmed.length > 20) return trimmed
  return null
}

// ── Score a code fix against the original intent ───────────────────────────
// Lightweight heuristic — doesn't use the full scoring engine (which needs
// a contract + PromptType classifier and is heavy). Just structural signals.

function quickScore(code: string, prompt: string, language: Language): number {
  let score = 0.5 // baseline

  // Length signal — very short fixes are suspicious for complex errors
  const lines = code.split('\n').filter(l => l.trim()).length
  if (lines >= 5) score += 0.1
  if (lines >= 15) score += 0.1

  // Has actual logic (not stub)
  if (/\bif\b|\bfor\b|\bwhile\b|\breturn\b/.test(code)) score += 0.1

  // Addresses keywords from the prompt
  const promptWords = new Set(prompt.toLowerCase().match(/\b\w{4,}\b/g) ?? [])
  const codeWords = new Set(code.toLowerCase().match(/\b\w{4,}\b/g) ?? [])
  const overlap = [...promptWords].filter(w => codeWords.has(w)).length
  score += Math.min(0.2, overlap * 0.03)

  // Language-specific: no undefined placeholders
  if (!/TODO|FIXME|NotImplemented|pass\s*$|\.\.\./.test(code)) score += 0.05

  // Doesn't use the exact same broken pattern
  // (crude: check if the error keyword is still there)

  return Math.min(1, score)
}

// ── Main pipeline ───────────────────────────────────────────────────────────

export async function runAnalysisPipeline(
  ctx: PipelineContext,
  callModel: ModelCaller,
  runSandbox: SandboxRunner,
  send: PipelineSend,
): Promise<boolean> {
  const { requestId } = ctx
  debugBus.emit('verify', 'analysis_start', { language: ctx.language, errorType: ctx.errorType }, { requestId })
  send({ type: 'analysis_start', message: 'Launching multi-model analysis...' })

  const functionScope = extractFunctionScope(ctx.code, ctx.errorLine, ctx.language)
  const intent = extractIntent(ctx.originalPrompt)

  let failureHistory = ''
  const MAX_ROUNDS = 2

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (round > 0) {
      send({ type: 'analysis_deepening', message: `Round ${round + 1}: deepening with failure context...` })
      debugBus.emit('verify', 'analysis_deepening', { round }, { requestId })
    }

    // ── Parallel attack: all 4 lenses fired simultaneously ─────────────────
    send({ type: 'analysis_status', message: `Firing ${LENSES.length} analysis threads in parallel...` })

    type Candidate = { lens: string; code: string; passed: boolean; score: number; error: string | null }

    const attackPromises = LENSES.map(async (lens, i): Promise<Candidate | null> => {
      const model = ATTACK_MODELS[i % ATTACK_MODELS.length]
      debugBus.emit('verify', 'attack_start', { lens: lens.name, model: model.id, round }, { requestId })
      send({ type: 'attack_start', lens: lens.name, attempt: i + 1, totalAttempts: LENSES.length })

      try {
        const response = await callModel(model, [
          { role: 'system', content: lens.systemPrompt },
          { role: 'user', content: lens.userPrompt(ctx, failureHistory) },
        ])

        const extracted = extractCode(response, ctx.language)
        if (!extracted) return null

        send({ type: 'candidate_proposed', lens: lens.name, message: `${lens.name}: candidate proposed` })
        debugBus.emit('verify', 'candidate_proposed', { lens: lens.name, codeLen: extracted.length }, { requestId })

        // Test in sandbox
        const result = await runSandbox(extracted, ctx.language, 8000)
        const passed = result.success

        send({ type: 'candidate_tested', lens: lens.name, message: `${lens.name}: ${passed ? 'PASSED' : 'failed'}` })
        debugBus.emit('verify', 'candidate_tested', {
          lens: lens.name, passed, error: result.error,
        }, { severity: passed ? 'success' : 'warn', requestId })

        const sc = passed ? quickScore(extracted, ctx.originalPrompt, ctx.language) : 0

        return { lens: lens.name, code: extracted, passed, score: sc, error: result.error }
      } catch (e: any) {
        debugBus.emit('verify', 'attack_start', { lens: lens.name, error: e.message }, { severity: 'error', requestId })
        return null
      }
    })

    const results = (await Promise.all(attackPromises)).filter(Boolean) as Candidate[]

    // ── Tournament: rank passing candidates by score ────────────────────────
    const passing = results.filter(r => r.passed).sort((a, b) => b.score - a.score)

    if (passing.length > 0) {
      const winner = passing[0]
      debugBus.emit('verify', 'analysis_fixed', {
        lens: winner.lens, score: winner.score, round,
        otherPassing: passing.length - 1,
      }, { severity: 'success', requestId })
      send({ type: 'analysis_fixed', code: winner.code, score: winner.score, lens: winner.lens,
             message: `Fixed by ${winner.lens} (score ${(winner.score * 100).toFixed(0)}/100)${passing.length > 1 ? ` — ${passing.length} candidates passed` : ''}` })
      return true
    }

    // ── Synthesis: no candidate passed — try to combine partial progress ────
    // Find candidates that produced a *different* error (made some progress)
    const partial = results.filter(r => !r.passed && r.error && r.error !== ctx.errorMessage)
    if (partial.length >= 2) {
      send({ type: 'synthesis_start', message: `Synthesizing from ${partial.length} partial fixes...` })
      debugBus.emit('verify', 'synthesis_start', { partialCount: partial.length, round }, { requestId })

      // Use the strongest available model to synthesize from partials
      const synthesizer = ATTACK_MODELS[0]
      const synthesisPrompt = `You have ${partial.length} incomplete fix attempts for this ${ctx.language} code.
Each got closer but didn't fully solve it. Combine their insights into one correct solution.

Original error: ${ctx.errorMessage}
Original code:
\`\`\`${ctx.language}
${ctx.code}
\`\`\`

Partial attempts (each fixed different parts):
${partial.map((p, i) => `Attempt ${i + 1} (${p.lens}):\n\`\`\`${ctx.language}\n${p.code}\n\`\`\`\nRemaining error: ${p.error}`).join('\n\n')}

Synthesize a single correct solution. Return only a code block.`

      try {
        const synthResponse = await callModel(synthesizer, [
          { role: 'system', content: 'You synthesize correct solutions from multiple partial fixes. Return ONLY a code block.' },
          { role: 'user', content: synthesisPrompt },
        ])
        const synthCode = extractCode(synthResponse, ctx.language)
        if (synthCode) {
          const synthResult = await runSandbox(synthCode, ctx.language, 8000)
          if (synthResult.success) {
            const sc = quickScore(synthCode, ctx.originalPrompt, ctx.language)
            debugBus.emit('verify', 'analysis_fixed', { lens: 'synthesis', score: sc, round }, { severity: 'success', requestId })
            send({ type: 'analysis_fixed', code: synthCode, score: sc, lens: 'synthesis', message: 'Fixed via synthesis of partial attempts' })
            return true
          }
        }
      } catch { /* synthesis failed, fall through to next round */ }
    }

    // Build failure history for the next round — inject what was tried
    failureHistory = results.length > 0
      ? `\nPrevious attempts in round ${round + 1} all failed:\n` +
        results.map(r => `- ${r.lens}: ${r.error?.slice(0, 120) ?? 'no output'}`).join('\n')
      : ''
  }

  // All rounds exhausted
  debugBus.emit('verify', 'analysis_failed', { rounds: MAX_ROUNDS }, { severity: 'error', requestId })
  send({ type: 'analysis_failed', error: `All ${LENSES.length * MAX_ROUNDS} attempts failed. Manual intervention required.` })
  return false
}
