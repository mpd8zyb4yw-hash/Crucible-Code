// EXPERIMENTAL — PARKED, NOT LIVE (decided 2026-07-04). See the banner in
// router/capabilityRouter.ts for the full fork-decision rationale — server.ts never imports
// this module; the live coding-agent path is agent/planner.ts + agent/loop.ts + synthDriver.ts.
//
// Tier 1.4 — Agentic Execution Loop (DAG-node executor).
//
// Threads every layer built so far into one honest, bounded loop that takes a
// classified DAG node (Tier 1.1) to a verified application — or abstains:
//
//   emit → run/commit → observe → parse semantically → mutate spec → retry
//
//   • EMIT      a candidate change set from the current spec (synthesis is injected;
//               production wires synthDriver/synthesizeUniversal — this module stays
//               model-agnostic and never calls a paid API itself).
//   • COMMIT    via the Tier 2.1 apply layer — the ONLY sanctioned write path. The
//               apply layer's never-regress gate is the run/verify step: a candidate
//               that doesn't hold is auto-reverted, so the loop observes a clean tree.
//   • OBSERVE   the apply verdict + verifier detail.
//   • PARSE     failures semantically (reuses verify.ts fingerprint + extractHints) —
//               not string-matching: error type, symbol, fix strategy, repeat detection.
//   • MUTATE    the spec with the parsed hints and retry.
//
// Hard guarantees:
//   • HARD BUDGET — at most `maxAttempts` emit/commit cycles per node.
//   • ANTI-THRASH — the same failure fingerprint twice ⇒ abstain (stop healing,
//     report honestly) rather than burn the budget on a loop that isn't converging.
//   • ABSTAIN EXIT — reachable at every step: router said abstain, synth returned
//     nothing, budget exhausted, or a repeated fingerprint. Abstain is honest, with a
//     calibrated reason; it never ships unverified code.
//   • AUDIT TRAIL — every attempt + verdict appended to .crucible/exec-ledger.jsonl.

import fs from 'fs'
import path from 'path'
import type { DagNode, TaskDag, VerificationGate } from './decompositionDag'
import { applyVerified, syntacticVerify, type FileChange, type VerifyFn, type ApplyResult } from './apply/applyLayer'
import { fingerprint, extractHints } from './agent/verify'
import { resolveAmbiguity } from './ambiguity'
import type { SemanticIndex } from './state/semanticIndex'

/** What the executor asks the synthesizer to produce for one attempt. */
export interface SynthRequest {
  node: DagNode
  /** The (possibly mutated) spec for this attempt. */
  spec: string
  attempt: number
  /** Hints parsed from the prior failed attempt, empty on the first. */
  priorHints: string[]
}

/** Injected synthesizer. Returns the candidate change set, or null if it cannot. */
export type Synthesize = (req: SynthRequest) => Promise<FileChange[] | null> | FileChange[] | null

export type ExecStatus = 'applied' | 'abstained' | 'blocked'

export interface NodeOutcome {
  nodeId: string
  status: ExecStatus
  attempts: number
  files: string[]
  /** Honest, human-readable reason — required for every terminal status. */
  reason: string
  apply?: ApplyResult
}

export interface ExecContext {
  projectPath: string
  synthesize: Synthesize
  /** Override the per-gate verifier. Default picks from the node's verification gate. */
  verify?: VerifyFn
  /** Hard budget: max emit/commit cycles per node. Default 3. */
  maxAttempts?: number
  /** Pre-fetched retrieval grounding (Tier 1.3) injected into the spec for retrieve-routed nodes. */
  retrievalBlock?: string
  /** Tier 1.2 index — when present, an ambiguity gate (Tier 2.4) runs before synthesis:
   *  an unresolvable/underspecified node abstains with a clarification instead of guessing.
   *  Resolved references rewrite the node's spec to name a concrete target. */
  index?: SemanticIndex
  dryRun?: boolean
}

// ── Gate → verifier mapping ─────────────────────────────────────────────────────
// The apply layer is verifier-agnostic; the node's declared gate decides how its
// application is checked. tsc/property-family/behavioral all reduce to a runnable
// check the apply layer scores; here we use the fast syntactic verifier as the
// always-available floor and let callers inject a stronger one (tscProjectVerify or
// a behavioral runner) per gate.
function verifierForGate(_gate: VerificationGate, override?: VerifyFn): VerifyFn {
  return override ?? syntacticVerify
}

// ── Spec construction + mutation ────────────────────────────────────────────────

function buildNodeSpec(node: DagNode, retrievalBlock?: string): string {
  const lines = [
    `TASK: ${node.goal}`,
    `change type: ${node.changeType}`,
    node.targetFiles.length ? `target file(s): ${node.targetFiles.join(', ')}` : 'target file(s): (resolve from the task)',
    `verification gate: ${node.verificationGate}`,
  ]
  if (retrievalBlock) lines.push('', retrievalBlock)
  return lines.join('\n')
}

function mutateSpec(spec: string, failureDetail: string, hints: string[]): string {
  return [
    spec,
    '',
    'PREVIOUS ATTEMPT WAS REVERTED (did not pass the verification gate):',
    failureDetail.slice(0, 1200),
    hints.length ? 'HINTS:\n' + hints.map(h => `  - ${h}`).join('\n') : '',
    'Produce a corrected change set that passes the gate.',
  ].filter(Boolean).join('\n')
}

// ── Audit ledger ─────────────────────────────────────────────────────────────────

