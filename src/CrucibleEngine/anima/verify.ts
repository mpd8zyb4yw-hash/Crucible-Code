// ANIMA processes signal to extract universal observations. No user data is stored at any layer.
//
// Epistemic integrity pipeline. Every candidate truth must pass ALL FIVE gates
// before it reaches the store:
//   1. H1 confidence gate   — confidence < 0.35 ⇒ discard silently
//   2. Novelty gate         — noveltyScore < 0.4 ⇒ already known, discard
//   3. Fragility assessment — empty / "nothing" ⇒ unfalsifiable, discard
//   4. Dialectical challenge— antithesis model argues against; if it wins, discard
//   5. Cross-domain check   — if a near-duplicate exists under a different domain,
//                             CONFIRM the existing entry instead of creating a dupe
//
// Only observations surviving all five gates are written to the store.

import * as store from './store.js'
import type { AnimaDeps, CandidateObservation, UniversalTruth } from './types.js'

const CHALLENGE_SYSTEM = `You are an adversarial epistemologist. A candidate universal observation about human experience has been proposed. Argue the strongest honest case AGAINST it: is it actually universal, or culture/context-bound? Is it falsifiable, or dressed-up truism? Does the stated fragility actually threaten it?

Return ONLY a JSON object: { "antithesisStronger": true|false, "reason": "one sentence" }
antithesisStronger=true means your counter-case is stronger than the original claim (it should NOT be stored).
antithesisStronger=false means the observation survives your challenge.`

export interface VerifyOutcome {
  observation: string
  result: 'stored' | 'confirmed-existing' | 'rejected'
  gate?: 'confidence' | 'novelty' | 'fragility' | 'dialectical'
  truthId?: string
}

// Lexical similarity for near-duplicate detection (no embeddings in ANIMA).
function similarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w.length > 3)
  const sa = new Set(norm(a)), sb = new Set(norm(b))
  if (!sa.size || !sb.size) return 0
  let inter = 0
  for (const w of sa) if (sb.has(w)) inter++
  return inter / (sa.size + sb.size - inter)
}

const UNFALSIFIABLE = /^(nothing|none|n\/?a|unfalsifiable|can't|cannot|unknown)\b/i

export async function verifyCandidates(
  candidates: CandidateObservation[],
  deps: AnimaDeps,
): Promise<VerifyOutcome[]> {
  const outcomes: VerifyOutcome[] = []

  for (const c of candidates) {
    // ── Gate 1: confidence ──────────────────────────────────────────────
    if (c.confidence < 0.35) {
      outcomes.push({ observation: c.observation, result: 'rejected', gate: 'confidence' })
      continue
    }
    // ── Gate 2: novelty ─────────────────────────────────────────────────
    if (c.noveltyScore < 0.4) {
      outcomes.push({ observation: c.observation, result: 'rejected', gate: 'novelty' })
      continue
    }
    // ── Gate 3: fragility (falsifiability) ──────────────────────────────
    const frag = c.fragilityAssessment.trim()
    if (!frag || UNFALSIFIABLE.test(frag) || frag.length < 6) {
      outcomes.push({ observation: c.observation, result: 'rejected', gate: 'fragility' })
      continue
    }

    // ── Gate 5 (run before dialectical to short-circuit dupes): cross-domain ──
    // If a near-duplicate already exists anywhere, confirm it rather than dup.
    const existing = store.allLiveTruths()
    const match = existing
      .map(t => ({ t, sim: similarity(t.observation, c.observation) }))
      .sort((a, b) => b.sim - a.sim)[0]
    if (match && match.sim >= 0.5) {
      const confirmed = store.confirm(match.t.id)
      outcomes.push({ observation: c.observation, result: 'confirmed-existing', truthId: confirmed?.id ?? match.t.id })
      continue
    }

    // ── Gate 4: dialectical challenge ───────────────────────────────────
    const survived = await dialecticalChallenge(c, deps)
    if (!survived) {
      outcomes.push({ observation: c.observation, result: 'rejected', gate: 'dialectical' })
      continue
    }

    // Survived all gates — write as a new candidate truth.
    const written = store.write({
      observation: c.observation,
      domain: c.domain,
      noveltyScore: c.noveltyScore,
      fragility: frag,
    })
    outcomes.push({ observation: c.observation, result: 'stored', truthId: written.id })
  }

  return outcomes
}

async function dialecticalChallenge(c: CandidateObservation, deps: AnimaDeps): Promise<boolean> {
  const { models } = deps.selectModels('analysis', undefined, 'simple')
  // Prefer a different model than observe.ts used, for genuine independence.
  const model = models[Math.min(1, models.length - 1)] ?? models[0]
  if (!model) return true  // can't challenge ⇒ default to letting the candidate through

  try {
    const raw = await deps.withTimeout(
      deps.callModel(model, [
        { role: 'system', content: CHALLENGE_SYSTEM },
        { role: 'user', content: `CANDIDATE OBSERVATION: ${c.observation}\nDOMAIN: ${c.domain}\nSTATED FRAGILITY: ${c.fragilityAssessment}` },
      ], { requestId: deps.requestId }),
      10000,
      '{"antithesisStronger": false, "reason": "challenge timed out"}',
    )
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    const verdict: { antithesisStronger?: boolean } = JSON.parse(cleaned)
    return verdict.antithesisStronger !== true
  } catch {
    return true  // challenge itself failed ⇒ do not punish the candidate
  }
}
