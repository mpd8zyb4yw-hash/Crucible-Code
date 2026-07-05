// ============================================================================
// The execution ORACLE — the single source of correctness for the universal engine.
//
// Every proposer (template match, composition, search, on-device FM) emits candidate
// files; NOTHING is trusted until this oracle accepts it. So a wrong proposal — from any
// source, including a model — is caught and discarded, never shipped. This is what makes
// "reason about code it doesn't have" safe: the reasoner proposes, execution decides.
//
// Gate A (static):     tsc --noEmit under a lenient config — kills hallucinated APIs / type
//                      errors before anything runs.
// Gate A2 (lint):      curated correctness-only ESLint pass (lintGate.ts) — kills known-
//                      always-wrong shapes tsc can't see (dupe keys, self-compare, NaN ===…).
//                      In-process, local tool, fails open if ESLint is unavailable.
// Gate A3 (contract):  declared-vs-actual export signature check (contractGate.ts) — kills
//                      contract violations (wrong name/arity/return type) that the
//                      deliberately lenient Gate A tsconfig lets through. Fails open when
//                      the spec carries no "Exact public API" block to check against.
// Gate B (behavioral): write the candidate + a spec-derived test into a throwaway scratch
//                      dir and run it via `tsx`; accepted iff the test exits 0.
// model-cost-independent, sandboxed to a tmp dir, time-bounded so a runaway candidate is reaped.
// ============================================================================
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync, spawn } from 'child_process'
import { fileURLToPath } from 'url'
import type { SynthFile } from './synthEngine'
import { lintCandidates } from './lintGate'
import { checkContract } from './contractGate'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CODE_DIR = path.resolve(HERE, '../../..')   // repo root (has tsx/tsc + @types/node)

export interface Verdict {
  accepted: boolean
  gateA: boolean          // static typecheck
  gateB: boolean          // behavioral test
  detail: string          // first error / PASS-FAIL tail
  ranAssertions: boolean  // whether a behavioral test actually executed
}

interface RunOut { ok: boolean; out: string; timedOut: boolean }

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): RunOut {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: process.env })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  return { ok: r.status === 0, out, timedOut: r.signal === 'SIGTERM' || (r.error as any)?.code === 'ETIMEDOUT' }
}

/** Non-blocking variant of `run` — for the live server path, which must never stall the event loop. */
function runAsync(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<RunOut> {
  return new Promise(resolve => {
    let out = ''
    let timedOut = false
    const child = spawn(cmd, args, { cwd, env: process.env })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, timeoutMs)
    const cap = (d: Buffer) => { out += d.toString('utf8'); if (out.length > 8 * 1024 * 1024) child.kill('SIGTERM') }
    child.stdout?.on('data', cap)
    child.stderr?.on('data', cap)
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, out: `${out}${String(e)}`, timedOut }) })
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, out, timedOut }) })
  })
}

/** Build the lenient tsconfig the static gate uses.
 * When projectPath is provided, inherits its compiler settings and type roots
 * so that project-local packages (express, prisma, etc.) resolve correctly. */
function writeTsConfig(cfgDir: string, scratch: string, projectPath?: string): string {
  const cfgPath = path.join(cfgDir, 'tsconfig.json')

  // Collect extra compiler options from the real project's tsconfig (best-effort).
  let projectCo: Record<string, unknown> = {}
  const projectNodeModules = projectPath ? path.join(projectPath, 'node_modules') : null
  if (projectPath) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(projectPath, 'tsconfig.json'), 'utf-8'))
      const co = raw.compilerOptions ?? {}
      // Carry over settings that affect type resolution and emit shape.
      if (co.target) projectCo.target = co.target
      if (co.lib) projectCo.lib = co.lib
      if (co.jsx) projectCo.jsx = co.jsx
      if (co.moduleResolution) projectCo.moduleResolution = co.moduleResolution
      if (co.paths) projectCo.paths = co.paths
      if (co.baseUrl) projectCo.baseUrl = path.join(projectPath, co.baseUrl)
    } catch { /* non-fatal — fall through to defaults */ }
  }

  const typeRoots = [
    ...(projectNodeModules ? [path.join(projectNodeModules, '@types')] : []),
    path.join(CODE_DIR, 'node_modules/@types'),
  ]

  fs.writeFileSync(cfgPath, JSON.stringify({
    compilerOptions: {
      noEmit: true, skipLibCheck: true, esModuleInterop: true, module: 'commonjs',
      target: 'es2020', moduleResolution: 'node10', ignoreDeprecations: '6.0',
      strict: false, noImplicitAny: false,
      typeRoots, types: ['node'],
      ...projectCo,
    },
    include: [path.join(scratch, '**/*.ts'), path.join(scratch, '**/*.tsx')],
  }))
  return cfgPath
}

