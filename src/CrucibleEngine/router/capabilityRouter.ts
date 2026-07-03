// EXPERIMENTAL — PARKED, NOT LIVE (decided 2026-07-04, Tier 0-2 fork resolution).
// server.ts does not import this module. The code path a real /api/chat request takes is
// agent/planner.ts + agent/loop.ts + agent/synthDriver.ts. This file (and decompositionDag.ts,
// nodeExecutor.ts) is proven correct only in isolation/tests. Decision: keep it parked as a
// design reference and a candidate for a future deliberate migration, rather than merge it into
// the live path piecemeal — the live stack already carries hard-won, battle-tested fixes
// (protected-file tool-layer enforcement, wrong-write-target guard, secondary-file spec
// isolation) that a rewrite would have to re-earn. Do not build further on this stack without
// first re-opening the fork decision; do not treat "[x]" in ROADMAP.md's mission build order as
// "live" for these three files.
//
// Capability Router + Escalation Policy — the foundation layer (mission Tier 0).
//
// Before any task touches the FM or the synthesis engine, it is classified here.
// The router replaces the concept of "escalation to a paid model": there is no paid
// model to escalate to. `abstain` means abstain, with a calibrated confidence score
// and a human-readable reason. The abstain path is ALWAYS reachable — there is no
// "try anyway" fallback that bypasses this contract.
//
// Every decision emits a confidence classification, not just a route. This is what
// makes the moat number honest: verified vs FM-pattern vs retrieved vs escalated are
// reported as separate buckets, never one aggregate pass rate.
//
// STATUS: typed contract + stub only. No classification logic yet — the stub abstains.

/** Where a task should be handled. */
export type Route =
  | 'synth'    // verified-deterministic → synth engine directly, zero FM inference
  | 'fm'       // pattern-covered → FM with property-family gating
  | 'retrieve' // retrieval-required → fetch from the internet first, ground, then synthesize
  | 'abstain'  // not attemptable with calibrated confidence → surface to the user

/** The unit of work handed to the router. */
export interface RouterTask {
  /** Natural-language request as received. */
  goal: string
  /** Absolute path to the project the task operates on, if any. */
  projectPath?: string
  /** Files the task is known to target, if already resolved by an upstream step. */
  targetFiles?: string[]
  /** Free-form hints from earlier pipeline stages (DAG node, prior attempts, etc.). */
  context?: Record<string, unknown>
}

/** The router's decision. Confidence is in [0, 1] and is per-route calibrated. */
export interface RouteDecision {
  route: Route
  /** Calibrated confidence in [0, 1] that this route will succeed. */
  confidence: number
  /** Human-readable justification — required, never empty. */
  reason: string
}

/** Reporting buckets, kept distinct so the moat number stays honest. */
export type ResultBucket =
  | 'verified'           // synth route, behaviourally proven
  | 'fm-pattern'         // fm route, property-family gated
  | 'retrieval-grounded' // retrieve route, grounded then synthesized/gated
  | 'escalated'          // surfaced for human follow-up
  | 'abstained'          // explicitly declined

import CATALOG from '../synth/catalogIndex'
import { findSymbol, type SemanticIndex } from '../state/semanticIndex'

// Precompile the catalog's weighted patterns once. The catalog (241+ entries) is the
// deterministic-pattern source of truth: a task's coverage is the best entry's summed
// matching-pattern weight. Strong/multiple hits ⇒ exact primitive (synth); a single
// moderate hit ⇒ the family is covered but not exact (fm).
const COMPILED = CATALOG.map(e => ({
  id: e.id,
  patterns: e.patterns.map(p => ({ re: safeRegExp(p.re), weight: p.weight })),
}))

function safeRegExp(src: string): RegExp | null {
  try { return new RegExp(src, 'i') } catch { return null }
}

/** Best deterministic-pattern coverage for a goal: { id, score in [0,1] }. */
function catalogCoverage(goal: string): { id: string; score: number } {
  let best = { id: '', score: 0 }
  for (const entry of COMPILED) {
    let s = 0
    for (const p of entry.patterns) if (p.re && p.re.test(goal)) s += p.weight
    if (s > best.score) best = { id: entry.id, score: Math.min(1, s) }
  }
  return best
}

// ── Decision thresholds (calibrated bands over the synth match score) ─────────────
// One ranking, two bands: a strong match is a deterministic emit (synth); a moderate
// match means the FAMILY is covered but not an exact primitive (fm). Below the fm
// floor we have no pattern coverage at all.
const SYNTH_T = 0.7     // exact deterministic primitive → emit verified code
const FM_T = 0.35       // pattern-covered family → FM with property-family gating
const RETRIEVE_T = 0.5  // enough external evidence to ground before attempting

