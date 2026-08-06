// Execution traces as evidence (Track A4) — after the sandbox runs code in a
// synthesis response, capture stdout/stderr/exit code and inject the actual
// runtime behaviour into the synthesis context. The synthesiser then writes
// about what *actually happened*, not what it predicts will happen.
// This is wired between Stage 5 synthesis and Stage 5b polish: if the synthesis
// contains a code block, run it, capture the trace, inject into polish prompt.

export interface ExecutionTrace {
  stdout: string
  stderr: string
  exitCode: number
  runtimeMs: number
  language: string
  passed: boolean
}

// Extract the first fenced code block from a synthesis text
export function extractFirstCodeBlock(text: string): { code: string; language: string } | null {
  const match = text.match(/```(\w+)?\n([\s\S]*?)```/)
  if (!match) return null
  const language = (match[1] ?? 'javascript').toLowerCase()
  const code = match[2].trim()
  return { code, language }
}

// Build the trace context block injected into the polish prompt
export function buildTraceBlock(trace: ExecutionTrace, code: string): string {
  const lines: string[] = [
    `[EXECUTION TRACE — ${trace.language}]`,
    `Exit code: ${trace.exitCode} (${trace.passed ? 'passed' : 'FAILED'}) | Runtime: ${trace.runtimeMs}ms`,
  ]
  if (trace.stdout) lines.push(`stdout:\n${trace.stdout.slice(0, 400)}`)
  if (trace.stderr) lines.push(`stderr:\n${trace.stderr.slice(0, 200)}`)
  if (!trace.passed) lines.push('The code above produced an error. Fix or explicitly caveat before returning.')
  else lines.push('The code above ran successfully. You may reference its output in your answer.')
  return lines.join('\n')
}

// Determine if a synthesis is worth executing (has a runnable code block)
export function shouldRunTrace(synthesisText: string, promptType: string): boolean {
  if (promptType !== 'coding') return false
  return /```(javascript|typescript|python|js|ts|py)\b/i.test(synthesisText)
}
