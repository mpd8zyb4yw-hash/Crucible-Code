// ── RSI proposals — the human approval layer over the self-improvement cycle ────
//
// FABLE5_HANDOFF Feature 7. The RSI cycle (controller.ts) already guarantees
// never-regress mechanically (snapshot → measure → tune → re-measure → keep only
// if not worse). What it lacked was a USER-facing surface: a plain-language
// statement of what a cycle would change and why, with an explicit approve/reject
// step BEFORE anything runs. This module is that layer.
//
// A proposal is built from signals the system already computes (RSI state, learned
// weights, quality history size, live quality trend) — zero model inference, same
// convention as the confidence-calibration design in ROADMAP Priority 6. Approving
// a proposal runs the normal gated cycle; the proposal record then carries the
// cycle's honest verdict (promoted / held / reverted / error) so the user sees what
// actually happened, not just what was promised.

import fs from 'fs'
import path from 'path'
import { rsiStatus, isRsiEnabled } from './controller'
import { status as autoImproveStatus } from '../autoImprove'
import { qualityPredictor } from '../qualityPredictor'

export interface RsiProposal {
  id: string
  createdAt: number
  status: 'pending' | 'approved' | 'rejected' | 'applied' | 'failed'
  // Plain-language, user-facing — no jargon. What / why / how / risk.
  title: string
  summary: string       // WHAT the system wants to do
  rationale: string     // WHY now — the observed signals that motivated it
  plan: string[]        // HOW — the concrete steps, in order
  risk: string          // what could go wrong and what the safety net is
  // Filled in after an approved proposal actually runs:
  verdict?: string      // 'promoted' | 'held' | 'reverted' | 'skipped' | 'error'
  verdictDetail?: string
  resolvedAt?: number
}

const MAX_KEPT = 50
const proposalsFile = (dir: string) => path.join(dir, '.crucible', 'rsi-proposals.json')

function load(dir: string): RsiProposal[] {
  try { return JSON.parse(fs.readFileSync(proposalsFile(dir), 'utf8')) } catch { return [] }
}
function save(dir: string, list: RsiProposal[]): void {
  try {
    fs.mkdirSync(path.dirname(proposalsFile(dir)), { recursive: true })
    fs.writeFileSync(proposalsFile(dir), JSON.stringify(list.slice(-MAX_KEPT), null, 2))
  } catch {}
}

export function listProposals(dir: string): RsiProposal[] {
  return load(dir).sort((a, b) => b.createdAt - a.createdAt)
}

export function getProposal(dir: string, id: string): RsiProposal | null {
  return load(dir).find(p => p.id === id) ?? null
}

/** Build (and persist) a new pending improvement proposal from live system signals.
 *  Returns null if one is already pending — the user should answer that one first. */
export function buildCycleProposal(dir: string): RsiProposal | null {
  const existing = load(dir)
  if (existing.some(p => p.status === 'pending' || p.status === 'approved')) return null

  const rsi = rsiStatus(dir)
  const ai = autoImproveStatus()
  const trend = (() => { try { return qualityPredictor.stats().trend } catch { return 'unknown' } })()

  let qualityRounds = 0
  try {
    qualityRounds = (JSON.parse(fs.readFileSync(path.join(dir, '.crucible', 'quality-history.json'), 'utf8')) as unknown[]).length
  } catch {}

  const w = ai.weights
  const historyLine = rsi.cycles > 0
    ? `So far it has run ${rsi.cycles} time(s): ${rsi.promotions} kept improvement(s), ${rsi.reverts} automatically undone.`
    : 'This would be its first recorded run on this machine.'
  const trendLine = trend === 'up' ? 'Recent answer quality is trending up — a good moment to lock gains in.'
    : trend === 'down' ? 'Recent answer quality is trending DOWN — a tuning pass may recover it, and anything that makes things worse is undone automatically.'
    : 'Recent answer quality is holding steady.'

  const proposal: RsiProposal = {
    id: 'rsip-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
    createdAt: Date.now(),
    status: 'pending',
    title: 'Tune how answers are scored and picked, based on recent results',
    summary:
      'Crucible wants to run one self-improvement pass: it will study its recent answers, ' +
      'learn which patterns produced the best results, and adjust the internal weights it ' +
      'uses to score and choose answers. No source code is touched — only learned settings.',
    rationale:
      `There are ${qualityRounds} recent scored answers to learn from. ${trendLine} ` +
      `Current scoring balance: similarity ${w.similarity.toFixed(2)}, ` +
      `functional ${w.functional.toFixed(2)}, novelty ${w.novelty.toFixed(2)} ` +
      `(updated ${w.updateCount} time(s) so far). ${historyLine}`,
    plan: [
      'Save a snapshot of the current learned settings (the undo point).',
      'Measure today\'s answer quality against the built-in benchmark suite.',
      'Run the tuning pass: extract winning patterns and adjust scoring weights.',
      'Re-measure against the same benchmark.',
      'Keep the changes only if quality held or improved — otherwise restore the snapshot automatically.',
    ],
    risk:
      'Low. The pass only edits learned-settings files, never code. Every change is measured ' +
      'before and after, and anything that scores worse is rolled back to the snapshot on the ' +
      'spot. Worst case is a few minutes of background compute with no net change.',
  }
  existing.push(proposal)
  save(dir, existing)
  return proposal
}

/** Mark a pending proposal approved (the caller then runs the cycle) or rejected. */
export function resolveProposal(dir: string, id: string, approve: boolean): RsiProposal | null {
  const list = load(dir)
  const p = list.find(x => x.id === id)
  if (!p || p.status !== 'pending') return null
  p.status = approve ? 'approved' : 'rejected'
  if (!approve) p.resolvedAt = Date.now()
  save(dir, list)
  return p
}

/** Record what actually happened after an approved proposal's cycle finished. */
export function recordProposalOutcome(dir: string, id: string, verdict: string, detail?: string): void {
  const list = load(dir)
  const p = list.find(x => x.id === id)
  if (!p) return
  p.status = (verdict === 'promoted' || verdict === 'held') ? 'applied' : 'failed'
  p.verdict = verdict
  p.verdictDetail = detail ?? (
    verdict === 'promoted' ? 'Quality improved on the benchmark — changes kept.'
    : verdict === 'held' ? 'Quality held steady — changes kept (no regression).'
    : verdict === 'reverted' ? 'Quality dipped on re-measure — changes were automatically undone.'
    : verdict === 'skipped' ? 'The cycle could not run (disabled, busy, or nothing to measure).'
    : 'The cycle hit an error and made no lasting change.')
  p.resolvedAt = Date.now()
  save(dir, list)
}

/** True when the user has opted into fully-automatic cycles (no approval step). */
export function isAutoApproveEnabled(dir: string): boolean {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, '.crucible', 'rsi-auto-approve.json'), 'utf8')).enabled === true
  } catch { return false }
}
export function setAutoApprove(dir: string, enabled: boolean): void {
  try {
    fs.mkdirSync(path.join(dir, '.crucible'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.crucible', 'rsi-auto-approve.json'), JSON.stringify({ enabled, updatedAt: Date.now() }))
  } catch {}
}

/** One status blob for the UI card. */
export function selfRepairStatus(dir: string) {
  return {
    rsi: rsiStatus(dir),
    enabled: isRsiEnabled(),
    autoApprove: isAutoApproveEnabled(dir),
    proposals: listProposals(dir).slice(0, 10),
  }
}
