// ═══════════════════════════════════════════════════════════════════════════════
// AGENT POST-CONDITIONS — the deterministic gate between "I did it" and "it is done"
// ═══════════════════════════════════════════════════════════════════════════════
//
// MEASURED 2026-08-03 (`npm run agent:workflow`, task `read-then-write`):
//
//   said: "The file prices.csv has been successfully read and added. No problems were flagged
//          during the process."
//   disk: prices.csv only. total.txt was never created.
//
// That is the failure this product exists to make impossible, and it happened on the agentic
// path because `loop.ts:65` makes verification OPTIONAL and DEFAULTS TO ACCEPTING the final
// answer. Everything labelled "VERIFY BEFORE REPORTING" in the agent system prompt is prose
// addressed to a 1.5B model — the loop asks the model to check itself and believes the reply.
// DOCTRINE §1 forbids exactly this: the model may PROPOSE, only a mechanical check may CERTIFY.
//
// So: extract post-conditions from the GOAL TEXT — before the agent runs, in language the user
// already wrote — and check them against the filesystem AFTER. The goal "write X into
// total.txt" contains a checkable claim, and checking it needs no model at all.
//
// Three principles, each learned from a specific failure in this repo:
//
//   1. EXTRACTION IS CONSERVATIVE. A goal we cannot read yields ZERO post-conditions, and zero
//      post-conditions is reported as UNVERIFIED, never as verified. `answerEngine.ts` shipped
//      `verified: true` for months because absence-of-a-check evaluated to true; that lesson
//      is baked in here as a distinct third state.
//   2. THE CHECK READS THE WORLD, NOT THE TRANSCRIPT. The agent's own account of what it did is
//      not evidence about what it did.
//   3. A FAILED POST-CONDITION IS NOT A STYLE NOTE. It is returned as a failure the loop must
//      act on, with the exact discrepancy, so the next iteration has something to fix.
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs'
import path from 'node:path'

export type Postcondition =
  /** A file must exist at `file`. */
  | { kind: 'file-exists'; file: string }
  /** A file must exist AND match `pattern` (source kept for the message). */
  | { kind: 'file-contains'; file: string; pattern: RegExp; described: string }
  /** No file under `dir` may have been removed — the seeded set must still be present. */
  | { kind: 'files-preserved'; dir: string; names: string[] }
  /** `token` must NOT appear in any of `files`. */
  | { kind: 'absent-in'; files: string[]; token: string }

export interface PostconditionResult {
  /** True only when at least one post-condition ran and every one passed. */
  verified: boolean
  /** True when nothing checkable could be extracted — distinct from a pass. */
  unverified: boolean
  passed: string[]
  failed: string[]
}

// ── Extraction ────────────────────────────────────────────────────────────────────────

/** Absolute-ish paths and bare filenames mentioned in the goal, in order of appearance. */
// A space inside the path class made "…/T/crucible-post-B2 containing exactly the line" one
// path, and a trailing "." in "in the folder /tmp/x." became part of the directory name. Both
// were caught by the bench; paths here are token-shaped and punctuation is stripped explicitly.
const PATH_CHARS = String.raw`[\w.@+-]`
const FILE_RX = new RegExp(String.raw`(?:^|[\s"'\`(])((?:\/${PATH_CHARS}+)+\/?|[\w-]+\.[a-z]{1,5})\b`, 'gi')
const DIR_HINT_RX = new RegExp(String.raw`\b(?:in|into|inside|under|to)\s+(?:the\s+)?(?:folder|directory|dir)?\s*((?:\/${PATH_CHARS}+)+)`, 'i')

/** Trailing sentence punctuation is never part of a path. */
const trimPunct = (s: string) => s.replace(/[.,;:!?)\]]+$/, '')

/** A filename mention with a directory nearby resolves to an absolute path. */
function resolveTargets(goal: string): { dir: string | null; files: string[] } {
  const dirRaw = DIR_HINT_RX.exec(goal)?.[1]
  const dir = dirRaw ? trimPunct(dirRaw).replace(/\/$/, '') : null
  const raw: string[] = []
  for (const m of goal.matchAll(FILE_RX)) {
    const tok = trimPunct(m[1])
    if (!/\.[a-z]{1,5}$/i.test(tok)) continue          // directories are not targets
    if (dir && tok === dir) continue                   // the directory itself is not a target
    raw.push(tok)
  }
  // Only ABSOLUTE targets become post-conditions. A bare "notes.md" with no directory in the
  // goal cannot be resolved to a real location, so asserting on it would fail forever against
  // the process cwd — and once the FINISH gate consults these, a permanently-failing condition
  // means an agent that can never declare itself done. Unresolvable is UNVERIFIED, not FAILED,
  // which is the same three-state discipline the rest of this file follows.
  const files = Array.from(new Set(raw))
    .map(f => (f.startsWith('/') ? f : dir ? path.join(dir, f) : null))
    .filter((f): f is string => f !== null)
  return { dir, files }
}

