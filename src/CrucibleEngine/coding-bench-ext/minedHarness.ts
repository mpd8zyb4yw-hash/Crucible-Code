// Runner for git-mined bench tasks (W42.2) — materializes the historical world and
// stages the run through the REAL oracle, so a mined task exercises the exact
// verification path the live agent faces.
//
// Staging model: the parent commit's src/ tree (plus its tsconfig.json) is extracted
// once per sha into a cached snapshot dir, with the repo's node_modules symlinked in.
// The snapshot is passed to verifyCandidate as projectPath, so the oracle's own
// import-closure walk pulls EXACTLY the sibling files the candidate and the suite
// import — from the historical tree, never from today's working tree (version skew
// from the present would silently change what the suite means). The candidate is the
// ONE overlay file; the suite is the paired bench pinned at the fix commit, placed at
// its real repo-relative path so its sibling imports resolve naturally.
//
// The audit takes only the agent's target file from the workspace; every other file is
// staged from the pinned snapshot — editing siblings cannot game the suite.
//
// Deterministic, model-free, offline: git objects are content-addressed, and Gate B
// runs under the W30 hermetic contract (frozen clock, seeded PRNG, network denied,
// double-run determinism check on accept).

import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { verifyCandidate, type Verdict } from '../synth/oracle'
import { MINED_TASKS, type MinedTask } from './tasks-mined'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CODE_DIR = path.resolve(HERE, '../../..')

const SHA_RX = /^[0-9a-f]{40}$/
const COMPLETE_MARKER = '.crucible-snapshot-complete'

function assertSha(sha: string): void {
  if (!SHA_RX.test(sha)) throw new Error(`mined task sha must be a full 40-char sha, got: ${sha}`)
}

