// ── Research DAG Engine — Gen-2 research orchestrator ────────────────────────
//
// Replaces researchMode.ts. Architecture:
//
//   Layer 0  Decompose the question into atomic leaf sub-questions (heuristic +
//            FM-guided, recipe-templated). No FM call escapes this layer.
//
//   Layer 1  Bounded leaf primitives: each leaf is a fixed-shape FM call.
//            FM proposes; Node verifies. No unbounded generation.
//
//   Layer 2  Read-reliability vote: FM reads the same snippet 3× and checks
//            agreement — measures extraction stability, NOT truth.
//
//   Layer 3  Retrieval per leaf: corpus-first (SQLite), then web (DuckDuckGo +
//            page fetch via retrievalLayer). Never a raw dump to the FM.
//
//   Layer 4  Per-leaf scratchpad (taskScratchpad) — keeps FM context narrow.
//
//   Layer 5  Contradiction detection: Jaccard pre-cluster, FM pairwise within
//            clusters, deterministic resolution (tier > authority > recency).
//
//   Layer 6  Confidence roll-up: abstained leaves taint parent answer.
//            Final synthesis is constrained — every sentence must map to a
//            verified claim, or it is cut.
//
// Hard guarantees:
//   - Budget: maxLeafNodes, maxWebPages, maxMs
//   - Abstain is a first-class result, not a failure
//   - Every claim carries its VerificationTier; no claim is certified by FM alone
//   - The same ResearchEvent interface as researchMode.ts for server.ts swap

import path from 'path'
import { search, fetch as fetchPage, stripBoilerplate, rankByRelevance } from '../retrieval/retrievalLayer'
import { queryLivingCorpus } from '../corpus/query'
import { writeScratch, buildScratchContext, clearScratch } from '../agent/taskScratchpad'
import { debugBus } from '../debug/bus'
import {
  snippetAnswers, decomposeQuestion, groundedSynthesis, buildSearchQuery,
  readReliabilityVote, pingLocalFm, checkPremiseGrounding, isPremiseBearing, type FmCall, defaultFmCall,
} from './leafPrimitives'
import {
  verifyClaim, filterGroundedSentences,
  type VerifiedClaim, type SourceEvidence, type VerificationTier,
} from './provenanceOracle'
import { lookupClaim, storeClaim } from './verifiedClaimCache'

// ── Types ─────────────────────────────────────────────────────────────────────

// Same event shape as researchMode.ts — server.ts can swap without changes.
export interface ResearchEvent {
  type: 'research_step' | 'research_done' | 'research_error'
  step?: number
  phase?: 'decompose' | 'retrieve' | 'verify' | 'contradict' | 'synthesize' | 'audit'
  detail?: string
  leafQuestion?: string
  tier?: VerificationTier
  confidence?: number
  sources?: number
  claimsFound?: number
  gapsIdentified?: number
  text?: string
}

export interface ResearchOpts {
  /** Max leaf sub-questions (default 6) */
  maxLeafNodes?: number
  /** Max web pages fetched total (default 10) */
  maxWebPages?: number
  /** Wall-clock cap in ms (default 90s) */
  maxMs?: number
  /** Minimum coverage fraction before synthesis (0-1, default 0.6) */
  coverageThreshold?: number
  /** Override the FM call (for testing) */
  fmCall?: FmCall
  /** Project root for scratchpad + cache */
  projectDir?: string
  /** Disable read-reliability vote (faster, fewer FM calls) */
  skipReadReliability?: boolean
  /**
   * Emit the full research chrome — `[CORROBORATED · N% …]` confidence header,
   * evidence quote block, and `*Sources: …*` line. Defaults to true for the
   * explicit /api/research endpoint. The conversational path (synthDriver)
   * sets this false so plain factual questions get a plain-sentence answer;
   * it flips back on when the user actually asks for sources/citations.
   */
  verbose?: boolean
}

interface LeafResult {
  question: string
  claim: VerifiedClaim | null
  extractedAnswer: string
  sources: string[]
  abstained: boolean
  abstainReason?: string
}

// ── Layer 0: Decompose ────────────────────────────────────────────────────────

async function decomposeToLeaves(
  question: string,
  maxLeafNodes: number,
  fmCall: FmCall,
): Promise<string[]> {
  const { subQuestions } = await decomposeQuestion(question, fmCall)
  return subQuestions.slice(0, maxLeafNodes)
}

