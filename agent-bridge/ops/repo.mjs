/**
 * Repository operations — inspection and confined mutation.
 *
 * Every path argument goes through safePath(), so nothing here can read or
 * write outside the Crucible repo. Every mutation takes a checkpoint first
 * and honours expected_sha256 so a concurrent Claude Code edit is never
 * silently clobbered.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { REPO, SEARCH_MAX } from '../config.mjs'
import { Refusal, redact, relative, safePath } from '../security.mjs'
import { checkpoint, git, journal, restore as restoreCheckpoint, run, sha256 } from '../util.mjs'

const text = (abs) => readFileSync(abs, 'utf8')

/** Refuse a write whose base has moved since the agent last read it. */
function guardStale(abs, expected) {
  if (expected == null) return
  const actual = existsSync(abs) ? sha256(readFileSync(abs)) : null
  if (actual !== expected) {
    throw new Refusal('STALE_FILE', `file changed since expected_sha256 (now ${actual ?? 'absent'}); re-read before writing`)
  }
}

export async function status() {
  const [branch, st, head] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['status', '--porcelain']),
    git(['log', '-1', '--pretty=%H%n%s%n%an%n%aI']),
  ])
  const lines = st.stdout.split('\n').filter(Boolean)
  const [hash, subject, author, date] = head.stdout.split('\n')
  return {
    repo_root: REPO,
    branch: branch.stdout.trim(),
    dirty: lines.length > 0,
    changed_count: lines.length,
    changed: lines.slice(0, 100).map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) })),
    head: { hash, subject, author, date },
  }
}

export async function list({ path = '.', depth = 1 } = {}) {
  const abs = safePath(path, { mustExist: true })
  const d = Math.min(Math.max(Number(depth) || 1, 1), 3)
  const out = []
  const walk = (dir, level) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === 'node_modules' || name === '.git') continue
      const full = join(dir, name)
      let st
      try { st = statSync(full) } catch { continue }
      out.push({ path: relative(full), kind: st.isDirectory() ? 'dir' : 'file', size: st.isDirectory() ? undefined : st.size })
      if (st.isDirectory() && level < d) walk(full, level + 1)
      if (out.length > 2000) return
    }
  }
  if (statSync(abs).isDirectory()) walk(abs, 1)
  else out.push({ path: relative(abs), kind: 'file', size: statSync(abs).size })
  return { path: relative(abs), count: out.length, entries: out.slice(0, 2000) }
}

export async function read({ path, start_line, end_line } = {}) {
  const abs = safePath(path, { mustExist: true })
  if (statSync(abs).isDirectory()) throw new Refusal('IS_DIR', `${path} is a directory`)
  const raw = readFileSync(abs)
  const all = raw.toString('utf8').split('\n')
  const start = Math.max(Number(start_line ?? 1), 1)
  const end = Math.min(Number(end_line ?? all.length), all.length)
  if (end < start) throw new Refusal('BAD_RANGE', 'end_line before start_line')
  return {
    path: relative(abs),
    sha256: sha256(raw),
    total_lines: all.length,
    start_line: start,
    end_line: end,
    content: redact(all.slice(start - 1, end).join('\n')),
  }
}

/**
 * Content search.
 *
 * `git grep` rather than ripgrep: this machine has no rg binary, and git grep
 * is already repo-aware. `--untracked` keeps new files visible; the pathspecs
 * keep vendored trees out.
 */