function git(args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync('git', args, { cwd: CODE_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' }
}

/** Content of one file at one commit — the immutable pin the shard relies on. */
export function gitShow(sha: string, rel: string): string {
  assertSha(sha)
  const r = git(['show', `${sha}:${rel}`])
  if (!r.ok) throw new Error(`git show ${sha.slice(0, 12)}:${rel} failed: ${r.err.slice(0, 200)}`)
  return r.out
}

/** True when the object exists at that commit (existence probe for the certifier). */
export function gitPathExists(sha: string, rel: string): boolean {
  assertSha(sha)
  return git(['cat-file', '-e', `${sha}:${rel}`]).ok
}

/** Files the commit touched vs its recorded parent — the commit-shape check's input. */
export function gitChangedFiles(parentSha: string, fixSha: string): string[] {
  assertSha(parentSha); assertSha(fixSha)
  const r = git(['diff', '--name-only', parentSha, fixSha])
  if (!r.ok) throw new Error(`git diff --name-only failed: ${r.err.slice(0, 200)}`)
  return r.out.split('\n').map(s => s.trim()).filter(Boolean)
}

/** Added lines of the fix diff on one file (trimmed, substantial) — the no-leak needles. */
export function addedDiffLines(parentSha: string, fixSha: string, rel: string): string[] {
  assertSha(parentSha); assertSha(fixSha)
  const r = git(['diff', parentSha, fixSha, '--', rel])
  if (!r.ok) throw new Error(`git diff failed for ${rel}: ${r.err.slice(0, 200)}`)
  return r.out.split('\n')
    .filter(l => l.startsWith('+') && !l.startsWith('+++'))
    .map(l => l.slice(1).trim())
    .filter(l => l.length >= 13)
}

/**
 * Extract src/ + tsconfig.json at `sha` into a cached snapshot dir and symlink the
 * repo's node_modules in. Cache key is the sha itself (content-addressed ⇒ immutable);
 * a marker file distinguishes complete snapshots from crashed half-extractions.
 */
export function materializeSnapshot(sha: string): string {
  assertSha(sha)
  const dir = path.join(os.tmpdir(), `crucible-mined-${sha.slice(0, 12)}`)
  if (fs.existsSync(path.join(dir, COMPLETE_MARKER))) return dir
  fs.rmSync(dir, { recursive: true, force: true })

  const build = `${dir}.build-${process.pid}`
  fs.rmSync(build, { recursive: true, force: true })
  fs.mkdirSync(build, { recursive: true })
  const tarPath = path.join(build, 'snapshot.tar')
  const ar = git(['archive', '-o', tarPath, sha, 'src', 'tsconfig.json'])
  if (!ar.ok) { fs.rmSync(build, { recursive: true, force: true }); throw new Error(`git archive ${sha.slice(0, 12)} failed: ${ar.err.slice(0, 200)}`) }
  const tr = spawnSync('tar', ['-xf', tarPath, '-C', build], { encoding: 'utf8' })
  fs.rmSync(tarPath, { force: true })
  if (tr.status !== 0) { fs.rmSync(build, { recursive: true, force: true }); throw new Error(`tar extract failed: ${(tr.stderr ?? '').slice(0, 200)}`) }

  const nm = path.join(CODE_DIR, 'node_modules')
  if (fs.existsSync(nm)) {
    try { fs.symlinkSync(nm, path.join(build, 'node_modules'), 'dir') } catch { /* best-effort */ }
  }
  fs.writeFileSync(path.join(build, COMPLETE_MARKER), sha)
  try {
    fs.renameSync(build, dir)
  } catch {
    // Lost a race to a concurrent materializer — its complete snapshot wins.
    fs.rmSync(build, { recursive: true, force: true })
    if (!fs.existsSync(path.join(dir, COMPLETE_MARKER))) throw new Error(`snapshot rename failed and no complete snapshot exists at ${dir}`)
  }
  return dir
}

export function minedRefContent(task: MinedTask): string { return gitShow(task.fixSha, task.targetPath) }
export function minedParentContent(task: MinedTask): string { return gitShow(task.parentSha, task.targetPath) }
export function minedSuiteContent(task: MinedTask): string { return gitShow(task.fixSha, task.benchPath) }

/**
 * The suite's transitive relative-import closure inside the parent snapshot, seeded
 * from target+bench — mirrors the oracle's own stageImportClosure walk so the caller
 * can know, ahead of staging, exactly which historical files will surround the run.
 */
export function snapshotClosure(task: MinedTask): string[] {
  const snapshot = materializeSnapshot(task.parentSha)
  const queue = [task.targetPath, task.benchPath]
  const seen = new Set<string>()
  while (queue.length) {
    const rel = queue.pop()!
    if (seen.has(rel)) continue
    seen.add(rel)
    let src: string
    if (rel === task.benchPath) src = minedSuiteContent(task)
    else {
      const abs = path.join(snapshot, rel)
      if (!fs.existsSync(abs)) continue
      src = fs.readFileSync(abs, 'utf8')
    }
    for (const m of src.matchAll(REL_IMPORT_RX)) {
      const baseRel = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]))
      if (baseRel.startsWith('..')) continue
      const resolved = resolveInSnapshot(snapshot, baseRel)
      if (resolved && !seen.has(resolved)) queue.push(resolved)
    }
  }
  return [...seen]
}

/**
 * Run one candidate body for the target file against the task's pinned suite, staged
 * on the parent-commit snapshot. This IS the audit: candidate in, Verdict out.
 *
 * Gate-A scoping (found live, first certifier run): the repo of that era carried
 * hundreds of PRE-EXISTING tsc errors and its benches ran under tsx, which never
 * typechecks — so a whole-scratch tsc trips on historical CONTEXT files (e.g.
 * agent/fmReact.ts) the task does not touch and the agent cannot edit. Those files are
 * immutable history: their errors are deferred via changeSetScope, while errors in the
 * CANDIDATE file itself stay fatal — the agent's own output must still typecheck.
 */