// ── Layer 3 + 4: Retrieve per leaf ────────────────────────────────────────────

interface RetrievedEvidence {
  sources: SourceEvidence[]
  corpusHits: number
  webHits: number
}

async function retrieveForLeaf(
  question: string,
  maxWebPages: number,
  webPagesUsed: { count: number },
): Promise<RetrievedEvidence> {
  const sources: SourceEvidence[] = []
  let corpusHits = 0

  // Corpus-first (no network, fast)
  try {
    const hits = await queryLivingCorpus(question, { topK: 4, minSimilarity: 0.3 })
    for (const h of hits) {
      sources.push({
        url: `corpus:${h.chunk.source}`,
        text: h.chunk.content,
        authority: h.chunk.sourceReliability,
        domain: h.chunk.domain,
        sourceClass: 'corpus',
      })
      corpusHits++
    }
  } catch { /* corpus may be empty — graceful */ }

  // Web retrieval fallback (or supplement when corpus thin)
  let webHits = 0
  if (webPagesUsed.count < maxWebPages) {
    try {
      const query = buildSearchQuery(question)
      const results = await search(query)
      const ranked = rankByRelevance(results, { goal: question }, r => `${r.title} ${r.snippet}`)
        .slice(0, Math.min(3, maxWebPages - webPagesUsed.count))
      for (const { item } of ranked) {
        if (webPagesUsed.count >= maxWebPages) break
        const html = await fetchPage(item.url)
        if (!html) continue
        webPagesUsed.count++
        webHits++
        const text = stripBoilerplate(html)
        // Authority heuristic from URL
        const authority =
          /\.edu\b|academic|scholar|pubmed|arxiv|doi\.org/.test(item.url) ? 0.8 :
          /wikipedia|britannica|encyclopedia/.test(item.url) ? 0.65 :
          /\.gov\b|rfc-editor/.test(item.url) ? 0.85 :
          0.45
        sources.push({ url: item.url, text, authority, sourceClass: 'web' })
      }
    } catch { /* graceful */ }
  }

  return { sources, corpusHits, webHits }
}

// ── Layer 1 + 2: Execute a single leaf question ───────────────────────────────

async function executeLeafNode(
  question: string,
  taskId: string,
  retrieved: RetrievedEvidence,
  projectDir: string,
  skipReadReliability: boolean,
  fmCall: FmCall,
): Promise<LeafResult> {
  const { sources } = retrieved

  // Check verified-claim cache first (RSI flywheel)
  const cached = lookupClaim(question, projectDir)
  if (cached && cached.tier !== 'unverified') {
    writeScratch(taskId, question, cached.claim, 'cache', cached.confidence)
    return {
      question,
      claim: cached,
      extractedAnswer: cached.claim,
      sources: sources.map(s => s.url),
      abstained: false,
    }
  }

  if (sources.length === 0) {
    return {
      question,
      claim: null,
      extractedAnswer: '',
      sources: [],
      abstained: true,
      abstainReason: 'no sources retrieved',
    }
  }

  // Try each source until we get a snippet that answers the question
  const extractedAnswers: string[] = []
  const crossDerivedAnswers: Array<{ answer: string; sourceClass: 'corpus' | 'web' | 'academic' }> = []
  let bestAnswer = ''
  let bestEvidence: SourceEvidence | null = null
  let partialAnswer = ''
  let partialEvidence: SourceEvidence | null = null

  for (const src of sources.slice(0, 8)) {
    if (!src.text || src.text.length < 20) continue
    // Layer 1: snippetAnswers
    const sa = await snippetAnswers(question, src.text.slice(0, 1500), fmCall)
    if (sa.verdict === 'no' || sa.extractedAnswer === 'none') continue

    // Layer 2: read-reliability vote (skip if disabled)
    if (!skipReadReliability && sa.verdict === 'yes') {
      const reliability = await readReliabilityVote(question, src.text.slice(0, 1500), 2, fmCall)
      if (reliability.reliability < 0.4) continue
    }

    extractedAnswers.push(sa.extractedAnswer)
    crossDerivedAnswers.push({
      answer: sa.extractedAnswer,
      sourceClass: src.sourceClass ?? 'web',
    })
    if (sa.verdict === 'yes' && !bestAnswer) {
      bestAnswer = sa.extractedAnswer
      bestEvidence = src
    } else if (sa.verdict === 'partial' && !partialAnswer) {
      partialAnswer = sa.extractedAnswer
      partialEvidence = src
    }
  }

  // Accept partial if no 'yes' found — still goes through oracle cascade for certification
  if (!bestAnswer && partialAnswer) {
    bestAnswer = partialAnswer
    bestEvidence = partialEvidence
  }

  if (!bestAnswer) {
    return {
      question,
      claim: null,
      extractedAnswer: '',
      sources: sources.map(s => s.url),
      abstained: true,
      abstainReason: 'no source answered the question',
    }
  }

  // Build claim text from the best answer
  const claimText = bestAnswer.length > 30 ? bestAnswer : `${question}: ${bestAnswer}`

  // Oracle cascade
  const verified = await verifyClaim(
    {
      claim: claimText,
      sources: bestEvidence ? [bestEvidence, ...sources.filter(s => s !== bestEvidence)] : sources,
      extractedAnswers,
      crossDerivedAnswers,
    },
    fmCall,
  )

  // Write to scratchpad
  writeScratch(
    taskId,
    question,
    `${verified.tier}|${verified.confidence.toFixed(2)}|${claimText.slice(0, 200)}`,
    'leaf-executor',
    verified.confidence,
  )

  // Cache if verified
  if (verified.tier !== 'unverified') {
    storeClaim(question, verified, projectDir)
  }

  return {
    question,
    claim: verified.tier !== 'unverified' ? verified : null,
    extractedAnswer: claimText,
    sources: sources.map(s => s.url),
    abstained: verified.tier === 'unverified',
    abstainReason: verified.tier === 'unverified' ? 'oracle cascade: all tiers failed' : undefined,
  }
}

