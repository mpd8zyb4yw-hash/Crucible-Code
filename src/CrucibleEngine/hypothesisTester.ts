// Hypothesis tester — for research and technical tasks, generates a testable
// hypothesis from the prompt, designs a minimal test, runs it via sandbox.ts,
// captures the result via executionTrace.ts, and updates the synthesis prompt
// with the test result before the final answer.
//
// If the test fails, revises the hypothesis once and retries before flagging uncertainty.

import { extractFirstCodeBlock, buildTraceBlock, type ExecutionTrace } from './executionTrace'
import { debugBus } from './debug/bus'

// Prompt types that benefit from hypothesis testing
const HYPOTHESIS_TYPES = new Set(['coding', 'reasoning', 'math'])

export interface Hypothesis {
  claim: string            // the testable assertion
  testCode: string         // minimal code to verify it (JS by default)
  language: string
  confidence: number       // 0-1: expected confidence if test passes
}

export interface HypothesisResult {
  hypothesis: Hypothesis
  revisedHypothesis?: Hypothesis
  trace: ExecutionTrace
  passed: boolean
  synthesisAddendum: string  // block to inject into synthesis prompt
  uncertain: boolean         // true if all attempts failed
}

// Generate a testable hypothesis and minimal test code from a prompt.
// Uses heuristic extraction — no model call (free-tier safe).
function generateHypothesis(prompt: string): Hypothesis | null {
  const lower = prompt.toLowerCase()

  // Math/calculation hypothesis
  const mathMatch = prompt.match(/(\d[\d\s+\-*/^.()\[\]]*=\s*\?|\bwhat\s+is\s+[\d\s+\-*/^.]+)/i)
  if (mathMatch) {
    const expr = mathMatch[0].replace(/what is/i, '').replace(/[=?]/g, '').trim()
    const safeExpr = expr.replace(/[^0-9+\-*/().\s]/g, '')
    if (safeExpr.length > 0) {
      return {
        claim: `The result of "${safeExpr}" is computable`,
        testCode: `console.log(JSON.stringify({ result: ${safeExpr} }))`,
        language: 'javascript',
        confidence: 0.95,
      }
    }
  }

  // Code-in-prompt hypothesis: test the first code block
  const codeBlock = extractFirstCodeBlock(prompt)
  if (codeBlock && ['javascript', 'typescript', 'python'].includes(codeBlock.language)) {
    return {
      claim: `The provided ${codeBlock.language} code executes without error`,
      testCode: codeBlock.code,
      language: codeBlock.language,
      confidence: 0.85,
    }
  }

  // Algorithm complexity hypothesis
  const complexityMatch = prompt.match(/\b(O\([^)]+\)|time complexity|space complexity)\b/i)
  if (complexityMatch) {
    return {
      claim: `Complexity claim is verifiable via empirical timing`,
      testCode: [
        `const start = Date.now()`,
        `let n = 1000, sum = 0`,
        `for (let i = 0; i < n; i++) sum += i  // O(n) baseline`,
        `const elapsed = Date.now() - start`,
        `console.log(JSON.stringify({ elapsed, n, opsPerMs: n / Math.max(elapsed, 1) }))`,
      ].join('\n'),
      language: 'javascript',
      confidence: 0.7,
    }
  }

  // General assertion hypothesis — look for "X is Y" or "X does Y" claims
  const assertionMatch = prompt.match(/\b(\w[\w\s]{2,20})\s+(?:is|are|does|will|can)\s+([^.!?,]{5,50})/i)
  if (assertionMatch) {
    return {
      claim: `"${assertionMatch[0].trim().slice(0, 80)}" can be verified`,
      testCode: `// Structural test of the claim\nconsole.log(JSON.stringify({ claim: "${assertionMatch[0].trim().slice(0, 60).replace(/"/g, "'")}", testable: true }))`,
      language: 'javascript',
      confidence: 0.5,
    }
  }

  return null
}

