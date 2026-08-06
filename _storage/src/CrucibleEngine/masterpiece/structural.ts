// MASTERPIECE — Structural Resonance Engine
// Detects edge-graph isomorphisms between the shard's domain and other domains
// in the corpus. Two subgraphs are structurally resonant if their edge types
// and connectivity patterns match, even if the node labels differ entirely.
//
// This is distinct from abductive connections (semantic bridges) —
// structural resonances are about *pattern topology*, not content similarity.

import { randomUUID } from 'crypto'
import type {
  Shard,
  StructuralResonance,
  ResonanceEdge,
  EdgeType,
  MasterpieceDeps,
} from './types.js'

// Known structural patterns with their canonical edge topologies.
// The engine asks a model to map the shard onto these patterns,
// then finds other domains where the same pattern appears.
const STRUCTURAL_PATTERNS: Array<{
  name: string
  description: string
  edges: Array<{ from: string; to: string; type: EdgeType }>
  commonIn: string[]
}> = [
  {
    name: 'feedback-stabilisation',
    description: 'A system output feeds back as input, creating a self-correcting equilibrium',
    edges: [
      { from: 'output', to: 'sensor', type: 'enables' },
      { from: 'sensor', to: 'controller', type: 'enables' },
      { from: 'controller', to: 'effector', type: 'enables' },
      { from: 'effector', to: 'output', type: 'constrains' },
    ],
    commonIn: ['thermodynamics', 'cognitive-science', 'economics', 'complex-systems', 'evolutionary-biology'],
  },
  {
    name: 'exploration-exploitation',
    description: 'A system must balance exploiting known high-value states vs exploring unknown states',
    edges: [
      { from: 'known-optimum', to: 'exploitation-strategy', type: 'enables' },
      { from: 'exploitation-strategy', to: 'local-maximum', type: 'scales-with' },
      { from: 'local-maximum', to: 'exploration-pressure', type: 'enables' },
      { from: 'exploration-pressure', to: 'novel-state', type: 'enables' },
      { from: 'novel-state', to: 'known-optimum', type: 'constrains' },
    ],
    commonIn: ['evolutionary-biology', 'computer-science', 'economics', 'cognitive-science', 'game-theory'],
  },
  {
    name: 'phase-transition',
    description: 'A gradual parameter change causes a sudden qualitative regime shift',
    edges: [
      { from: 'parameter', to: 'critical-threshold', type: 'scales-with' },
      { from: 'critical-threshold', to: 'macro-order', type: 'enables' },
      { from: 'micro-fluctuations', to: 'macro-order', type: 'emerges-from' },
      { from: 'macro-order', to: 'micro-fluctuations', type: 'constrains' },
    ],
    commonIn: ['thermodynamics', 'complex-systems', 'network-science', 'economics', 'evolutionary-biology'],
  },
  {
    name: 'adversarial-coevolution',
    description: 'Two systems evolve in response to each other, escalating adaptation arms race',
    edges: [
      { from: 'agent-A', to: 'agent-B', type: 'constrains' },
      { from: 'agent-B', to: 'counter-strategy', type: 'enables' },
      { from: 'counter-strategy', to: 'agent-A', type: 'constrains' },
      { from: 'agent-A', to: 'counter-counter-strategy', type: 'enables' },
    ],
    commonIn: ['evolutionary-biology', 'game-theory', 'economics', 'computer-science', 'philosophy-of-science'],
  },
  {
    name: 'compression-redundancy-tradeoff',
    description: 'Reducing redundancy increases efficiency but reduces robustness to noise',
    edges: [
      { from: 'redundancy', to: 'robustness', type: 'enables' },
      { from: 'compression', to: 'redundancy', type: 'constrains' },
      { from: 'compression', to: 'efficiency', type: 'enables' },
      { from: 'noise', to: 'robustness', type: 'depends-on' },
    ],
    commonIn: ['information-theory', 'evolutionary-biology', 'cognitive-science', 'network-science'],
  },
  {
    name: 'hub-and-spoke-cascade',
    description: 'Centralised hubs amplify propagation; hub failure causes disproportionate collapse',
    edges: [
      { from: 'hub', to: 'spoke-nodes', type: 'enables' },
      { from: 'spoke-nodes', to: 'hub', type: 'depends-on' },
      { from: 'hub-failure', to: 'cascade', type: 'enables' },
      { from: 'cascade', to: 'network', type: 'constrains' },
    ],
    commonIn: ['network-science', 'economics', 'complex-systems', 'evolutionary-biology'],
  },
]