// ── Layer 5: Contradiction detection ────────────────────────────────────────

interface ContradictionPair {
  a: LeafResult
  b: LeafResult
  explanation: string
  resolved: 'a-wins' | 'b-wins' | 'both-labeled'
}

function detectContradictions(results: LeafResult[]): ContradictionPair[] {
  // Deterministic pre-cluster by shared topic words (no FM needed for clustering)
  const TIER_ORDER: VerificationTier[] = ['executable', 'verbatim-provenance', 'cross-derived', 'corroborated', 'unverified']
  const tierRank = (t: VerificationTier) => TIER_ORDER.indexOf(t)

  const pairs: ContradictionPair[] = []
  const verified = results.filter(r => r.claim && r.claim.tier !== 'unverified')

  for (let i = 0; i < verified.length; i++) {
    for (let j = i + 1; j < verified.length; j++) {
      const a = verified[i], b = verified[j]
      if (!a.claim || !b.claim) continue

      // Quick Jaccard topic filter — skip if different topics
      const tokA = new Set((a.claim.claim.toLowerCase().match(/[a-z]{4,}/g) ?? []))
      const tokB = new Set((b.claim.claim.toLowerCase().match(/[a-z]{4,}/g) ?? []))
      const union = new Set([...tokA, ...tokB])
      const intersection = [...tokA].filter(t => tokB.has(t)).length
      const jaccard = union.size > 0 ? intersection / union.size : 0
      if (jaccard < 0.2) continue // different topics, skip

      // Simple polarity check (no FM for this cluster pre-filter)
      const negA = /\b(not|no|never|cannot|false|incorrect|wrong)\b/i.test(a.claim.claim)
      const negB = /\b(not|no|never|cannot|false|incorrect|wrong)\b/i.test(b.claim.claim)
      if (negA === negB) continue // same polarity on same topic — not a contradiction

      // Resolve: higher tier wins; same tier → higher confidence wins
      const aRank = tierRank(a.claim.tier), bRank = tierRank(b.claim.tier)
      const resolved: ContradictionPair['resolved'] =
        aRank < bRank ? 'a-wins' :
        bRank < aRank ? 'b-wins' :
        a.claim.confidence >= b.claim.confidence ? 'a-wins' : 'b-wins'

      pairs.push({
        a, b,
        explanation: `potential contradiction (jaccard ${jaccard.toFixed(2)}, polarity conflict)`,
        resolved,
      })
    }
  }
  return pairs
}

