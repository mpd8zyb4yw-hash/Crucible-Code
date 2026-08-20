/**
 * Scoped execution and the package-task wrappers.
 *
 * `process.run` takes a program plus an argv array. There is no code path in
 * which a string becomes a command line: no shell, no `-c`, no eval.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ALLOWED_PROGRAMS, REPO, DEFAULT_TIMEOUT_MS } from '../config.mjs'
import { Refusal, relative, safePath } from '../security.mjs'
import { journal, run } from '../util.mjs'

/** Scripts the project actually defines, discovered rather than guessed. */
export function scripts() {
  try { return JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).scripts ?? {} } catch { return {} }
}

function cwdOf(cwd) {
  if (!cwd || cwd === '.') return REPO
  return safePath(cwd, { mustExist: true })
}

export async function processRun({ program, args = [], cwd = '.', timeout_ms } = {}) {
  if (typeof program !== 'string') throw new Refusal('BAD_ARGS', 'program required')
  if (!ALLOWED_PROGRAMS.includes(program)) {
    throw new Refusal('PROGRAM_NOT_ALLOWED', `program not on allowlist: ${program}. Allowed: ${ALLOWED_PROGRAMS.join(', ')}`)
  }
  const r = await run(program, args, { cwd: cwdOf(cwd), timeout_ms: timeout_ms ?? DEFAULT_TIMEOUT_MS })
  journal({ type: 'process', program, args, exit: r.exit, duration_ms: r.duration_ms })
  return { program, args, cwd: relative(cwdOf(cwd)), ...r }
}

/** Run one npm script by name, refusing anything the project does not define. */
async function npmScript(name, timeout_ms) {
  const all = scripts()
  if (!all[name]) throw new Refusal('NO_SCRIPT', `package.json defines no "${name}" script. Available: ${Object.keys(all).join(', ')}`)
  const r = await run('npm', ['run', name], { timeout_ms: timeout_ms ?? 900_000 })
  journal({ type: 'test', suite: name, exit: r.exit, duration_ms: r.duration_ms })
  return { script: name, command: all[name], ...r }
}

export async function testRun({ suite, timeout_ms } = {}) {
  const all = scripts()
  const name = suite ?? 'test'
  if (suite && !all[suite]) throw new Refusal('NO_SCRIPT', `no "${suite}" script. Available: ${Object.keys(all).join(', ')}`)
  return npmScript(name, timeout_ms)
}

export async function buildRun({ timeout_ms } = {}) { return npmScript('build', timeout_ms) }

export async function typecheckRun({ timeout_ms } = {}) {
  const all = scripts()
  if (all.typecheck) return npmScript('typecheck', timeout_ms)
  // The project has no typecheck script; use its own tsc project build.
  const r = await run('npx', ['tsc', '-b', '--pretty', 'false'], { timeout_ms: timeout_ms ?? 600_000 })
  journal({ type: 'test', suite: 'typecheck', exit: r.exit, duration_ms: r.duration_ms })
  return { script: 'tsc -b', ...r }
}