// Lexical cues that signal each pattern WITHOUT a model call. Light mode uses
// these to surface candidate structural resonances locally (< 1ms), so structural
// resonance detection works on every prompt within the 500ms budget. Deep mode
// still runs the model-driven MATCH_SYSTEM pass below for precise node mapping.
const PATTERN_CUES: Record<string, RegExp> = {
  'feedback-stabilisation':          /\b(feedback|equilibr|homeostas|self-correct|regulat|stabil|control loop|set ?point|thermostat)\b/i,
  'exploration-exploitation':        /\b(explor|exploit|trade.?off|search|optimi[sz]|local (?:optimum|maximum|minimum)|greedy|bandit|innovat)\b/i,
  'phase-transition':                /\b(threshold|tipping point|phase|critical|sudden|regime|emergen|cascade onset|percolat|crystalli)\b/i,
  'adversarial-coevolution':         /\b(adversar|arms race|co-?evolv|attack|defen[cs]e|counter.?strateg|predator|escalat|red team)\b/i,
  'compression-redundancy-tradeoff': /\b(compress|redundan|efficien|robust|noise|encod|lossy|bandwidth|signal)\b/i,
  'hub-and-spoke-cascade':           /\b(hub|central|spoke|cascade|propagat|single point|bottleneck|broadcast|fan.?out|topolog)\b/i,
}

// Returns the canonical pattern names whose lexical cues fire on the text, OR
// whose `commonIn` list includes the prompt's domain. Pure-local, no model call.
export function detectLocalStructuralPatterns(text: string, domain: string): string[] {
  const hits = new Set<string>()
  for (const p of STRUCTURAL_PATTERNS) {
    if (PATTERN_CUES[p.name]?.test(text)) hits.add(p.name)
    if (p.commonIn.includes(domain)) hits.add(p.name)
  }
  return [...hits]
}

const MATCH_SYSTEM = `You are a structural pattern analyst. Given a text passage, determine whether it instantiates a known structural pattern from the list provided. If it does, map the pattern's abstract node labels to the concrete entities in the passage.

Return ONLY a JSON object: {
  "patternName": "name of the matched pattern or null",
  "confidence": 0.0 to 1.0,
  "nodeMapping": { "abstract-node": "concrete entity from the passage" },
  "resonantDomain": "a domain from: computer-science, economics, evolutionary-biology, thermodynamics, cognitive-science, philosophy-of-science, complex-systems, game-theory, information-theory, network-science, general",
  "resonantDescription": "one sentence: how this pattern manifests in the resonantDomain"
}

If no pattern applies with confidence ≥ 0.55, return { "patternName": null }.`

export async function findStructuralResonances(
  shard: Shard,
  deps: MasterpieceDeps,
): Promise<StructuralResonance[]> {
  const { callModel, selectModels, withTimeout } = deps
  const { models } = selectModels('analysis', undefined, 'simple')
  const model = models[0]

  const patternDescriptions = STRUCTURAL_PATTERNS.map(p =>
    `Pattern "${p.name}": ${p.description}`
  ).join('\n')

  const userPrompt = `PASSAGE (domain: ${shard.domain}):\n${shard.content}\n\nAVAILABLE PATTERNS:\n${patternDescriptions}`

  let result: {
    patternName: string | null
    confidence: number
    nodeMapping: Record<string, string>
    resonantDomain: string
    resonantDescription: string
  } | null = null

  try {
    const raw = await withTimeout(
      callModel(model, [
        { role: 'system', content: MATCH_SYSTEM },
        { role: 'user', content: userPrompt },
      ], { requestId: deps.requestId }),
      12000,
      '',
    )
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    result = JSON.parse(cleaned)
  } catch {
    return []
  }

  if (!result?.patternName || result.confidence < 0.55) return []

  const pattern = STRUCTURAL_PATTERNS.find(p => p.name === result!.patternName)
  if (!pattern) return []

  // Build concrete edge list using the node mapping
  const mapping = result.nodeMapping ?? {}
  const concreteEdges: ResonanceEdge[] = pattern.edges.map(e => ({
    fromLabel: mapping[e.from] ?? e.from,
    toLabel: mapping[e.to] ?? e.to,
    type: e.type,
    strength: result!.confidence,
  }))

  const resonance: StructuralResonance = {
    id: randomUUID(),
    shardId: shard.id,
    matchedPattern: pattern.name,
    sourceDomain: shard.domain,
    resonantDomain: result.resonantDomain,
    resonantDescription: result.resonantDescription,
    edges: concreteEdges,
    mappingConfidence: result.confidence,
  }

  return [resonance]
}
