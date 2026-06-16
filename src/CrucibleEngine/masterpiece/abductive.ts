// MASTERPIECE — Abductive Synthesis Engine
// Finds defensible, non-obvious cross-domain connections between each shard
// and the curated corpus. Connection candidates are challenged by the antithesis
// from the triadic pass before they are accepted.
//
// Only connections that survive the defensibility challenge are returned.
// The caller (orchestrator.ts) adds them to the RefinedShard for downstream use.

import { randomUUID } from 'crypto'
import { queryCrossCorpusBridge } from './corpus/living.js'
import type {
  Shard,
  TriadicOutput,
  AbductiveConnection,
  MasterpieceDeps,
} from './types.js'

const FIND_SYSTEM = `You are an abductive reasoning specialist. Your task: given a passage and a cross-domain excerpt from a completely different field, identify a defensible non-obvious structural connection between them. The connection must:
1. Be genuinely non-obvious (not a simple synonym or surface metaphor)
2. Map a specific structural pattern from one domain onto the other
3. Be defensible with evidence and reasoning
4. Identify what would make this connection BREAK (the fragile assumption)

Return ONLY a JSON object with this schema:
{
  "sourceDomain": "domain of the passage",
  "targetDomain": "domain of the cross-domain excerpt",
  "bridgeReasoning": "the argument for why these domains structurally map",
  "structuralMirror": "what specifically mirrors what (be precise)",
  "fragileAssumption": "what would falsify or break this connection",
  "noveltyScore": 0.0 to 1.0
}

If no defensible connection exists, return { "noConnection": true }.`

const CHALLENGE_SYSTEM = `You are an adversarial analyst. A cross-domain connection has been proposed. Your task: challenge it rigorously. Does the structural mapping actually hold? Is the novelty score inflated? Is the fragile assumption fatal?

Return ONLY a JSON object: { "survived": true|false, "reason": "one sentence" }

survived=true means the connection is defensible despite your challenge.
survived=false means the connection fails under scrutiny.`

export async function findAbductiveConnections(
  shard: Shard,
  triad: TriadicOutput,
  deps: MasterpieceDeps,
): Promise<AbductiveConnection[]> {
  const { callModel, selectModels, withTimeout } = deps
  const { models } = selectModels('analysis', undefined, 'simple')
  const model = models[0]
  const challengerModel = models[Math.min(1, models.length - 1)]

  // Find top cross-domain corpus chunks
  const crossResults = await queryCrossCorpusBridge(shard.content, shard.domain, 3)
  if (crossResults.length === 0) return []

  const connections: AbductiveConnection[] = []

  await Promise.all(crossResults.map(async ({ chunk }) => {
    const findPrompt = `PASSAGE (domain: ${shard.domain}):\n${shard.content}\n\nCROSS-DOMAIN EXCERPT (domain: ${chunk.domain}):\n${chunk.content}`

    let candidate: {
      noConnection?: boolean
      sourceDomain?: string
      targetDomain?: string
      bridgeReasoning?: string
      structuralMirror?: string
      fragileAssumption?: string
      noveltyScore?: number
    } | null = null

    try {
      const raw = await withTimeout(
        callModel(model, [
          { role: 'system', content: FIND_SYSTEM },
          { role: 'user', content: findPrompt },
        ], { requestId: deps.requestId }),
        15000,
        '',
      )
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
      candidate = JSON.parse(cleaned)
    } catch {
      return
    }

    if (!candidate || candidate.noConnection) return
    if (!candidate.bridgeReasoning || !candidate.structuralMirror) return

    // Defensibility challenge — the antithesis arm of the triadic pass provides
    // the adversarial frame used to pressure-test the connection.
    const challengePrompt = `PROPOSED CONNECTION:\nBridge: ${candidate.bridgeReasoning}\nMirror: ${candidate.structuralMirror}\nFragile assumption: ${candidate.fragileAssumption}\n\nADVERSARIAL CONTEXT (from dialectical antithesis of source shard):\n${triad.antithesis.slice(0, 500)}`

    let survived = true
    try {
      const challengeRaw = await withTimeout(
        callModel(challengerModel, [
          { role: 'system', content: CHALLENGE_SYSTEM },
          { role: 'user', content: challengePrompt },
        ], { requestId: deps.requestId }),
        10000,
        '{"survived": true, "reason": "challenge timed out"}',
      )
      const cleanedC = challengeRaw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
      const verdict: { survived: boolean } = JSON.parse(cleanedC)
      survived = verdict.survived ?? true
    } catch {
      survived = true  // default to accepting if challenge itself fails
    }

    connections.push({
      id: randomUUID(),
      shardId: shard.id,
      sourceDomain: candidate.sourceDomain ?? shard.domain,
      targetDomain: candidate.targetDomain ?? chunk.domain,
      sourceContent: shard.content.slice(0, 300),
      targetContent: chunk.content.slice(0, 300),
      bridgeReasoning: candidate.bridgeReasoning,
      structuralMirror: candidate.structuralMirror,
      fragileAssumption: candidate.fragileAssumption ?? '',
      noveltyScore: Math.min(1, Math.max(0, candidate.noveltyScore ?? 0.5)),
      survivedDialectic: survived,
      corpusChunkId: chunk.id,
    })
  }))

  // Return only survived connections, sorted by novelty.
  return connections
    .filter(c => c.survivedDialectic)
    .sort((a, b) => b.noveltyScore - a.noveltyScore)
}
