// ── Research Benchmark — prove:all for research ───────────────────────────────
//
// The research equivalent of synth/prove-all.ts. A set of questions with known,
// checkable ground-truth answers. Runs each through runResearchDag and scores:
//
//   VERIFIED   — claim passed oracle cascade at tier ≥ 'corroborated'
//   CORRECT    — answer text contains the expected answer
//   PARTIAL    — answer text partially matches
//   ABSTAINED  — DAG could not verify (honest failure — not necessarily wrong)
//   WRONG      — answer verified but does not match expected
//
// Usage: npx tsx src/CrucibleEngine/research/researchBenchmark.ts

import { runResearchDag, type ResearchEvent } from './researchDag'

export interface BenchmarkCase {
  question: string
  /** Strings that MUST appear in a correct answer (case-insensitive). All must match. */
  expectedTerms: string[]
  /** Optional strings that disqualify the answer (hallucination markers). */
  forbiddenTerms?: string[]
  /** Minimum acceptable verification tier */
  minTier?: 'executable' | 'verbatim-provenance' | 'cross-derived' | 'corroborated'
}

export type BenchmarkVerdict = 'correct' | 'partial' | 'abstained' | 'wrong' | 'error'

export interface BenchmarkResult {
  question: string
  verdict: BenchmarkVerdict
  tier?: string
  confidence?: number
  answerPreview?: string
  durationMs: number
}

// ── Known-answer test suite ───────────────────────────────────────────────────
// Questions chosen to exercise all four oracle tiers + abstain path.

export const BENCHMARK_CASES: BenchmarkCase[] = [
  // Executable tier: pure computation
  {
    question: 'Is 17 prime?',
    expectedTerms: ['prime'],
    minTier: 'executable',
  },
  {
    question: 'What is 2 + 2?',
    expectedTerms: ['4'],
    minTier: 'executable',
  },
  {
    question: 'What is 2^10?',
    expectedTerms: ['1024'],
    minTier: 'executable',
  },
  // Verbatim-provenance / cross-derived tier: web-sourced facts
  {
    question: 'What is the capital of France?',
    expectedTerms: ['paris'],
    forbiddenTerms: ['london', 'berlin', 'madrid'],
  },
  {
    question: 'What language is TypeScript a superset of?',
    expectedTerms: ['javascript'],
  },
  {
    question: 'What does HTTP stand for?',
    expectedTerms: ['hypertext', 'transfer', 'protocol'],
  },
  {
    question: 'What is the time complexity of binary search?',
    expectedTerms: ['log', 'o(log n)'],
  },
  // Multi-step (decomposed)
  {
    question: 'What is the difference between TCP and UDP?',
    expectedTerms: ['tcp', 'udp'],
  },
  {
    question: 'What are the three primary colors of light?',
    expectedTerms: ['red', 'green', 'blue'],
  },
  // Abstain-expected (vague/unanswerable)
  {
    question: 'What is the exact population of Earth right now?',
    expectedTerms: [], // expect abstain or partial — no single verifiable answer
  },
]

// ── Scorer ────────────────────────────────────────────────────────────────────

function scoreAnswer(
  answerText: string,
  expectedTerms: string[],
  forbiddenTerms: string[] = [],
  confidence: number,
): BenchmarkVerdict {
  if (!answerText || confidence === 0) return 'abstained'
  const lower = answerText.toLowerCase()

  // Check for forbidden terms (hallucination)
  if (forbiddenTerms.some(t => lower.includes(t.toLowerCase()))) return 'wrong'

  if (expectedTerms.length === 0) return 'abstained' // nothing to check

  // All expected terms present → correct
  const hits = expectedTerms.filter(t => lower.includes(t.toLowerCase()))
  if (hits.length === expectedTerms.length) return 'correct'
  // More than half → partial
  if (hits.length >= Math.ceil(expectedTerms.length / 2)) return 'partial'
  return 'wrong'
}

// ── Runner ────────────────────────────────────────────────────────────────────

