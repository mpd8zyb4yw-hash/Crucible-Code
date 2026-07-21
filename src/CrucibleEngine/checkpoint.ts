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

/**
 * Snapshot the project so an agent edit can be rolled back.
 *
 * `paths` scopes what gets staged, and callers that know which file they are about to touch
 * SHOULD pass it. The unscoped `git add -A` fallback stages the entire working tree, which
 * means a checkpoint sweeps up every unrelated in-flight edit — another session's work, or the
 * user's own uncommitted changes — and buries it under a "crucible: pre-<tool>" message. That
 * is not hypothetical: on 2026-07-21 two agent harnesses ran against this one working tree and
 * a single write_file checkpoint committed a second session's UI work plus this session's
 * engine changes together, under a message describing neither. Staging only the target file
 * still gives a restorable pre-write snapshot of the thing being changed, which is all the
 * checkpoint is for.
 */
/**
 * Derive a `createCheckpoint` path scope for a mutation whose target file is known.
 *
 * Returns `[target]` when the file lives inside the project, `[]` ("snapshot nothing") when it
 * demonstrably does not, and `undefined` only when the target is unknown — the sole case where
 * a whole-tree `git add -A` is still the honest answer.
 *
 * The containment test is a resolved path-prefix check, not a string test on `isAbsolute`. An
 * earlier version treated EVERY absolute path as external, which was wrong in the common
 * direction: an agent writing `/Users/me/proj/src/x.ts` inside `/Users/me/proj` got `[]` and so
 * received NO pre-write snapshot at all — the checkpoint silently became a no-op for exactly
 * the edits it exists to protect. The `sep` guard stops `/a/proj-backup` matching `/a/proj`.
 */
export function checkpointScopeFor(projectPath: string, target: string | undefined): string[] | undefined {
  if (target === undefined) return undefined
  if (target.startsWith('~')) return []
  const root = path.resolve(projectPath)
  const abs = path.resolve(root, target)
  return abs === root || abs.startsWith(root + path.sep) ? [abs] : []
}

export function createCheckpoint(projectPath: string, message: string, paths?: string[]): Checkpoint | null {
  try {
    ensureGitRepo(projectPath)
    if (paths) {
      // An EMPTY array is meaningful and distinct from undefined: it means the caller knows
      // the mutation touches nothing inside this repo (write_file targeting ~/Desktop), so
      // there is nothing here to snapshot. Falling back to -A in that case is precisely how
      // the dog-breeds runs — which only ever wrote to the Desktop — ended up committing
      // unrelated engine and UI work under "crucible: pre-write_file".
      if (paths.length) {
        // -- terminates flags so a path can never be read as one; each path is quoted.
        const spec = paths.map(p => `'${p.replace(/'/g, "'\\''")}'`).join(' ')
        exec(`git add -- ${spec}`, projectPath)
      }
    } else {
      exec('git add -A', projectPath)
    }
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
