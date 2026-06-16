// ============================================================
// CRUCIBLE — Knowledge Base & Scoring Engine Types
// Runs entirely on-device. No API calls. No external deps.
// ============================================================

export type PatternCategory =
  | "algorithm"
  | "data-structure"
  | "design-pattern"
  | "error-handling"
  | "async-pattern"
  | "architecture"
  | "performance"
  | "security";

export type ComplexityClass = "O(1)" | "O(log n)" | "O(n)" | "O(n log n)" | "O(n²)" | "O(2^n)";

// A single gold standard entry in the knowledge base
export interface KnowledgeEntry {
  id: string;
  name: string;
  category: PatternCategory;
  description: string;
  tags: string[];
  // Structural fingerprint — derived from AST, not raw source
  // Stored as a normalized token sequence for comparison
  structuralTokens: string[];
  // Known antipatterns this entry guards against
  antipatterns: string[];
  // Complexity characteristics
  timeComplexity?: ComplexityClass;
  spaceComplexity?: ComplexityClass;
  // What makes this gold standard
  qualitySignals: QualitySignal[];
  // Source tier: 1=hand-curated, 2=crucible-approved, 3=imported-reference
  tier: 1 | 2 | 3;
  // Approval metadata for tier 2 entries
  approvedAt?: number;
  approvedBy?: "human";
  // How many pipeline runs have referenced this entry
  hitCount: number;
}

export interface QualitySignal {
  name: string;
  description: string;
  weight: number; // 0–1
}

// What gets submitted to the scoring engine
export interface ScoringInput {
  // The proposed implementation as raw source
  proposedSource: string;
  // What problem it's trying to solve
  problemStatement: string;
  // Language hint — defaults to TypeScript
  language?: string;
  // Previous iteration scores if this is a refinement pass
  priorScores?: CompositeScore[];
  // Which pipeline layer submitted this
  pipelineLayer?: 1 | 2 | 3 | 4;
  // Prompt classification — drives context-aware scoring thresholds
  promptType?: 'coding' | 'reasoning' | 'math' | 'creative' | 'factual' | 'general';
  // The contract generated for this pipeline run — drives contract-aware scoring
  contract?: {
    requiredStructure: string[];
    forbiddenAntipatterns: string[];
    qualityGates: string[];
    promptType: string;
    promptRequirements?: string[];
    evaluationCriteria?: Array<{ concept: string; keywords: string[]; required: boolean }>;
  };
}

// The full scoring result
export interface CompositeScore {
  // 0–1 how close to a known gold standard structure
  similarityScore: number;
  // 0–1 does it functionally solve the problem
  functionalScore: number;
  // 0–1 distance from library AND high functional score
  noveltyScore: number;
  // Weighted composite of the three
  compositeScore: number;
  // Triggers surprise bonus weighting
  isSurpriseCandidate: boolean;
  // Specific issues found — fed back to models as plain language critique
  critiques: Critique[];
  // Which knowledge base entries were most similar
  closestMatches: ClosestMatch[];
  // Whether this passed the quality threshold
  passedThreshold: boolean;
  // Iteration number (max 3 before escalating to full pipeline)
  iteration: number;
  timestamp: number;
}

export interface Critique {
  severity: "blocking" | "major" | "minor" | "suggestion";
  category: "correctness" | "pattern" | "antipattern" | "edge-case" | "complexity" | "novelty";
  message: string; // Plain English, fed directly to models
  // If this matches a known antipattern, which one
  antipatternRef?: string;
}

export interface ClosestMatch {
  entryId: string;
  entryName: string;
  similarityScore: number;
  // What specifically matched
  matchedTokens: string[];
}

// Scoring config — tunable without code changes
export interface ScoringConfig {
  weights: {
    similarity: number;   // default 0.35
    functional: number;   // default 0.45
    novelty: number;      // default 0.20
  };
  thresholds: {
    pass: number;         // default 0.65 — composite score to pass
    noveltyBonus: number; // default 0.75 — novelty score to trigger surprise bonus
    blockingCritique: number; // default 0.30 — functional score below this = blocking
  };
  maxLocalIterations: number; // default 3
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  weights: {
    similarity: 0.35,
    functional: 0.45,
    novelty: 0.20,
  },
  thresholds: {
    pass: 0.55,
    noveltyBonus: 0.75,
    blockingCritique: 0.30,
  },
  maxLocalIterations: 3,
};