// External-knowledge lexical signals: the task is about something outside the repo.
const EXTERNAL_LEXICAL = /\b(latest|current|up[\s-]?to[\s-]?date|api\s+docs?|documentation|changelog|rfc|spec(?:ification)?|sdk|npm\s+package|version of|how\s+does\s+.*\s+work)\b/i
const NODE_BUILTINS = new Set(['fs', 'path', 'os', 'crypto', 'util', 'events', 'stream', 'http', 'https', 'net', 'child_process', 'url', 'zlib', 'buffer', 'process', 'assert', 'readline', 'tty', 'module'])

/** Candidate external module / library names referenced in the goal text. */
function extractExternalRefs(goal: string): string[] {
  const out = new Set<string>()
  for (const m of goal.matchAll(/\b(?:from|import|require)\s+['"]([@\w/.-]+)['"]/g)) out.add(m[1])
  for (const m of goal.matchAll(/`([@\w/-]+)`/g)) out.add(m[1])
  for (const m of goal.matchAll(/\b([A-Z][a-zA-Z0-9]{2,})\s+(?:API|SDK|library|package|client|docs?)\b/g)) out.add(m[1])
  return [...out]
}

/** Strength (0..1) of evidence that the task needs internet grounding. */
function retrieveStrength(task: RouterTask, index?: SemanticIndex): { score: number; why: string } {
  let score = 0
  const reasons: string[] = []
  if (EXTERNAL_LEXICAL.test(task.goal)) { score = 0.6; reasons.push('references latest/external docs or API') }

  const refs = extractExternalRefs(task.goal)
  const unknownExternal = refs.filter(r => {
    if (r.startsWith('.') || r.startsWith('/')) return false       // relative — local concern
    const bare = r.replace(/^@[\w-]+\//, '').split('/')[0]
    if (NODE_BUILTINS.has(bare)) return false                       // node builtin, not external
    if (index && findSymbol(index, r).length) return false          // defined locally → known
    return true
  })
  if (unknownExternal.length) {
    score = Math.max(score, 0.55 + Math.min(0.2, 0.05 * unknownExternal.length))
    reasons.push(`unknown external types/modules: ${unknownExternal.slice(0, 4).join(', ')}`)
  }
  return { score: Math.min(1, score), why: reasons.join('; ') }
}

/**
 * Classify a task into a route + calibrated confidence + reason, using the synth
 * catalog (deterministic-pattern coverage) and the Tier 1.2 semantic index (local
 * vs external knowledge) as signal sources. Confidence reflects actual signal
 * strength — never a fixed value. The abstain path is always reachable: any task
 * without sufficient signal for synth/fm/retrieve falls through to abstain.
 *
 * Priority follows the mission spec — synth → fm → retrieve → abstain — with one
 * honest tie-break: a STRONG external-knowledge signal preempts a merely-borderline
 * fm match, since attempting an external-API task with no grounding is exactly the
 * hallucination the retrieval layer exists to prevent.
 */
export function classify(task: RouterTask, opts: { index?: SemanticIndex } = {}): RouteDecision {
  // Deterministic-pattern coverage from the synth catalog (pure-code, no inference).
  const cov = catalogCoverage([task.goal, ...(task.targetFiles ?? [])].join('\n'))
  const matchScore = cov.score
  const retr = retrieveStrength(task, opts.index)

  // 1. Deterministic pattern → emit verified code.
  if (matchScore >= SYNTH_T) {
    return { route: 'synth', confidence: matchScore, reason: `deterministic synth primitive '${cov.id}' matches (score ${matchScore.toFixed(2)})` }
  }

  // 2. Pattern-covered skill family → FM (property-family gated) — unless a strong
  //    external signal says we must ground first.
  const fmCovered = matchScore >= FM_T
  if (fmCovered && matchScore >= retr.score) {
    return { route: 'fm', confidence: matchScore, reason: `pattern-covered family (nearest '${cov.id}', score ${matchScore.toFixed(2)}) — FM with property-family gating` }
  }

  // 3. External APIs / latest docs / unknown types not in the index → retrieve first.
  if (retr.score >= RETRIEVE_T) {
    return { route: 'retrieve', confidence: retr.score, reason: `needs grounding: ${retr.why}` }
  }

  // 2b. Borderline fm match with no strong retrieve signal still beats abstain.
  if (fmCovered) {
    return { route: 'fm', confidence: matchScore, reason: `pattern-covered family (nearest '${cov.id}', score ${matchScore.toFixed(2)})` }
  }

  // 4. Insufficient signal anywhere → abstain (always reachable).
  const best = Math.max(matchScore, retr.score)
  return {
    route: 'abstain',
    confidence: +(1 - best).toFixed(3),  // confidence IN the abstain: high when all signals are weak
    reason: `no route above threshold (synth/fm ${matchScore.toFixed(2)} < ${FM_T}, retrieve ${retr.score.toFixed(2)} < ${RETRIEVE_T}) — abstaining`,
  }
}
