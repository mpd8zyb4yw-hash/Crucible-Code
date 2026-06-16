// Confidence calibrator — runs as a final pass after synthesis.
// Scores each claim in the output using:
//   1. Ensemble disagreement score (if multiple model outputs available)
//   2. Web grounding hit rate (if webGrounding was used)
//   3. Verification pass/fail (from domainVerifiers / sandbox)
//
// Annotates the output with confidence tiers: HIGH | MEDIUM | LOW | UNVERIFIED
// Exposes a confidence summary at the top of the response.
// Integrates with scoringEngine.ts and domainVerifiers.ts.

import { debugBus } from './debug/bus'

export type ConfidenceTier = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNVERIFIED'

export interface ClaimConfidence {
  claim: string            // the sentence/claim text
  tier: ConfidenceTier
  score: number            // 0-1 aggregate confidence
  signals: {
    ensembleAgreement?: number    // how much models agreed (0-1)
    webGrounded?: boolean         // whether web results supported this
    verificationPassed?: boolean  // sandbox/domain-verifier outcome
  }
}

export interface CalibrationResult {
  claims: ClaimConfidence[]
  summary: {
    HIGH: number
    MEDIUM: number
    LOW: number
    UNVERIFIED: number
    overallTier: ConfidenceTier
    overallScore: number
  }
  annotatedText: string    // synthesis with inline confidence markers
  summaryBlock: string     // block to prepend to response
  fragilityAssumption?: string  // the single most fragile named assumption, if found
}

// Prompt types that warrant fragility analysis (skip creative/code — no factual assumptions)
const FRAGILITY_PROMPT_TYPES = new Set(['factual', 'reasoning', 'math', 'general'])

// Reject outputs that are generic hedges rather than named assumptions.
// The model sometimes produces "This answer assumes current data is accurate" —
// that's useless. We require a named entity (capitalized word, number, or
// product name) to appear in the output before surfacing it.
function isSpecificEnough(assumption: string): boolean {
  if (assumption.length < 20 || assumption.length > 300) return false
  // Must contain a named entity: capitalized proper noun, a number, a quoted term,
  // a version string, or a date-like pattern
  const hasNamedEntity = /[A-Z][a-z]{2,}|v\d+\.\d+|\d{4}|"\w|\b\d+[\s%$]/.test(assumption)
  // Reject modal-heavy hedges ("may", "might", "could", "generally", "typically")
  // that signal the model gave a generic disclaimer instead of a specific claim
  const hedgeCount = (assumption.match(/\b(may|might|could|generally|typically|usually|often|sometimes)\b/gi) ?? []).length
  return hasNamedEntity && hedgeCount <= 1
}

// Build the fragility prompt. The design constraint: make hedging structurally
// impossible by (a) showing a bad/good contrast, (b) banning modal verbs,
// (c) requiring a named entity, (d) demanding a single sentence with no preamble.
export function buildFragilityPrompt(synthesisText: string, question: string): string {
  return `You are identifying the single most fragile hidden assumption in an answer.

Question: ${question.slice(0, 300)}

Answer: ${synthesisText.slice(0, 1200)}

Find the ONE assumption this answer is most sensitive to — the specific named fact, number, policy, version, or condition that, if wrong, most undermines the answer.

Rules:
- Name the specific entity: not "the service" but "Groq's free tier", not "the library" but "React 18", not "the data" but "the November 2024 pricing page"
- State what it is assumed to be (the concrete value or condition taken for granted)
- State what breaks if that assumption is wrong
- One sentence only — no preamble, no "Note:", no "This answer assumes..." opener (just state the assumption and consequence directly)
- No modal verbs: not "may break" but "breaks", not "could be wrong" but "is wrong"

Bad: "This answer assumes the data is current."
Good: "Groq's free-tier rate limit is treated as 6,000 tokens/minute — if they've tightened it since Q4 2024, the batching strategy described will hit limits on any prompt over 2,000 tokens."

Output only the one-sentence assumption. Nothing else.`
}

