// ═══════════════════════════════════════════════════════════════════════════════
// VGR — code proposer (the ONLY place the model lives)
// ═══════════════════════════════════════════════════════════════════════════════
//
// The proposer wraps the on-device FM as a fallible candidate generator. It is
// explicitly NOT trusted: its output is always handed to the execution verifier.
// Its job is to turn the spec PLUS the structured feedback from every prior failed
// attempt into a better next guess. The feedback loop is what makes a weak 3B
// converge — each rejected candidate's ACTUAL-vs-expected signals are fed straight
// back into the next prompt, so the model debugs its own code against ground truth
// instead of guessing blind.
// ═══════════════════════════════════════════════════════════════════════════════

import { fmComplete } from '../agent/fmReact'
import type { Candidate, ProposeContext } from './types'

/** Deterministic fingerprint for anti-thrash dedup (normalizes whitespace). */
function fingerprint(code: string): string {
  const norm = code.replace(/\s+/g, ' ').trim()
  let h = 5381
  for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) | 0
  return `c${(h >>> 0).toString(36)}`
}

/** Pull the first fenced code block, else the whole trimmed body. */
function extractCode(raw: string): string {
  const fence = /```(?:[a-zA-Z]+)?\n([\s\S]*?)```/.exec(raw)
  return (fence ? fence[1] : raw).trim()
}

export async function proposeCode(ctx: ProposeContext<string>): Promise<Candidate<string> | null> {
  const { spec, history, diversify } = ctx
  const acc = spec.acceptance as { entry: string }

  const system = [
    'You are a code-generation function inside a verification loop. You are NOT trusted —',
    'your output will be EXECUTED against hidden test cases immediately. Your only job is to',
    'return a correct implementation. Output ONE ES module in a single ``` code block and',
    'nothing else — no prose, no explanation.',
    '',
    `Export a function named \`${acc.entry}\` (use \`export function ${acc.entry}(...)\`).`,
    spec.context ? `\n## Grounding\n${spec.context}` : '',
  ].join('\n')

  // Thread the most recent failures back in as concrete, actionable debugging signal.
  // This is the sample-efficiency lever: the model sees exactly what went wrong.
  const recent = history.slice(-3)
  const feedback = recent.length
    ? '\n\n## Your previous attempts FAILED verification. Fix these specific problems:\n' +
      recent.map((a, i) => {
        const code = a.candidate.value.length > 800 ? a.candidate.value.slice(0, 800) + '\n…(truncated)' : a.candidate.value
        return `### Attempt ${i + 1} (score ${a.verdict.score})\n\`\`\`\n${code}\n\`\`\`\nFailures:\n` +
          a.verdict.signals.map(s => `- ${s}`).join('\n')
      }).join('\n\n')
    : ''

  // SEMANTIC-THRASH detection (sample-efficiency): the model may make the SAME logical
  // mistake with cosmetically-different code (e.g. `.join(/\s+/)` vs `.join(/\s+/)` again),
  // so fingerprint-dedup never sees it. If the identical FAILURE SIGNAL recurs, the model is
  // anchored — point it at the exact culprit instead of just repeating "try differently".
  const sig = (a: typeof history[number]) => (a.verdict.signals[0] ?? '')
  const lastSig = recent.length ? sig(recent[recent.length - 1]) : ''
  const repeats = lastSig && recent.filter(a => sig(a) === lastSig).length >= 2
  const stuckNote = repeats
    ? `\n\n## YOU ARE STUCK — READ THIS CAREFULLY\nYour last attempts produced the EXACT SAME wrong result every time:\n"${lastSig}"\nThat means the bug is in a SPECIFIC line, not the overall approach. Look at HOW you build the return value — a wrong argument to a call (e.g. passing a regex where a string is required, an off-by-one, wrong separator, wrong comparison). Identify the one wrong expression and change THAT. Do not rewrite the whole thing the same way again.`
    : ''

  const diversifyNote = (diversify || repeats)
    ? '\n\nYour recent attempts are stuck. Change the SPECIFIC operation that produces the wrong output — different call, argument, or operator — not a cosmetic rename.'
    : ''

  const user = `## Task\n${spec.goal}${feedback}${stuckNote}${diversifyNote}\n\nReturn the corrected full module now.`

  const raw = await fmComplete(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    { temperature: (diversify || repeats) ? 0.8 : 0.3 },
  )
  if (!raw || !raw.trim()) return null
  const code = extractCode(raw)
  if (!code) return null
  return { value: code, fingerprint: fingerprint(code) }
}
