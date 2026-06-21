// Planner — task decomposition into a compact JSON todo list, executed step-by-step
// by the agent loop. One strong-model call; no stored chain-of-thought.

import { runAgentLoop, compressObservation, defaultSystemPreamble } from './loop'
import type { AgentLoopResult, DriveTurn, VerifyResult } from './loop'
import { safeParseJSON } from '../tools/protocol'
import type { ToolCtx } from '../tools/protocol'

export interface Step {
  id: number
  intent: string
  files?: string[]
  doneCheck?: string
  status: 'pending' | 'active' | 'done' | 'failed'
}

export type PlanModel = (messages: Array<{ role: string; content: string }>) => Promise<string>

const PLAN_SYSTEM = `You are a planning module. Decompose the user's coding task into 2-6 concrete, ordered steps.
Reply with ONLY a JSON array, no prose:
[{"id":1,"intent":"<imperative step>","files":["optional file paths"],"doneCheck":"<how to tell it's done>"}, ...]
Steps must be small, verifiable, and in dependency order.`

export async function plan(goal: string, planModel: PlanModel): Promise<Step[]> {
  const raw = await planModel([
    { role: 'system', content: PLAN_SYSTEM },
    { role: 'user', content: goal },
  ])
  const steps = parseSteps(raw)
  // Planner output unusable → degrade to a single step; the loop still works.
  if (!steps.length) return [{ id: 1, intent: goal, status: 'pending' }]
  return steps
}

export async function replan(goal: string, steps: Step[], failure: string, planModel: PlanModel): Promise<Step[]> {
  const doneSteps = steps.filter(s => s.status === 'done')
  const raw = await planModel([
    { role: 'system', content: PLAN_SYSTEM },
    {
      role: 'user',
      content: `Task: ${goal}\nAlready completed: ${doneSteps.map(s => s.intent).join('; ') || '(none)'}\n` +
        `The previous approach FAILED with:\n${failure.slice(0, 1500)}\n\n` +
        `Produce a NEW plan for the remaining work only. Do NOT repeat the failed approach — ` +
        `diagnose why it failed and choose a fundamentally different method (different tool, ` +
        `different decomposition, or a smaller verifiable step).`,
    },
  ])
  const fresh = parseSteps(raw)
  // Empty replan → return only the done steps (no pending). The caller detects the
  // lack of new pending work and escalates instead of silently re-running failures.
  if (!fresh.length) return doneSteps
  let nextId = Math.max(0, ...doneSteps.map(s => s.id)) + 1
  return [...doneSteps, ...fresh.map(s => ({ ...s, id: nextId++, status: 'pending' as const }))]
}

/** Stable signature of a failure — step id + the first error-ish line, normalized. */
function failFingerprint(stepId: number, failure: string): string {
  const sig = (failure.split('\n').find(l => /error|fail|exception|cannot|undefined|not found/i.test(l)) ?? failure.slice(0, 120))
    .replace(/0x[0-9a-f]+/gi, '').replace(/\d+/g, 'N').trim().slice(0, 100)
  return `${stepId}:${sig}`
}

function parseSteps(raw: string): Step[] {
  // Tolerant: find the first [...] array, else a fenced block.
  const arrText = raw.match(/\[[\s\S]*\]/)?.[0]
  if (!arrText) return []
  let parsed: unknown
  try { parsed = JSON.parse(arrText) } catch {
    parsed = safeParseJSON(arrText.replace(/,\s*([\]}])/g, '$1'))  // trailing commas
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter((s: any) => s && typeof s.intent === 'string')
    .slice(0, 8)
    .map((s: any, i: number) => ({
      id: Number(s.id ?? i + 1),
      intent: s.intent,
      files: Array.isArray(s.files) ? s.files.map(String) : undefined,
      doneCheck: typeof s.doneCheck === 'string' ? s.doneCheck : undefined,
      status: 'pending' as const,
    }))
}

/** A goal that benefits from explicit decomposition (multi-part or long). */
export function needsPlan(goal: string): boolean {
  if (goal.length > 220) return true
  const conjunctions = (goal.match(/\b(then|and then|after that|finally|also)\b/gi) ?? []).length
  const listItems = (goal.match(/(^|\n)\s*([-*]|\d+[.)])\s/g) ?? []).length
  return conjunctions >= 2 || listItems >= 2
}

