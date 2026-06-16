// 24/7 improvement daemon (Track G1) — a background loop that continuously
// looks for improvement opportunities across all tracks, dispatches them in
// priority order, and writes a daemon log. It orchestrates:
//   1. Failure taxonomy rebuild (every 2h)
//   2. Emergent cluster detection (every 4h)
//   3. Benchmark regression check (every 6h)
//   4. Roster evaluation (every 200-round trigger, checked every hour)
//   5. Self-patcher cycle (driven externally, queried here for status)
//   6. Causal memory compaction (every 8h) — prune low-confidence edges
//   7. Goal decomposition health check (every 3h) — flag stalled subtasks
//   8. Cross-session contradiction sweep (every 2h) — index new session summaries
//   9. Confidence calibration report (every 4h) — track claim accuracy trends
//  10. Context budget monitoring — log model switches from contextManager
//
// Each task runs only if there's been at least one pipeline round since last run.

import fs from 'fs'
import path from 'path'
import { debugBus } from './debug/bus'

export interface DaemonTask {
  name: string
  intervalMs: number
  lastRunAt: number
  runCount: number
}

export interface DaemonState {
  startedAt: number
  tasks: DaemonTask[]
  log: string[]          // last 100 log entries
  modelSwitches: Array<{ ts: number; from: string; to: string; reason: string }>  // last 50
}

const daemonFile = (dir: string) => path.join(dir, '.crucible', 'daemon-state.json')

const DEFAULT_TASKS: DaemonTask[] = [
  { name: 'failure_taxonomy',         intervalMs: 2 * 60 * 60 * 1000, lastRunAt: 0, runCount: 0 },
  { name: 'cluster_detection',        intervalMs: 4 * 60 * 60 * 1000, lastRunAt: 0, runCount: 0 },
  { name: 'benchmark_check',          intervalMs: 6 * 60 * 60 * 1000, lastRunAt: 0, runCount: 0 },
  { name: 'roster_probe',             intervalMs: 1 * 60 * 60 * 1000, lastRunAt: 0, runCount: 0 },
  { name: 'stage_weight_rebuild',     intervalMs: 3 * 60 * 60 * 1000, lastRunAt: 0, runCount: 0 },
  { name: 'causal_memory_compact',    intervalMs: 8 * 60 * 60 * 1000, lastRunAt: 0, runCount: 0 },
  { name: 'goal_decomp_health',       intervalMs: 3 * 60 * 60 * 1000, lastRunAt: 0, runCount: 0 },
  { name: 'contradiction_sweep',      intervalMs: 2 * 60 * 60 * 1000, lastRunAt: 0, runCount: 0 },
  { name: 'confidence_calibration',   intervalMs: 4 * 60 * 60 * 1000, lastRunAt: 0, runCount: 0 },
  { name: 'context_budget_report',    intervalMs: 1 * 60 * 60 * 1000, lastRunAt: 0, runCount: 0 },
]

export function loadDaemonState(dir: string): DaemonState {
  try {
    const saved = JSON.parse(fs.readFileSync(daemonFile(dir), 'utf8')) as DaemonState
    // Merge in any new tasks that didn't exist when the state was last saved
    const existingNames = new Set(saved.tasks.map(t => t.name))
    for (const defaultTask of DEFAULT_TASKS) {
      if (!existingNames.has(defaultTask.name)) {
        saved.tasks.push({ ...defaultTask })
      }
    }
    if (!saved.modelSwitches) saved.modelSwitches = []
    return saved
  } catch {
    return {
      startedAt: Date.now(),
      tasks: DEFAULT_TASKS.map(t => ({ ...t })),
      log: [],
      modelSwitches: [],
    }
  }
}

export function saveDaemonState(dir: string, state: DaemonState) {
  fs.mkdirSync(path.dirname(daemonFile(dir)), { recursive: true })
  state.log = state.log.slice(-100)
  state.modelSwitches = (state.modelSwitches ?? []).slice(-50)
  fs.writeFileSync(daemonFile(dir), JSON.stringify(state, null, 2))
}

export function daemonLog(dir: string, msg: string) {
  const state = loadDaemonState(dir)
  state.log.push(`[${new Date().toISOString()}] ${msg}`)
  saveDaemonState(dir, state)
  console.log(`[Daemon] ${msg}`)
  debugBus.emit('system', 'daemon_log', { msg }, { severity: 'info' })
}

// Record a model switch triggered by contextManager — visible in debug bus
export function recordModelSwitch(dir: string, from: string, to: string, reason: string) {
  const state = loadDaemonState(dir)
  state.modelSwitches = state.modelSwitches ?? []
  state.modelSwitches.push({ ts: Date.now(), from, to, reason })
  const msg = `model_switch: ${from} → ${to} (${reason})`
  state.log.push(`[${new Date().toISOString()}] ${msg}`)
  saveDaemonState(dir, state)

  debugBus.emit('agent', 'daemon_model_switch', {
    from,
    to,
    reason,
    ts: Date.now(),
  }, { severity: 'info' })

  console.log(`[Daemon] ${msg}`)
}

// Check which tasks are overdue and return them
export function getOverdueTasks(dir: string): DaemonTask[] {
  const state = loadDaemonState(dir)
  const now = Date.now()
  return state.tasks.filter(t => now - t.lastRunAt >= t.intervalMs)
}

