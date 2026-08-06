// ============================================================================
// userSkillPipeline — the verified NL-skill path for the Library drawer
// (FABLE5_HANDOFF Feature 1 increment).
//
// A plain-language skill request becomes a PROVEN catalog entry, or it becomes
// nothing — never an unverified one. The pipeline reuses the existing factory
// end to end rather than duplicating any of it:
//
//   1. Admission     — the request must declare an exact API (export function …)
//                      and pin down ≥2 worked examples (f(x) -> y). No examples
//                      ⇒ nothing to prove ⇒ honest rejection with guidance.
//   2. Duplicate     — an export-name / id collision with the merged catalog is
//                      reported, not silently shadowed (catalogIndex dedupes by
//                      first-wins, so a shadowed entry would be dead weight).
//   3. Synthesis     — synthesizeUniversal: L0 primitive → L1 enumerative → L3
//                      on-device FM, all gated by the execution oracle against
//                      the spec's own examples. An L0 hit means the library
//                      already covers the request — reported as such.
//   4. Entry build   — the verified impl + the SAME examples the oracle ran
//                      become a CatalogEntry in catalogs/user-skills.json.
//   5. Batch oracle  — validate-batch.ts on the whole user batch (shape gate,
//                      self-match ≥0.5, suite run in scratch).
//   6. Library oracle— generate:skills + prove:all (Invariant 4, library-wide
//                      self-match). Any failure rolls the batch back and re-runs
//                      generate+prove so the manifest never drifts from green.
//
// Long-running (FM rounds + ~100s prove:all) — callers run it as a background
// job and poll; onProgress streams stage transitions.
// ============================================================================

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'
import CATALOG, { type CatalogEntry } from './catalogIndex'
import { extractFeatures } from './synthEngine'
import { extractSpecExamples } from './derive'
import { synthesizeUniversal } from './universal'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
const CATALOGS_DIR = path.join(HERE, 'catalogs')
const USER_BATCH = path.join(CATALOGS_DIR, 'user-skills.json')
const SKILLS_DIR = path.join(HERE, 'skills')

export type UserSkillStage =
  | 'admission' | 'duplicate' | 'synthesize' | 'validate' | 'prove' | 'done'

export interface UserSkillBuildResult {
  ok: boolean
  stage: UserSkillStage
  message: string
  /** Set on success — the full proven entry (also appended to user-skills.json). */
  entry?: CatalogEntry
  detail?: string
}

export interface UserSkillProgress { stage: UserSkillStage; message: string }

function readUserBatch(): CatalogEntry[] {
  try {
    const arr = JSON.parse(fs.readFileSync(USER_BATCH, 'utf8'))
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/** One line, ≤160 chars, and never "function <word>(" prose that extractFeatures
 *  would read as a spurious export on the prove-all proof spec. */
function buildSummary(request: string): string {
  const lines = request.split('\n').map(l => l.trim().replace(/^[-*\d.)\s]+/, '')).filter(l => l.length > 0)
  // Prefer descriptive prose over file directives, signature declarations, and examples.
  const prose = lines.find(l =>
    !/^create\b.*\.\w+$/i.test(l) &&
    !/^export\s/.test(l) &&
    !/(->|=>|===|\breturns\b)/.test(l))
  const firstLine = prose ?? lines[0] ?? 'user-built skill'
  return `User-built skill: ${firstLine.replace(/\bfunction\s+(?=[A-Za-z_$][\w$]*\s*\()/gi, 'routine ')}`.slice(0, 160)
}

function run(cmd: string, args: string[], timeoutMs: number): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
  })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

