// MASTERPIECE — Ensemble MoE Refinement
// Each shard is routed to a specialist archetype based on its domain:
//   researcher  → information-theory, philosophy-of-science, network-science
//   coder       → computer-science
//   strategist  → economics, game-theory, complex-systems
//   critic      → any shard escalated (LOW/UNVERIFIED) — always the critic archetype
//
// The specialist receives the full context: original shard + triadic outputs +
// abductive connections + structural resonances + escalation result.
// It synthesises all of this into a refined, enriched shard text.

import type {
  Shard,
  TriadicOutput,
  AbductiveConnection,
  StructuralResonance,
  EscalationDecision,
  RefinedShard,
  SpecialistRole,
  MoEAssignment,
  MasterpieceDeps,
} from './types.js'

const DOMAIN_TO_SPECIALIST: Record<string, SpecialistRole> = {
  'information-theory':    'researcher',
  'philosophy-of-science': 'researcher',
  'network-science':       'researcher',
  'evolutionary-biology':  'researcher',
  'thermodynamics':        'researcher',
  'computer-science':      'coder',
  'economics':             'strategist',
  'game-theory':           'strategist',
  'complex-systems':       'strategist',
  'cognitive-science':     'researcher',
  'general':               'researcher',
}

const SPECIALIST_SYSTEMS: Record<SpecialistRole, string> = {
  researcher: `You are a deep-research specialist contributing to a MASTERPIECE synthesis. You have been given:
1. A shard of the original analysis
2. Its dialectical triadic outputs (thesis/antithesis/middle-ground)
3. Cross-domain abductive connections that survived adversarial challenge
4. Structural resonances found in the edge-graph topology
5. An escalation assessment (if applicable)

Your task: synthesise all of this into an enriched, substantive expansion of the shard. You MUST:
- Integrate the most defensible abductive connections explicitly (name the cross-domain bridges)
- Address the genuine uncertainties identified in the middle-ground
- Preserve factual precision — do not overstate certainties
- Be substantive and specific, not vague and broad
- 3–5 paragraphs`,

  coder: `You are a technical specialist contributing to a MASTERPIECE synthesis. You have been given:
1. A shard with technical/computational content
2. Its dialectical triadic outputs
3. Cross-domain abductive connections
4. Structural resonances
5. Escalation assessment (if applicable)

Your task: synthesise all inputs into an enriched technical analysis. You MUST:
- Ground abstractions in concrete implementation considerations
- Surface the algorithmic or architectural implications of the abductive connections
- Identify edge cases or boundary conditions the middle-ground identified
- Be technically precise, not hand-wavy
- 3–5 paragraphs`,

  strategist: `You are a strategic analyst contributing to a MASTERPIECE synthesis. You have been given:
1. A shard with strategic/economic/systems content
2. Its dialectical triadic outputs
3. Cross-domain abductive connections
4. Structural resonances
5. Escalation assessment (if applicable)

Your task: synthesise all inputs into an enriched strategic analysis. You MUST:
- Draw out the incentive structures and feedback loops the abductive connections reveal
- Identify second-order effects the antithesis raised
- Use structural resonances to find analogous strategies from other domains
- Be specific about trade-offs — do not paper over tensions
- 3–5 paragraphs`,

  critic: `You are a rigorous critic contributing to a MASTERPIECE synthesis for a shard that received LOW or UNVERIFIED escalation tier — meaning significant internal disagreement was found. Your role is not to tear down the shard, but to produce the most honest, calibrated, nuanced analysis possible.

You MUST:
- Clearly label what is well-established vs. contested vs. speculative
- Incorporate the external escalation result (independent model) where it adds signal
- Not pretend to more certainty than the evidence warrants
- Still be substantive and useful — honest uncertainty is not the same as vagueness
- 3–5 paragraphs`,
}

function assignSpecialist(shard: Shard, escalation: EscalationDecision): MoEAssignment {
  if (escalation.tier === 'LOW' || escalation.tier === 'UNVERIFIED') {
    return {
      shardId: shard.id,
      specialist: 'critic',
      reason: `Escalation tier ${escalation.tier} — assigning critic for calibrated uncertainty handling`,
    }
  }
  const specialist = DOMAIN_TO_SPECIALIST[shard.domain] ?? 'researcher'
  return {
    shardId: shard.id,
    specialist,
    reason: `Domain '${shard.domain}' maps to ${specialist} specialist`,
  }
}

function buildSpecialistContext(
  shard: Shard,
  triad: TriadicOutput,
  connections: AbductiveConnection[],
  resonances: StructuralResonance[],
  escalation: EscalationDecision,
): string {
  const parts: string[] = []

  parts.push(`## SHARD (domain: ${shard.domain})\n${shard.content}`)

  parts.push(`## TRIADIC DIALECTICAL PASS\n**Thesis:**\n${triad.thesis}\n\n**Antithesis:**\n${triad.antithesis}\n\n**Middle-Ground (Uncertainty Map):**\n${triad.middleGround}`)

  if (connections.length > 0) {
    const connText = connections.map((c, i) =>
      `Connection ${i + 1}: ${c.sourceDomain} → ${c.targetDomain}\n  Bridge: ${c.bridgeReasoning}\n  Mirror: ${c.structuralMirror}\n  Fragile assumption: ${c.fragileAssumption}`
    ).join('\n\n')
    parts.push(`## ABDUCTIVE CONNECTIONS (survived adversarial challenge)\n${connText}`)
  }

  if (resonances.length > 0) {
    const resText = resonances.map(r =>
      `Pattern: ${r.matchedPattern}\n  Resonant domain: ${r.resonantDomain}\n  Description: ${r.resonantDescription}\n  Confidence: ${(r.mappingConfidence * 100).toFixed(0)}%`
    ).join('\n\n')
    parts.push(`## STRUCTURAL RESONANCES\n${resText}`)
  }

  parts.push(`## ESCALATION ASSESSMENT\nTier: ${escalation.tier} (calibration score: ${escalation.calibrationScore.toFixed(2)})${escalation.externalResult ? `\n\nExternal model independent assessment:\n${escalation.externalResult}` : ''}`)

  return parts.join('\n\n---\n\n')
}

function scoreConfidence(escalation: EscalationDecision, connections: AbductiveConnection[]): number {
  let base = escalation.calibrationScore
  // Survived cross-domain connections slightly boost confidence (evidence of coherence)
  base += connections.length * 0.03
  return Math.min(0.99, Math.max(0.01, base))
}

export async function refineShard(
  shard: Shard,
  triad: TriadicOutput,
  connections: AbductiveConnection[],
  resonances: StructuralResonance[],
  escalation: EscalationDecision,
  deps: MasterpieceDeps,
): Promise<RefinedShard> {
  const { callModel, selectModels, withTimeout } = deps
  const assignment = assignSpecialist(shard, escalation)

  const { models } = selectModels('analysis', undefined, 'complex')
  const model = models[0]

  const systemPrompt = SPECIALIST_SYSTEMS[assignment.specialist]
  const context = buildSpecialistContext(shard, triad, connections, resonances, escalation)

  let refinedContent: string
  try {
    refinedContent = await withTimeout(
      callModel(model, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: context },
      ], { requestId: deps.requestId }),
      30000,
      shard.content,  // fallback: use original shard unchanged
    )
  } catch {
    refinedContent = shard.content
  }

  return {
    shardId: shard.id,
    index: shard.index,
    originalContent: shard.content,
    refinedContent: refinedContent || shard.content,
    specialist: assignment.specialist,
    connections,
    resonances,
    escalationTier: escalation.tier,
    confidenceScore: scoreConfidence(escalation, connections),
  }
}
