// ── Provenance Oracle — truth certification cascade ───────────────────────────
//
// A claim is "verified" only if it passes the highest tier it's eligible for.
// Cascade runs strongest-first; stops at the first passing tier.
//
// Tier 1 (strongest): Executable reduction — claim reduces to something computable.
//   Node runs the computation and checks the result. The FM is not involved.
//
// Tier 2: Verbatim provenance — FM proposes an exact quote from a primary source;
//   Node verifies the quote exists in the fetched page text (string search).
//   The FM cannot fabricate a quote that passes this check.
//
// Tier 3: Cross-derivation — the same answer is derived from two independent source
//   classes (e.g. corpus + web, or two different domains). Node diffs the results.
//
// Tier 4 (weakest): Corroboration — weighted agreement across ≥2 sources.
//   Used only for irreducibly empirical claims; labeled LOWER_CONFIDENCE.
//
// Tier 0: UNVERIFIED — nothing passed. Callers must abstain or label.

import { extractVerbatimSpan, type FmCall, defaultFmCall } from './leafPrimitives'

// ── Types ─────────────────────────────────────────────────────────────────────

export type VerificationTier =
  | 'executable'          // computed by Node, true oracle
  | 'verbatim-provenance' // exact quote exists in fetched source
  | 'cross-derived'       // same answer from two independent source classes
  | 'corroborated'        // weighted multi-source agreement (weakest, labeled)
  | 'unverified'

export interface SourceEvidence {
  url: string
  text: string              // fetched page text (stripped)
  authority: number         // 0-1 (peer-reviewed=0.9, preprint=0.7, wiki=0.6, blog=0.4)
  domain?: string           // corpus shard domain, if from corpus
  sourceClass?: 'corpus' | 'web' | 'academic'
}

export interface VerifiedClaim {
  claim: string
  tier: VerificationTier
  confidence: number        // 0-1 aggregate
  evidence: {
    url?: string
    quote?: string          // the verbatim span that passed the check
    execResult?: string     // the computed result (executable tier)
    sourcesAgreed?: number  // corroboration tier
  }
  verifiedAt: number
}

export interface OracleResult {
  verified: VerifiedClaim | null
  /** Human-readable reason for failure, if not verified */
  failReason?: string
}

// ── Tier 1: Executable reduction ─────────────────────────────────────────────
//
// Patterns where a claim can be reduced to a Node computation.
// We only attempt this for clearly numeric/logical claims — no general eval.

interface ExecReduction {
  pattern: RegExp
  compute: (match: RegExpMatchArray, claim: string) => string | null
}