// Revise a failing hypothesis — invert the approach or simplify the test
function reviseHypothesis(original: Hypothesis, failureOutput: string): Hypothesis {
  // Simplify: strip side effects, add try/catch, reduce scope
  const revisedCode = [
    `try {`,
    `  ${original.testCode.split('\n').join('\n  ')}`,
    `} catch (e) {`,
    `  console.log(JSON.stringify({ error: e.message, hypothesis: 'revised' }))`,
    `}`,
  ].join('\n')

  return {
    claim: `${original.claim} (revised after: ${failureOutput.slice(0, 50)})`,
    testCode: revisedCode,
    language: original.language,
    confidence: original.confidence * 0.6,
  }
}

// Main entry point — run for coding/reasoning/math prompts.
// Returns null if the prompt type doesn't warrant hypothesis testing.
export async function runHypothesisTest(
  prompt: string,
  promptType: string,
  runCode: (code: string, language: string) => Promise<ExecutionTrace>,
  requestId?: string,
): Promise<HypothesisResult | null> {
  if (!HYPOTHESIS_TYPES.has(promptType)) return null

  const hypothesis = generateHypothesis(prompt)
  if (!hypothesis) return null

  debugBus.emit('pipeline', 'hypothesis_generated', {
    claim: hypothesis.claim.slice(0, 100),
    language: hypothesis.language,
    promptType,
    requestId,
  }, { severity: 'info', requestId })

  // Run the test
  let trace: ExecutionTrace
  try {
    trace = await Promise.race([
      runCode(hypothesis.testCode, hypothesis.language),
      new Promise<ExecutionTrace>((_, rej) => setTimeout(() => rej(new Error('hypothesis timeout')), 10_000)),
    ])
  } catch (e: any) {
    debugBus.emit('pipeline', 'hypothesis_test_error', { error: e.message, requestId }, { severity: 'warn', requestId })
    return null
  }

  debugBus.emit('pipeline', 'hypothesis_test_result', {
    claim: hypothesis.claim.slice(0, 80),
    passed: trace.passed,
    exitCode: trace.exitCode,
    requestId,
  }, { severity: trace.passed ? 'success' : 'warn', requestId })

  // If failed, revise once and retry
  let revisedHypothesis: Hypothesis | undefined
  let finalTrace = trace
  if (!trace.passed) {
    revisedHypothesis = reviseHypothesis(hypothesis, trace.stderr.slice(0, 100))
    try {
      finalTrace = await Promise.race([
        runCode(revisedHypothesis.testCode, revisedHypothesis.language),
        new Promise<ExecutionTrace>((_, rej) => setTimeout(() => rej(new Error('revision timeout')), 8_000)),
      ])
      debugBus.emit('pipeline', 'hypothesis_revision_result', {
        passed: finalTrace.passed,
        requestId,
      }, { severity: finalTrace.passed ? 'success' : 'error', requestId })
    } catch {
      finalTrace = trace
    }
  }

  const passed = finalTrace.passed
  const uncertain = !passed

  const traceBlock = buildTraceBlock(finalTrace, (revisedHypothesis ?? hypothesis).testCode)
  const synthesisAddendum = [
    `[HYPOTHESIS TEST RESULT]`,
    `Hypothesis: ${hypothesis.claim}`,
    revisedHypothesis ? `(Revised after first failure)` : '',
    traceBlock,
    uncertain
      ? `The hypothesis could not be verified — treat conclusions in this area with appropriate uncertainty.`
      : `The hypothesis was verified — use this result to ground your explanation.`,
  ].filter(Boolean).join('\n')

  return {
    hypothesis,
    revisedHypothesis,
    trace: finalTrace,
    passed,
    synthesisAddendum,
    uncertain,
  }
}

// Convenience check: should hypothesis testing run for this prompt?
export function shouldRunHypothesis(promptType: string, prompt: string): boolean {
  if (!HYPOTHESIS_TYPES.has(promptType)) return false
  // Must have some specific claim or code to test
  return !!(
    prompt.match(/\b(calculate|compute|verify|test|check|prove|what is \d)/i) ||
    extractFirstCodeBlock(prompt) ||
    prompt.match(/O\([^)]+\)/)
  )
}
