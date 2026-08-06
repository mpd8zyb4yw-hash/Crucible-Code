// ============================================================================
// CRUCIBLE_NO_LEARN measurement-mode bench.
//
// WHY: the coding benchmark grades its own memory. A task solved via path=gen has
// its solution distilled into skills/_learned/ (pureCode.ts distillToSkill), and
// loadLibrary.ts imports that directory at boot — so the NEXT run of the same task
// matches the learned skill and scores path=catalog. Measured on bugfixCsv: 99s
// gen -> 3s catalog. That means "run it 3x for confidence" measures memorized
// reliability, not generative reliability, and the gen sample shrinks every run.
//
// CRUCIBLE_NO_LEARN=1 closes BOTH halves — the read (loadLibrary skips _learned/)
// and the write (distillToSkill is a no-op, including its in-memory registration).
// This bench is the isolation proof that both halves actually hold, so a future
// refactor cannot silently re-contaminate the measurement.
//
// Run: npx tsx src/CrucibleEngine/synth/__noLearn_bench.ts
//
// Structure: the read half MUST be checked in a fresh process (library loading is
// memoized and ESM module caching makes a learned skill permanent once imported),
// so the bench re-spawns itself as a child in each configuration and asserts on the
// child's JSON report.
// ============================================================================

import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SELF = path.join(HERE, '__noLearn_bench.ts')
const LEARNED_DIR = path.join(HERE, 'skills', '_learned')

// ── child mode: report what this process actually loaded / registered ────────
if (process.env.__NOLEARN_CHILD) {
  const { ensureLibraryLoaded } = await import('./loadLibrary')
  const { listSkills } = await import('./synthEngine')
  const { distillToSkill } = await import('./pureCode')

  await ensureLibraryLoaded()
  const learnedLoaded = listSkills().filter(s => s.id.startsWith('learned/')).length

  // Write half — a spec shaped like a real synth win, with an export the matcher can key on.
  const before = listSkills().length
  distillToSkill(
    'Create src/__nolearn_probe.ts.\n\nExact public API (src/__nolearn_probe.ts):\n  export function noLearnProbeFn(x: number): number',
    'src/__nolearn_probe.ts',
    'export function noLearnProbeFn(x: number): number { return x }',
  )
  const registered = listSkills().length - before

  process.stdout.write('\n__NOLEARN_REPORT__' + JSON.stringify({ learnedLoaded, registered }) + '\n')
  process.exit(0)
}

// ── parent mode ──────────────────────────────────────────────────────────────
function runChild(noLearn: boolean): { learnedLoaded: number; registered: number } {
  const r = spawnSync('npx', ['tsx', SELF], {
    cwd: path.resolve(HERE, '../../..'),
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, __NOLEARN_CHILD: '1', ...(noLearn ? { CRUCIBLE_NO_LEARN: '1' } : {}) },
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const m = out.match(/__NOLEARN_REPORT__(\{.*\})/)
  if (!m) throw new Error(`child (noLearn=${noLearn}) produced no report:\n${out.slice(-1200)}`)
  return JSON.parse(m[1])
}

let pass = 0, fail = 0
const check = (name: string, cond: boolean, detail: string) => {
  if (cond) { pass++; console.log(`  PASS  ${name} — ${detail}`) }
  else { fail++; console.log(`  FAIL  ${name} — ${detail}`) }
}

console.log('CRUCIBLE_NO_LEARN measurement-mode bench\n')

// Precondition: there must BE learned skills on disk, or the read-half test proves nothing
// (0 loaded with the flag off and 0 with it on would trivially "pass" while measuring nothing).
const onDisk = fs.existsSync(LEARNED_DIR)
  ? fs.readdirSync(LEARNED_DIR).filter(f => f.endsWith('.ts') || f.endsWith('.js'))
  : []
console.log(`  learned/ on disk: ${onDisk.length} file(s)\n`)

const off = runChild(false)
const on = runChild(true)

check('read half: default mode LOADS the learned catalog',
  off.learnedLoaded > 0,
  `flag off -> ${off.learnedLoaded} learned skill(s) registered (needs > 0 for this bench to mean anything; ${onDisk.length} on disk)`)

check('read half: CRUCIBLE_NO_LEARN suppresses the learned catalog',
  on.learnedLoaded === 0,
  `flag on -> ${on.learnedLoaded} learned skill(s) registered (want 0)`)

check('write half: default mode DISTILLS a verified candidate',
  off.registered === 1,
  `flag off -> distillToSkill registered ${off.registered} skill(s) (want 1)`)

check('write half: CRUCIBLE_NO_LEARN suppresses distillation',
  on.registered === 0,
  `flag on -> distillToSkill registered ${on.registered} skill(s) (want 0)`)

// The guard must hold on DISK, not just in memory — an in-memory-only suppression would
// still poison the next process via skills/_learned/. Two children ran: the flag-OFF
// control (which SHOULD have persisted exactly one probe file) and the flag-ON subject
// (which should have persisted nothing). Exactly one new file total proves both.
//
// Compare against the same `.ts`/`.js` filter used to build `onDisk` — an earlier version
// of this check read the directory unfiltered, saw the tracked `.gitkeep` as "new", and
// its cleanup step deleted it.
const newLearned = (fs.existsSync(LEARNED_DIR)
  ? fs.readdirSync(LEARNED_DIR).filter(f => f.endsWith('.ts') || f.endsWith('.js'))
  : []
).filter(f => !onDisk.includes(f))

check('write half: exactly one new file on disk — the control child\'s, not the guarded child\'s',
  newLearned.length === 1,
  `new learned file(s) after both children: ${newLearned.length ? newLearned.join(', ') : '(none)'} — want exactly 1 ` +
  `(0 means the flag-OFF control did not persist, so the disk half is untested; 2 means CRUCIBLE_NO_LEARN did not hold)`)

// Remove the control child's artifact so the bench is idempotent and does not itself
// contaminate the learned catalog it exists to protect. Only ever deletes files this
// run created (`newLearned`), never a pre-existing one.
for (const f of newLearned) {
  try { fs.unlinkSync(path.join(LEARNED_DIR, f)); console.log(`  cleanup: removed control artifact ${f}`) } catch { /* best-effort */ }
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)
