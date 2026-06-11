// ============================================================
// CRUCIBLE — Scoring Engine
// The weighted intelligence layer. Runs on-device.
// No API calls. No external deps. Deterministic.
// ============================================================

import { tokenizeSource, tokenSimilarity } from "./tokenizer";
import { TIER_1_ENTRIES } from "./knowledge-base";
import type {
  ScoringInput,
  CompositeScore,
  Critique,
  ClosestMatch,
  KnowledgeEntry,
  ScoringConfig,
  // DEFAULT_SCORING_CONFIG,
} from "./types";

// In-memory knowledge base — tier 2 and 3 entries appended at runtime
let knowledgeBase: KnowledgeEntry[] = [...TIER_1_ENTRIES];

export function loadAdditionalEntries(entries: KnowledgeEntry[]): void {
  knowledgeBase = [...TIER_1_ENTRIES, ...entries];
}

export function addApprovedEntry(entry: KnowledgeEntry): void {
  // Only tier 2 entries (crucible-approved) can be added at runtime
  if (entry.tier !== 2) throw new Error("Only tier 2 entries can be added at runtime");
  knowledgeBase.push(entry);
}

// ── FUNCTIONAL SCORE ────────────────────────────────────────
// Rule-based. Does this code do what it claims? Penalises antipatterns.

function computeFunctionalScore(
  _source: string,
  antipatterns: Array<{ name: string; severity: "blocking" | "major" | "minor" }>,
  tokenResult: ReturnType<typeof tokenizeSource>,
  promptType: string = 'general'
): { score: number; critiques: Critique[] } {
  const critiques: Critique[] = [];
  let score = 0.7; // Start at 0.7, adjust from here

  // Antipattern penalties
  for (const ap of antipatterns) {
    if (ap.severity === "blocking") {
      score -= 0.35;
      critiques.push({
        severity: "blocking",
        category: "antipattern",
        message: `Blocking antipattern detected: ${ap.name}. This must be resolved before the implementation can be accepted.`,
        antipatternRef: ap.name,
      });
    } else if (ap.severity === "major") {
      score -= 0.15;
      critiques.push({
        severity: "major",
        category: "antipattern",
        message: `Major antipattern detected: ${ap.name}. This will cause reliability or correctness issues.`,
        antipatternRef: ap.name,
      });
    } else {
      score -= 0.05;
      critiques.push({
        severity: "minor",
        category: "antipattern",
        message: `Minor antipattern detected: ${ap.name}. Consider addressing this for production quality.`,
        antipatternRef: ap.name,
      });
    }
  }

  // Positive signals
  if (tokenResult.hasErrorHandling) score += 0.08;
  if (tokenResult.hasTypeAnnotations) score += 0.06;
  if (tokenResult.hasAsyncAwait && tokenResult.hasErrorHandling) score += 0.05;

  // Prompt-type-aware length check
  // coding/math: short responses are suspicious — require substance
  // factual/general/creative: short responses are often correct — skip penalty
  const codeIntensiveTypes = ['coding', 'math', 'reasoning']
  const isCodeIntensive = codeIntensiveTypes.includes(promptType)
  if (isCodeIntensive && tokenResult.lineCount < 5) {
    score -= 0.2;
    critiques.push({
      severity: "major",
      category: "correctness",
      message: "Implementation appears incomplete — fewer than 5 lines of substantive code.",
    });
  }

  // Penalise extremely long implementations without structure signals
  if (tokenResult.lineCount > 200 && tokenResult.structuralTokens.length < 3) {
    score -= 0.1;
    critiques.push({
      severity: "minor",
      category: "complexity",
      message: "Implementation is long but shows few recognisable structural patterns. Consider decomposing into smaller units.",
    });
  }

  return { score: Math.max(0, Math.min(1, score)), critiques };
}

// ── SIMILARITY SCORE ────────────────────────────────────────
// How close is this to a known gold standard?

