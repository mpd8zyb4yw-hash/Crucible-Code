// Track O — Long-horizon cross-session planning
// Detects structural dependencies across sessions. Surfaces what needs to exist
// before the user's current goal is achievable, even if they haven't asked yet.

import fs from 'fs'
import path from 'path'
import { debugBus } from './debug/bus'

export interface HorizonTask {
  id: string
  description: string
  status: 'pending' | 'in_progress' | 'done'
  createdAt: number
  updatedAt: number
  dependencies: string[]   // ids of tasks that must complete first
  sessionOrigin: string    // requestId or session key that created this
}

export interface HorizonPlan {
  goalSummary: string
  tasks: HorizonTask[]
  lastUpdated: number
}

const PLAN_FILE = '.crucible/horizon-plan.json'
const MAX_TASKS = 30

function planPath(dir: string) { return path.join(dir, PLAN_FILE) }

function loadPlan(dir: string): HorizonPlan | null {
  try {
    return JSON.parse(fs.readFileSync(planPath(dir), 'utf8')) as HorizonPlan
  } catch {
    return null
  }
}

function savePlan(dir: string, plan: HorizonPlan): void {
  const p = planPath(dir)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  plan.tasks = plan.tasks.slice(-MAX_TASKS)
  fs.writeFileSync(p, JSON.stringify(plan, null, 2))
}

// Check if the current query is likely a continuation of an in-progress horizon plan
function isContinuation(plan: HorizonPlan, query: string): boolean {
  const qLower = query.toLowerCase()
  const pending = plan.tasks.filter(t => t.status !== 'done')
  if (pending.length === 0) return false
  // Simple overlap: if 2+ keywords from any pending task description appear in query
  for (const task of pending) {
    const taskWords = task.description.toLowerCase().split(/\s+/).filter(w => w.length > 4)
    const matches = taskWords.filter(w => qLower.includes(w))
    if (matches.length >= 2) return true
  }
  return false
}

// Build a planning context block to inject into Stage 1
export function getLongHorizonContext(dir: string, query: string, requestId: string): string {
  const plan = loadPlan(dir)
  if (!plan) return ''

  const continuation = isContinuation(plan, query)
  if (!continuation) return ''

  const pending = plan.tasks.filter(t => t.status === 'pending')
  const inProgress = plan.tasks.filter(t => t.status === 'in_progress')

  if (pending.length === 0 && inProgress.length === 0) return ''

  debugBus.emit('pipeline', 'long_horizon_context_injected', { planGoal: plan.goalSummary, pendingCount: pending.length, requestId }, { severity: 'info', requestId })

  const lines = [
    `[Long-horizon plan: "${plan.goalSummary}"]`,
    ...(inProgress.map(t => `- In progress: ${t.description}`)),
    ...(pending.slice(0, 3).map(t => `- Still needed: ${t.description}`)),
  ]
  return lines.join('\n')
}

// Add tasks to the horizon plan (called when L2 decomposition runs on a complex query)
export function extendHorizonPlan(dir: string, goalSummary: string, subtasks: string[], sessionKey: string): void {
  const existing = loadPlan(dir)
  const now = Date.now()
  const tasks: HorizonTask[] = subtasks.map((desc, i) => ({
    id: `ht-${now}-${i}`,
    description: desc,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    dependencies: i > 0 ? [] : [],  // could infer deps from order — kept flat for now
    sessionOrigin: sessionKey,
  }))

  if (existing) {
    // Merge: don't re-add tasks that already appear by description similarity
    const newTasks = tasks.filter(t => !existing.tasks.some(e =>
      e.description.toLowerCase().slice(0, 40) === t.description.toLowerCase().slice(0, 40)
    ))
    existing.tasks.push(...newTasks)
    existing.goalSummary = goalSummary
    existing.lastUpdated = now
    savePlan(dir, existing)
  } else {
    savePlan(dir, { goalSummary, tasks, lastUpdated: now })
  }
}

// Mark a task as done by description match
export function markHorizonTaskDone(dir: string, description: string): void {
  const plan = loadPlan(dir)
  if (!plan) return
  const lower = description.toLowerCase()
  let changed = false
  for (const task of plan.tasks) {
    if (task.status !== 'done' && task.description.toLowerCase().includes(lower.slice(0, 30))) {
      task.status = 'done'
      task.updatedAt = Date.now()
      changed = true
    }
  }
  if (changed) savePlan(dir, { ...plan, lastUpdated: Date.now() })
}

export function getHorizonPlan(dir: string): HorizonPlan | null {
  return loadPlan(dir)
}