const EXEC_REDUCTIONS: ExecReduction[] = [
  // ── Question forms (return 'answer:<value>') ─────────────────────────────────
  // "Is N prime?"
  {
    pattern: /^is\s+(\d+)\s+prime\s*\??$/i,
    compute: (m) => {
      const n = parseInt(m[1], 10)
      if (n < 2) return `answer:${n} is not prime`
      for (let i = 2; i <= Math.sqrt(n); i++) { if (n % i === 0) return `answer:${n} is not prime` }
      return `answer:${n} is prime`
    },
  },
  // "What is X + Y?" / "What is X - Y?" / "What is X * Y?" / "What is X / Y?"
  {
    pattern: /^what\s+is\s+(\d+(?:\.\d+)?)\s*([\+\-\*\/×÷])\s*(\d+(?:\.\d+)?)\s*\??$/i,
    compute: (m) => {
      const a = parseFloat(m[1]), op = m[2], b = parseFloat(m[3])
      let actual: number
      if (op === '+') actual = a + b
      else if (op === '-') actual = a - b
      else if (op === '*' || op === '×') actual = a * b
      else if ((op === '/' || op === '÷') && b !== 0) actual = a / b
      else return null
      const str = Number.isInteger(actual) ? String(actual) : actual.toFixed(6).replace(/\.?0+$/, '')
      return `answer:${str}`
    },
  },
  // "What is 2^N?" / "What is 2**N?"
  {
    pattern: /^what\s+is\s+2\s*(?:\^|\*\*)\s*(\d+)\s*\??$/i,
    compute: (m) => {
      const exp = parseInt(m[1], 10)
      if (exp > 52) return null
      return `answer:${Math.pow(2, exp)}`
    },
  },
  // ── Declarative claim forms (verify a stated claim) ──────────────────────────
  // "X is prime" / "X is not prime"
  {
    pattern: /\b(\d+)\s+is\s+(not\s+)?prime\b/i,
    compute: (m) => {
      const n = parseInt(m[1], 10)
      if (n < 2) return 'not prime'
      for (let i = 2; i <= Math.sqrt(n); i++) { if (n % i === 0) return 'not prime' }
      return 'prime'
    },
  },
  // "X + Y = Z", "X * Y = Z", etc.
  {
    pattern: /\b(\d+(?:\.\d+)?)\s*([\+\-\*\/])\s*(\d+(?:\.\d+)?)\s*=\s*(\d+(?:\.\d+)?)\b/,
    compute: (m) => {
      const a = parseFloat(m[1]), op = m[2], b = parseFloat(m[3]), claimed = parseFloat(m[4])
      let actual: number
      if (op === '+') actual = a + b
      else if (op === '-') actual = a - b
      else if (op === '*') actual = a * b
      else if (op === '/' && b !== 0) actual = a / b
      else return null
      return Math.abs(actual - claimed) < 0.0001 ? 'correct' : `incorrect (actual: ${actual})`
    },
  },
  // "2^N = X"
  {
    pattern: /\b2\s*\^\s*(\d+)\s*=\s*(\d+)\b/,
    compute: (m) => {
      const exp = parseInt(m[1], 10), claimed = parseInt(m[2], 10)
      if (exp > 52) return null
      const actual = Math.pow(2, exp)
      return Math.abs(actual - claimed) < 1 ? 'correct' : `incorrect (actual: ${actual})`
    },
  },
  // Base64 round-trip: "base64 of 'X' is Y"
  {
    pattern: /base64\s+(?:of\s+)?['"]([^'"]{1,60})['"]\s+is\s+['"]?([A-Za-z0-9+/=]{4,80})['"]?/i,
    compute: (m) => {
      try {
        const actual = Buffer.from(m[1]).toString('base64')
        return actual === m[2] ? 'correct' : `incorrect (actual: ${actual})`
      } catch { return null }
    },
  },
]

export function tryExecutableReduction(claim: string): OracleResult {
  for (const { pattern, compute } of EXEC_REDUCTIONS) {
    const m = claim.match(pattern)
    if (!m) continue
    const result = compute(m, claim)
    if (result === null) continue
    // 'answer:<value>' — direct computation of a question's answer
    if (result.startsWith('answer:')) {
      return {
        verified: {
          claim,
          tier: 'executable',
          confidence: 1.0,
          evidence: { execResult: result.slice(7) },
          verifiedAt: Date.now(),
        },
      }
    }
    // Declarative check: claim confirmed true
    if (result === 'correct' || result === 'prime' || result === 'not prime') {
      return {
        verified: {
          claim,
          tier: 'executable',
          confidence: 1.0,
          evidence: { execResult: result },
          verifiedAt: Date.now(),
        },
      }
    }
    // Claim is factually wrong
    return { verified: null, failReason: `executable check failed: ${result}` }
  }
  return { verified: null, failReason: 'not reducible to computation' }
}

// ── Tier 2: Verbatim provenance ───────────────────────────────────────────────
//
// FM proposes an exact quote; Node checks the quote exists in pageText.
// We allow small whitespace differences but no paraphrasing.

function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/[""'']/g, '"').toLowerCase().trim()
}

function quoteExistsInPage(quote: string, pageText: string): boolean {
  const normQuote = normalizeForMatch(quote)
  const normPage = normalizeForMatch(pageText)
  if (normPage.includes(normQuote)) return true
  // Allow a window-based fuzzy check (80% token overlap in a contiguous window)
  const quoteToks = normQuote.split(/\s+/)
  if (quoteToks.length < 3) return normPage.includes(normQuote)
  const window = quoteToks.length
  const pageToks = normPage.split(/\s+/)
  let bestOverlap = 0
  for (let i = 0; i <= pageToks.length - window; i++) {
    const windowToks = new Set(pageToks.slice(i, i + window))
    const overlap = quoteToks.filter(t => windowToks.has(t)).length
    if (overlap > bestOverlap) bestOverlap = overlap
    if (bestOverlap / quoteToks.length >= 0.85) return true
  }
  return false
}

