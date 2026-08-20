/**
 * Shared plumbing: argv-only process execution, hashing, checkpoints, journal.
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { REPO, STATE, ALLOWED_PROGRAMS, DEFAULT_TIMEOUT_MS } from './config.mjs'
import { Refusal, redact, relative, safePath } from './security.mjs'

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/**
 * Run a program with an argv array. There is no shell anywhere in this path:
 * `spawn` is called with shell:false, so no argument is ever word-split,
 * globbed or interpreted. The program must be on the allowlist.
 */
export function run(program, args = [], { cwd = REPO, timeout_ms = DEFAULT_TIMEOUT_MS, allowAny = false, env } = {}) {
  if (!allowAny && !ALLOWED_PROGRAMS.includes(program)) {
    throw new Refusal('PROGRAM_NOT_ALLOWED', `program not on allowlist: ${program}`)
  }
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw new Refusal('BAD_ARGS', 'args must be an array of strings')
  }
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(program, args, {
      cwd,
      shell: false,
      env: { ...process.env, ...(env ?? {}), CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = '', killed = false
    const cap = 4_000_000
    child.stdout.on('data', (d) => { if (out.length < cap) out += d })
    child.stderr.on('data', (d) => { if (err.length < cap) err += d })
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL') }, timeout_ms)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ exit: -1, stdout: '', stderr: String(e.message), duration_ms: Date.now() - started, timed_out: false })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        exit: killed ? 124 : code ?? -1,
        stdout: redact(out),
        stderr: redact(err),
        duration_ms: Date.now() - started,
        timed_out: killed,
      })
    })
  })
}

export const git = (args, opts = {}) => run('git', args, { timeout_ms: 60_000, ...opts })

/* -------------------------------------------------------- checkpoints */

const CHECKPOINTS = join(STATE, 'checkpoints')

/**
 * Snapshot the current state of paths before a mutation so it can be undone.
 * A path that does not exist yet is recorded as absent, so restoring removes
 * the file the mutation created.
 */
export function checkpoint(paths, op) {
  mkdirSync(CHECKPOINTS, { recursive: true })
  const id = `ck_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
  const dir = join(CHECKPOINTS, id)
  mkdirSync(dir, { recursive: true })
  const entries = []
  for (const abs of paths) {
    const rel = relative(abs)
    const existed = existsSync(abs)
    const entry = { path: rel, existed, kind: null }
    if (existed) {
      const st = statSync(abs)
      entry.kind = st.isDirectory() ? 'dir' : 'file'
      const dest = join(dir, 'files', rel)
      mkdirSync(dirname(dest), { recursive: true })
      cpSync(abs, dest, { recursive: st.isDirectory() })
      if (entry.kind === 'file') entry.sha256 = sha256(readFileSync(abs))
    }
    entries.push(entry)
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id, op, created: new Date().toISOString(), entries }, null, 2))
  return id
}

export function restore(id) {
  if (!/^ck_[\w]+$/.test(String(id))) throw new Refusal('BAD_CHECKPOINT', 'malformed checkpoint id')
  const dir = join(CHECKPOINTS, id)
  if (!existsSync(join(dir, 'manifest.json'))) throw new Refusal('NOT_FOUND', `no such checkpoint: ${id}`)
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  const restored = []
  for (const e of manifest.entries) {
    const abs = safePath(e.path)
    if (e.existed) {
      const src = join(dir, 'files', e.path)
      mkdirSync(dirname(abs), { recursive: true })
      rmSync(abs, { recursive: true, force: true })
      cpSync(src, abs, { recursive: e.kind === 'dir' })
      restored.push({ path: e.path, action: 'reverted' })
    } else {
      rmSync(abs, { recursive: true, force: true })
      restored.push({ path: e.path, action: 'removed' })
    }
  }
  return { checkpoint_id: id, op: manifest.op, restored }
}

export function listCheckpoints(limit = 20) {
  if (!existsSync(CHECKPOINTS)) return []
  return readdirSync(CHECKPOINTS).sort().reverse().slice(0, limit).map((id) => {
    try {
      const m = JSON.parse(readFileSync(join(CHECKPOINTS, id, 'manifest.json'), 'utf8'))
      return { id, op: m.op, created: m.created, paths: m.entries.map((e) => e.path) }
    } catch { return { id, op: null } }
  })
}

/* ------------------------------------------------------------ journal */

const JOURNAL = join(STATE, 'journal.jsonl')

export function journal(event) {
  try {
    mkdirSync(STATE, { recursive: true })
    appendFileSync(JOURNAL, JSON.stringify({ at: new Date().toISOString(), ...redact(event) }) + '\n')
  } catch {}
}

export function journalLatest(limit = 40) {
  try {
    const lines = readFileSync(JOURNAL, 'utf8').trim().split('\n').filter(Boolean)
    return lines.slice(-Math.min(limit, 200)).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}
