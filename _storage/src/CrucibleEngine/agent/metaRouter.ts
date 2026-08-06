// Meta-agent task router (Track I2) — decomposes a goal into subtasks,
// assigns each to the best specialist archetype, and orchestrates execution.
// I4 agent-to-agent consultation is also implemented here via consult().

import { decompose } from '../goalDecomposer'
import { isWebArtifactGoal } from './synthDriver'
import { selectArchetype, getArchetype, type ArchetypeId } from './archetypes'
import { writeScratch, readScratch, buildScratchContext, persistScratch, clearScratch } from './taskScratchpad'
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
  completeness: number          // 0-1: fraction of sub-goals that produced a real result
  confidence: 'high' | 'medium' | 'low'
  incompleteSubtasks: string[]  // descriptions of sub-goals that could not be completed
}

/** Wall-clock cap per subtask so one hung specialist can't stall the whole wave. */
const SUBTASK_TIMEOUT_MS = 120_000
/** Iteration cap per specialist loop — subtasks are focused sub-problems. */
const SUBTASK_MAX_ITERS = 8

/** A reroute target distinct from the first-choice archetype. */
function fallbackArchetype(a: ArchetypeId): ArchetypeId {
  if (a === 'coder') return 'strategist'
  if (a === 'researcher') return 'strategist'
  if (a === 'strategist') return 'researcher'
  return 'researcher'
}

