// ============================================================================
// Shared proven-skill loader. Imports every filename in skills/_manifest.ts
// (Invariant 4: each passed prove-all's adversarial suite) into the global
// REGISTRY. Idempotent — ESM module caching means a skill self-registers once
// no matter how many importers reference it.
//
// Used by BOTH the L0 fast path (pureCode) and the L2 bridge so the matcher
// sees the full proven library deterministically, regardless of call order.
// ============================================================================

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILLS_DIR = path.join(HERE, 'skills')
const LEARNED_DIR = path.join(SKILLS_DIR, '_learned')

let libraryReady = false
let libraryLoading: Promise<void> | null = null

export async function ensureLibraryLoaded(): Promise<void> {
  if (libraryReady) return
  if (libraryLoading) { await libraryLoading; return }
  libraryLoading = (async () => {
    const { PROVEN_SKILLS } = await import(path.join(SKILLS_DIR, '_manifest.js')).catch(
      () => import(path.join(SKILLS_DIR, '_manifest.ts') as string),
    ) as { PROVEN_SKILLS: string[] }
    await Promise.allSettled(PROVEN_SKILLS.map(name =>
      import(path.join(SKILLS_DIR, `${name}.js`)).catch(() =>
        import(path.join(SKILLS_DIR, `${name}.ts`)).catch(() => { /* skill unavailable — skip */ }),
      ),
    ))

    // Phase A: load durable distilled skills from _learned/ (oracle-verified at distillation time)
    //
    // MEASUREMENT MODE (CRUCIBLE_NO_LEARN=1) skips this load entirely. Rationale: a task
    // solved via path=gen has its solution distilled into _learned/ (pureCode.ts
    // distillToSkill), so the NEXT run of the same task matches it here and scores
    // path=catalog — measured on bugfixCsv, 99s gen -> 3s catalog. That makes repeat runs
    // grade the benchmark's own memory instead of its generation, and it silently erodes
    // the gen sample over time. This is the READ half of the guard; distillToSkill holds
    // the WRITE half. Both must be off to get an uncontaminated capability number.
    if (process.env.CRUCIBLE_NO_LEARN) {
      libraryReady = true
      return
    }
    try {
      const learnedFiles = fs.readdirSync(LEARNED_DIR)
        .filter(f => f.endsWith('.ts') || f.endsWith('.js'))
      await Promise.allSettled(learnedFiles.map(f =>
        import(path.join(LEARNED_DIR, f.replace(/\.ts$/, '.js'))).catch(() =>
          import(path.join(LEARNED_DIR, f)).catch(() => { /* skip unloadable learned skill */ }),
        ),
      ))
    } catch { /* _learned/ absent — skip */ }

    libraryReady = true
  })()
  await libraryLoading
}

/** Test/bench hook: force a reload on next ensureLibraryLoaded (e.g. after regenerating skills). */
export function resetLibraryLoaded(): void { libraryReady = false; libraryLoading = null }