// Run fragility analysis against a fast model. Returns null on any failure
// or if the output is too generic to be useful.
export async function getFragilityAssumption(
  synthesisText: string,
  question: string,
  promptType: string,
  callModel: (model: any, messages: any[]) => Promise<string>,
  fastModel: any,
  requestId?: string,
): Promise<string | null> {
  if (!FRAGILITY_PROMPT_TYPES.has(promptType)) return null

  try {
    const prompt = buildFragilityPrompt(synthesisText, question)
    const raw = await Promise.race([
      callModel(fastModel, [
        { role: 'system', content: 'You identify hidden assumptions in answers. Output exactly one sentence — specific, named, no modal verbs. No preamble.' },
        { role: 'user', content: prompt },
      ]),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 4000)),
    ])
    if (!raw || typeof raw !== 'string') return null

    const assumption = raw.trim().replace(/^(Note:|Assumption:|The answer assumes|This answer assumes)\s*/i, '')
    if (!isSpecificEnough(assumption)) {
      debugBus.emit('pipeline', 'fragility_rejected', {
        reason: 'not_specific', assumption: assumption.slice(0, 80), requestId,
      }, { severity: 'info', requestId })
      return null
    }

    debugBus.emit('pipeline', 'fragility_found', {
      promptType, assumptionLen: assumption.length, requestId,
    }, { severity: 'info', requestId })

    return assumption
  } catch {
    return null
  }
}

// Sentence-level claim extraction
function extractClaims(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 20 && s.length < 400)
    .filter(s => /\b(is|are|was|were|has|have|will|can|does|do)\b/.test(s))
    .slice(0, 20)
}

// Estimate ensemble agreement for a claim given all model responses
function scoreEnsembleAgreement(claim: string, modelResponses: string[]): number {
  if (!modelResponses.length) return 0.5  // neutral when no ensemble data

  const claimWords = new Set(
    claim.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 4)
  )

  const coveragePerModel = modelResponses.map(resp => {
    const respWords = new Set(resp.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/))
    const covered = [...claimWords].filter(w => respWords.has(w)).length
    return covered / Math.max(claimWords.size, 1)
  })

  // Agreement = proportion of models that substantially cover this claim (>30% word overlap)
  const agreeing = coveragePerModel.filter(c => c >= 0.3).length
  return agreeing / Math.max(modelResponses.length, 1)
}

// Check if a claim appears in web grounding context
function scoreWebGrounding(claim: string, webContext?: string): boolean | undefined {
  if (!webContext) return undefined
  const claimWords = claim.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 4)
  const contextLower = webContext.toLowerCase()
  const hits = claimWords.filter(w => contextLower.includes(w)).length
  return hits >= Math.ceil(claimWords.length * 0.4)
}

// Determine if a claim is potentially high-stakes (factual, numeric, specific)
function isHighStakesClaim(claim: string): boolean {
  return /\b\d[\d.,]*\b|%|http|doi\.|(?:proved|disproved|discovered|invented|founded|born|died)\b/i.test(claim)
}

// Map aggregate score to tier
function scoreToTier(score: number): ConfidenceTier {
  if (score >= 0.75) return 'HIGH'
  if (score >= 0.5) return 'MEDIUM'
  if (score >= 0.25) return 'LOW'
  return 'UNVERIFIED'
}

