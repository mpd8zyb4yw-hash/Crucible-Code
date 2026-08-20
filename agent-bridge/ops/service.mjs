/**
 * Long-running development services.
 *
 * Deliberately not a general process manager: only the named Crucible
 * services below can be started, and each is a fixed argv.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO, STATE } from '../config.mjs'
import { Refusal, redact } from '../security.mjs'
import { journal } from '../util.mjs'

const RUN = join(STATE, 'services')
const LOGS = join(STATE, 'logs')

/** The only services this bridge knows how to run. */
export const SERVICES = {
  server: { program: 'npm', args: ['run', 'server'], note: 'Crucible API on :3001' },
  vite: { program: 'npx', args: ['vite'], note: 'front-end dev server' },
  dev: { program: 'npm', args: ['run', 'dev'], note: 'server + vite together' },
  evaluator: { program: 'node', args: ['evaluator/server.mjs'], note: 'browser evaluator on :8899' },
  fixture: { program: 'npm', args: ['run', 'fixture'], note: 'fixture server on :3002' },
}

const pidFile = (name) => join(RUN, `${name}.json`)

function named(name) {
  if (!Object.hasOwn(SERVICES, name)) {
    throw new Refusal('UNKNOWN_SERVICE', `unknown service: ${name}. Known: ${Object.keys(SERVICES).join(', ')}`)
  }
  return SERVICES[name]
}

function alive(pid) { try { process.kill(pid, 0); return true } catch { return false } }

function record(name) {
  try { return JSON.parse(readFileSync(pidFile(name), 'utf8')) } catch { return null }
}

export async function list() {
  return {
    services: Object.entries(SERVICES).map(([name, s]) => {
      const rec = record(name)
      return {
        name, note: s.note,
        running: rec ? alive(rec.pid) : false,
        pid: rec?.pid ?? null,
        started: rec?.started ?? null,
        log: rec ? `.agent-bridge/logs/${name}.log` : null,
      }
    }),
  }
}

export async function start({ name } = {}) {
  const svc = named(name)
  const rec = record(name)
  if (rec && alive(rec.pid)) return { name, already_running: true, pid: rec.pid }
  mkdirSync(RUN, { recursive: true })
  mkdirSync(LOGS, { recursive: true })
  const log = join(LOGS, `${name}.log`)
  const fd = openSync(log, 'a')
  const child = spawn(svc.program, svc.args, {
    cwd: REPO, shell: false, detached: true, stdio: ['ignore', fd, fd],
    env: { ...process.env, FORCE_COLOR: '0' },
  })
  child.unref()
  const meta = { name, pid: child.pid, started: new Date().toISOString(), program: svc.program, args: svc.args }
  writeFileSync(pidFile(name), JSON.stringify(meta, null, 2))
  journal({ type: 'service', name, action: 'start', pid: child.pid })
  await new Promise((r) => setTimeout(r, 1200))
  return { ...meta, running: alive(child.pid), log: `.agent-bridge/logs/${name}.log` }
}

export async function stop({ name } = {}) {
  named(name)
  const rec = record(name)
  if (!rec || !alive(rec.pid)) { rmSync(pidFile(name), { force: true }); return { name, running: false, stopped: false } }
  try { process.kill(-rec.pid, 'SIGTERM') } catch { try { process.kill(rec.pid, 'SIGTERM') } catch {} }
  await new Promise((r) => setTimeout(r, 800))
  if (alive(rec.pid)) { try { process.kill(-rec.pid, 'SIGKILL') } catch { try { process.kill(rec.pid, 'SIGKILL') } catch {} } }
  rmSync(pidFile(name), { force: true })
  journal({ type: 'service', name, action: 'stop', pid: rec.pid })
  return { name, stopped: true, pid: rec.pid }
}

export async function restart({ name } = {}) {
  await stop({ name })
  return start({ name })
}

export async function logs({ name, lines = 120 } = {}) {
  named(name)
  const f = join(LOGS, `${name}.log`)
  if (!existsSync(f)) return { name, lines: [], note: 'no log yet' }
  const all = readFileSync(f, 'utf8').split('\n')
  const n = Math.min(Number(lines) || 120, 800)
  return { name, total_lines: all.length, lines: redact(all.slice(-n).join('\n')) }
}