function ledger(projectPath: string, entry: Record<string, unknown>): void {
  try {
    const file = path.join(path.resolve(projectPath), '.crucible', 'exec-ledger.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(entry) + '\n')
  } catch { /* best-effort */ }
}

// ── Single-node execution loop ───────────────────────────────────────────────────

export async function executeNode(node: DagNode, ctx: ExecContext): Promise<NodeOutcome> {
  const maxAttempts = ctx.maxAttempts ?? 3
  const verify = verifierForGate(node.verificationGate, ctx.verify)
  const base = { nodeId: node.id, files: [] as string[] }

  // ABSTAIN EXIT (pre-loop): the router already declined this node.
  if (node.route?.route === 'abstain') {
    const reason = `abstained (router): ${node.route.reason}`
    ledger(ctx.projectPath, { event: 'abstain', nodeId: node.id, stage: 'router', reason })
    return { ...base, status: 'abstained', attempts: 0, reason }
  }

  // ABSTAIN EXIT (Tier 2.4): if the request can't be pinned down, ask rather than guess.
  let effectiveGoal = node.goal
  if (ctx.index) {
    const amb = resolveAmbiguity(node.goal, { index: ctx.index })
    if (amb.ambiguous) {
      const reason = `abstained (ambiguous): ${amb.clarification}`
      ledger(ctx.projectPath, { event: 'abstain', nodeId: node.id, stage: 'ambiguity', confidence: amb.confidence, reason })
      return { ...base, status: 'abstained', attempts: 0, reason }
    }
    if (amb.rewrittenGoal) effectiveGoal = amb.rewrittenGoal  // concrete target for synthesis
  }

  let spec = buildNodeSpec({ ...node, goal: effectiveGoal }, node.route?.route === 'retrieve' ? ctx.retrievalBlock : undefined)
  let priorHints: string[] = []
  const seenFingerprints = new Set<string>()

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // EMIT
    const changes = await ctx.synthesize({ node, spec, attempt, priorHints })
    if (!changes || !changes.length) {
      const reason = `abstained: synthesis produced no candidate on attempt ${attempt}`
      ledger(ctx.projectPath, { event: 'abstain', nodeId: node.id, stage: 'emit', attempt, reason })
      return { ...base, status: 'abstained', attempts: attempt, reason }
    }

    // COMMIT (run + verify via the never-regress apply gate)
    const apply = await applyVerified(ctx.projectPath, changes, { verify, dryRun: ctx.dryRun })
    ledger(ctx.projectPath, { event: 'attempt', nodeId: node.id, attempt, verdict: apply.verdict, files: apply.files })

    if (apply.verdict === 'applied' || (ctx.dryRun && apply.verdict === 'skipped')) {
      return { ...base, status: 'applied', attempts: attempt, files: apply.files, apply, reason: apply.detail }
    }
    if (apply.verdict === 'error') {
      // Path-escape or write error — not retryable, abstain honestly.
      return { ...base, status: 'abstained', attempts: attempt, reason: `abstained: ${apply.detail}`, apply }
    }

    // OBSERVE + PARSE SEMANTICALLY (apply.verdict === 'reverted')
    const detail = apply.candidate?.detail ?? apply.detail
    const fp = fingerprint(detail)
    priorHints = extractHints(detail, ctx.projectPath)

    // ANTI-THRASH: a repeated failure signature means we're not converging → abstain.
    if (seenFingerprints.has(fp)) {
      const reason = `abstained: failure signature repeated (not converging) after ${attempt} attempt(s) — ${detail.slice(0, 160)}`
      ledger(ctx.projectPath, { event: 'abstain', nodeId: node.id, stage: 'thrash', attempt, fp, reason })
      return { ...base, status: 'abstained', attempts: attempt, reason, apply }
    }
    seenFingerprints.add(fp)

    // MUTATE SPEC and retry (unless this was the last attempt).
    spec = mutateSpec(spec, detail, priorHints)
  }

  // ABSTAIN EXIT: hard budget exhausted.
  const reason = `abstained: verification gate not satisfied within ${maxAttempts} attempts`
  ledger(ctx.projectPath, { event: 'abstain', nodeId: node.id, stage: 'budget', reason })
  return { ...base, status: 'abstained', attempts: maxAttempts, reason }
}

// ── Whole-DAG execution (topological, dependency-gated) ──────────────────────────

export interface DagExecResult {
  outcomes: NodeOutcome[]
  applied: number
  abstained: number
  blocked: number
}

/**
 * Execute a classified DAG in its (already topological) order. A node whose
 * dependency did not apply is marked `blocked` and skipped — we never build on an
 * unverified predecessor. Honest accounting: applied / abstained / blocked are
 * reported as distinct buckets, never collapsed into one pass rate.
 */
export async function executeDag(dag: TaskDag, ctx: ExecContext): Promise<DagExecResult> {
  const outcomes: NodeOutcome[] = []
  const statusById = new Map<string, ExecStatus>()

  for (const node of dag.nodes) {
    const blockedBy = node.dependsOn.find(d => statusById.get(d) && statusById.get(d) !== 'applied')
    if (blockedBy) {
      const reason = `blocked: dependency ${blockedBy} did not apply (${statusById.get(blockedBy)})`
      ledger(ctx.projectPath, { event: 'blocked', nodeId: node.id, blockedBy })
      const outcome: NodeOutcome = { nodeId: node.id, status: 'blocked', attempts: 0, files: [], reason }
      outcomes.push(outcome); statusById.set(node.id, 'blocked')
      continue
    }
    const outcome = await executeNode(node, ctx)
    outcomes.push(outcome); statusById.set(node.id, outcome.status)
  }

  return {
    outcomes,
    applied: outcomes.filter(o => o.status === 'applied').length,
    abstained: outcomes.filter(o => o.status === 'abstained').length,
    blocked: outcomes.filter(o => o.status === 'blocked').length,
  }
}