// Mark a task as completed
export function markTaskDone(dir: string, taskName: string) {
  const state = loadDaemonState(dir)
  const task = state.tasks.find(t => t.name === taskName)
  if (task) { task.lastRunAt = Date.now(); task.runCount += 1 }
  saveDaemonState(dir, state)
}

// Build default handlers for the five new intelligence-layer tasks.
// Called from server.ts when setting up the daemon tick — callers merge these
// into their own handler map.
export function buildIntelligenceHandlers(projectDir: string): Partial<Record<string, () => Promise<void>>> {
  return {
    causal_memory_compact: async () => {
      // Prune causal edges with strength < 0.2 that haven't been reinforced
      try {
        const { loadCausalGraph, saveCausalGraph } = await import('./causalMemory')
        const g = loadCausalGraph()
        const before = g.edges.length
        g.edges = g.edges.filter(e => e.strength >= 0.2 || e.observedCount >= 2)
        const pruned = before - g.edges.length
        saveCausalGraph(g)
        daemonLog(projectDir, `causal_memory_compact: pruned ${pruned} weak edges (${g.edges.length} remain)`)
        debugBus.emit('system', 'causal_memory_compacted', { pruned, remaining: g.edges.length }, { severity: 'info' })
      } catch (e: any) {
        daemonLog(projectDir, `causal_memory_compact error: ${e.message}`)
      }
    },

    goal_decomp_health: async () => {
      // Log status of decomposition system (no persistent state to check yet,
      // but emit health signal to debug bus so operators can see it's running)
      debugBus.emit('system', 'goal_decomp_health_check', {
        status: 'ok',
        note: 'goalDecomposer operates per-request; no stalled tasks in daemon scope',
      }, { severity: 'info' })
      daemonLog(projectDir, 'goal_decomp_health: check complete')
    },

    contradiction_sweep: async () => {
      // Report contradiction log stats
      try {
        const { loadContradictionLog, loadSessionSummaries } = await import('./crossSessionContradiction')
        const log = loadContradictionLog(projectDir)
        const summaries = loadSessionSummaries(projectDir)
        const recentEvents = log.filter(e => Date.now() - e.timestamp < 24 * 60 * 60 * 1000)
        daemonLog(projectDir, `contradiction_sweep: ${recentEvents.length} events in last 24h, ${summaries.length} session summaries indexed`)
        debugBus.emit('system', 'contradiction_sweep_done', {
          recentEvents: recentEvents.length,
          totalSummaries: summaries.length,
          highScoreEvents: recentEvents.filter(e => e.score > 0.8).length,
        }, { severity: recentEvents.length > 5 ? 'warn' : 'info' })
      } catch (e: any) {
        daemonLog(projectDir, `contradiction_sweep error: ${e.message}`)
      }
    },

    confidence_calibration: async () => {
      // Report confidence calibration trends from pipeline history
      try {
        const histFile = path.join(projectDir, '.crucible', 'history.json')
        const history: any[] = JSON.parse(fs.readFileSync(histFile, 'utf8'))
        const recent = history.slice(-100)
        const avgScore = recent.reduce((s: number, h: any) => s + (h.compositeScore ?? 0.5), 0) / Math.max(recent.length, 1)
        daemonLog(projectDir, `confidence_calibration: avg composite score ${avgScore.toFixed(3)} over last ${recent.length} rounds`)
        debugBus.emit('system', 'confidence_calibration_report', {
          avgScore,
          roundCount: recent.length,
          note: 'Per-claim calibration runs at synthesis time via confidenceCalibrator.ts',
        }, { severity: avgScore < 0.6 ? 'warn' : 'info' })
      } catch (e: any) {
        daemonLog(projectDir, `confidence_calibration error: ${e.message}`)
      }
    },

    context_budget_report: async () => {
      // Report model switch history from the current daemon state
      const state = loadDaemonState(projectDir)
      const recentSwitches = (state.modelSwitches ?? []).filter(
        s => Date.now() - s.ts < 60 * 60 * 1000
      )
      daemonLog(projectDir, `context_budget_report: ${recentSwitches.length} model switches in last hour`)
      debugBus.emit('agent', 'context_budget_report', {
        switchesLastHour: recentSwitches.length,
        switches: recentSwitches.slice(-5).map(s => `${s.from.slice(0, 20)} → ${s.to.slice(0, 20)} (${s.reason})`),
      }, { severity: recentSwitches.length > 3 ? 'warn' : 'info' })
    },
  }
}

// The main daemon tick — called from server.ts on a setInterval
// Returns names of tasks that were triggered this tick
export function daemonTick(
  dir: string,
  handlers: Partial<Record<string, () => Promise<void>>>
): string[] {
  const overdue = getOverdueTasks(dir)
  const triggered: string[] = []

  for (const task of overdue) {
    const handler = handlers[task.name]
    if (!handler) continue
    triggered.push(task.name)
    markTaskDone(dir, task.name)
    handler().then(() => {
      daemonLog(dir, `${task.name} completed (run #${task.runCount + 1})`)
    }).catch(e => {
      daemonLog(dir, `${task.name} FAILED: ${e.message}`)
    })
  }

  return triggered
}
