// MASTERPIECE — Triadic Dialectical Pass
// For each shard, three models run simultaneously:
//   - Thesis:      the strongest possible case FOR the shard's claims/framing
//   - Antithesis:  the strongest possible case AGAINST or complicating the shard's framing
//   - MiddleGround: a genuine uncertainty map — what is actually unknown or contested
//
// The three outputs are used downstream by:
//   - abductive.ts (to enrich cross-domain connection defensibility)
//   - escalation.ts (calibrationScore derived from thesis/antithesis coherence gap)
//   - moe.ts (specialist has access to all three perspectives)

import type { Shard, TriadicOutput, MasterpieceDeps } from './types.js'

const THESIS_SYSTEM = `You are a constructive analyst. Your task: articulate the strongest, most intellectually honest case FOR the claims and framing presented in the following text. Do not hedge. Identify the best evidence, logical structure, and real-world examples that support it. Be precise and substantive. 2–3 paragraphs maximum.`

const ANTITHESIS_SYSTEM = `You are an adversarial analyst. Your task: articulate the strongest, most intellectually honest case AGAINST or that genuinely complicates the claims and framing in the following text. Do not be dismissive — find the real tensions, counterexamples, and structural weaknesses. Be precise and substantive. 2–3 paragraphs maximum.`

const MIDDLE_SYSTEM = `You are an epistemic cartographer. Your task: produce a genuine uncertainty map for the following text. Identify what is actually known vs. contested vs. speculative. Note which claims would change under different assumptions. Do not collapse uncertainty prematurely. 2–3 paragraphs maximum.`

export async function runTriadic(
  shard: Shard,
  deps: MasterpieceDeps,
): Promise<TriadicOutput> {
  const { callModel, selectModels, withTimeout } = deps
  const { models } = selectModels('analysis', undefined, 'complex')
  // Pick 3 distinct models for maximum diversity. Cycle if fewer than 3 available.
  const m0 = models[0]
  const m1 = models[Math.min(1, models.length - 1)]
  const m2 = models[Math.min(2, models.length - 1)]

  const userMsg = { role: 'user' as const, content: shard.content }
  const start = Date.now()

  const [thesis, antithesis, middleGround] = await Promise.all([
    withTimeout(
      callModel(m0, [{ role: 'system', content: THESIS_SYSTEM }, userMsg], { requestId: deps.requestId }),
      20000,
      '[Thesis generation timed out]',
    ),
    withTimeout(
      callModel(m1, [{ role: 'system', content: ANTITHESIS_SYSTEM }, userMsg], { requestId: deps.requestId }),
      20000,
      '[Antithesis generation timed out]',
    ),
    withTimeout(
      callModel(m2, [{ role: 'system', content: MIDDLE_SYSTEM }, userMsg], { requestId: deps.requestId }),
      20000,
      '[Middle-ground generation timed out]',
    ),
  ])

  return {
    shardId: shard.id,
    thesis,
    antithesis,
    middleGround,
    modelIds: { thesis: m0.id, antithesis: m1.id, middleGround: m2.id },
    elapsedMs: Date.now() - start,
  }
}

// Run triadic passes for all shards in parallel — each shard's 3 models run
// simultaneously, and all shards run simultaneously with each other.
export async function runAllTriadic(
  shards: Shard[],
  deps: MasterpieceDeps,
): Promise<TriadicOutput[]> {
  return Promise.all(shards.map(s => runTriadic(s, deps)))
}
