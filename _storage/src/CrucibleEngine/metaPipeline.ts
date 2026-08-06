// Meta-pipeline (Track B4) — a background job that reads failure patterns from
// the debug bus and taxonomy, identifies the top recurring failure mode, spawns
// an agent session targeting it ("reduce the rate of this failure mode by
// modifying pipeline code"), and commits only if the quality predictor improves.
//
// Architecture: the meta-pipeline does NOT call runAgentLoop directly (circular
// dependency). Instead it writes a `.crucible/meta-task.json` file that the
// server picks up and routes to the agent endpoint. The agent runs, commits,
// and writes a result back to `.crucible/meta-task-result.json`.

import fs from 'fs'
import path from 'path'

export interface MetaTask {
  id: string
  ts: number
  failureMode: string        // from failureTaxonomy cluster label
  targetFile: string         // which file to focus on
  goal: string               // the agent instruction
  status: 'pending' | 'running' | 'done' | 'failed'
  resultSummary?: string
  qualityDeltaEstimate?: number
}

const taskFile = (dir: string) => path.join(dir, '.crucible', 'meta-task.json')
const resultFile = (dir: string) => path.join(dir, '.crucible', 'meta-task-result.json')
const logFile = (dir: string) => path.join(dir, '.crucible', 'meta-pipeline-log.json')

export function loadMetaTask(dir: string): MetaTask | null {
  try { return JSON.parse(fs.readFileSync(taskFile(dir), 'utf8')) } catch { return null }
}

export function saveMetaTask(dir: string, task: MetaTask) {
  fs.mkdirSync(path.dirname(taskFile(dir)), { recursive: true })
  fs.writeFileSync(taskFile(dir), JSON.stringify(task, null, 2))
}

export function loadMetaTaskResult(dir: string): any | null {
  try { return JSON.parse(fs.readFileSync(resultFile(dir), 'utf8')) } catch { return null }
}

export function clearMetaTask(dir: string) {
  try { fs.unlinkSync(taskFile(dir)) } catch {}
  try { fs.unlinkSync(resultFile(dir)) } catch {}
}

export function appendMetaLog(dir: string, entry: any) {
  let log: any[] = []
  try { log = JSON.parse(fs.readFileSync(logFile(dir), 'utf8')) } catch {}
  log.push({ ts: Date.now(), ...entry })
  fs.mkdirSync(path.dirname(logFile(dir)), { recursive: true })
  fs.writeFileSync(logFile(dir), JSON.stringify(log.slice(-50), null, 2))
}

// Map a failure mode label to the most relevant pipeline file to target
function identifyTargetFile(failureMode: string): string {
  const lower = failureMode.toLowerCase()
  if (lower.includes('code') || lower.includes('coding')) return 'src/CrucibleEngine/domainVerifiers.ts'
  if (lower.includes('synth')) return 'server.ts'  // synthesis stage
  if (lower.includes('thin') || lower.includes('short')) return 'server.ts'  // synthesis prompt
  if (lower.includes('vague') || lower.includes('general')) return 'modelRegistry.ts'
  if (lower.includes('factual') || lower.includes('math')) return 'src/CrucibleEngine/domainVerifiers.ts'
  return 'server.ts'
}

// Build the agent instruction for a given failure mode
function buildGoal(failureMode: string, targetFile: string, exampleQuery: string): string {
  return `CRUCIBLE SELF-IMPROVEMENT TASK

Failure mode identified: "${failureMode}"
Example query that triggered it: "${exampleQuery}"

Your goal: Reduce the rate of this failure mode in the pipeline.

Focus file: ${targetFile}
Constraints:
- Do NOT change the model registry or add premium models
- Do NOT change the free-tier architecture
- Only modify prompt text, scoring logic, or verification heuristics
- Changes must be minimal and targeted
- After editing, verify the change makes logical sense by re-reading the modified section

Steps:
1. Read ${targetFile}
2. Identify the logic responsible for handling "${failureMode}" queries
3. Make a focused improvement (better prompt wording, improved heuristic, tighter verification)
4. Summarise what you changed and why in one paragraph`
}

// Schedule a meta-task if none is currently pending/running
export function scheduleMetaTask(
  dir: string,
  failureClusters: { label: string; exampleQuery: string }[]
): MetaTask | null {
  const existing = loadMetaTask(dir)
  if (existing && (existing.status === 'pending' || existing.status === 'running')) return null

  // Pick the largest cluster
  const cluster = failureClusters[0]
  if (!cluster) return null

  const targetFile = identifyTargetFile(cluster.label)
  const task: MetaTask = {
    id: `mt_${Date.now()}`,
    ts: Date.now(),
    failureMode: cluster.label,
    targetFile,
    goal: buildGoal(cluster.label, targetFile, cluster.exampleQuery),
    status: 'pending',
  }

  saveMetaTask(dir, task)
  appendMetaLog(dir, { event: 'task_scheduled', failureMode: cluster.label, targetFile })
  console.log(`[MetaPipeline] Task scheduled: ${cluster.label} → ${targetFile}`)
  return task
}
