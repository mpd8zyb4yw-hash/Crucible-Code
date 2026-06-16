// Iteration-level checkpoint — written after every agent loop iteration so a
// dropped connection, rate-limit kill, or max_iters cutoff can be resumed from
// the exact conversation state, not from scratch.
//
// Lifecycle: written on every iter → auto-deleted on clean task completion.
// A stale checkpoint (>24h) is silently ignored and deleted.

import fs from 'fs'
import path from 'path'
import { crucibleDir } from './session'
import type { Step } from '../agent/planner'

export interface IterCheckpoint {
  sessionId: string
  goal: string
  projectPath: string
  // Step context (only set when running inside runPlannedTask)
  stepIndex: number
  stepTotal: number
  stepIntent: string
  // Loop state
  iter: number
  maxIters: number
  messages: Array<Record<string, unknown>>
  completedSummaries: string[]
  steps: Step[]
  failureReason?: string
  savedAt: number
}

const MAX_AGE_MS = 24 * 60 * 60 * 1000

function checkpointFile(projectPath: string): string {
  return path.join(crucibleDir(projectPath), 'checkpoint-active.json')
}

export function writeCheckpoint(projectPath: string, data: Omit<IterCheckpoint, 'savedAt'>): void {
  try {
    fs.mkdirSync(crucibleDir(projectPath), { recursive: true })
    const file = checkpointFile(projectPath)
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ ...data, savedAt: Date.now() }), 'utf-8')
    fs.renameSync(tmp, file)
  } catch {}
}

export function readCheckpoint(projectPath: string): IterCheckpoint | null {
  try {
    const file = checkpointFile(projectPath)
    if (!fs.existsSync(file)) return null
    const data: IterCheckpoint = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (Date.now() - data.savedAt > MAX_AGE_MS) { clearCheckpoint(projectPath); return null }
    return data
  } catch { return null }
}

export function clearCheckpoint(projectPath: string): void {
  try {
    const file = checkpointFile(projectPath)
    if (fs.existsSync(file)) fs.unlinkSync(file)
  } catch {}
}

/** All directories that may contain project checkpoints. */
function checkpointSearchRoots(): string[] {
  const home = process.env.HOME ?? '/Users/Shared'
  return [
    path.join(home, 'Desktop', 'Crucible'),          // future Desktop workspace root
    path.join(process.cwd(), '.crucible', 'workspace'), // legacy default workspace
  ]
}

/** Scan all known project roots for live checkpoints. Stale ones are deleted as a side-effect. */
export function findAllCheckpoints(): IterCheckpoint[] {
  const results: IterCheckpoint[] = []
  for (const root of checkpointSearchRoots()) {
    if (!fs.existsSync(root)) continue
    try {
      const stat = fs.statSync(root)
      if (stat.isDirectory()) {
        // root is itself a project (legacy workspace)
        const cp = readCheckpoint(root)
        if (cp) results.push(cp)
        // also check one level of subdirs (Desktop/Crucible/<project>/)
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          const cp2 = readCheckpoint(path.join(root, entry.name))
          if (cp2) results.push(cp2)
        }
      }
    } catch {}
  }
  return results.sort((a, b) => b.savedAt - a.savedAt)
}

/**
 * Delete every checkpoint file older than MAX_AGE_MS across all known roots.
 * Called once at server startup — ensures no leftover files from previous sessions
 * accumulate even if the user never triggers a read.
 */
export function sweepStaleCheckpoints(): void {
  const cutoff = Date.now() - MAX_AGE_MS
  for (const root of checkpointSearchRoots()) {
    if (!fs.existsSync(root)) continue
    const sweep = (dir: string) => {
      try {
        const file = checkpointFile(dir)
        if (!fs.existsSync(file)) return
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { savedAt?: number }
        if (!raw.savedAt || raw.savedAt < cutoff) {
          fs.unlinkSync(file)
          console.log(`[Checkpoint] Swept stale file: ${file}`)
        }
      } catch {}
    }
    sweep(root)
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) sweep(path.join(root, entry.name))
      }
    } catch {}
  }
}