function computeSimilarityScore(
  proposedTokens: string[],
  _problemStatement: string
): { score: number; closestMatches: ClosestMatch[]; critiques: Critique[] } {
  const critiques: Critique[] = [];
  const matches: ClosestMatch[] = [];

  // Find most similar knowledge base entries
  for (const entry of knowledgeBase) {
    const sim = tokenSimilarity(proposedTokens, entry.structuralTokens);
    if (sim > 0.15) { // Only track meaningful similarities
      matches.push({
        entryId: entry.id,
        entryName: entry.name,
        similarityScore: sim,
        matchedTokens: proposedTokens.filter((t) => entry.structuralTokens.includes(t)),
      });
      // Increment hit count for this entry
      entry.hitCount++;
    }
  }

  // Sort by similarity, keep top 3
  matches.sort((a, b) => b.similarityScore - a.similarityScore);
  const top3 = matches.slice(0, 3);

  const bestSim = top3[0]?.similarityScore ?? 0;

  // If similarity is high, check for missing quality signals
  if (bestSim > 0.6) {
    const bestEntry = knowledgeBase.find((e) => e.id === top3[0].entryId)!;
    for (const signal of bestEntry.qualitySignals) {
      // Simple heuristic: if the signal name is mentioned in source/tokens, it's likely present
      const signalPresent = proposedTokens.some((t) =>
        t.includes(signal.name.split("-")[0])
      );
      if (!signalPresent && signal.weight > 0.3) {
        critiques.push({
          severity: "suggestion",
          category: "pattern",
          message: `This looks like a ${bestEntry.name} implementation. Consider ensuring: ${signal.description}`,
        });
      }
    }
  }

  return {
    score: bestSim,
    closestMatches: top3,
    critiques,
  };
}

// ── NOVELTY SCORE ────────────────────────────────────────────
// Genuinely different from everything in library + functionally sound = valuable

function computeNoveltyScore(
  similarityScore: number,
  functionalScore: number
): number {
  // Novelty = distance from library (1 - similarity) weighted by functional quality
  // Low similarity alone is not novelty — it might just be bad code.
  // High distance + high functional score = genuinely interesting.
  const distance = 1 - similarityScore;
  return distance * functionalScore;
}

// ── CONTRACT COMPLIANCE SCORE ───────────────────────────────
// Scores the response against the pipeline contract requirements.
// This is the primary quality signal — prompt-type aware.