function firstTsError(out: string): string { return out.split('\n').find(l => /error TS/.test(l)) ?? out.slice(0, 200) }

/**
 * Summarize a test run's console output for the retry prompt / audit trail.
 *
 * BUG FOUND 2026-07-04 (filterModule ledger audit): this used to be a fixed `.slice(-4)` over
 * every PASS/FAIL line. A property family with more than ~4 assertions (filter-opts has 8) can
 * have MULTIPLE real failures, and the fixed last-4 window silently dropped the earlier ones —
 * confirmed live: a candidate with 4 real bugs (active=false unfiltered, query-by-name broken,
 * query case-insensitivity broken, both-filters-compose broken) only ever showed the FM the
 * LAST 2 of those 4 in its retry prompt (`query case-insensitive`, `both filters compose`) —
 * the other two were true failures the FM never got a chance to see, let alone fix. Now:
 * include EVERY failing assertion line plus the final tally, dropping only the noise (PASS
 * lines carry no retry-actionable signal). Capped by total length, not line count, so a test
 * with many failures still fits a bounded prompt.
 */
function testTail(out: string): string {
  const lines = out.split('\n').filter(l => /PASS|FAIL|ALL PASS|FAILURE|Error|✓|✗/.test(l))
  const isSummary = (l: string) => /^ALL PASS$/.test(l.trim()) || /^\d+ FAILURE\(S\)$/.test(l.trim())
  const fails = lines.filter(l => !isSummary(l) && (/FAIL|✗/.test(l) || (/Error/.test(l) && !/PASS/.test(l))))
  const summary = lines.filter(isSummary)
  return [...fails, ...summary].join(' | ').slice(0, 2000)
}

/**
 * Verify candidate files. `testFile` (optional) is a spec-derived tsx script that imports
 * the candidate and asserts behavior, exiting non-zero on any failure. Without it only the
 * static gate runs (and ranAssertions=false → the caller should treat as low-confidence).
 */
export function verifyCandidate(
  files: SynthFile[],
  testFile?: SynthFile,
  opts: { compileTimeoutMs?: number; runTimeoutMs?: number; contextFiles?: Array<{ src: string; rel: string }>; projectPath?: string; spec?: string } = {},
): Verdict {
  if (!files.length) return { accepted: false, gateA: false, gateB: false, detail: 'no files', ranAssertions: false }
  const { scratch, cfgDir, cfgPath, testAbs } = stage(files, testFile, opts.contextFiles, opts.projectPath)
  try {
    const tc = run('npx', ['tsc', '--noEmit', '-p', cfgPath], CODE_DIR, opts.compileTimeoutMs ?? 60_000)
    if (!tc.ok) return { accepted: false, gateA: false, gateB: false, detail: `typecheck: ${firstTsError(tc.out)}`, ranAssertions: false }
    const lv = lintCandidates(files)
    if (!lv.ok) return { accepted: false, gateA: true, gateB: false, detail: lv.detail, ranAssertions: false }
    const cv = checkContract(opts.spec ?? '', files)
    if (!cv.ok) return { accepted: false, gateA: true, gateB: false, detail: cv.detail, ranAssertions: false }
    if (!testFile || !testAbs) return { accepted: false, gateA: true, gateB: false, detail: 'compiles, but no behavioral test to confirm correctness', ranAssertions: false }
    const tb = run('npx', ['tsx', testAbs], scratch, opts.runTimeoutMs ?? 30_000)
    return {
      accepted: tb.ok, gateA: true, gateB: tb.ok,
      detail: tb.timedOut ? 'behavioral test TIMED OUT (candidate reaped)' : (testTail(tb.out) || tb.out.slice(0, 200)),
      ranAssertions: true,
    }
  } catch (e: any) {
    return { accepted: false, gateA: false, gateB: false, detail: `oracle error: ${String(e?.message ?? e).slice(0, 160)}`, ranAssertions: false }
  } finally {
    cleanup(scratch, cfgDir)
  }
}