export interface PlannedTaskOpts {
  goal: string
  projectPath: string
  driveTurn: DriveTurn
  planModel: PlanModel
  emit: (event: Record<string, unknown>) => void
  signal?: AbortSignal
  makeVerify?: () => (finalText: string, ctx: ToolCtx) => Promise<VerifyResult>
  maxReplans?: number
  /** Resume a persisted task instead of planning fresh. */
  resume?: { steps: Step[]; completedSummaries: string[] }
  /** Called after the plan and after every step transition, for session persistence. */
  onPersist?: (steps: Step[], completedSummaries: string[], status: 'running' | 'done' | 'failed') => void
  /** Compressed project-memory digest injected into each step's driver preamble. */
  memoryDigest?: string
  /** Called after every loop iteration — forwarded to runAgentLoop for checkpoint writes. */
  onCheckpoint?: (messages: Array<Record<string, unknown>>, iter: number) => void
  /** Resume mid-step from a saved iteration checkpoint. */
  resumeCheckpoint?: { stepIndex: number; messages: Array<Record<string, unknown>> }
  /** Called when a file-mutating tool writes; forwarded to runAgentLoop. */
  onFileMutated?: (absPaths: string[]) => void
}

export interface PlannedTaskResult {
  ok: boolean
  steps: Step[]
  summary: string
}