function computeContractScore(
  source: string,
  contract: { requiredStructure: string[]; forbiddenAntipatterns: string[]; qualityGates: string[]; promptType: string } | undefined,
  promptType: string
): { score: number; critiques: Critique[] } {
  if (!contract) return { score: 0.5, critiques: [] }

  const critiques: Critique[] = []
  const lower = source.toLowerCase()
  let score = 0.5 // neutral baseline

  // ── Required structure checks ─────────────────────────────
  const structureHeuristics: Record<string, RegExp[]> = {
    'explicit error handling':     [/try\s*\{/, /\.catch\(/, /except\s/, /rescue\s/, /Result|Either/],
    'type annotations':            [/:\s*(str|int|float|bool|list|dict|tuple|None)\b/, /:\s*(string|number|boolean|void)\b/, /interface |type /, /->\s*\w/],
    'named constants':             [/[A-Z_]{2,}\s*=/, /const\s+[A-Z]/, /final\s+[A-Z]/],
    'single responsibility':       [/def\s+\w+\(/, /function\s+\w+\(/, /const\s+\w+\s*=\s*\(/, /=>\s*\{/],
    'edge case':                   [/if.*null|if.*none|if.*empty|if.*undefined/, /\.length\s*===?\s*0/, /len\(.*\)\s*==\s*0/],
    'step-by-step':                [/step\s+\d|first,|second,|then,|finally,/i],
    'structured argument':         [/therefore|because|however|in contrast/i],
    'direct answer':               [/\w{3,}/],
    'supporting reasoning':        [/because|since|therefore|this means|as a result/i],
    'clear narrative':             [/\w[\s\S]{100,}\w/],
    'code block':                  [/```[\s\S]*```/, /~~~/, /^\s{4}\w/m],
    'function definition':         [/def\s+\w+|function\s+\w+|const\s+\w+\s*=|=>\s*\{/],
    'return value':                [/\breturn\b/, /\byield\b/],
    'loop or iteration':           [/\bfor\b|\bwhile\b|\.map\(|\.forEach\(|\.reduce\(/],
    'variable assignment':         [/\blet\b|\bconst\b|\bvar\b|\w+\s*=\s*\w+/],
  }

  let structureHits = 0
  for (const req of contract.requiredStructure) {
    const reqLower = req.toLowerCase()
    let matched = false
    for (const [key, patterns] of Object.entries(structureHeuristics)) {
      if (reqLower.includes(key)) {
        if (patterns.some(p => p.test(source))) {
          structureHits++
          matched = true
          break
        }
      }
    }
    if (!matched) {
      // Generic fallback: look for keywords from the requirement in the source
      const keywords = reqLower.split(/\s+/).filter(w => w.length > 4)
      if (keywords.some(kw => lower.includes(kw))) {
        structureHits++
      } else {
        critiques.push({
          severity: 'major',
          category: 'correctness',
          message: `Missing required element: ${req}`,
        })
      }
    }
  }

  const structureRatio = contract.requiredStructure.length > 0
    ? structureHits / contract.requiredStructure.length
    : 1.0
  score += structureRatio * 0.35

  // ── Forbidden antipattern checks ─────────────────────────
  const forbiddenHeuristics: Record<string, RegExp> = {
    'swallowed errors':           /catch\s*\([^)]*\)\s*\{\s*\}|except\s*:\s*pass/,
    'innerHTML':                  /innerHTML\s*=\s*.*(?:req\.|user|input)/i,
    'infinite retry':             /while\s*(?:true|1)\s*\{.*retry/is,
    'fabricated citations':       /\[\d+\]|\(source:|\(citation/i,
    'padding without substance':  /^[\s\S]{0,30}$/m,
    'telling instead of showing': /it feels|one might say|you could imagine/i,
    'skipping derivation':        /obviously|clearly|trivially|it is easy to show/i,
  }

  for (const forbidden of contract.forbiddenAntipatterns) {
    const forbLower = forbidden.toLowerCase()
    for (const [key, pattern] of Object.entries(forbiddenHeuristics)) {
      if (forbLower.includes(key.split(' ')[0]) && pattern.test(source)) {
        score -= 0.15
        critiques.push({
          severity: 'blocking',
          category: 'antipattern',
          message: `Forbidden pattern detected: ${forbidden}`,
        })
        break
      }
    }
  }

  // ── Quality gate: minimum substance ──────────────────────
  const lineCount = source.split('\n').filter(l => l.trim().length > 0).length
  const isCodeType = ['coding', 'math'].includes(promptType)
  if (isCodeType && lineCount < 5) {
    score -= 0.2
    critiques.push({ severity: 'major', category: 'correctness', message: 'Response too short — insufficient code substance.' })
  } else if (!isCodeType && source.trim().length < 50) {
    score -= 0.15
    critiques.push({ severity: 'major', category: 'correctness', message: 'Response too short to adequately address the question.' })
  }

  return { score: Math.max(0, Math.min(1, score)), critiques }
}

// ── MAIN SCORING FUNCTION ────────────────────────────────────

export function score(
  input: ScoringInput,
  config: ScoringConfig,
  iteration: number = 1
): CompositeScore {
  const tokenResult = tokenizeSource(input.proposedSource);

  const functional = computeFunctionalScore(
    input.proposedSource,
    tokenResult.detectedAntipatterns,
    tokenResult,
    input.promptType ?? 'general'
  );

  const similarity = computeSimilarityScore(
    tokenResult.structuralTokens,
    input.problemStatement
  );

  const noveltyScore = computeNoveltyScore(
    similarity.score,
    functional.score
  );

  // Contract compliance — primary signal
  const contractResult = computeContractScore(
    input.proposedSource,
    input.contract,
    input.promptType ?? 'general'
  )
  // Weighted composite — contract drives the score, knowledge base is a bonus
  const hasKnowledgeMatch = similarity.score > 0.15
  const similarityWeight = hasKnowledgeMatch ? 0.10 : 0
  const contractWeight   = 0.50
  const functionalWeight = 0.30
  const noveltyWeight    = 0.10

  const compositeScore =
    contractResult.score   * contractWeight  +
    functional.score       * functionalWeight +
    noveltyScore           * noveltyWeight   +
    similarity.score       * similarityWeight;

  // Surprise candidate: high novelty AND high functional AND meaningfully different from prior rounds
  const isSurpriseCandidate =
    noveltyScore >= config.thresholds.noveltyBonus &&
    functional.score >= 0.7;

  const allCritiques = [...functional.critiques, ...similarity.critiques];
  const allCritiquesWithContract = [...allCritiques, ...contractResult.critiques];

  // If composite is low, add a top-level summary critique for the models to act on
  if (compositeScore < config.thresholds.pass && allCritiquesWithContract.length === 0) {
    allCritiques.push({
      severity: "major",
      category: "correctness",
      message: `Overall quality score is ${(compositeScore * 100).toFixed(0)}/100. The implementation needs improvement across multiple dimensions. Focus on: establishing clear structural patterns, handling error cases explicitly, and ensuring edge cases are considered.`,
    });
  }

  return {
    similarityScore: similarity.score,
    functionalScore: functional.score,
    noveltyScore,
    compositeScore,
    isSurpriseCandidate,
    critiques: allCritiquesWithContract,
    closestMatches: similarity.closestMatches,
    passedThreshold: compositeScore >= config.thresholds.pass,
    iteration,
    timestamp: Date.now(),
  };
}

// ── CRITIQUE FORMATTER ───────────────────────────────────────
// Converts score output into plain English for model consumption

export function formatCritiqueForModel(scored: CompositeScore): string {
  const lines: string[] = [];

  lines.push(`Quality Score: ${(scored.compositeScore * 100).toFixed(0)}/100`);
  lines.push(`  Structural pattern match: ${(scored.similarityScore * 100).toFixed(0)}%`);
  lines.push(`  Functional correctness:   ${(scored.functionalScore * 100).toFixed(0)}%`);
  lines.push(`  Novelty score:            ${(scored.noveltyScore * 100).toFixed(0)}%`);

  if (scored.closestMatches.length > 0) {
    lines.push(`\nClosest known patterns: ${scored.closestMatches.map((m) => m.entryName).join(", ")}`);
  }

  if (scored.isSurpriseCandidate) {
    lines.push(`\n⭐ This implementation shows genuine novelty with high functional quality. Preserve this approach.`);
  }

  if (scored.critiques.length > 0) {
    lines.push(`\nIssues to address:`);
    const blocking = scored.critiques.filter((c) => c.severity === "blocking");
    const major = scored.critiques.filter((c) => c.severity === "major");
    const minor = scored.critiques.filter((c) => c.severity === "minor");
    const suggestions = scored.critiques.filter((c) => c.severity === "suggestion");

    for (const c of blocking) lines.push(`  🚫 BLOCKING: ${c.message}`);
    for (const c of major)    lines.push(`  ⚠️  MAJOR: ${c.message}`);
    for (const c of minor)    lines.push(`  ℹ️  MINOR: ${c.message}`);
    for (const c of suggestions) lines.push(`  💡 SUGGESTION: ${c.message}`);
  }

  if (scored.passedThreshold) {
    lines.push(`\n✅ Implementation passed quality threshold.`);
  } else {
    lines.push(`\n❌ Implementation did not pass threshold. Refine and resubmit.`);
    lines.push(`   Iteration ${scored.iteration} of 3. After 3 iterations this escalates to the full multi-model debate.`);
  }

  return lines.join("\n");
}

// ── ITERATION MANAGER ────────────────────────────────────────
// Manages the local refinement loop before escalating to models

export interface IterationResult {
  shouldEscalate: boolean;   // true = send to full pipeline
  shouldAccept: boolean;     // true = passed, move on
  score: CompositeScore;
  critiqueText: string;
}

export function evaluateIteration(
  input: ScoringInput,
  config: ScoringConfig,
  iteration: number
): IterationResult {
  const scored = score(input, config, iteration);
  const critiqueText = formatCritiqueForModel(scored);

  const shouldAccept = scored.passedThreshold;
  const shouldEscalate = !shouldAccept && iteration >= config.maxLocalIterations;

  return { shouldEscalate, shouldAccept, score: scored, critiqueText };
}