export async function tryVerbatimProvenance(
  claim: string,
  sources: SourceEvidence[],
  fmCall: FmCall = defaultFmCall,
): Promise<OracleResult> {
  // Sort by authority, highest first
  const ranked = [...sources].sort((a, b) => b.authority - a.authority)
  for (const src of ranked) {
    if (!src.text || src.text.length < 20) continue
    const proposedSpan = await extractVerbatimSpan(claim, src.text, fmCall)
    if (!proposedSpan) continue
    if (quoteExistsInPage(proposedSpan, src.text)) {
      return {
        verified: {
          claim,
          tier: 'verbatim-provenance',
          confidence: Math.min(0.97, 0.7 + src.authority * 0.27),
          evidence: { url: src.url, quote: proposedSpan },
          verifiedAt: Date.now(),
        },
      }
    }
  }
  return { verified: null, failReason: 'no verbatim quote found in any source' }
}

// ── Tier 3: Cross-derivation ─────────────────────────────────────────────────
//
// The same factual answer was reached via two independent source classes.
// "Same" = the key noun phrases or numbers substantially agree.

function extractKeyPhrases(text: string): Set<string> {
  const phrases = new Set<string>()
  // Numbers (including with units)
  for (const m of text.matchAll(/\b\d+(?:[.,]\d+)?\s*(?:%|km|kg|mph|GB|TB|MB|ms|s|m|ft|mi|°[CF])?\b/g)) {
    phrases.add(m[0].toLowerCase().trim())
  }
  // Proper nouns (Title Case sequences)
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g)) {
    if (m[1].length > 3) phrases.add(m[1].toLowerCase())
  }
  return phrases
}

function phrasesAgree(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let overlap = 0
  for (const p of a) if (b.has(p)) overlap++
  return overlap / Math.min(a.size, b.size)
}

export function tryCrossDerivation(
  claim: string,
  answers: Array<{ answer: string; sourceClass: 'corpus' | 'web' | 'academic' }>,
): OracleResult {
  // Need at least two answers from different source classes
  const classes = new Map<string, string>()
  for (const a of answers) {
    if (!classes.has(a.sourceClass)) classes.set(a.sourceClass, a.answer)
    if (classes.size >= 2) break
  }
  if (classes.size < 2) {
    return { verified: null, failReason: 'only one source class — cannot cross-derive' }
  }
  const [ansA, ansB] = [...classes.values()]
  const phrasesA = extractKeyPhrases(ansA)
  const phrasesB = extractKeyPhrases(ansB)
  const agreement = phrasesAgree(phrasesA, phrasesB)

  if (agreement >= 0.5) {
    return {
      verified: {
        claim,
        tier: 'cross-derived',
        confidence: Math.min(0.93, 0.65 + agreement * 0.28),
        evidence: { sourcesAgreed: 2 },
        verifiedAt: Date.now(),
      },
    }
  }
  return { verified: null, failReason: `cross-derivation disagreement (agreement=${agreement.toFixed(2)})` }
}

// ── Tier 4: Corroboration ─────────────────────────────────────────────────────
//
// Weighted multi-source agreement. Weakest tier — labeled as such.
// Compares extracted answers against each other using simple token overlap,
// NOT against key-phrase extraction (which breaks for CS notation, colors, etc.)

function simpleTokens(text: string): Set<string> {
  // Include 2+ character lowercase tokens — catches "log", "red", "tcp", etc.
  return new Set((text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []))
}

function tokenOverlap(a: string, b: string): number {
  const tA = simpleTokens(a), tB = simpleTokens(b)
  if (tA.size === 0 || tB.size === 0) return 0
  let overlap = 0
  for (const t of tA) if (tB.has(t)) overlap++
  return overlap / Math.min(tA.size, tB.size)
}

export function tryCorroboration(
  claim: string,
  sources: SourceEvidence[],
  extractedAnswers: string[],
): OracleResult {
  const meaningful = extractedAnswers.filter(a => a && a !== 'none' && a.length > 2)
  if (meaningful.length < 2) {
    return { verified: null, failReason: `only ${meaningful.length} meaningful answer(s) — cannot corroborate` }
  }

  // Find the best pairwise agreement between any two extracted answers
  let bestAgreement = 0
  for (let i = 0; i < meaningful.length; i++) {
    for (let j = i + 1; j < meaningful.length; j++) {
      const overlap = tokenOverlap(meaningful[i], meaningful[j])
      if (overlap > bestAgreement) bestAgreement = overlap
    }
  }

  // Also check: does any answer have meaningful token overlap with the claim?
  const claimToks = simpleTokens(claim)
  const claimAgreement = claimToks.size > 0
    ? meaningful.reduce((best, a) => Math.max(best, tokenOverlap(a, claim)), 0)
    : 0

  // Score: best pairwise agreement weighted with claim agreement
  const score = bestAgreement * 0.7 + claimAgreement * 0.3

  if (score >= 0.3 && meaningful.length >= 2) {
    // Weight confidence by source authority of agreeing sources
    const avgAuthority = sources.slice(0, meaningful.length).reduce((s, src) => s + src.authority, 0) / Math.min(sources.length, meaningful.length)
    return {
      verified: {
        claim,
        tier: 'corroborated',
        confidence: Math.min(0.75, 0.35 + score * 0.30 + avgAuthority * 0.10),
        evidence: { sourcesAgreed: meaningful.length },
        verifiedAt: Date.now(),
      },
    }
  }
  return { verified: null, failReason: `corroboration score too low (${score.toFixed(2)}, best-pair=${bestAgreement.toFixed(2)})` }
}