/** The literal a goal says the file must contain: "containing exactly the line: X" / "the line: X". */
const LITERAL_RX = /\bcontain(?:ing|s)?\s+(?:exactly\s+)?(?:the\s+)?(?:line|text|string|words?)\s*:?\s*["“']?([^"”'\n.]{3,120})/i
/** "rename A to B" — B must be present and A must be gone. */
const RENAME_RX = /\brename\s+(?:the\s+)?(?:function|method|variable|symbol|constant)?\s*([A-Za-z_$][\w$]*)\s+to\s+([A-Za-z_$][\w$]*)\b/i
/** Destructive intent: the post-condition is that nothing was lost without asking. */
const DESTROY_RX = /\b(delete|remove|erase|wipe|clear out|empty)\b/i

/**
 * Derive checkable post-conditions from the goal text.
 *
 * `seedNames` is what existed in the working directory BEFORE the run — needed for the
 * preservation check, which is the only condition whose truth depends on the prior state.
 */
export function extractPostconditions(goal: string, seedNames: string[] = []): Postcondition[] {
  const g = goal ?? ''
  const out: Postcondition[] = []
  const { dir, files } = resolveTargets(g)

  // Destructive goals invert: the post-condition is that the files SURVIVED, because a
  // destructive action must be confirmed by a human first. If the user has confirmed, the
  // caller simply does not run this check.
  if (DESTROY_RX.test(g) && dir && seedNames.length) {
    return [{ kind: 'files-preserved', dir, names: seedNames }]
  }

  const rename = RENAME_RX.exec(g)
  if (rename) {
    const [, from, to] = rename
    // Every file the goal points at, or every seeded file when it points at a directory.
    const targets = files.length ? files : dir ? seedNames.map(n => path.join(dir, n)) : []
    if (targets.length) {
      out.push({ kind: 'absent-in', files: targets, token: from })
      for (const f of targets) {
        out.push({ kind: 'file-contains', file: f, pattern: new RegExp(`\\b${to}\\b`), described: to })
      }
    }
    return out
  }

  // A goal that names a file and asks for it to be written/created must produce that file.
  // The FIRST file mentioned is treated as the target only when a creation verb is present —
  // "read prices.csv and write total.txt" must not assert that prices.csv was created.
  const creating = /\b(create|write|save|produce|generate|put|output|add)\b/i.test(g)
  if (creating && files.length) {
    // Prefer a file that appears AFTER a creation verb; fall back to the last mentioned.
    const target = files[files.length - 1]
    out.push({ kind: 'file-exists', file: target })
    const lit = LITERAL_RX.exec(g)
    if (lit) {
      const text = lit[1].trim()
      out.push({
        kind: 'file-contains',
        file: target,
        pattern: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
        described: text,
      })
    }
  }
  return out
}

// ── Checking ──────────────────────────────────────────────────────────────────────────

function readSafe(f: string): string | null {
  try { return fs.readFileSync(f, 'utf8') } catch { return null }
}

/** Run every post-condition against the real filesystem. No model, no transcript. */
export function checkPostconditions(conds: Postcondition[]): PostconditionResult {
  const passed: string[] = []
  const failed: string[] = []

  for (const c of conds) {
    switch (c.kind) {
      case 'file-exists': {
        if (fs.existsSync(c.file)) passed.push(`${path.basename(c.file)} exists`)
        else failed.push(`${c.file} was never created`)
        break
      }
      case 'file-contains': {
        const t = readSafe(c.file)
        if (t === null) failed.push(`${c.file} was never created, so it cannot contain "${c.described}"`)
        else if (c.pattern.test(t)) passed.push(`${path.basename(c.file)} contains "${c.described}"`)
        else failed.push(`${path.basename(c.file)} exists but does not contain "${c.described}"`)
        break
      }
      case 'files-preserved': {
        const missing = c.names.filter(n => !fs.existsSync(path.join(c.dir, n)))
        if (missing.length) failed.push(`destructive action taken without confirmation — lost ${missing.join(', ')}`)
        else passed.push(`no files were destroyed without confirmation`)
        break
      }
      case 'absent-in': {
        const still = c.files.filter(f => { const t = readSafe(f); return t !== null && new RegExp(`\\b${c.token}\\b`).test(t) })
        if (still.length) failed.push(`"${c.token}" still present in ${still.map(f => path.basename(f)).join(', ')}`)
        else passed.push(`"${c.token}" no longer appears in any target file`)
        break
      }
    }
  }

  return {
    // Absence of a check is NOT a pass. This is the same defect answerEngine.ts shipped.
    verified: conds.length > 0 && failed.length === 0,
    unverified: conds.length === 0,
    passed,
    failed,
  }
}

/** One-shot: extract from the goal, check against the world. */
export function verifyGoal(goal: string, seedNames: string[] = []): PostconditionResult {
  return checkPostconditions(extractPostconditions(goal, seedNames))
}

/** The correction message handed back to the loop when a post-condition fails. */
export function correctionFor(r: PostconditionResult): string {
  return [
    'POST-CONDITION CHECK FAILED. The filesystem was inspected directly and does not match what you reported:',
    ...r.failed.map(f => `  - ${f}`),
    'Do not answer again until you have used a tool to make each of these true. Report only what a tool call confirmed.',
  ].join('\n')
}
