// Meta-agent task router (Track I2) — decomposes a goal into subtasks,
// assigns each to the best specialist archetype, and orchestrates execution.
// I4 agent-to-agent consultation is also implemented here via consult().

import { decompose } from '../goalDecomposer'
import { selectArchetype, getArchetype, type ArchetypeId } from './archetypes'
import { writeScratch, readScratch, buildScratchContext, persistScratch } from './taskScratchpad'
import { debugBus } from '../debug/bus'
import type { AgentLoopOpts, AgentLoopResult } from './loop'

export interface SubtaskPlan {
  id: string
  description: string
  archetype: ArchetypeId
  dependsOn: string[]   // other subtask ids that must complete first
  result?: string
  done: boolean
}

export interface MetaRouterOpts {
  goal: string
  projectPath: string
  taskId: string
  /** Run a single agent loop turn — provided by server to avoid circular imports */
  runLoop: (opts: AgentLoopOpts) => Promise<AgentLoopResult>
  /** Build a DriveTurn for a given archetype */
  buildDriveTurn: (archetype: ArchetypeId) => AgentLoopOpts['driveTurn']
  emit: (event: Record<string, unknown>) => void
  signal?: AbortSignal
}

export interface MetaRouterResult {
  finalAnswer: string
  subtasks: SubtaskPlan[]
  criticFindings: string | null
}

