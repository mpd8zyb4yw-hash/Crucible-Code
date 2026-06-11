import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

export interface Checkpoint {
  hash: string
  message: string
  timestamp: number
  projectPath: string
}

const CHECKPOINT_LOG = path.join(process.cwd(), '.crucible-checkpoints.json')

function loadCheckpoints(): Checkpoint[] {
  try {
    if (fs.existsSync(CHECKPOINT_LOG)) {
      return JSON.parse(fs.readFileSync(CHECKPOINT_LOG, 'utf-8'))
    }
  } catch { /* ignore */ }
  return []
}

function saveCheckpoints(checkpoints: Checkpoint[]) {
  fs.writeFileSync(CHECKPOINT_LOG, JSON.stringify(checkpoints.slice(-50), null, 2))
}

function exec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 10000 }).trim()
  } catch (e: any) {
    return e.message || ''
  }
}

export function ensureGitRepo(projectPath: string): void {
  const gitDir = path.join(projectPath, '.git')
  if (!fs.existsSync(gitDir)) {
    exec('git init', projectPath)
    exec('git add -A', projectPath)
    exec('git commit -m "crucible: initial checkpoint" --allow-empty', projectPath)
    console.log(`[Checkpoint] Initialized git repo in ${projectPath}`)
  }
}

export function createCheckpoint(projectPath: string, message: string): Checkpoint | null {
  try {
    ensureGitRepo(projectPath)
    exec('git add -A', projectPath)
    const result = exec(`git commit -m "crucible: ${message}" --allow-empty`, projectPath)
    const hash = exec('git rev-parse --short HEAD', projectPath)
    const checkpoint: Checkpoint = {
      hash,
      message,
      timestamp: Date.now(),
      projectPath,
    }
    const checkpoints = loadCheckpoints()
    checkpoints.push(checkpoint)
    saveCheckpoints(checkpoints)
    console.log(`[Checkpoint] Created: ${hash} — ${message}`)
    return checkpoint
  } catch (e: any) {
    console.error('[Checkpoint] Failed:', e.message)
    return null
  }
}

export function rollbackToCheckpoint(hash: string, projectPath: string): boolean {
  try {
    exec(`git checkout ${hash} -- .`, projectPath)
    console.log(`[Checkpoint] Rolled back to ${hash}`)
    return true
  } catch (e: any) {
    console.error('[Checkpoint] Rollback failed:', e.message)
    return false
  }
}

export function getCheckpoints(projectPath?: string): Checkpoint[] {
  const all = loadCheckpoints()
  if (!projectPath) return all
  return all.filter(c => c.projectPath === projectPath)
}
