// MASTERPIECE — Escalation Confidence Gate (H1 at shard level)
// Assigns each shard a calibration score derived from the coherence of its
// triadic pass: how much do thesis and antithesis agree on the underlying facts
// (even if they disagree on interpretation)?
//
// Shards scoring LOW or UNVERIFIED are escalated to an additional external
// model call for an independent take before entering MoE refinement.

import type {
  Shard,
  TriadicOutput,
  EscalationDecision,
  EscalationTier,
  MasterpieceDeps,
} from './types.js'

const COHERENCE_SYSTEM = `You are a calibration analyst. You are given three analytical perspectives on the same text (thesis, antithesis, middle-ground). Your task: score how much the thesis and antithesis agree on the *underlying factual claims* (ignoring their interpretive differences).

A high score means: both perspectives accept the same base facts and only disagree on framing.
A low score means: the perspectives make incompatible factual claims.

Return ONLY a JSON object: { "coherenceScore": 0.0 to 1.0, "tier": "HIGH"|"MEDIUM"|"LOW"|"UNVERIFIED" }

Tier thresholds:
  HIGH (≥ 0.75): Strong factual agreement, confident shard
  MEDIUM (0.55–0.74): Moderate agreement, proceed with caution
  LOW (0.35–0.54): Significant disagreement, needs external verification
  UNVERIFIED (< 0.35): Fundamental conflict, must escalate`

const ESCALATION_SYSTEM = `You are an expert generalist. You are given an analytically contested shard — the internal dialectical pass found significant disagreement between its thesis and antithesis. Your task: produce an independent, balanced assessment that does not pick either extreme. Explicitly flag which claims are well-established vs. speculative. 3–4 paragraphs.`

function tierFromScore(score: number): EscalationTier {
  if (score >= 0.75) return 'HIGH'
  if (score >= 0.55) return 'MEDIUM'
  if (score >= 0.35) return 'LOW'
  return 'UNVERIFIED'
}

export async function evaluateEscalation(
  shard: Shard,
  triad: TriadicOutput,
  deps: MasterpieceDeps,
): Promise<EscalationDecision> {
  const { callModel, selectModels, withTimeout } = deps
  const { models } = selectModels('analysis', undefined, 'simple')
  const scorerModel = models[0]

  // Score coherence
  const coherencePrompt = `THESIS:\n${triad.thesis.slice(0, 600)}\n\nANTITHESIS:\n${triad.antithesis.slice(0, 600)}\n\nMIDDLE-GROUND:\n${triad.middleGround.slice(0, 400)}`

  let calibrationScore = 0.65
  let tier: EscalationTier = 'MEDIUM'

  try {
    const raw = await withTimeout(
      callModel(scorerModel, [
        { role: 'system', content: COHERENCE_SYSTEM },
        { role: 'user', content: coherencePrompt },
      ], { requestId: deps.requestId }),
      10000,
      '',
    )
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    const parsed: { coherenceScore?: number; tier?: EscalationTier } = JSON.parse(cleaned)
    if (typeof parsed.coherenceScore === 'number') {
      calibrationScore = Math.min(1, Math.max(0, parsed.coherenceScore))
      tier = parsed.tier ?? tierFromScore(calibrationScore)
    }
  } catch {
    // use defaults
  }

  const needsEscalation = tier === 'LOW' || tier === 'UNVERIFIED'

  if (!needsEscalation) {
    return {
      shardId: shard.id,
      tier,
      calibrationScore,
      escalated: false,
    }
  }

  // Escalate: call an independent external model
  const { models: escalationModels } = selectModels('analysis', undefined, 'complex')
  // Pick a different model than the scorer to maximise independence
  const escalationModel = escalationModels[Math.min(1, escalationModels.length - 1)]
  const escalationStart = Date.now()

  let externalResult: string | undefined
  try {
    externalResult = await withTimeout(
      callModel(escalationModel, [
        { role: 'system', content: ESCALATION_SYSTEM },
        { role: 'user', content: `CONTESTED SHARD:\n${shard.content}\n\nKNOWN TENSIONS:\n${triad.middleGround.slice(0, 500)}` },
      ], { requestId: deps.requestId }),
      25000,
      '',
    )
  } catch {
    externalResult = undefined
  }

  return {
    shardId: shard.id,
    tier,
    calibrationScore,
    escalated: true,
    externalModelId: escalationModel.id,
    externalResult: externalResult || undefined,
    escalationMs: Date.now() - escalationStart,
  }
}
