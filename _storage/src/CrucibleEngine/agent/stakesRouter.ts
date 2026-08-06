// HITL_PLANNING_TRACK.md §3 — stakes-aware HITL/automation router, first real slice
// (2026-07-05, widened 2026-07-06). Scores each about-to-execute tool CALL (loop.ts now
// checks every call in a turn, not just a lone call) on reversibility + blast radius (both
// deterministic — no model call) and decides whether it's safe to auto-execute or must
// route to the human first. Ambiguity is deliberately NOT re-scored here — ambiguity.ts
// already owns that axis pre-turn; re-litigating it per tool call would double-gate the
// same signal. This module only asks: "is what's about to happen a one-way door, and did
// the user's own words already authorize this specific door?" That second question is the
// router's version of "ambiguity" for a stakes decision — not "is the request unclear" but
// "did the user actually ask for THIS."
//
// Scope, honestly stated (same discipline as ambiguity.ts's own slice):
// - Covers the built-in destructive filesystem tools (delete_file, delete_folder,
//   empty_trash), a fixed set of destructive shell-command patterns run via the `run`
//   tool, and (2026-07-06) `create_tool` bodies that call native destructive fs/shell-out
//   APIs (see destructiveToolBodyReason in tools/registry.ts) — gated at CREATION time,
//   since a persisted dynamic tool is itself a one-way door (reloads on every future
//   server start) and its later invocations use whatever name the model gave it, which
//   this router has no way to recognize post-hoc. It does NOT cover control_mac or other
//   external integrations — still out of scope for this slice, not silently assumed safe;
//   a future pass should extend coverage rather than assume this list is exhaustive.
// - "Explicitly authorized" is a keyword/substring heuristic against the user's own goal
//   text, not real NLU. It errs toward asking (false positives cost one extra confirm;
//   false negatives ship an unwanted irreversible action) — see EXPLICIT_VERBS below.
//
// Found while building this: the `run` tool (registry.ts) already had its OWN destructive-
// command guard (DESTRUCTIVE_PATTERNS / destructiveReason) — but ctx.allowDestructive, the
// flag that's supposed to let an approved command through, was never set true ANYWHERE in
// the codebase. That guard was a permanent dead end: any destructive `run` command failed
// forever, even after a genuine explicit user "yes" reply, because nothing ever flipped the
// flag. This module reuses destructiveReason (not a second pattern list) and loop.ts now
// actually sets allowDestructive on a confirmed retry — see the loop.ts wiring.

export interface StakesAssessment {
  stakes: 'low' | 'high'
  reversible: boolean
  blastRadius: 'narrow' | 'wide'
  /** Plain-language restatement of the real-world consequence, per §3 — not the
   *  technical mechanism. Only set when stakes === 'high'. */
  reason: string
}

import { destructiveReason, destructiveToolBodyReason } from '../tools/registry'

const IRREVERSIBLE_TOOLS = new Set(['delete_file', 'delete_folder', 'empty_trash'])
const WIDE_BLAST_TOOLS = new Set(['delete_folder', 'empty_trash'])

/** Keywords whose presence in the user's OWN goal text count as explicit authorization
 *  for the matching class of irreversible action. Deliberately generic per action class
 *  (not per-path) — requiring an exact path match would make "clean up my Desktop" never
 *  count as authorization for deleting a specific file found while cleaning up, which is
 *  exactly the kind of reasonable-default autonomy RULE in defaultSystemPreamble grants. */
const EXPLICIT_VERBS: Record<string, RegExp> = {
  delete_file: /\b(delete|remove|erase|get rid of)\b/i,
  delete_folder: /\b(delete|remove|erase|wipe|clean\s*(up|out)|clear\s*out)\b/i,
  empty_trash: /\bempty\s+(the\s+)?trash\b/i,
  run: /\b(delete|remove|erase|wipe|force[\s-]?push|force[\s-]?reset|hard reset|drop table|reformat)\b/i,
  create_tool: /\b(delete|remove|erase|wipe|overwrite|shell out|run (?:a |an )?(?:arbitrary|shell) command)\b/i,
}

