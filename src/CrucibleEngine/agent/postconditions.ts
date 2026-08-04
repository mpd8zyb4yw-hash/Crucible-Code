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
/**
 * "add/append the word world to <file>" — the literal that must end up IN the file.
 *
 * MEASURED 2026-08-04 (`follow-up-turn`): the second turn resolved to a real path, `add` counted
 * as a creation verb, and the only post-condition raised was "draft.txt exists" — which was
 * ALREADY TRUE, because turn one created it. So FINISH was offered on the first iteration and
 * the agent stopped in 3.2s having done nothing, reporting "every step has been carried out".
 * An existence check on a file that already exists is not a check. The goal names the exact
 * text to add, so the condition worth asserting is that the text is now there.
 */
export const ADD_LITERAL_RX = /\b(?:add|append|insert)\s+(?:the\s+)?(?:word|line|text|string|phrase)\s*:?\s*["“']?([^"”'\n.,]{1,80}?)["”']?\s+(?:to|onto|at|into)\b/i
/** "rename A to B" — B must be present and A must be gone. */
export const RENAME_RX = /\brename\s+(?:the\s+)?(?:function|method|variable|symbol|constant)?\s*([A-Za-z_$][\w$]*)\s+to\s+([A-Za-z_$][\w$]*)\b/i
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
    // A goal can name SEVERAL deliverables. MEASURED 2026-08-03: "create two files: first.txt
    // containing alpha, and second.txt containing bravo" asserted only second.txt, so the FINISH
    // gate was satisfied with half the job — and an attempt to steer writes by the outstanding
    // path forced the second file and stranded the first. When the goal announces a count
    // ("two files") or lists targets with a colon/comma, every file named after the creation
    // verb is a deliverable. Otherwise the last-mentioned file remains the single target, which
    // is what keeps "read prices.csv and write total.txt" from asserting prices.csv.
    const multi = /\b(two|three|four|both|several|each)\b[^.]{0,40}\bfiles?\b/i.test(g)
    const verbIdx = g.search(/\b(create|write|save|produce|generate|put|output|add)\b/i)
    const afterVerb = files.filter(f => g.indexOf(path.basename(f)) > verbIdx)
    const targets = multi && afterVerb.length > 1 ? afterVerb : [files[files.length - 1]]
    for (const t of targets) out.push({ kind: 'file-exists', file: t })
    const target = targets[targets.length - 1]
    // The literal check assumes ONE deliverable: with several, "containing the word alpha, and
    // second.txt containing the word bravo" reads as a single literal "alpha, and second" and
    // asserts it of the wrong file. Matching a literal per target needs a parse this does not
    // have, so multi-target goals assert existence only — conservative, per the rule at the top
    // of this file that an unreadable condition is simply not asserted.
    // An ADD/APPEND names its literal in a different shape than a CREATE does ("add the word
    // world TO x" vs "create x CONTAINING the word world"), and for an append the existence
    // check is vacuous — see ADD_LITERAL_RX.
    const lit = targets.length > 1 ? null : (LITERAL_RX.exec(g) ?? ADD_LITERAL_RX.exec(g))
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

/**
 * The absolute paths a goal requires but which are not satisfied yet, in goal order.
 *
 * The failure MESSAGES are for humans; a caller that needs to ACT on them needs the path itself.
 * Used by the tool-call driver to set a write's target directly instead of describing it and
 * hoping the model reads the description.
 */
export function outstandingPaths(goal: string, seedNames: string[] = []): string[] {
  const out: string[] = []
  for (const c of extractPostconditions(goal, seedNames)) {
    if (c.kind === 'file-exists' && !fs.existsSync(c.file)) out.push(c.file)
    else if (c.kind === 'file-contains') {
      const t = readSafe(c.file)
      if (t === null || !c.pattern.test(t)) out.push(c.file)
    }
  }
  return Array.from(new Set(out))
}

/**
 * The content a goal states for a SPECIFIC file — "second.txt containing the word bravo".
 *
 * MEASURED 2026-08-03: once the driver started pointing a write at the outstanding file, it
 * wrote the RIGHT path with the WRONG content — second.txt got "alpha", the first file's word,
 * because only the path was being corrected. A goal that names the content per file states it
 * unambiguously; reading it is a parse, not a judgement.
 */
export function contentForFile(goal: string, file: string): string | null {
  const base = path.basename(file)
  const i = (goal ?? '').indexOf(base)
  if (i < 0) return null
  const after = goal.slice(i + base.length)
  const m = /^[^.]{0,20}?\bcontain(?:ing|s)?\s+(?:exactly\s+)?(?:the\s+)?(?:word|line|text|string)?\s*:?\s*["“']?([^"”'\n,;]{1,120}?)["”']?\s*(?:,|;|\.|and\b|$)/i.exec(after)
  return m ? m[1].trim() || null : null
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