/**
 * Async, non-blocking twin of `verifyCandidate` — same two gates, but spawns the toolchain
 * without stalling the event loop. The live server path uses this so an in-request pure-code
 * verification can't freeze other in-flight SSE streams.
 */
export async function verifyCandidateAsync(
  files: SynthFile[],
  testFile?: SynthFile,
  opts: { compileTimeoutMs?: number; runTimeoutMs?: number; contextFiles?: Array<{ src: string; rel: string }>; projectPath?: string; spec?: string } = {},
): Promise<Verdict> {
  if (!files.length) return { accepted: false, gateA: false, gateB: false, detail: 'no files', ranAssertions: false }
  const { scratch, cfgDir, cfgPath, testAbs } = stage(files, testFile, opts.contextFiles, opts.projectPath)
  try {
    const tc = await runAsync('npx', ['tsc', '--noEmit', '-p', cfgPath], CODE_DIR, opts.compileTimeoutMs ?? 60_000)
    if (!tc.ok) return { accepted: false, gateA: false, gateB: false, detail: `typecheck: ${firstTsError(tc.out)}`, ranAssertions: false }
    const lv = lintCandidates(files)
    if (!lv.ok) return { accepted: false, gateA: true, gateB: false, detail: lv.detail, ranAssertions: false }
    const cv = checkContract(opts.spec ?? '', files)
    if (!cv.ok) return { accepted: false, gateA: true, gateB: false, detail: cv.detail, ranAssertions: false }
    if (!testFile || !testAbs) return { accepted: false, gateA: true, gateB: false, detail: 'compiles, but no behavioral test to confirm correctness', ranAssertions: false }
    const tb = await runAsync('npx', ['tsx', testAbs], scratch, opts.runTimeoutMs ?? 30_000)
    return {
      accepted: tb.ok, gateA: true, gateB: tb.ok,
      detail: tb.timedOut ? 'behavioral test TIMED OUT (candidate reaped)' : (testTail(tb.out) || tb.out.slice(0, 200)),
      ranAssertions: true,
    }
  } catch (e: any) {
    return { accepted: false, gateA: false, gateB: false, detail: `oracle error: ${String(e?.message ?? e).slice(0, 160)}`, ranAssertions: false }
  } finally {
    cleanup(scratch, cfgDir)
  }
}

/** Write candidate + (optional) test into throwaway scratch dirs; returns the paths to act on. */
function stage(
  files: SynthFile[],
  testFile?: SynthFile,
  contextFiles?: Array<{ src: string; rel: string }>,  // Phase C: project files for correct placement
  projectPath?: string,  // Phase 6: project root — symlinks its node_modules into scratch
): { scratch: string; cfgDir: string; cfgPath: string; testAbs: string | null } {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-oracle-'))
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-oracle-cfg-'))

  // Phase 6: symlink the project's node_modules so `import 'express'` resolves inside scratch.
  // Symlink (not copy) keeps setup ~instant regardless of node_modules size.
  if (projectPath) {
    const projNm = path.join(projectPath, 'node_modules')
    if (fs.existsSync(projNm)) {
      try { fs.symlinkSync(projNm, path.join(scratch, 'node_modules'), 'dir') } catch { /* best-effort */ }
    }
  }

  // Copy project context files at their correct relative paths so generated imports resolve.
  // e.g. { src: '/project/src/types.ts', rel: 'src/types.ts' } → scratch/src/types.ts
  if (contextFiles?.length) {
    for (const { src, rel } of contextFiles) {
      try {
        const dest = path.join(scratch, rel)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(src, dest)
      } catch { /* non-fatal — tsc degrades gracefully on missing context */ }
    }
  }

  for (const f of files) {
    const abs = path.join(scratch, f.path)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, f.content)
  }
  const cfgPath = writeTsConfig(cfgDir, scratch, projectPath)
  let testAbs: string | null = null
  if (testFile) {
    testAbs = path.join(scratch, testFile.path)
    fs.mkdirSync(path.dirname(testAbs), { recursive: true })
    fs.writeFileSync(testAbs, testFile.content)
  }
  return { scratch, cfgDir, cfgPath, testAbs }
}

function cleanup(scratch: string, cfgDir: string): void {
  try { fs.rmSync(scratch, { recursive: true, force: true }) } catch { /* best effort */ }
  try { fs.rmSync(cfgDir, { recursive: true, force: true }) } catch { /* best effort */ }
}