// Main calibration pass
export function calibrate(
  synthesisText: string,
  options: {
    modelResponses?: string[]
    webGroundingContext?: string
    verificationPassed?: boolean
    domainVerifierIssues?: string[]
    ensembleCompositeScore?: number
    requestId?: string
  } = {},
): CalibrationResult {
  const claims = extractClaims(synthesisText)
  const {
    modelResponses = [],
    webGroundingContext,
    verificationPassed,
    domainVerifierIssues = [],
    ensembleCompositeScore,
    requestId,
  } = options

  const calibratedClaims: ClaimConfidence[] = claims.map(claim => {
    const ensembleAgreement = scoreEnsembleAgreement(claim, modelResponses)
    const webGrounded = scoreWebGrounding(claim, webGroundingContext)

    // Verification signal — high-stakes claims penalised if verifier found issues
    const hasVerifierIssue = domainVerifierIssues.some(issue =>
      issue.toLowerCase().split(/\s+/).some(w => w.length > 4 && claim.toLowerCase().includes(w))
    )
    const verificationScore = verificationPassed === undefined
      ? 0.5
      : hasVerifierIssue
        ? 0.2
        : verificationPassed ? 0.85 : 0.35

    // Aggregate: ensemble (40%), web grounding (30%), verification (30%)
    const webScore = webGrounded === undefined ? 0.5 : webGrounded ? 0.85 : 0.3
    let score = ensembleAgreement * 0.4 + webScore * 0.3 + verificationScore * 0.3

    // Boost from composite score if available
    if (ensembleCompositeScore !== undefined) {
      score = score * 0.7 + ensembleCompositeScore * 0.3
    }

    // High-stakes claims get penalised by 0.1 unless well-grounded
    if (isHighStakesClaim(claim) && webGrounded === false) score -= 0.1

    score = Math.max(0, Math.min(1, score))

    return {
      claim: claim.slice(0, 120),
      tier: scoreToTier(score),
      score: parseFloat(score.toFixed(3)),
      signals: {
        ensembleAgreement: parseFloat(ensembleAgreement.toFixed(3)),
        webGrounded,
        verificationPassed: verificationPassed ?? (verificationScore > 0.5),
      },
    }
  })

  // Aggregate summary
  const counts = { HIGH: 0, MEDIUM: 0, LOW: 0, UNVERIFIED: 0 }
  for (const c of calibratedClaims) counts[c.tier]++

  const overallScore = calibratedClaims.length
    ? calibratedClaims.reduce((s, c) => s + c.score, 0) / calibratedClaims.length
    : 0.5

  const overallTier = scoreToTier(overallScore)


  // Build annotated text — append tier markers to high-stake sentences inline
  let annotatedText = synthesisText
  for (const cc of calibratedClaims) {
    if (cc.tier === 'LOW' || cc.tier === 'UNVERIFIED') {
      const escaped = cc.claim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      try {
        annotatedText = annotatedText.replace(
          new RegExp(escaped.slice(0, 60)),
          `${cc.claim.slice(0, 60)} [${cc.tier}]`,
        )
      } catch { /* skip if regex fails on special chars */ }
    }
  }

  // Summary block for top of response
  const summaryLines: string[] = []
  summaryLines.push(`Confidence: ${overallTier} (${(overallScore * 100).toFixed(0)}%)`)
  if (counts.LOW + counts.UNVERIFIED > 0) {
    summaryLines.push(`${counts.HIGH} high · ${counts.MEDIUM} medium · ${counts.LOW} low · ${counts.UNVERIFIED} unverified`)
    summaryLines.push(`Claims marked [LOW] or [UNVERIFIED] have limited grounding — verify independently.`)
  }

  const summaryBlock = summaryLines.join(' | ')

  debugBus.emit('pipeline', 'confidence_calibrated', {
    claimCount: calibratedClaims.length,
    overallTier,
    overallScore,
    counts,
    requestId,
  }, { severity: overallTier === 'HIGH' ? 'success' : overallTier === 'LOW' ? 'warn' : 'info', requestId })

  return {
    claims: calibratedClaims,
    summary: { ...counts, overallTier, overallScore },
    annotatedText,
    summaryBlock,
  }
}

// Light integration with scoringEngine: adjust composite score based on calibration
export function adjustScoreForConfidence(
  compositeScore: number,
  calibration: CalibrationResult,
): number {
  // Penalise low-confidence synthesis
  const unverifiedRatio = calibration.summary.UNVERIFIED / Math.max(calibration.claims.length, 1)
  const lowRatio = calibration.summary.LOW / Math.max(calibration.claims.length, 1)
  const penalty = unverifiedRatio * 0.1 + lowRatio * 0.05
  return Math.max(0, Math.min(1, compositeScore - penalty))
}