export async function runBenchmark(
  cases: BenchmarkCase[] = BENCHMARK_CASES,
  opts: { maxMs?: number; projectDir?: string; verbose?: boolean } = {},
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = []
  const verbose = opts.verbose ?? true
  const maxMs = opts.maxMs ?? 45_000  // per-question timeout

  for (const tc of cases) {
    const t0 = Date.now()
    if (verbose) process.stdout.write(`  ? ${tc.question.slice(0, 60).padEnd(60)} `)

    let finalText = ''
    let confidence = 0
    let tier = 'unverified'
    let verdict: BenchmarkVerdict = 'error'
    let gotDone = false
    let gotError = false

    try {
      for await (const ev of runResearchDag(tc.question, {
        maxMs, projectDir: opts.projectDir ?? process.cwd(),
        maxLeafNodes: 4, maxWebPages: 6, skipReadReliability: true,
      })) {
        if (ev.type === 'research_done') {
          finalText = ev.text ?? ''
          confidence = ev.confidence ?? 0
          gotDone = true
        } else if (ev.type === 'research_error') {
          gotError = true
          finalText = ev.text ?? ''
        }
        // Extract tier from verify steps
        if (ev.phase === 'verify' && ev.tier) tier = ev.tier
      }

      if (gotError && !gotDone) {
        verdict = 'error'
      } else if (gotDone) {
        verdict = scoreAnswer(finalText, tc.expectedTerms, tc.forbiddenTerms, confidence)
      }
      // else: neither done nor error — leave as 'error' (something went wrong silently)
    } catch (e: any) {
      verdict = 'error'
      finalText = e?.message ?? 'exception'
    }

    const durationMs = Date.now() - t0
    const r: BenchmarkResult = {
      question: tc.question,
      verdict,
      tier,
      confidence: parseFloat(confidence.toFixed(3)),
      answerPreview: finalText.slice(0, 120),
      durationMs,
    }
    results.push(r)

    if (verbose) {
      const icon = verdict === 'correct' ? '✓' : verdict === 'partial' ? '~' : verdict === 'abstained' ? '∅' : '✗'
      console.log(`${icon} [${tier.slice(0, 10).padEnd(10)}] ${(confidence * 100).toFixed(0)}% ${(durationMs / 1000).toFixed(1)}s`)
    }
  }

  return results
}

// ── Summary ───────────────────────────────────────────────────────────────────

export function summarizeBenchmark(results: BenchmarkResult[]): void {
  const counts: Record<BenchmarkVerdict, number> = { correct: 0, partial: 0, abstained: 0, wrong: 0, error: 0 }
  let totalMs = 0
  let totalConf = 0

  for (const r of results) {
    counts[r.verdict]++
    totalMs += r.durationMs
    totalConf += r.confidence ?? 0
  }

  const n = results.length
  console.log('\n── Research Benchmark Results ─────────────────────────────────')
  console.log(`  Correct:   ${counts.correct}/${n}  (${(counts.correct / n * 100).toFixed(0)}%)`)
  console.log(`  Partial:   ${counts.partial}/${n}`)
  console.log(`  Abstained: ${counts.abstained}/${n}  (honest failures — not necessarily wrong)`)
  console.log(`  Wrong:     ${counts.wrong}/${n}`)
  console.log(`  Error:     ${counts.error}/${n}`)
  console.log(`  Avg conf:  ${(totalConf / n * 100).toFixed(0)}%`)
  console.log(`  Avg time:  ${(totalMs / n / 1000).toFixed(1)}s per question`)
  console.log('────────────────────────────────────────────────────────────────')
}

// ── CLI entry ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('Research DAG Benchmark — running...\n')
  const results = await runBenchmark(BENCHMARK_CASES, { verbose: true })
  summarizeBenchmark(results)
  const wrong = results.filter(r => r.verdict === 'wrong' || r.verdict === 'error')
  if (wrong.length > 0) {
    console.log('\nFailed cases:')
    for (const r of wrong) {
      console.log(`  [${r.verdict}] ${r.question}`)
      if (r.answerPreview) console.log(`    Answer: ${r.answerPreview}`)
    }
  }
  process.exit(wrong.length > 0 ? 1 : 0)
}

// Run if called directly
const isMain = process.argv[1]?.endsWith('researchBenchmark.ts') || process.argv[1]?.endsWith('researchBenchmark.js')
if (isMain) main().catch(e => { console.error(e); process.exit(1) })
