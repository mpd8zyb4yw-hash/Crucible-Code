// ═══════════════════════════════════════════════════════════════════════════════
// FM-BACKED PLANNER — the (untrusted) decomposition proposer for solveByDecomposition
// ═══════════════════════════════════════════════════════════════════════════════
//
// solveByDecomposition needs a Planner: a function that splits a stuck goal into an
// ordered list of smaller subgoals. That is a PROPOSAL, not a judgement — a weak plan
// only wastes budget, it can never make a wrong answer pass (every rung and the whole
// composition are verifier-certified downstream). So the small on-device model is a fine
// planner: cheap, fallible, and fully contained by the verifier.
//
// The prompt asks for a strictly INCREMENTAL plan — each rung builds on the last and adds
// ONE checkable capability — because that is the shape the weak proposer can actually
// climb (see decompose.ts). We parse defensively: any of a numbered list / JSON array /
// newline bullets is accepted, and a plan that doesn't parse into ≥2 rungs returns null
// so decomposition cleanly DECLINES rather than guessing.
// ═══════════════════════════════════════════════════════════════════════════════

import { fmComplete } from '../agent/fmReact'
import type { Planner, SubGoal } from './decompose'
import type { Attempt, TaskSpec } from './types'

const SYSTEM =
  'You are a planning module. You break ONE hard goal into the smallest possible ordered ' +
  'sequence of sub-steps, where each sub-step builds directly on the previous one and adds ' +
  'exactly ONE independently-checkable piece. You never solve the goal — you only outline ' +
  'the rungs. Prefer FEWER, larger-than-trivial rungs (2–6). Each rung must be a concrete, ' +
  'verifiable milestone, not a vague phase.'

function buildUser(spec: TaskSpec, best: Attempt | null): string {
  const parts = [
    `GOAL:\n${spec.goal}`,
    best?.verdict.signals?.length
      ? `A single-shot attempt STALLED. What the verifier reported:\n${best.verdict.signals.slice(0, 6).map((s) => `- ${s}`).join('\n')}`
      : 'A single-shot attempt could not be certified.',
    'Output ONLY a numbered list of 2–6 rungs, most-foundational first. Each line: ' +
      '"N. <one concrete milestone that builds on the prior rung>". No preamble, no code.',
  ]
  return parts.join('\n\n')
}

/** Parse an FM reply into ordered subgoals. Accepts numbered lists, dashes, or a JSON array. */
export function parsePlan(raw: string): SubGoal[] {
  const text = (raw ?? '').trim()
  if (!text) return []

  // Try JSON array of strings/objects first.
  if (text.startsWith('[')) {
    try {
      const arr = JSON.parse(text)
      if (Array.isArray(arr)) {
        const goals = arr
          .map((x) => (typeof x === 'string' ? x : x?.goal ?? x?.step ?? x?.title))
          .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          .map((g) => ({ goal: g.trim() }))
        if (goals.length) return goals
      }
    } catch { /* fall through to line parsing */ }
  }

  const out: SubGoal[] = []
  for (const line of text.split('\n')) {
    // strip leading "1." / "1)" / "-" / "*" / "•"
    const m = line.match(/^\s*(?:\d+[.)]|[-*•])\s+(.*\S)\s*$/)
    if (m) {
      const goal = m[1].replace(/\*\*/g, '').trim()
      if (goal.length > 2) out.push({ goal })
    }
  }
  return out
}

export interface FmPlannerOpts {
  /** Override the planning temperature (a little exploration helps here). Default 0.4. */
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
}

/** Build a Planner that asks the on-device FM for an incremental decomposition. */
export function makeFmPlanner(opts: FmPlannerOpts = {}): Planner {
  return async (spec: TaskSpec, best: Attempt | null, signal?: AbortSignal) => {
    const raw = await fmComplete(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: buildUser(spec, best) },
      ],
      { temperature: opts.temperature ?? 0.4, maxTokens: opts.maxTokens ?? 400, timeoutMs: opts.timeoutMs, signal },
    )
    const plan = parsePlan(raw)
    // < 2 rungs is not a decomposition — decline so the caller keeps its honest abstain.
    return plan.length >= 2 ? plan : null
  }
}