// I2 — top-level orchestrator. Decomposes the goal into a dependency DAG, runs
// each subtask with the best specialist archetype in topological waves (parallel
// within a wave), retries/reroutes failures, blocks dependents of failed work,
// then runs an adversarial critic and a strategist synthesis.
export async function runMetaRouter(opts: MetaRouterOpts): Promise<MetaRouterResult> {
  const { goal, projectPath, taskId, runLoop, buildDriveTurn, emit, signal } = opts

  debugBus.emit('agent', 'meta_router_start', { taskId, goal: goal.slice(0, 80) }, { severity: 'info' })

  // Decompose into the real dependency tree. decompose() returns { nodes } where each
  // SubtaskNode has { id, goal, dependsOn[] }. The root (depth 0) is the overall goal;
  // the actual subtasks are the depth>0 nodes.
  // Single-artifact web builds (game/interactive HTML) must NOT be decomposed: the
  // coder path writes ONE runtime-verified file, and every extra subtask the splitter
  // invents ("also produce a web version…") re-enters the same game state machine and
  // rebuilds the identical artifact. Measured 2026-07-07: decompose+critic+synthesis
  // rebuilt game.html three times — all of the wall time past the first 3.5s build was
  // redundant. One coder subtask, no splitting.
  const webArtifact = isWebArtifactGoal(goal)
  const subNodes = webArtifact ? [] : decompose(goal).nodes.filter(n => n.depth > 0)
  const subIds = new Set(subNodes.map(n => n.id))
  const plans: SubtaskPlan[] = subNodes.map(n => ({
    id: n.id,
    description: n.goal,
    archetype: selectArchetype(n.goal),
    // Keep only dependencies that are themselves subtasks (drop the root edge).
    dependsOn: n.dependsOn.filter(d => subIds.has(d)),
    result: undefined,
    done: false,
  }))

  // No meaningful decomposition → single best-archetype pass over the whole goal.
  if (!plans.length) {
    plans.push({ id: 'st_0', description: goal, archetype: webArtifact ? 'coder' : selectArchetype(goal), dependsOn: [], result: undefined, done: false })
  }

  emit({ type: 'agent_meta', event: 'plan', subtasks: plans.map(p => ({ id: p.id, archetype: p.archetype, description: p.description, dependsOn: p.dependsOn })) })

  const byId = new Map(plans.map(p => [p.id, p]))
  const failed = new Set<string>()
  const blocked = new Set<string>()

  /** Run one subtask with a wall-clock timeout, retrying once via a fallback archetype. */
  async function runSubtask(subtask: SubtaskPlan): Promise<void> {
    const tryArchetypes: ArchetypeId[] = [subtask.archetype, fallbackArchetype(subtask.archetype)]
    for (let attempt = 0; attempt < tryArchetypes.length; attempt++) {
      if (signal?.aborted) return
      const arche = tryArchetypes[attempt]
      const archetype = getArchetype(arche)
      const scratchContext = buildScratchContext(taskId)
      const systemPreamble = archetype.systemPrompt + (scratchContext ? `\n\n${scratchContext}` : '')

      emit({ type: 'agent_meta', event: 'subtask_start', subtaskId: subtask.id, archetype: arche, attempt: attempt + 1 })
      debugBus.emit('agent', 'meta_subtask_start', { taskId, subtaskId: subtask.id, archetype: arche, attempt: attempt + 1 }, { severity: 'info' })

      // Per-subtask abort: fires on timeout or when the parent signal aborts.
      const subAc = new AbortController()
      const onParentAbort = () => subAc.abort()
      signal?.addEventListener('abort', onParentAbort)
      const timer = setTimeout(() => subAc.abort(), SUBTASK_TIMEOUT_MS)
      try {
        const result = await runLoop({
          goal: subtask.description,
          projectPath,
          driveTurn: buildDriveTurn(arche),
          emit,
          signal: subAc.signal,
          maxIters: SUBTASK_MAX_ITERS,
          systemPreamble,
        })
        if (result.ok && result.finalText.trim()) {
          subtask.result = result.finalText
          subtask.archetype = arche
          subtask.done = true
          writeScratch(taskId, subtask.id, result.finalText, arche)
          persistScratch(taskId, projectPath)   // durable after each subtask (crash-safe)
          emit({ type: 'agent_meta', event: 'subtask_done', subtaskId: subtask.id, archetype: arche })
          debugBus.emit('agent', 'meta_subtask_done', { taskId, subtaskId: subtask.id }, { severity: 'success' })
          return
        }
        // Not ok (verify_failed / stalled / max_iters / empty) → try the fallback archetype.
        debugBus.emit('agent', 'meta_subtask_retry', { taskId, subtaskId: subtask.id, from: arche, stopped: result.stopped }, { severity: 'warn' })
      } catch (e: any) {
        debugBus.emit('agent', 'meta_subtask_error', { taskId, subtaskId: subtask.id, archetype: arche, error: e?.message }, { severity: 'error' })
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onParentAbort)
      }
    }
    // All attempts exhausted.
    subtask.done = true
    failed.add(subtask.id)
    subtask.result = `[${subtask.archetype} could not complete this subtask after retries]`
    emit({ type: 'agent_meta', event: 'subtask_failed', subtaskId: subtask.id })
  }

  // Topological execution: run all dependency-satisfied subtasks in parallel, await
  // the wave, recompute the ready set, repeat. Dependents of failed/blocked work are
  // skipped (blocked) rather than run blind.
  // A valid DAG needs at most one wave per subtask (linear chain); +2 slack. Scaling
  // with plan count means large decompositions aren't silently truncated, while still
  // bounding against a pathological cycle.
  let guard = 0
  const maxWaves = plans.length + 2
  while (plans.some(p => !p.done) && guard++ < maxWaves) {
    if (signal?.aborted) break
    const ready = plans.filter(p => !p.done && p.dependsOn.every(d => byId.get(d)?.done ?? true))
    if (!ready.length) {
      // Remaining subtasks have an unsatisfiable dependency (cycle or all-blocked) — stop.
      plans.filter(p => !p.done).forEach(p => { p.done = true; blocked.add(p.id); p.result = '[blocked: dependency never completed]' })
      break
    }
    await Promise.all(ready.map(async (subtask) => {
      // If a dependency failed or was blocked, skip this subtask as blocked.
      if (subtask.dependsOn.some(d => failed.has(d) || blocked.has(d))) {
        subtask.done = true
        blocked.add(subtask.id)
        subtask.result = '[blocked: a prerequisite subtask did not complete]'
        emit({ type: 'agent_meta', event: 'subtask_blocked', subtaskId: subtask.id })
        return
      }
      await runSubtask(subtask)
    }))
  }
  // Safety sweep — if the guard ever exhausts (pathological input), don't leave subtasks
  // dangling: mark any still-undone plan as blocked so the audit/synthesis sees the gap.
  plans.filter(p => !p.done).forEach(p => { p.done = true; blocked.add(p.id); p.result = '[blocked: not reached before wave limit]' })

  // C1 — goal-completion audit: every planned sub-goal must have produced a real,
  // non-trivial result. Anything failed/blocked/empty is an explicit gap the synthesis
  // must surface rather than paper over.
  const isIncomplete = (p: SubtaskPlan) =>
    failed.has(p.id) || blocked.has(p.id) || !p.result ||
    p.result.trim().length < 40 || /^\[(blocked|.*failed|.*could not)/i.test(p.result.trim())
  const incompletePlans = plans.filter(isIncomplete)
  const completeness = plans.length ? (plans.length - incompletePlans.length) / plans.length : 0
  emit({ type: 'agent_meta', event: 'completeness', completed: plans.length - incompletePlans.length, total: plans.length, score: +completeness.toFixed(2) })
  debugBus.emit('agent', 'meta_completeness', { completed: plans.length - incompletePlans.length, total: plans.length, incomplete: incompletePlans.map(p => p.id) }, { severity: incompletePlans.length ? 'warn' : 'success' })

  // Critic pass (I5) — adversarial audit of all completed subtask results
  const draftAnswer = plans.filter(p => p.result).map(p => `[${p.archetype}]: ${p.result}`).join('\n\n')
  let criticFindings: string | null = null

  // Runtime-verified artifact fast path: the coder subtask's game/HTML write already
  // passed a REAL execution gate (loaded in Electron offscreen, keys pressed, canvas
  // drawn, zero page errors) — strictly stronger evidence than a prose critic re-read.
  // Worse, the critic/synthesis prompts embed the goal, so both re-enter the game state
  // machine and rebuild the identical file (measured: 2 redundant rebuilds per run).
  // Return the specialist's answer directly.
  if (webArtifact && incompletePlans.length === 0) {
    emit({ type: 'agent_meta', event: 'confidence', confidence: 'high', completeness: 1 })
    debugBus.emit('agent', 'meta_router_done', { taskId, subtaskCount: plans.length, completeness: 1, confidence: 'high', fastPath: 'runtime-verified-artifact' }, { severity: 'success' })
    try { persistScratch(taskId, projectPath); clearScratch(taskId) } catch {}
    return { finalAnswer: draftAnswer.replace(/^\[\w+\]:\s*/, ''), subtasks: plans, criticFindings: null, completeness: 1, confidence: 'high', incompleteSubtasks: [] }
  }
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
  const gapNote = incompletePlans.length
    ? `\n\nIMPORTANT — these sub-goals could NOT be completed: ${incompletePlans.map(p => `"${p.description.slice(0, 80)}"`).join('; ')}. ` +
      `Explicitly tell the user these parts are incomplete (and why, if known) rather than pretending they were done.`
    : ''
  let finalAnswer = draftAnswer
  try {
    const synthContext = buildScratchContext(taskId)
    const strategistResult = await runLoop({
      goal: `Synthesize a final answer for: "${goal.slice(0, 120)}". Draw on all specialist outputs in the scratchpad. If the Critic flagged problems, address them or explicitly caveat them. Return the complete answer the user should see.${gapNote}`,
      projectPath,
      driveTurn: buildDriveTurn('strategist'),
      emit,
      signal,
      maxIters: 4,
      systemPreamble: getArchetype('strategist').systemPrompt + (synthContext ? `\n\n${synthContext}` : ''),
    })
    if (strategistResult.finalText.trim()) finalAnswer = strategistResult.finalText
  } catch {}

  // C5 — confidence signal: full completion + no significant critic findings → high.
  const criticFlaggedMajor = !!criticFindings && /significant|wrong|incorrect|critical|missing|flaw|contradic/i.test(criticFindings)
  const confidence: MetaRouterResult['confidence'] =
    incompletePlans.length === 0
      ? (criticFlaggedMajor ? 'medium' : 'high')
      : (completeness >= 0.5 ? 'medium' : 'low')
  emit({ type: 'agent_meta', event: 'confidence', confidence, completeness: +completeness.toFixed(2) })

  // Best-effort cleanup — a filesystem hiccup here must never discard the finished answer.
  // Persist the durable record, then free ONLY the in-memory pad (no dir arg) so the
  // crash-safe scratchpad file survives for post-hoc inspection/recovery.
  try {
    persistScratch(taskId, projectPath)
    clearScratch(taskId)
  } catch (e: any) {
    debugBus.emit('agent', 'meta_scratch_cleanup_error', { taskId, error: e?.message }, { severity: 'warn' })
  }
  debugBus.emit('agent', 'meta_router_done', { taskId, subtaskCount: plans.length, completeness: +completeness.toFixed(2), confidence }, { severity: 'success' })

  return { finalAnswer, subtasks: plans, criticFindings, completeness, confidence, incompleteSubtasks: incompletePlans.map(p => p.description) }
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
