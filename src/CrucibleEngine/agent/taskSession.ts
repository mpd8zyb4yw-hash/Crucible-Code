// Stateful agent session store — persists task context across Remote Brain turns.
// Keyed by sessionId (cross-device identifier from the frontend).
//
// Design:
// - One AgentSession per sessionId
// - Stores the accumulated message history (for context continuity across redirects)
// - Stores the active AbortController so in-flight tasks can be cancelled on redirect
// - Maintains a task stack: current goal + prior completed steps
// - Kept in memory only (node process restart resets it — intentional for simplicity)

export interface TaskStep {
  goal: string
  completedAt: number
  summary: string
}

export interface AgentSession {
  sessionId: string
  currentGoal: string | null
  taskStack: TaskStep[]          // completed prior steps, oldest first
  messages: Array<Record<string, unknown>>  // accumulated conversation messages
  ac: AbortController | null    // active abort controller (null when idle)
  status: 'idle' | 'running'
  lastUpdated: number
}

const sessions = new Map<string, AgentSession>()

export function getOrCreateSession(sessionId: string): AgentSession {
  let s = sessions.get(sessionId)
  if (!s) {
    s = {
      sessionId,
      currentGoal: null,
      taskStack: [],
      messages: [],
      ac: null,
      status: 'idle',
      lastUpdated: Date.now(),
    }
    sessions.set(sessionId, s)
  }
  return s
}

export function getSession(sessionId: string): AgentSession | undefined {
  return sessions.get(sessionId)
}

/** Begin a new task. If one is running, abort it first. */
export function startTask(sessionId: string, goal: string): AbortController {
  const s = getOrCreateSession(sessionId)
  // Abort any currently running task
  if (s.ac && s.status === 'running') {
    s.ac.abort()
  }
  const ac = new AbortController()
  s.ac = ac
  s.currentGoal = goal
  s.status = 'running'
  s.lastUpdated = Date.now()
  return ac
}

/** Called when a task completes (success or failure). */
export function completeTask(sessionId: string, summary: string, finalMessages: Array<Record<string, unknown>>) {
  const s = sessions.get(sessionId)
  if (!s) return
  if (s.currentGoal) {
    s.taskStack.push({ goal: s.currentGoal, completedAt: Date.now(), summary })
    // Keep stack bounded to last 10 completed steps
    if (s.taskStack.length > 10) s.taskStack.splice(0, s.taskStack.length - 10)
  }
  // Accumulate messages for context continuity
  // Replace system message with latest, append new turns
  const newNonSystem = finalMessages.filter(m => m.role !== 'system')
  const existingNonSystem = s.messages.filter(m => m.role !== 'system')
  const systemMsg = finalMessages.find(m => m.role === 'system')
  s.messages = [
    ...(systemMsg ? [systemMsg] : []),
    ...existingNonSystem,
    ...newNonSystem,
  ]
  // Cap accumulated messages at 40 entries to avoid context explosion
  const sys = s.messages.filter(m => m.role === 'system')
  const rest = s.messages.filter(m => m.role !== 'system')
  if (rest.length > 40) rest.splice(0, rest.length - 40)
  s.messages = [...sys, ...rest]

  s.ac = null
  s.currentGoal = null
  s.status = 'idle'
  s.lastUpdated = Date.now()
}

/** Abort the current in-flight task (for redirect handling). Returns true if something was aborted. */
export function abortCurrentTask(sessionId: string): boolean {
  const s = sessions.get(sessionId)
  if (!s || !s.ac || s.status !== 'running') return false
  s.ac.abort()
  s.ac = null
  s.status = 'idle'
  // Keep messages and taskStack — redirect inherits context
  return true
}

/** Build a task history digest to inject into the system prompt for context continuity. */
export function buildTaskContext(sessionId: string): string {
  const s = sessions.get(sessionId)
  if (!s || s.taskStack.length === 0) return ''
  const lines = s.taskStack.slice(-5).map((t, i) =>
    `Step ${i + 1}: ${t.goal.slice(0, 80)} → ${t.summary.slice(0, 120)}`
  )
  return `TASK HISTORY (completed steps this session):\n${lines.join('\n')}`
}

/** Get accumulated messages for context continuity across turns. */
export function getSessionMessages(sessionId: string): Array<Record<string, unknown>> {
  return sessions.get(sessionId)?.messages ?? []
}

/** Purge sessions idle for more than 2 hours. */
export function purgeStaleSessions() {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000
  for (const [id, s] of sessions) {
    if (s.lastUpdated < cutoff) sessions.delete(id)
  }
}

// Purge stale sessions every 30 minutes
setInterval(purgeStaleSessions, 30 * 60 * 1000)