// ── Layer 6: Confidence roll-up ───────────────────────────────────────────────

interface RollupResult {
  overallConfidence: number
  coverage: number          // fraction of leaves that got a verified answer
  lowestTier: VerificationTier
}

function rollupConfidence(results: LeafResult[]): RollupResult {
  if (results.length === 0) return { overallConfidence: 0, coverage: 0, lowestTier: 'unverified' }
  const verified = results.filter(r => r.claim && r.claim.tier !== 'unverified')
  const coverage = verified.length / results.length
  if (verified.length === 0) return { overallConfidence: 0, coverage: 0, lowestTier: 'unverified' }

  // Aggregate: min confidence (abstained leaves pull the whole answer down)
  const minConf = Math.min(...verified.map(r => r.claim!.confidence))
  // Penalise by abstained leaves
  const abstainPenalty = (results.length - verified.length) * 0.08
  const overallConfidence = Math.max(0, minConf - abstainPenalty)

  const TIER_ORDER: VerificationTier[] = ['executable', 'verbatim-provenance', 'cross-derived', 'corroborated', 'unverified']
  const lowestTier = verified
    .map(r => r.claim!.tier)
    .sort((a, b) => TIER_ORDER.indexOf(b) - TIER_ORDER.indexOf(a))[0] ?? 'unverified'

  return { overallConfidence, coverage, lowestTier }
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function* runResearchDag(
  question: string,
  opts: ResearchOpts = {},
): AsyncGenerator<ResearchEvent> {
  const maxLeafNodes = opts.maxLeafNodes ?? 6
  const maxWebPages = opts.maxWebPages ?? 10
  const maxMs = opts.maxMs ?? 90_000
  const coverageThreshold = opts.coverageThreshold ?? 0.6
  const fmCall = opts.fmCall ?? defaultFmCall
  const projectDir = opts.projectDir ?? process.cwd()
  const skipReadReliability = opts.skipReadReliability ?? false
  const verbose = opts.verbose ?? true
  const taskId = `research_${Date.now()}`
  const t0 = Date.now()

  try {
    // ── Tier 1 fast-path: try executable reduction on the whole question first ─
    // This handles math/computation without any FM or network call.
    yield { type: 'research_step', phase: 'decompose', detail: question }
    {
      const { tryExecutableReduction } = await import('./provenanceOracle')
      const execResult = tryExecutableReduction(question)
      if (execResult.verified) {
        const vc = execResult.verified
        storeClaim(question, vc, projectDir)
        yield {
          type: 'research_done',
          text: `[ORACLE-VERIFIED · 100% confidence]\n\n${vc.evidence.execResult}`,
          confidence: 1.0,
          sources: 0,
        }
        return
      }
    }

    // ── Check FM availability (needed for all other tiers) ───────────────────
    const fmUp = await pingLocalFm(fmCall)
    if (!fmUp) {
      yield { type: 'research_error', text: 'Local FM unavailable — cannot run research DAG. Check :11435.' }
      return
    }

    // ── Layer 0: Decompose ────────────────────────────────────────────────────
    const leaves = await decomposeToLeaves(question, maxLeafNodes, fmCall)
    debugBus.emit('pipeline', 'research_dag_decomposed', {
      question: question.slice(0, 80), leafCount: leaves.length,
    }, { severity: 'info' })

    // ── Layer 3: Retrieve + Layer 1: Execute per leaf ─────────────────────────
    const webPagesUsed = { count: 0 }
    const leafResults: LeafResult[] = []

    for (let i = 0; i < leaves.length; i++) {
      if (Date.now() - t0 > maxMs) {
        yield { type: 'research_step', phase: 'retrieve', detail: 'time budget exhausted — synthesizing with gathered claims' }
        break
      }

      const leaf = leaves[i]
      yield { type: 'research_step', step: i, phase: 'retrieve', leafQuestion: leaf }

      const retrieved = await retrieveForLeaf(leaf, maxWebPages, webPagesUsed)

      yield {
        type: 'research_step', step: i, phase: 'verify', leafQuestion: leaf,
        sources: retrieved.sources.length,
      }

      const result = await executeLeafNode(
        leaf, taskId, retrieved, projectDir, skipReadReliability, fmCall,
      )
      leafResults.push(result)

      if (result.claim) {
        yield {
          type: 'research_step', step: i, phase: 'verify',
          leafQuestion: leaf, tier: result.claim.tier,
          confidence: result.claim.confidence,
          claimsFound: 1,
        }
      }

      debugBus.emit('pipeline', 'research_leaf_done', {
        leaf: leaf.slice(0, 60),
        tier: result.claim?.tier ?? 'abstained',
        confidence: result.claim?.confidence ?? 0,
      }, { severity: result.claim ? 'success' : 'warn' })
    }

    // ── Layer 5: Contradiction detection ──────────────────────────────────────
    yield { type: 'research_step', phase: 'contradict' }
    const contradictions = detectContradictions(leafResults)
    if (contradictions.length > 0) {
      yield {
        type: 'research_step', phase: 'contradict',
        detail: `${contradictions.length} potential contradiction(s) detected and resolved`,
        gapsIdentified: contradictions.length,
      }
      // Apply resolution: drop the losing side (mark as abstained)
      for (const c of contradictions) {
        if (c.resolved === 'b-wins') {
          const idx = leafResults.indexOf(c.a)
          if (idx >= 0) leafResults[idx] = { ...leafResults[idx], claim: null, abstained: true, abstainReason: `contradiction resolved: overridden by higher-tier claim` }
        } else if (c.resolved === 'a-wins') {
          const idx = leafResults.indexOf(c.b)
          if (idx >= 0) leafResults[idx] = { ...leafResults[idx], claim: null, abstained: true, abstainReason: `contradiction resolved: overridden by higher-tier claim` }
        }
      }
    }

    // ── Layer 6: Roll-up ─────────────────────────────────────────────────────
    const rollup = rollupConfidence(leafResults)
    const verifiedClaims = leafResults.filter(r => r.claim).map(r => r.claim!)
    const abstainedCount = leafResults.filter(r => r.abstained).length

    if (rollup.coverage < coverageThreshold) {
      yield {
        type: 'research_step', phase: 'synthesize',
        detail: `Low coverage (${(rollup.coverage * 100).toFixed(0)}% of sub-questions verified) — answer will be partial`,
      }
    }

    // ── Final synthesis (constrained) ────────────────────────────────────────
    yield { type: 'research_step', phase: 'synthesize', claimsFound: verifiedClaims.length }

    if (verifiedClaims.length === 0) {
      clearScratch(taskId)
      yield {
        type: 'research_done',
        text: buildAbstainedAnswer(question, leafResults),
        sources: webPagesUsed.count,
        confidence: 0,
      }
      return
    }

    const factsList = verifiedClaims.map(vc => vc.claim)
    const raw = await groundedSynthesis(question, factsList, fmCall)

    // ── Premise-grounding gate (Bug A) ──────────────────────────────────────
    // A false-premise question ("...purchase Alaska from Canada?") makes synthesis
    // parrot the embedded claim, and token-overlap grounding below can't catch it
    // (the parroted sentence still overlaps the true fact's tokens). Before trusting
    // the synthesized answer, classify — using ONLY the verified facts — whether those
    // facts contradict a premise the question presupposes. If they do, replace the
    // answer with the evidence-grounded correction. This is a verification/control-flow
    // gate, not a "be skeptical" instruction: the FM is a classifier here, and the
    // correction text comes from the verified facts.
    //
    // Gated by isPremiseBearing first (Bug: explain-category regression): running the
    // full check unconditionally on every question made the FM invent contradictions
    // for ordinary "explain how X works" questions with no embedded claim, overwriting
    // good synthesized answers. Only myth/trivia-shaped questions reach the full check.
    let premiseCorrection = ''
    try {
      const risk = await isPremiseBearing(question, fmCall)
      if (risk.bearsClaim) {
        const premise = await checkPremiseGrounding(question, factsList, fmCall)
        if (premise.contradicted && premise.confidence >= 0.6) {
          premiseCorrection = premise.correction.trim()
          debugBus.emit('pipeline', 'research_premise_corrected', {
            question: question.slice(0, 80), confidence: premise.confidence,
            correction: premiseCorrection.slice(0, 120),
          }, { severity: 'success' })
        }
      }
    } catch (e: any) {
      debugBus.emit('pipeline', 'research_premise_check_fail', {
        reason: String(e?.message ?? e).slice(0, 80),
      }, { severity: 'warn' })
    }

    // Post-synthesis grounding check — cut sentences without verified-claim backing.
    // When the premise was contradicted, the synthesized answer parrots a false claim,
    // so discard it and lead with the correction instead.
    const { grounded, cut } = filterGroundedSentences(raw, verifiedClaims)
    const answer = premiseCorrection
      ? premiseCorrection
      : grounded.join(' ').trim()

    if (cut.length > 0) {
      debugBus.emit('pipeline', 'research_synthesis_pruned', {
        cutCount: cut.length, retained: grounded.length,
      }, { severity: 'info' })
    }

    // Build sources citation
    const allSources = [...new Set(leafResults.flatMap(r => r.sources))].slice(0, 8)

    // Build confidence header
    const confHeader = buildConfidenceHeader(rollup, abstainedCount, leafResults.length, verifiedClaims)

    // Build quote attributions for high-tier claims
    const provenanceBlock = buildProvenanceBlock(verifiedClaims)

    // Plain mode (conversational path, no explicit sources request): drop the
    // confidence header, evidence block, and *Sources* line — a full-tier
    // factual answer should read as a plain sentence, not a robotic report.
    // The confidence/tier still ride out on the `research_done` event fields
    // for callers that want them programmatically.
    const finalAnswer = (verbose
      ? [
          confHeader,
          answer || 'The retrieved evidence supported the following verified facts:',
          factsList.length > 0 && !answer ? '\n' + factsList.map(f => `• ${f}`).join('\n') : '',
          provenanceBlock,
          allSources.length ? `\n*Sources: ${allSources.join(', ')}*` : '',
        ]
      : [
          answer || 'The retrieved evidence supported the following verified facts:',
          factsList.length > 0 && !answer ? '\n' + factsList.map(f => `• ${f}`).join('\n') : '',
        ]
    ).filter(Boolean).join('\n\n').trim()

    clearScratch(taskId)

    yield {
      type: 'research_done',
      text: finalAnswer,
      sources: webPagesUsed.count,
      confidence: rollup.overallConfidence,
    }

  } catch (e: any) {
    clearScratch(taskId)
    yield { type: 'research_error', text: `Research DAG failed: ${e?.message ?? e}` }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildAbstainedAnswer(question: string, results: LeafResult[]): string {
  const reasons = results
    .filter(r => r.abstainReason)
    .map(r => `• ${r.question.slice(0, 60)}: ${r.abstainReason}`)
    .slice(0, 5)
  return [
    `[Abstained] The research DAG could not verify a confident answer to: "${question.slice(0, 120)}"`,
    reasons.length ? '\nReasons:\n' + reasons.join('\n') : '',
    '\nThe sources retrieved did not contain verifiable evidence meeting the oracle cascade requirements.',
    'Consider rephrasing the question or checking source availability.',
  ].join('')
}

function buildConfidenceHeader(
  rollup: RollupResult,
  abstainedCount: number,
  total: number,
  claims: VerifiedClaim[],
): string {
  const pct = (rollup.overallConfidence * 100).toFixed(0)
  const tier = rollup.lowestTier
  const covPct = (rollup.coverage * 100).toFixed(0)
  const tierLabel: Record<VerificationTier, string> = {
    'executable': 'ORACLE-VERIFIED',
    'verbatim-provenance': 'SOURCE-QUOTED',
    'cross-derived': 'CROSS-DERIVED',
    'corroborated': 'CORROBORATED',
    'unverified': 'UNVERIFIED',
  }
  let header = `[${tierLabel[tier]} · ${pct}% confidence · ${covPct}% coverage`
  if (abstainedCount > 0) header += ` · ${abstainedCount}/${total} sub-questions abstained`
  header += ']'
  return header
}

function buildProvenanceBlock(claims: VerifiedClaim[]): string {
  const lines: string[] = []
  for (const vc of claims) {
    if (vc.tier === 'verbatim-provenance' && vc.evidence.quote && vc.evidence.url) {
      lines.push(`> "${vc.evidence.quote.slice(0, 120)}" — ${vc.evidence.url}`)
    } else if (vc.tier === 'executable' && vc.evidence.execResult) {
      lines.push(`> Computed: ${vc.evidence.execResult}`)
    }
  }
  if (!lines.length) return ''
  return '\n**Evidence:**\n' + lines.join('\n')
}
