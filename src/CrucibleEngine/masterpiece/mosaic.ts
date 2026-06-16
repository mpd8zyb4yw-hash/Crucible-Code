// MASTERPIECE — Mosaic Sharding
// Decomposes the prompt into semantically coherent shards.
// Invariant: the Ground Truth Anchor (originalPrompt) is NEVER modified here
// or anywhere else. Shards are sub-problems derived from it, not replacements.

import { randomUUID } from 'crypto'
import type { GroundTruthAnchor, Shard, ShardManifest, AnchorId, ShardId } from './types.js'
import { stmts } from './corpus/db.js'
import type { MasterpieceDeps } from './types.js'

// Domain vocabulary used for quick lexical detection.
// A more expensive LLM-based domain detection runs for ambiguous cases.
const DOMAIN_KEYWORDS: Record<string, string[]> = {
  'computer-science':     ['algorithm', 'code', 'software', 'system', 'database', 'api', 'machine learning', 'ai', 'neural', 'compute', 'programming'],
  'economics':            ['market', 'price', 'cost', 'incentive', 'supply', 'demand', 'trade', 'capital', 'investment', 'economic', 'revenue'],
  'evolutionary-biology': ['evolution', 'species', 'genome', 'gene', 'natural selection', 'fitness', 'adapt', 'organism', 'mutation'],
  'thermodynamics':       ['entropy', 'energy', 'heat', 'temperature', 'thermodynamic', 'equilibrium', 'dissipation', 'free energy'],
  'cognitive-science':    ['cognition', 'memory', 'perception', 'attention', 'brain', 'learning', 'consciousness', 'behaviour', 'behavior', 'mind'],
  'philosophy-of-science':['paradigm', 'hypothesis', 'falsifiable', 'epistem', 'theory', 'scientific', 'evidence', 'logic', 'rationality'],
  'complex-systems':      ['emergence', 'self-organis', 'feedback', 'nonlinear', 'complex system', 'network', 'cascade', 'attractor'],
  'game-theory':          ['game', 'strategy', 'equilibrium', 'nash', 'prisoner', 'cooperation', 'defect', 'incentive', 'payoff'],
  'information-theory':   ['entropy', 'information', 'bit', 'channel', 'compression', 'encoding', 'signal', 'noise', 'bandwidth'],
  'network-science':      ['graph', 'node', 'edge', 'network', 'topology', 'hub', 'cluster', 'degree', 'connectivity'],
  'general':              [],
}

export function detectDomain(text: string): string {
  const lower = text.toLowerCase()
  const scores: Record<string, number> = {}
  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    if (domain === 'general') continue
    scores[domain] = keywords.filter(k => lower.includes(k)).length
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0]
  return best && best[1] > 0 ? best[0] : 'general'
}

function estimateTokens(text: string): number {
  return Math.round(text.trim().split(/\s+/).length * 0.75)
}

// Creates the Ground Truth Anchor and stores it in the DB.
export function createAnchor(originalPrompt: string): GroundTruthAnchor {
  const anchor: GroundTruthAnchor = {
    id: randomUUID(),
    originalPrompt,
    storedAt: Date.now(),
    shardCount: 0,
  }
  stmts().insertAnchor.run(anchor.id, anchor.originalPrompt, anchor.storedAt, 0)
  return anchor
}

// Decomposes the prompt into 2–6 shards.
// Strategy:
//   1. Ask a fast model to extract distinct analytical sub-questions.
//   2. Parse its JSON response into shard content.
//   3. Fall back to sentence-boundary splitting if parsing fails.
export async function shardPrompt(
  anchor: GroundTruthAnchor,
  deps: MasterpieceDeps,
): Promise<ShardManifest> {
  const { callModel, selectModels, withTimeout } = deps

  // Use the fastest available model for decomposition — this step must be quick.
  const { models } = selectModels('analysis', undefined, 'simple')
  const model = models[0]

  const systemPrompt = `You are an expert analytical decomposer. Your task is to break down a complex prompt into 2–6 distinct, non-overlapping sub-questions or analytical dimensions. Each shard should be a self-contained semantic unit that can be reasoned about independently. Return ONLY a JSON object with this exact schema: { "shards": [ { "content": "the sub-question or analytical dimension text", "domain": "one of: computer-science, economics, evolutionary-biology, thermodynamics, cognitive-science, philosophy-of-science, complex-systems, game-theory, information-theory, network-science, general" } ] }. Do not wrap in markdown. Do not add any explanation outside the JSON object.`

  const userPrompt = `Decompose this prompt into 2–6 distinct analytical dimensions:\n\n${anchor.originalPrompt}`

  let shardTexts: Array<{ content: string; domain: string }> = []

  try {
    const response = await withTimeout(
      callModel(model, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ], { requestId: deps.requestId }),
      12000,
      '',
    )

    // Strip possible markdown fences
    const cleaned = response.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    const parsed = JSON.parse(cleaned)
    if (Array.isArray(parsed.shards) && parsed.shards.length >= 2) {
      shardTexts = parsed.shards.filter(
        (s: unknown) => typeof s === 'object' && s !== null && typeof (s as Record<string, unknown>).content === 'string',
      )
    }
  } catch {
    // Decomposition failed — fall through to heuristic splitter
  }

  // Heuristic fallback: split on paragraph boundaries or sentence groups.
  if (shardTexts.length < 2) {
    shardTexts = heuristicShard(anchor.originalPrompt)
  }

  const shards: Shard[] = shardTexts.map((s, i) => {
    const id: ShardId = `shard-${i}-${anchor.id.slice(0, 8)}`
    return {
      id,
      anchorId: anchor.id,
      index: i,
      content: s.content,
      domain: s.domain ?? detectDomain(s.content),
      tokenEstimate: estimateTokens(s.content),
    }
  })

  const manifest: ShardManifest = {
    anchorId: anchor.id,
    shards,
    createdAt: Date.now(),
  }

  return manifest
}

function heuristicShard(text: string): Array<{ content: string; domain: string }> {
  // Try paragraph splits first.
  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 30)
  if (paragraphs.length >= 2) {
    return paragraphs.map(p => ({ content: p, domain: detectDomain(p) }))
  }

  // Fall back to halving on sentence boundaries.
  const sentences = text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean)
  const mid = Math.ceil(sentences.length / 2)
  const halves = [
    sentences.slice(0, mid).join(' '),
    sentences.slice(mid).join(' '),
  ].filter(h => h.length > 20)

  return halves.length >= 2
    ? halves.map(h => ({ content: h, domain: detectDomain(h) }))
    : [{ content: text, domain: detectDomain(text) }]
}