// I2 — top-level orchestrator
export async function runMetaRouter(opts: MetaRouterOpts): Promise<MetaRouterResult> {
  const { goal, projectPath, taskId, runLoop, buildDriveTurn, emit, signal } = opts

  debugBus.emit('agent', 'meta_router_start', { taskId, goal: goal.slice(0, 80) }, { severity: 'info' })

  // Decompose goal into subtasks
  const tree = decompose(goal)
  const plans: SubtaskPlan[] = tree.subtasks.map((s, i) => ({
    id: `st_${i}`,
    description: s.intent,
    archetype: selectArchetype(s.intent),
    dependsOn: i === 0 ? [] : [],  // heuristic: first pass all parallel; seq only if explicit dep
    result: undefined,
    done: false,
  }))

  // If no meaningful decomposition, fall back to single researcher pass
  if (!plans.length) {
    plans.push({ id: 'st_0', description: goal, archetype: 'researcher', dependsOn: [], result: undefined, done: false })
  }

  emit({ type: 'agent_meta', event: 'plan', subtasks: plans.map(p => ({ id: p.id, archetype: p.archetype, description: p.description })) })

  // Execute subtasks — parallel where no deps, sequential where deps exist
  const pending = [...plans]
  let iters = 0
  while (pending.some(p => !p.done) && iters < 20) {
    iters++
    // Find runnable (all deps done)
    const runnable = pending.filter(p => !p.done && p.dependsOn.every(dep => plans.find(pl => pl.id === dep)?.done))
    if (!runnable.length) break

    await Promise.all(runnable.map(async (subtask) => {
      if (signal?.aborted) return
      const archetype = getArchetype(subtask.archetype)
      const scratchContext = buildScratchContext(taskId)
      const systemPreamble = archetype.systemPrompt + (scratchContext ? `\n\n${scratchContext}` : '')

      debugBus.emit('agent', 'meta_subtask_start', { taskId, subtaskId: subtask.id, archetype: subtask.archetype }, { severity: 'info' })
      emit({ type: 'agent_meta', event: 'subtask_start', subtaskId: subtask.id, archetype: subtask.archetype })

      try {
        const result = await runLoop({
          goal: subtask.description,
          projectPath,
          driveTurn: buildDriveTurn(subtask.archetype),
          emit,
          signal,
          maxIters: 6,
          systemPreamble,
        })
        subtask.result = result.finalText
        subtask.done = true
        // Write result to scratchpad so other archetypes can read it
        writeScratch(taskId, subtask.id, result.finalText, subtask.archetype)
        emit({ type: 'agent_meta', event: 'subtask_done', subtaskId: subtask.id, archetype: subtask.archetype })
        debugBus.emit('agent', 'meta_subtask_done', { taskId, subtaskId: subtask.id }, { severity: 'success' })
      } catch (e: any) {
        subtask.done = true  // mark done even on failure so we don't loop forever
        subtask.result = `[${subtask.archetype} failed: ${e.message}]`
        debugBus.emit('agent', 'meta_subtask_error', { taskId, subtaskId: subtask.id, error: e.message }, { severity: 'error' })
      }
    }))
  }

  // Critic pass (I5) — adversarial audit of all completed subtask results
  const draftAnswer = plans.filter(p => p.result).map(p => `[${p.archetype}]: ${p.result}`).join('\n\n')
  let criticFindings: string | null = null
  try {
    const criticContext = `Goal: ${goal}\n\nDraft outputs:\n${draftAnswer}`
    const criticResult = await runLoop({
      goal: `Adversarially review these outputs for the goal: "${goal.slice(0, 120)}". Find the three most significant problems — things that are wrong, incomplete, or overconfident. Do not find minor stylistic issues.`,
      projectPath,
      driveTurn: buildDriveTurn('critic'),
      emit,
      signal,
      maxIters: 3,
      systemPreamble: getArchetype('critic').systemPrompt + `\n\nMaterial to review:\n${criticContext.slice(0, 3000)}`,
    })
    criticFindings = criticResult.finalText
    writeScratch(taskId, 'critic_review', criticFindings, 'critic', 0.9)
    emit({ type: 'agent_meta', event: 'critic_done', findings: criticFindings.slice(0, 200) })
  } catch {}

  // Strategist synthesizes final answer with all context available
  let finalAnswer = draftAnswer
  try {
    const synthContext = buildScratchContext(taskId)
    const strategistResult = await runLoop({
      goal: `Synthesize a final answer for: "${goal.slice(0, 120)}". Draw on all specialist outputs in the scratchpad. If the Critic flagged problems, address them or explicitly caveat them. Return the complete answer the user should see.`,
      projectPath,
      driveTurn: buildDriveTurn('strategist'),
      emit,
      signal,
      maxIters: 4,
      systemPreamble: getArchetype('strategist').systemPrompt + (synthContext ? `\n\n${synthContext}` : ''),
    })
    finalAnswer = strategistResult.finalText
  } catch {}

  persistScratch(taskId, projectPath)
  debugBus.emit('agent', 'meta_router_done', { taskId, subtaskCount: plans.length }, { severity: 'success' })

  return { finalAnswer, subtasks: plans, criticFindings }
}

// I4 — agent-to-agent consultation: specialist asks another specialist a focused question
// Returns the consulted specialist's answer. Max depth 1 (no recursion).
export async function consult(
  taskId: string,
  archetype: ArchetypeId,
  question: string,
  runLoop: MetaRouterOpts['runLoop'],
  buildDriveTurn: MetaRouterOpts['buildDriveTurn'],
  emit: MetaRouterOpts['emit'],
  projectPath: string,
  signal?: AbortSignal,
): Promise<string> {
  debugBus.emit('agent', 'agent_consultation', { taskId, targetArchetype: archetype, question: question.slice(0, 80) }, { severity: 'info' })
  emit({ type: 'agent_meta', event: 'consultation', targetArchetype: archetype, question: question.slice(0, 80) })

  try {
    const result = await runLoop({
      goal: question,
      projectPath,
      driveTurn: buildDriveTurn(archetype),
      emit,
      signal,
      maxIters: 3,
      systemPreamble: getArchetype(archetype).systemPrompt,
    })
    debugBus.emit('agent', 'agent_consultation_done', { taskId, targetArchetype: archetype }, { severity: 'success' })
    return result.finalText
  } catch (e: any) {
    return `[consultation with ${archetype} failed: ${e.message}]`
  }
}