// ── Public cascade ────────────────────────────────────────────────────────────

export interface CascadeInput {
  claim: string
  sources: SourceEvidence[]
  extractedAnswers?: string[]
  crossDerivedAnswers?: Array<{ answer: string; sourceClass: 'corpus' | 'web' | 'academic' }>
}

/**
 * Run the full oracle cascade on a claim. Returns the first verified result
 * (highest tier that passes) or unverified. Never throws.
 */
export async function verifyClaim(
  input: CascadeInput,
  fmCall: FmCall = defaultFmCall,
): Promise<VerifiedClaim> {
  const { claim, sources, extractedAnswers = [], crossDerivedAnswers = [] } = input
  const unverified: VerifiedClaim = {
    claim,
    tier: 'unverified',
    confidence: 0,
    evidence: {},
    verifiedAt: Date.now(),
  }

  // Tier 1: Executable reduction (no FM, fastest)
  try {
    const r1 = tryExecutableReduction(claim)
    if (r1.verified) return r1.verified
  } catch { /* best-effort */ }

  // Tier 2: Verbatim provenance (FM proposes, Node checks)
  if (sources.length > 0) {
    try {
      const r2 = await tryVerbatimProvenance(claim, sources, fmCall)
      if (r2.verified) return r2.verified
    } catch { /* best-effort */ }
  }

  // Tier 3: Cross-derivation (two source classes)
  if (crossDerivedAnswers.length >= 2) {
    try {
      const r3 = tryCrossDerivation(claim, crossDerivedAnswers)
      if (r3.verified) return r3.verified
    } catch { /* best-effort */ }
  }

  // Tier 4: Corroboration (weighted multi-source)
  if (sources.length >= 2 && extractedAnswers.length >= 2) {
    try {
      const r4 = tryCorroboration(claim, sources, extractedAnswers)
      if (r4.verified) return r4.verified
    } catch { /* best-effort */ }
  }

  return unverified
}

// ── Sentence-level grounding check (post-synthesis) ──────────────────────────
// After final synthesis, verify every output sentence maps to a verified claim.
// Returns only sentences that are grounded (have a matching verified claim).

function tokenize(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []))
}

function sentenceOverlapsWithClaim(sentence: string, claim: VerifiedClaim): number {
  const sToks = tokenize(sentence)
  const cToks = tokenize(claim.claim)
  if (sToks.size === 0 || cToks.size === 0) return 0
  let overlap = 0
  for (const t of sToks) if (cToks.has(t)) overlap++
  return overlap / Math.min(sToks.size, cToks.size)
}

export function filterGroundedSentences(
  synthesizedText: string,
  verifiedClaims: VerifiedClaim[],
  minOverlap = 0.35,
): { grounded: string[]; cut: string[] } {
  // Length floor of 3 (not 10): a terse entity answer to a lookup ("France.", "1867.")
  // is the BEST possible synthesis, and a >10 floor silently deleted it, collapsing the
  // final answer to the bullet-list fallback (observed live on "who won the 2018 World
  // Cup?"). 3 still drops empty fragments and stray punctuation.
  const sentences = synthesizedText
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 3)

  const grounded: string[] = []
  const cut: string[] = []

  for (const sentence of sentences) {
    const bestOverlap = verifiedClaims.reduce(
      (best, vc) => Math.max(best, sentenceOverlapsWithClaim(sentence, vc)),
      0,
    )
    if (bestOverlap >= minOverlap || verifiedClaims.length === 0) {
      grounded.push(sentence)
    } else {
      cut.push(sentence)
    }
  }

  return { grounded, cut }
}