export async function search({ query, path = '.', glob, max = 80, ignore_case = false } = {}) {
  if (typeof query !== 'string' || !query.length) throw new Refusal('BAD_ARGS', 'query required')
  const abs = safePath(path, { mustExist: true })
  const limit = Math.min(Number(max) || 80, SEARCH_MAX)
  const args = ['grep', '--line-number', '--no-color', '-I', '--untracked', '--fixed-strings']
  if (ignore_case) args.push('-i')
  args.push('-e', query, '--')
  const scope = relative(abs)
  // A bare pattern like `*.ts` must recurse, so give it a `**/` prefix.
  const pattern = glob && !String(glob).includes('/') ? `**/${glob}` : glob
  args.push(pattern ? `:(glob)${scope === '.' ? '' : scope + '/'}${pattern}` : scope)
  args.push(':(exclude)node_modules', ':(exclude)_storage', ':(exclude)dist', ':(exclude).agent-bridge')
  const r = await run('git', args, { timeout_ms: 45_000 })
  // git grep exits 1 when there are simply no matches; anything else is real.
  if (r.exit !== 0 && r.exit !== 1) throw new Refusal('SEARCH_FAILED', r.stderr.slice(0, 400) || `git grep exit ${r.exit}`)
  const matches = r.stdout.split('\n').filter(Boolean).map((line) => {
    const m = /^(.*?):(\d+):(.*)$/.exec(line)
    if (!m) return null
    return { path: m[1], line: Number(m[2]), text: redact(m[3].slice(0, 300)) }
  }).filter(Boolean)
  return { query, total: matches.length, truncated: matches.length > limit, matches: matches.slice(0, limit) }
}

export async function changedFiles() {
  const r = await git(['status', '--porcelain'])
  return {
    files: r.stdout.split('\n').filter(Boolean).map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) })),
  }
}

export async function diff({ staged = false, base } = {}) {
  const args = ['diff']
  if (staged) args.push('--cached')
  if (base) { if (!/^[\w./-]{1,80}$/.test(String(base))) throw new Refusal('BAD_ARGS', 'bad base ref'); args.push(String(base)) }
  const r = await git(args, { timeout_ms: 60_000 })
  const stat = await git([...args.slice(0, args.length), '--stat'].filter((x) => x !== undefined), { timeout_ms: 60_000 })
  return { diffstat: redact(stat.stdout), patch: redact(r.stdout) }
}

export async function diffFile({ path } = {}) {
  const abs = safePath(path)
  const r = await git(['diff', '--', relative(abs)])
  return { path: relative(abs), patch: redact(r.stdout) }
}

/* ------------------------------------------------------- mutations */

export async function write({ path, content, expected_sha256 } = {}) {
  if (typeof content !== 'string') throw new Refusal('BAD_ARGS', 'content must be a string')
  const abs = safePath(path)
  guardStale(abs, expected_sha256)
  const ck = checkpoint([abs], 'repo.write')
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  journal({ type: 'mutation', op: 'repo.write', path: relative(abs), checkpoint_id: ck })
  const after = await diffFile({ path: relative(abs) })
  return { path: relative(abs), checkpoint_id: ck, sha256: sha256(readFileSync(abs)), bytes: Buffer.byteLength(content), patch: after.patch.slice(0, 20_000) }
}

export async function create({ path, content = '' } = {}) {
  const abs = safePath(path)
  if (existsSync(abs)) throw new Refusal('EXISTS', `${path} already exists; use repo.write`)
  return write({ path, content })
}

export async function mkdir({ path } = {}) {
  const abs = safePath(path)
  if (existsSync(abs)) return { path: relative(abs), created: false }
  const ck = checkpoint([abs], 'repo.mkdir')
  mkdirSync(abs, { recursive: true })
  journal({ type: 'mutation', op: 'repo.mkdir', path: relative(abs), checkpoint_id: ck })
  return { path: relative(abs), created: true, checkpoint_id: ck }
}

export async function remove({ path, expected_sha256, recursive = false } = {}) {
  const abs = safePath(path, { mustExist: true })
  if (abs === safePath('.')) throw new Refusal('REFUSED', 'refusing to delete the repository root')
  const st = statSync(abs)
  if (st.isDirectory()) {
    if (!recursive) throw new Refusal('IS_DIR', `${path} is a directory; pass recursive:true to delete it`)
    const count = readdirSync(abs).length
    if (count > 50) throw new Refusal('TOO_LARGE', `directory holds ${count} entries; delete narrower paths instead`)
  } else {
    guardStale(abs, expected_sha256)
  }
  const ck = checkpoint([abs], 'repo.delete')
  rmSync(abs, { recursive: st.isDirectory(), force: false })
  journal({ type: 'mutation', op: 'repo.delete', path: relative(abs), checkpoint_id: ck })
  return { path: relative(abs), deleted: true, kind: st.isDirectory() ? 'dir' : 'file', checkpoint_id: ck, restore_with: { op: 'repo.restore', args: { checkpoint_id: ck } } }
}