export async function buildUserSkill(
  request: string,
  onProgress?: (p: UserSkillProgress) => void,
): Promise<UserSkillBuildResult> {
  const progress = (stage: UserSkillStage, message: string) => { try { onProgress?.({ stage, message }) } catch { /* observer only */ } }

  // ── 1. Admission — the request must pin down provable behavior. ────────────
  progress('admission', 'Checking the request declares an exact API and worked examples')
  const feats = extractFeatures(request)
  if (!feats.exports.length) {
    return {
      ok: false, stage: 'admission',
      message: 'The request must declare the exact API to build, e.g. `export function slugify(title: string): string`. Without a pinned signature there is nothing the oracle can prove.',
    }
  }
  const examples = extractSpecExamples(request)
  if (examples.length < 2) {
    return {
      ok: false, stage: 'admission',
      message: `A proven skill needs at least 2 worked examples pinning its behavior (found ${examples.length}). Add lines like \`slugify("Hello World") -> "hello-world"\` — the oracle verifies the generated code against exactly these before anything enters the library.`,
    }
  }

  // ── 2. Duplicate check against the merged catalog + on-disk user batch. ────
  const existingUser = readUserBatch()
  const all = [...CATALOG, ...existingUser]
  const wanted = new Set(feats.exports)
  const collision = all.find(e => e.exports.some(x => wanted.has(x)))
  if (collision) {
    return {
      ok: false, stage: 'duplicate',
      message: `Already covered: catalog skill '${collision.id}' exports ${collision.exports.filter(x => wanted.has(x)).join(', ')}. Use /skill ${collision.id} to emit it, or rename your export if the behavior is genuinely different.`,
    }
  }

  // ── 3. Oracle-gated synthesis (L0 → L1 → on-device FM). ────────────────────
  const primaryExport = feats.exports[0]
  const modulePath = feats.modulePath ?? `src/lib/${primaryExport}.ts`
  progress('synthesize', `Synthesizing ${modulePath} — pure-code cascade first, on-device FM as last resort, oracle-gated against your ${examples.length} example(s)`)
  // 6 FM rounds (default 3): a user explicitly asked for this skill and is
  // watching a progress card — spending more oracle-gated attempts is the right
  // trade, and every round is still verified against the spec's own examples.
  const synth = await synthesizeUniversal(request, { modulePath, distill: false, maxFmRounds: 6 })
  if (synth.source === 'primitive') {
    return {
      ok: false, stage: 'duplicate',
      message: `An existing verified primitive already solves this (${synth.detail}) — no new entry needed.`,
    }
  }
  if (!synth.verified || !synth.files.length) {
    return {
      ok: false, stage: 'synthesize',
      message: 'Could not produce an oracle-passing implementation — nothing was added to the library (it only ever grows with proven code).',
      detail: synth.detail,
    }
  }
  const impl = synth.files[0].content

  // ── 4. Build the CatalogEntry. ──────────────────────────────────────────────
  const usedNames = new Set<string>()
  for (const e of all) { usedNames.add(e.id); usedNames.add(e.filename) }
  let id = `user/${primaryExport}`
  let filename = `user_${primaryExport}`
  for (let n = 2; usedNames.has(id) || usedNames.has(filename) || fs.existsSync(path.join(SKILLS_DIR, `${filename}.ts`)); n++) {
    id = `user/${primaryExport}${n}`
    filename = `user_${primaryExport}${n}`
  }
  const entry: CatalogEntry = {
    id, filename,
    summary: buildSummary(request),
    defaultPath: modulePath,
    exports: feats.exports,
    // Exact export-name patterns at 0.9 — the skill-factory self-match convention
    // (the proof spec always contains the export stubs, so these always fire).
    patterns: feats.exports.map(x => ({ re: `\\b${escapeRe(x)}\\b`, weight: 0.9 })),
    impl,
    tests: examples.map(e => ({ desc: `${e.lhs} === ${e.rhs}`.slice(0, 120), call: e.lhs, want: e.rhs })),
  }

  // ── 5. Per-batch oracle on the WHOLE user batch (existing entries + new). ──
  progress('validate', 'Running the batch oracle (shape gate, self-match, adversarial suite)')
  const scratchDir = fs.mkdtempSync(path.join(REPO_ROOT, '.crucible', 'user-skill-'))
  const scratchBatch = path.join(scratchDir, 'user-skills.json')
  fs.writeFileSync(scratchBatch, JSON.stringify([...existingUser, entry], null, 2))
  const val = run('npx', ['tsx', path.join(HERE, 'validate-batch.ts'), scratchBatch], 5 * 60_000)
  fs.rmSync(scratchDir, { recursive: true, force: true })
  if (!val.ok) {
    return {
      ok: false, stage: 'validate',
      message: 'The generated skill failed the batch oracle — not added.',
      detail: val.out.split('\n').filter(l => /✗|FAIL/.test(l)).slice(-4).join('\n') || val.out.slice(-400),
    }
  }

  // ── 6. Land it, then hold it to the library-wide bar (Invariant 4). ────────
  progress('prove', 'Entry passed — regenerating skill files and re-proving the whole library (~2 min)')
  const before = fs.existsSync(USER_BATCH) ? fs.readFileSync(USER_BATCH, 'utf8') : null
  fs.writeFileSync(USER_BATCH, JSON.stringify([...existingUser, entry], null, 2))
  const gen = run('npm', ['run', 'generate:skills'], 2 * 60_000)
  const prove = gen.ok ? run('npm', ['run', 'prove:all'], 10 * 60_000) : gen
  if (!prove.ok) {
    // Roll back: restore the batch, drop the generated files, restore a green manifest.
    if (before === null) fs.rmSync(USER_BATCH, { force: true })
    else fs.writeFileSync(USER_BATCH, before)
    fs.rmSync(path.join(SKILLS_DIR, `${filename}.ts`), { force: true })
    fs.rmSync(path.join(SKILLS_DIR, '_suites', `${filename}.hidden.ts`), { force: true })
    run('npm', ['run', 'generate:skills'], 2 * 60_000)
    run('npm', ['run', 'prove:all'], 10 * 60_000)
    return {
      ok: false, stage: 'prove',
      message: 'The entry passed its own suite but failed the library-wide prove (usually a self-match collision with an existing skill). Rolled back — the library is unchanged.',
      detail: prove.out.split('\n').filter(l => /FAIL|✗/.test(l)).slice(-4).join('\n') || prove.out.slice(-400),
    }
  }

  const via = synth.source === 'enumerative' ? 'pure-code enumerative search (zero model calls)' : `on-device FM (${synth.fmCalls} call(s)), oracle-verified`
  return {
    ok: true, stage: 'done', entry,
    message: `'${id}' is now a proven library skill — built via ${via}, verified against your ${examples.length} example(s) plus the library-wide prove (Invariant 4 holds). Reusable in every future session with zero model calls: /skill ${id}`,
  }
}