export function runMinedCandidate(
  task: MinedTask,
  candidateContent: string,
  opts?: { runTimeoutMs?: number },
): Verdict {
  const snapshot = materializeSnapshot(task.parentSha)
  const closure = snapshotClosure(task).filter(rel => rel !== task.targetPath && rel !== task.benchPath)
  return verifyCandidate(
    [{ path: task.targetPath, content: candidateContent }],
    { path: task.benchPath, content: minedSuiteContent(task) },
    {
      projectPath: snapshot,
      // Pre-stage the ENTIRE historical closure ourselves: this walker resolves the
      // ESM './x.js' → 'x.ts' convention the oracle's own walk takes literally, and a
      // file it would miss dies at runtime as a phantom missing module. With everything
      // staged up front, the oracle's walk finds nothing left to copy.
      contextFiles: closure.map(rel => ({ src: path.join(snapshot, rel), rel })),
      changeSetScope: [...closure, task.benchPath],
      // Callers that run MANY variants of one task (the mutation teeth-check) pass a
      // tighter budget: a suite that has teeth fails an assertion and exits well before
      // the full-run cap, and a mutant that induces a hang must not burn the whole budget.
      runTimeoutMs: opts?.runTimeoutMs ?? task.runTimeoutMs ?? 300_000,
      compileTimeoutMs: 240_000,
    },
  )
}

/** Audit entry point for the live harness: agent-edited target file in, Verdict out. */
export function auditMinedCandidate(taskId: string, candidateContent: string): Verdict {
  const task = MINED_TASKS.find(t => t.id === taskId)
  if (!task) throw new Error(`unknown mined task: ${taskId}`)
  return runMinedCandidate(task, candidateContent)
}

const REL_IMPORT_RX = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g

/**
 * tsx-compatible resolution against the snapshot. The shape that matters (found live,
 * second certifier run): ESM-convention imports name './embed.js' while the source on
 * disk is './embed.ts' — tsx maps the specifier at runtime, so the walker must map it
 * at staging time or the file is silently never staged and Gate B dies on a phantom
 * missing module.
 */
function resolveInSnapshot(snapshot: string, baseRel: string): string | null {
  const tries = /\.(ts|tsx)$/.test(baseRel)
    ? [baseRel]
    : /\.(js|mjs|cjs)$/.test(baseRel)
      ? [baseRel.replace(/\.(js|mjs|cjs)$/, '.ts'), baseRel.replace(/\.(js|mjs|cjs)$/, '.tsx'), baseRel]
      : [`${baseRel}.ts`, `${baseRel}.tsx`, `${baseRel}/index.ts`, `${baseRel}.js`, `${baseRel}/index.js`]
  for (const t of tries) {
    const abs = path.join(snapshot, t)
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return t
  }
  return null
}

/**
 * Workspace scaffold the agent starts from: the buggy target file plus its DIRECT
 * relative imports (one hop, pinned at the parent commit) for type context. One hop is
 * deliberate — the suite's own (much larger) closure is staged at audit time from the
 * snapshot, so the agent neither sees nor needs the bench's world, and every extra
 * scaffold file is one more thing a small model might wrongly edit.
 */
export function minedScaffold(task: MinedTask): Array<{ path: string; content: string }> {
  const snapshot = materializeSnapshot(task.parentSha)
  const target = minedParentContent(task)
  const out: Array<{ path: string; content: string }> = [{ path: task.targetPath, content: target }]
  const seen = new Set([task.targetPath])
  for (const m of target.matchAll(REL_IMPORT_RX)) {
    const baseRel = path.posix.normalize(path.posix.join(path.posix.dirname(task.targetPath), m[1]))
    if (baseRel.startsWith('..')) continue
    const resolved = resolveInSnapshot(snapshot, baseRel)
    if (!resolved || seen.has(resolved)) continue
    seen.add(resolved)
    out.push({ path: resolved, content: fs.readFileSync(path.join(snapshot, resolved), 'utf8') })
  }
  return out
}

/**
 * Agent-facing enrollment shape for coding-benchmarks.ts (Track A wires): the task's
 * scaffold pre-populates the workspace, modulePath names the file to fix, and the
 * audit routes through auditMinedCandidate — ref and suite deliberately absent.
 */
export function toMinedBenchTasks(): Array<{
  id: string; title: string; modulePath: string; prompt: string
  scaffold: Array<{ path: string; content: string }>
}> {
  return MINED_TASKS.map(t => ({
    id: t.id, title: t.title, modulePath: t.targetPath, prompt: t.prompt, scaffold: minedScaffold(t),
  }))
}