/**
 * Apply a unified diff with `git apply`.
 *
 * Paths are checked twice: once here against the diff's own headers, and
 * again by git, which refuses to touch anything outside the work tree.
 */
export async function applyPatch({ patch, check_only = false } = {}) {
  if (typeof patch !== 'string' || !patch.trim()) throw new Refusal('BAD_ARGS', 'patch required')
  const targets = new Set()
  for (const m of patch.matchAll(/^(?:\+\+\+|---)\s+(?:[ab]\/)?(\S+)/gm)) {
    if (m[1] === '/dev/null') continue
    targets.add(m[1])
  }
  if (!targets.size) throw new Refusal('BAD_PATCH', 'no file headers found in patch')
  const paths = [...targets].map((p) => safePath(p))

  const tmp = join(REPO, '.agent-bridge', `patch_${Date.now()}.diff`)
  mkdirSync(dirname(tmp), { recursive: true })
  writeFileSync(tmp, patch.endsWith('\n') ? patch : patch + '\n')
  try {
    const check = await git(['apply', '--check', '--whitespace=nowarn', tmp])
    if (check.exit !== 0) throw new Refusal('PATCH_DOES_NOT_APPLY', check.stderr.slice(0, 600) || 'patch does not apply')
    if (check_only) return { applied: false, check: 'ok', files: [...targets] }

    const ck = checkpoint(paths, 'repo.apply_patch')
    const applied = await git(['apply', '--whitespace=nowarn', tmp])
    if (applied.exit !== 0) {
      restoreCheckpoint(ck)
      throw new Refusal('PATCH_FAILED', applied.stderr.slice(0, 600))
    }
    const stat = await git(['diff', '--stat', '--', ...[...targets]])
    const after = await git(['diff', '--', ...[...targets]])
    journal({ type: 'mutation', op: 'repo.apply_patch', files: [...targets], checkpoint_id: ck })
    return {
      applied: true,
      checkpoint_id: ck,
      files: [...targets],
      diffstat: redact(stat.stdout),
      patch: redact(after.stdout).slice(0, 40_000),
    }
  } finally {
    rmSync(tmp, { force: true })
  }
}

export async function restore({ checkpoint_id } = {}) {
  const out = restoreCheckpoint(checkpoint_id)
  journal({ type: 'mutation', op: 'repo.restore', checkpoint_id })
  return out
}

/* ------------------------------------------------------------- git */

export async function show({ ref = 'HEAD', path } = {}) {
  if (!/^[\w./~^:-]{1,80}$/.test(String(ref))) throw new Refusal('BAD_ARGS', 'bad ref')
  const args = ['show', String(ref)]
  if (path) args.push('--', relative(safePath(path)))
  const r = await git(args, { timeout_ms: 60_000 })
  if (r.exit !== 0) throw new Refusal('GIT_FAILED', r.stderr.slice(0, 400))
  return { ref, output: redact(r.stdout) }
}

export async function log({ limit = 20, path } = {}) {
  const n = Math.min(Number(limit) || 20, 200)
  const args = ['log', `-${n}`, '--pretty=%H%x1f%s%x1f%an%x1f%aI%x1e']
  if (path) args.push('--', relative(safePath(path)))
  const r = await git(args)
  const commits = r.stdout.split('\x1e').map((c) => c.trim()).filter(Boolean).map((c) => {
    const [hash, subject, author, date] = c.split('\x1f')
    return { hash, subject, author, date }
  })
  return { count: commits.length, commits }
}
