// Persistent task plan — the long-horizon primitive for unattended runs.
//
// The scratchpad (taskScratchpad.ts) stores *facts* a task has learned. This stores the
// *plan*: an ordered, model-updatable list of steps with status. It is what lets an agent
// keep the thread across dozens of turns and, critically, know when it is finished — the
// missing piece behind the roadmap's "zero prompts after the first" goal.
//
// Free-tier philosophy: every invariant here is enforced deterministically in client code,
// never by asking a model to be disciplined. A weak model that emits a sloppy plan still
// ends up with a well-formed one.

import fs from 'fs'
import path from 'path'
import { debugBus } from '../debug/bus'

export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked'

export interface PlanStep {
  step: string
  status: StepStatus
  /** Why a step is blocked, or what completing it produced. */
  note?: string
}

export interface TaskPlan {
  goal: string
  steps: PlanStep[]
  updatedAt: number
}

const STATUSES: StepStatus[] = ['pending', 'in_progress', 'completed', 'blocked']
const plans = new Map<string, TaskPlan>()

function planFile(projectPath: string) {
  return path.join(projectPath, '.crucible', 'plan.json')
}

/** Normalize a step's text so a replan can be matched against prior progress. */
function stepKey(step: string): string {
  return step.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim()
}

function coerceStatus(raw: unknown): StepStatus {
  const s = String(raw ?? 'pending').toLowerCase().trim()
  return (STATUSES as string[]).includes(s) ? (s as StepStatus) : 'pending'
}

/**
 * Enforce the plan invariants that a free model reliably violates:
 *  - at most one step in_progress (later ones demote to pending)
 *  - blank steps dropped, duplicates collapsed
 *  - if nothing is in_progress and work remains, the first pending step is promoted,
 *    so an unattended run always has an unambiguous "current step"
 */
export function normalizeSteps(raw: Array<Partial<PlanStep>>): PlanStep[] {
  const seen = new Set<string>()
  const steps: PlanStep[] = []
  for (const r of raw ?? []) {
    const text = String(r?.step ?? '').trim()
    if (!text) continue
    const key = stepKey(text)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const note = r?.note == null ? undefined : String(r.note).trim() || undefined
    steps.push({ step: text, status: coerceStatus(r?.status), note })
  }

  let active = false
  for (const s of steps) {
    if (s.status !== 'in_progress') continue
    if (active) s.status = 'pending'
    else active = true
  }
  if (!active) {
    const next = steps.find(s => s.status === 'pending')
    if (next) next.status = 'in_progress'
  }
  return steps
}

/**
 * Merge a new step list over the existing one, carrying forward the status of any step
 * whose text still matches. Without this, a mid-run replan silently resets completed work
 * and the agent redoes it — the classic long-horizon failure.
 */
export function mergePreservingProgress(prev: PlanStep[], next: PlanStep[]): PlanStep[] {
  const prior = new Map(prev.map(s => [stepKey(s.step), s]))
  const merged = next.map(s => {
    const old = prior.get(stepKey(s.step))
    if (!old) return s
    // `blocked` is always an explicit report that something regressed — it must be able to
    // reopen even a completed step, or a late-discovered failure gets silently hidden.
    if (s.status === 'blocked') return { step: s.step, status: 'blocked', note: s.note ?? old.note }
    // Otherwise an explicit forward move in the incoming plan wins; else keep what we knew.
    const rank = (st: StepStatus) => STATUSES.indexOf(st === 'blocked' ? 'in_progress' : st)
    const keepOld = rank(old.status) > rank(s.status)
    return { step: s.step, status: keepOld ? old.status : s.status, note: s.note ?? old.note }
  })
  return normalizeSteps(merged)
}

export function getPlan(projectPath: string): TaskPlan | null {
  const cached = plans.get(projectPath)
  if (cached) return cached
  try {
    const parsed = JSON.parse(fs.readFileSync(planFile(projectPath), 'utf-8')) as TaskPlan
    if (!Array.isArray(parsed?.steps)) return null
    plans.set(projectPath, parsed)
    return parsed
  } catch {
    return null
  }
}

export function savePlan(projectPath: string, plan: TaskPlan): void {
  plans.set(projectPath, plan)
  try {
    const file = planFile(projectPath)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(plan, null, 2))
  } catch { /* persistence is best-effort — the in-memory plan still drives the run */ }
}

export function clearPlan(projectPath: string): void {
  plans.delete(projectPath)
  try { fs.unlinkSync(planFile(projectPath)) } catch {}
}

export interface PlanProgress {
  total: number
  completed: number
  current: PlanStep | null
  blocked: PlanStep[]
  /** True when there is a plan and no step is still pending/in_progress. */
  done: boolean
}

export function planProgress(plan: TaskPlan | null): PlanProgress {
  const steps = plan?.steps ?? []
  const completed = steps.filter(s => s.status === 'completed').length
  const blocked = steps.filter(s => s.status === 'blocked')
  return {
    total: steps.length,
    completed,
    current: steps.find(s => s.status === 'in_progress') ?? null,
    blocked,
    done: steps.length > 0 && !steps.some(s => s.status === 'pending' || s.status === 'in_progress'),
  }
}

const MARK: Record<StepStatus, string> = {
  completed: '[x]',
  in_progress: '[>]',
  blocked: '[!]',
  pending: '[ ]',
}

/** Render the plan back to the model. Re-reading its own state each turn is what keeps
 *  a long run coherent, so every update_plan call returns this. */
export function renderPlan(plan: TaskPlan | null): string {
  if (!plan || !plan.steps.length) return 'No plan set. Call update_plan with the steps you intend to take.'
  const p = planProgress(plan)
  const lines = plan.steps.map((s, i) => `${i + 1}. ${MARK[s.status]} ${s.step}${s.note ? ` — ${s.note}` : ''}`)
  const head = `Plan${plan.goal ? ` for: ${plan.goal}` : ''} (${p.completed}/${p.total} complete)`
  const foot = p.done
    ? p.blocked.length
      ? '\nAll steps resolved, but some are blocked. Report what is blocked and why — do not claim success.'
      : '\nAll steps complete. Give your final answer now; do not call more tools.'
    : p.current
      ? `\nCurrent step: ${p.current.step}`
      : ''
  return `${head}\n${lines.join('\n')}${foot}`
}

/** Compact plan state for injection into a system preamble. Empty string when no plan,
 *  so callers can append unconditionally. */
export function buildPlanContext(projectPath: string): string {
  const plan = getPlan(projectPath)
  if (!plan || !plan.steps.length) return ''
  return `\n\nYour current plan (maintain it with update_plan):\n${renderPlan(plan)}`
}

export interface ApplyPlanInput {
  goal?: string
  steps?: Array<Partial<PlanStep>>
}

/** Apply a model-supplied plan update. Returns the rendered result to hand back as tool output. */
export function applyPlanUpdate(projectPath: string, input: ApplyPlanInput): { plan: TaskPlan; rendered: string; progress: PlanProgress } {
  const prev = getPlan(projectPath)
  const incoming = normalizeSteps(input.steps ?? [])
  const steps = prev ? mergePreservingProgress(prev.steps, incoming) : incoming
  const plan: TaskPlan = {
    goal: String(input.goal ?? prev?.goal ?? '').trim(),
    steps,
    updatedAt: Date.now(),
  }
  savePlan(projectPath, plan)
  const progress = planProgress(plan)
  debugBus.emit('agent', 'plan_update', {
    goal: plan.goal,
    total: progress.total,
    completed: progress.completed,
    current: progress.current?.step,
    done: progress.done,
  })
  return { plan, rendered: renderPlan(plan), progress }
}