function destructiveRunMatch(command: string): { label: string; blastRadius: 'narrow' | 'wide' } | null {
  for (const p of DESTRUCTIVE_RUN_PATTERNS) if (p.re.test(command)) return { label: p.label, blastRadius: p.blastRadius }
  return null
}

export function assessStakes(toolName: string, args: Record<string, unknown>, goal: string): StakesAssessment {
  let irreversibleLabel: string | null = null
  let blastRadius: 'narrow' | 'wide' = 'narrow'

  // ── First non-filesystem consumer (FABLE5_HANDOFF Feature 7 / priority-ladder
  // item 3): the scheduled RSI self-improvement cycle. Mechanically never-regress
  // (snapshot → measure → keep-only-if-not-worse → hard-restore), so the
  // reversibility axis is intact by construction; the live stakes question is pure
  // AUTHORIZATION — an autonomous change to Crucible's own learned behavior is a
  // "who decided this?" door, not a data-loss door. The durable fully-automatic
  // toggle (.crucible/rsi-auto-approve.json, set through the Self-repair drawer)
  // is this action's standing equivalent of EXPLICIT_VERBS: the user's own explicit
  // opt-in, so re-confirming every scheduled tick would be exactly the un-asked-for
  // HITL friction §3 avoids. Toggle off ⇒ high stakes ⇒ the scheduler surfaces a
  // proposal card and waits for the human instead of running.
  if (toolName === 'rsi_cycle') {
    if (args?.autoApproveEnabled === true) {
      return { stakes: 'low', reversible: true, blastRadius: 'narrow', reason: '' }
    }
    return {
      stakes: 'high', reversible: true, blastRadius: 'narrow',
      reason: 'About to change how Crucible scores and picks answers, on its own schedule, without a human approving this specific change — the fully-automatic toggle is off, so this decision belongs to you (any change that measures worse is undone automatically either way).',
    }
  }

  if (IRREVERSIBLE_TOOLS.has(toolName)) {
    const target = String(args?.path ?? '').trim()
    blastRadius = WIDE_BLAST_TOOLS.has(toolName) ? 'wide' : 'narrow'
    irreversibleLabel = toolName === 'empty_trash'
      ? 'permanently empty the Trash (nothing in it can be recovered afterward)'
      : toolName === 'delete_folder'
        ? `permanently delete the folder "${target || '(unnamed)'}" and everything inside it`
        : `permanently delete the file "${target || '(unnamed)'}"`
  } else if (toolName === 'run') {
    const command = String(args?.command ?? '').trim()
    const why = command ? destructiveReason(command) : null
    if (why) {
      irreversibleLabel = `run a command that will do a ${why} (\`${command.slice(0, 120)}\`)`
      blastRadius = 'wide' // every destructiveReason pattern is a wide-impact class of action
    }
  } else if (toolName === 'create_tool') {
    const body = String(args?.body ?? '').trim()
    const name = String(args?.name ?? '(unnamed)').trim()
    const why = body ? destructiveToolBodyReason(body) : null
    if (why) {
      irreversibleLabel = `create and permanently register a new tool ("${name}") whose code ${why} — it will be available and auto-runnable in every future session too`
      blastRadius = 'wide' // a persisted capability, not a one-off action
    }
  }

  if (!irreversibleLabel) return { stakes: 'low', reversible: true, blastRadius: 'narrow', reason: '' }

  const authorizeRe = EXPLICIT_VERBS[toolName]
  const explicitlyAuthorized = !!authorizeRe && authorizeRe.test(goal)
  if (explicitlyAuthorized) {
    // The user's own words already asked for this class of action — automate per §3
    // ("automate when safe and effective"); re-confirming something they just asked for
    // would be the annoying, un-asked-for HITL friction this design explicitly avoids.
    return { stakes: 'low', reversible: false, blastRadius, reason: '' }
  }

  return {
    stakes: 'high',
    reversible: false,
    blastRadius,
    reason: `About to ${irreversibleLabel} — this can't be undone${blastRadius === 'wide' ? ' and affects more than one item' : ''}, and the request didn't explicitly ask for this.`,
  }
}