/** Execute a multi-step task: plan once, run the loop per step, replan on failure. */
export async function runPlannedTask(opts: PlannedTaskOpts): Promise<PlannedTaskResult> {
  const { goal, projectPath, driveTurn, planModel, emit, signal, onPersist } = opts
  let steps: Step[]
  const completedSummaries: string[] = []
  if (opts.resume) {
    // Rehydrate: re-run only the unfinished steps.
    steps = opts.resume.steps
    completedSummaries.push(...opts.resume.completedSummaries)
    emit({ type: 'plan', steps: publicSteps(steps), resumed: true })
  } else {
    steps = await plan(goal, planModel)
    emit({ type: 'plan', steps: publicSteps(steps) })
  }
  onPersist?.(steps, completedSummaries, 'running')

  let replans = 0
  const maxReplans = opts.maxReplans ?? 2
  // Track per-step failure fingerprints so we escalate on a true loop (same step,
  // same error twice) instead of replanning into the same wall forever.
  const seenFailures = new Set<string>()

  for (let i = 0; i < steps.length; i++) {
    if (signal?.aborted) return { ok: false, steps, summary: 'Cancelled.' }
    const step = steps[i]
    if (step.status === 'done') continue
    step.status = 'active'
    emit({ type: 'step_status', id: step.id, status: 'active', intent: step.intent })

    const context = completedSummaries.length
      ? `Overall task: ${goal}\nCompleted so far:\n${completedSummaries.map(s => `- ${s}`).join('\n')}\n\nCurrent step: `
      : `Overall task: ${goal}\n\nCurrent step: `
    const result: AgentLoopResult = await runAgentLoop({
      goal: context + step.intent + (step.doneCheck ? `\nDone when: ${step.doneCheck}` : ''),
      projectPath,
      driveTurn,
      emit,
      signal,
      verify: opts.makeVerify?.(),
      maxIters: 20,
      stepIndex: i,
      stepTotal: steps.length,
      stepIntent: step.intent,
      onCheckpoint: opts.onCheckpoint,
      onFileMutated: opts.onFileMutated,
      initialMessages: opts.resumeCheckpoint?.stepIndex === i
        ? opts.resumeCheckpoint.messages
        : undefined,
      systemPreamble: opts.memoryDigest
        ? `${defaultSystemPreamble(projectPath)}\n\n${opts.memoryDigest}`
        : undefined,
    })

    // Clarification — the agent called ask_user and genuinely needs input to proceed.
    // Pause the plan WITHOUT marking the step done or failed (and without replanning):
    // surface the question and keep the task resumable so the user's reply re-enters
    // this exact step. Must be checked before the ok/done-check path so a question is
    // never mistaken for step completion.
    if (result.stopped === 'clarification') {
      step.status = 'pending'
      emit({ type: 'step_status', id: step.id, status: 'awaiting_input', intent: step.intent })
      onPersist?.(steps, completedSummaries, 'running')
      return { ok: false, steps, summary: result.finalText }
    }

    // C3 — done-check mini-verification: confirm the step actually satisfied its
    // acceptance criterion, not merely that the loop stopped. This catches silently
    // skipped sub-goals, especially when no runnable test exists (verify auto-passes).
    let doneCheckFailed = false
    if (result.ok && step.doneCheck && result.finalText.trim()) {
      try {
        const verdict = await planModel([
          { role: 'system', content: 'You are a strict step-completion judge. Reply with exactly "PASS" or "FAIL: <one-line reason>". Be skeptical: only PASS if the result clearly satisfies the criterion.' },
          { role: 'user', content: `Step intent: ${step.intent}\nAcceptance criterion: ${step.doneCheck}\n\nResult produced:\n${result.finalText.slice(0, 1500)}\n\nDid the result satisfy the acceptance criterion?` },
        ])
        if (/^\s*FAIL/i.test(verdict)) {
          doneCheckFailed = true
          // Reflect the real reason so the escalation summary doesn't read 'final'.
          result.stopped = 'verify_failed'
          result.finalText = `Step did not satisfy its done-check ("${step.doneCheck}"): ${verdict.replace(/^\s*FAIL:?\s*/i, '').slice(0, 200)}\n\n${result.finalText}`
          emit({ type: 'step_status', id: step.id, status: 'donecheck_failed', intent: step.intent })
        }
      } catch { /* judge unavailable (quota) — accept the step rather than block on judge error */ }
    }

    if (result.ok && !doneCheckFailed) {
      step.status = 'done'
      completedSummaries.push(`${step.intent} → ${compressObservation(result.finalText, 300)}`)
      emit({ type: 'step_status', id: step.id, status: 'done', intent: step.intent })
      onPersist?.(steps, completedSummaries, 'running')   // checkpoint after each step
      continue
    }

    step.status = 'failed'
    emit({ type: 'step_status', id: step.id, status: 'failed', intent: step.intent, stopped: result.stopped })
    if (result.stopped === 'cancelled') { onPersist?.(steps, completedSummaries, 'running'); return { ok: false, steps, summary: 'Cancelled.' } }

    // Escalate on a true loop: this exact step has already failed with this exact error.
    const fp = failFingerprint(step.id, result.finalText || result.stopped)
    const repeatedFailure = seenFailures.has(fp)
    seenFailures.add(fp)
    if (repeatedFailure || replans >= maxReplans) {
      emit({ type: 'step_stuck', id: step.id, intent: step.intent, reason: repeatedFailure ? 'repeated_failure' : 'replans_exhausted' })
      onPersist?.(steps, completedSummaries, 'failed')
      return { ok: false, steps, summary: `Stopped at step ${step.id} ("${step.intent}"): ${repeatedFailure ? 'the same failure recurred' : result.stopped}.\n${result.finalText}` }
    }
    replans++
    const replanned = await replan(goal, steps, result.finalText || result.stopped, planModel)
    // No new pending work produced (empty/degenerate replan) → escalate rather than loop.
    if (!replanned.some(s => s.status === 'pending')) {
      onPersist?.(steps, completedSummaries, 'failed')
      return { ok: false, steps, summary: `Stopped at step ${step.id} ("${step.intent}"): could not form a recovery plan.\n${result.finalText}` }
    }
    steps = replanned
    emit({ type: 'plan', steps: publicSteps(steps), replanned: true })
    onPersist?.(steps, completedSummaries, 'running')
    i = steps.findIndex(s => s.status !== 'done') - 1   // resume at first pending
  }

  const summary = completedSummaries.join('\n')
  emit({ type: 'plan_done', ok: true })
  onPersist?.(steps, completedSummaries, 'done')
  return { ok: true, steps, summary }
}

const publicSteps = (steps: Step[]) => steps.map(s => ({ id: s.id, intent: s.intent, status: s.status, doneCheck: s.doneCheck }))
