/**
 * Optional Claude Code delegation.
 *
 * Asynchronous by construction: `claude.start` spawns and returns a task id
 * immediately, so a long implementation run never blocks command polling.
 * Output goes to a file; only a bounded tail travels by mail.
 *
 * The invocation is `claude -p <task-file-contents>` — the documented
 * non-interactive form of the installed CLI, verified with `claude --help`.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO, STATE } from '../config.mjs'
import { Refusal, redact } from '../security.mjs'
import { journal, run } from '../util.mjs'

const TASKS = join(STATE, 'claude')
const meta = (id) => join(TASKS, `${id}.json`)
const outFile = (id) => join(TASKS, `${id}.out`)

export async function available() {
  const r = await run('claude', ['--version'], { timeout_ms: 15_000 })
  return r.exit === 0 ? r.stdout.trim() : null
}

function load(id) {
  if (!/^cl_[\w]+$/.test(String(id))) throw new Refusal('BAD_ARGS', 'malformed task id')
  if (!existsSync(meta(id))) throw new Refusal('NOT_FOUND', `no such claude task: ${id}`)
  return JSON.parse(readFileSync(meta(id), 'utf8'))
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

/**
 * Start a Claude Code run inside the repo.
 *
 * `task` should already be concise — objective, files, constraints,
 * acceptance test. The bridge does not prepend project philosophy; feeding
 * the whole context every time is what makes delegation expensive.
 */
export async function start({ task, allowed_tools, timeout_ms } = {}) {
  if (typeof task !== 'string' || task.trim().length < 10) throw new Refusal('BAD_ARGS', 'task must be a non-trivial string')
  if (!(await available())) throw new Refusal('CLAUDE_UNAVAILABLE', 'claude CLI not available')
  mkdirSync(TASKS, { recursive: true })
  const id = `cl_${Date.now().toString(36)}`
  const brief = join(TASKS, `${id}.task.md`)
  writeFileSync(brief, task)

  const args = ['-p', task, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']
  if (Array.isArray(allowed_tools) && allowed_tools.every((t) => typeof t === 'string')) {
    args.push('--allowedTools', ...allowed_tools)
  }
  const fd = openSync(outFile(id), 'a')
  const child = spawn('claude', args, { cwd: REPO, shell: false, detached: true, stdio: ['ignore', fd, fd] })
  child.unref()
  const rec = {
    id, pid: child.pid, started: new Date().toISOString(),
    task_file: `.agent-bridge/claude/${id}.task.md`,
    out_file: `.agent-bridge/claude/${id}.out`,
    timeout_ms: timeout_ms ?? 3_600_000,
  }
  writeFileSync(meta(id), JSON.stringify(rec, null, 2))
  journal({ type: 'claude_task', status: 'started', id })
  return { ...rec, status: 'running' }
}

export async function status({ task_id } = {}) {
  if (!task_id) {
    const ids = existsSync(TASKS) ? readdirSync(TASKS).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : []
    return { tasks: ids.map((id) => { const r = load(id); return { id: r.id, running: alive(r.pid), started: r.started } }) }
  }
  const rec = load(task_id)
  const running = alive(rec.pid)
  const size = existsSync(outFile(task_id)) ? readFileSync(outFile(task_id)).length : 0
  return { id: rec.id, running, status: running ? 'running' : 'finished', started: rec.started, output_bytes: size }
}

/** Bounded tail plus the final assistant message, if the stream produced one. */
export async function result({ task_id, tail_lines = 60 } = {}) {
  const rec = load(task_id)
  const running = alive(rec.pid)
  const raw = existsSync(outFile(task_id)) ? readFileSync(outFile(task_id), 'utf8') : ''
  const lines = raw.split('\n').filter(Boolean)
  let final = null
  for (const l of lines) {
    try { const e = JSON.parse(l); if (e.type === 'result' && typeof e.result === 'string') final = e.result } catch {}
  }
  return {
    id: rec.id,
    status: running ? 'running' : 'finished',
    final_message: redact(final),
    tail: redact(lines.slice(-Math.min(Number(tail_lines) || 60, 300)).join('\n')).slice(0, 20_000),
    output_bytes: raw.length,
    out_file: rec.out_file,
  }
}

export async function cancel({ task_id } = {}) {
  const rec = load(task_id)
  if (!alive(rec.pid)) return { id: rec.id, cancelled: false, note: 'already finished' }
  try { process.kill(-rec.pid, 'SIGTERM') } catch { try { process.kill(rec.pid, 'SIGTERM') } catch {} }
  journal({ type: 'claude_task', status: 'cancelled', id: rec.id })
  return { id: rec.id, cancelled: true }
}
