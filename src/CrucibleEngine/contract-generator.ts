// ============================================================
// CRUCIBLE — Interface Contract Generator
// Produces a deterministic JSON schema lock before Stage 1.
// All parallel models must conform to this contract.
// Prevents cascading hallucinations across tracks.
// ============================================================

import type { PromptType } from '../../modelRegistry'

export interface EvaluationCriterion {
  concept: string              // human-readable name e.g. "gossip/sync protocol"
  keywords: string[]           // any match → concept covered (semantic alternatives)
  required: boolean            // true = missing → blocking score penalty
}

export interface InterfaceContract {
  promptType: PromptType
  requiredStructure: string[]
  forbiddenAntipatterns: string[]
  outputFormat: string
  qualityGates: string[]
  systemPrompt: string
  promptRequirements: string[]
  evaluationCriteria: EvaluationCriterion[]   // semantic must-include checks
}

const STRUCTURE_BY_TYPE: Record<PromptType, string[]> = {
  coding: [
    'explicit error handling (try/catch or Result type)',
    'type annotations on all function parameters and return values',
    'named constants instead of magic numbers',
    'single responsibility — one function per concern',
    'edge case handling (empty input, null, boundary values)',
  ],
  reasoning: [
    'structured argument with clear premise and conclusion',
    'explicit acknowledgement of counterarguments',
    'evidence or reasoning cited for each claim',
    'clear separation of facts from inferences',
  ],
  math: [
    'step-by-step derivation shown',
    'units and domains stated explicitly',
    'edge cases identified (division by zero, overflow)',
    'final answer clearly labeled',
  ],
  creative: [
    'clear narrative arc or structural form',
    'consistent voice and tone throughout',
    'concrete sensory details over abstract statements',
  ],
  factual: [
    'direct answer in the first sentence',
    'source quality indicated where relevant',
    'uncertainty explicitly stated when present',
    'no hallucinated citations',
  ],
  general: [
    'direct answer to the question asked',
    'supporting reasoning provided',
    'appropriate scope — not over-broad',
  ],
}

const FORBIDDEN_BY_TYPE: Record<PromptType, string[]> = {
  coding: [
    'swallowed errors (empty catch blocks)',
    'innerHTML assigned from user input',
    'infinite retry loops without backoff',
    'unbounded Promise.all over user-supplied arrays',
    'missing cleanup for timers or event listeners',
  ],
  reasoning: [
    'unsupported absolute claims',
    'strawman representations of opposing views',
    'circular reasoning',
  ],
  math: [
    'skipping derivation steps',
    'assuming without stating',
    'numeric approximation without disclosure',
  ],
  creative: [
    'clichéd openings',
    'telling instead of showing',
    'inconsistent point of view',
  ],
  factual: [
    'fabricated citations',
    'confident claims on uncertain facts',
    'mixing opinion with fact without labeling',
  ],
  general: [
    'padding without substance',
    'refusing to take a position when one is asked for',
  ],
}

const FORMAT_BY_TYPE: Record<PromptType, string> = {
  coding:    'Respond with working code in a single code block, followed by a brief explanation. No pseudocode.',
  reasoning: 'Respond in structured prose. Use numbered points for multi-step arguments.',
  math:      'Show all steps. Box or label the final answer clearly.',
  creative:  'Respond with the creative work directly as flowing prose. Never wrap the writing in code blocks, quotes, or a variable assignment — it is prose, not a string literal. No meta-commentary unless asked.',
  factual:   'Lead with the direct answer. Support with concise explanation.',
  general:   'Be direct and concise. Lead with the answer, follow with reasoning.',
}

// ── Requirement extractor ─────────────────────────────────────────────────────
// Pulls explicit multi-part asks out of the user's prompt so they become scored
// contract requirements rather than silently ignored background context.
export function extractPromptRequirements(message: string): string[] {
  const reqs: string[] = []
  const lines = message.split(/\n/)

  // Numbered list items: "1. X", "1) X", "(1) X"
  for (const line of lines) {
    const m = line.match(/^\s*(?:\d+[.)]\s*|\(\d+\)\s*)(.{10,120})/)
    if (m) reqs.push(m[1].trim().replace(/[:.]+$/, ''))
  }

  // Lettered list items: "a. X", "a) X"
  for (const line of lines) {
    const m = line.match(/^\s*[a-zA-Z][.)]\s+(.{10,120})/)
    if (m) reqs.push(m[1].trim().replace(/[:.]+$/, ''))
  }

  // "Show/Describe/Include/Implement X" imperatives in running text
  const imperativeRe = /(?:show|describe|include|implement|design|explain|provide|define|write|build|create|outline)\s+(?:the\s+)?([a-z][^.!?]{10,120})/gi
  let em: RegExpExecArray | null
  while ((em = imperativeRe.exec(message)) !== null) {
    reqs.push(em[1].trim().replace(/[:.]+$/, ''))
  }

  // Colon-enumerated inline lists: "Design: X, Y, and Z" or "Design X, Y, and Z."
  const colonListRe = /(?:design|the|show|include|your answer (?:must|should) cover)[^:]*:\s*([^.!?\n]{20,200})/gi
  while ((em = colonListRe.exec(message)) !== null) {
    // Split on commas + "and" to get individual items
    const items = em[1].split(/,\s*(?:and\s+)?|(?:^|\s)and\s+/)
    for (const item of items) {
      const t = item.trim().replace(/[:.]+$/, '')
      if (t.length >= 8) reqs.push(t)
    }
  }

  // Deduplicate and limit to 8 most relevant requirements
  const seen = new Set<string>()
  const unique: string[] = []
  for (const r of reqs) {
    const key = r.toLowerCase().slice(0, 40)
    if (!seen.has(key)) { seen.add(key); unique.push(r) }
  }
  return unique.slice(0, 8)
}

// Build semantic evaluation criteria from extracted prompt requirements.
// Each criterion maps a human concept to multiple keyword alternatives so that
// paraphrases ("peer sync" instead of "gossip protocol") still score coverage.
// This is separate from promptRequirements (structural) — it's a correctness gate.
function buildEvaluationCriteria(promptReqs: string[]): EvaluationCriterion[] {
  return promptReqs.map(req => {
    const lower = req.toLowerCase()
    const keywords: string[] = []

    // Extract non-trivial tokens as primary keywords
    const tokens = lower
      .split(/[\s/,]+/)
      .filter(w => w.length > 3 && !/^(the|and|for|that|this|with|from|each|into|how|you|your|all|any)$/.test(w))
      .slice(0, 5)
    keywords.push(...tokens)

    // Domain-specific synonym expansions for common distributed systems concepts
    const synonymMap: Record<string, string[]> = {
      gossip:       ['gossip', 'sync', 'propagat', 'exchang', 'peer', 'broadcast'],
      sliding:      ['sliding', 'window', 'rolling', 'interval', 'bucket'],
      consensus:    ['consensus', 'coordinat', 'quorum', 'agreement', 'synchroni'],
      data:         ['data', 'struct', 'array', 'map', 'list', 'queue', 'store'],
      guarantee:    ['guarantee', 'bound', 'limit', 'never exceed', 'at most', 'overage', 'drift'],
      protocol:     ['protocol', 'algorithm', 'process', 'sync', 'propagat'],
      server:       ['server', 'node', 'instance', 'replica', 'peer'],
      rate:         ['rate', 'request', 'limit', 'throttl', 'quota'],
      token:        ['token', 'counter', 'credit', 'allowance'],
      window:       ['window', 'interval', 'period', 'second', 'rolling'],
      distributed:  ['distributed', 'stateless', 'decentral', 'replicated'],
      code:         ['code', 'struct', 'class', 'function', 'implement', 'algorithm'],
    }

    for (const [key, syns] of Object.entries(synonymMap)) {
      if (tokens.some(t => t.startsWith(key))) {
        keywords.push(...syns)
      }
    }

    const unique = [...new Set(keywords)]
    return {
      concept: req.slice(0, 80),
      keywords: unique,
      required: true,
    }
  })
}

export function generateContract(
  message: string,
  promptType: PromptType
): InterfaceContract {
  const required  = [...STRUCTURE_BY_TYPE[promptType]]
  const forbidden = FORBIDDEN_BY_TYPE[promptType]
  const format    = FORMAT_BY_TYPE[promptType]

  // Extract prompt-specific requirements and add to required structure so they
  // are scored by computeContractScore and visible to all models in the system prompt.
  const promptReqs = extractPromptRequirements(message)
  const allRequired = [...required, ...promptReqs]
  const evaluationCriteria = buildEvaluationCriteria(promptReqs)

  const qualityGates = [
    `Response must directly address: "${message.slice(0, 120)}${message.length > 120 ? '…' : ''}"`,
    'No content from outside the scope of the question',
    'Minimum substantive length: 3 meaningful sentences or 10 lines of code',
    'Plain text only — no emojis or decorative Unicode pictographs anywhere in the response',
  ]

  const systemPrompt = [
    '## PIPELINE CONTRACT — READ BEFORE RESPONDING',
    '',
    'You are one of several parallel models in a multi-agent debate pipeline.',
    'Your response will be scored, critiqued by peer models, and synthesized.',
    'Conform strictly to this contract or your output will be rejected.',
    '',
    '### REQUIRED STRUCTURAL ELEMENTS',
    ...required.map(r => `- ${r}`),
    '',
    ...(promptReqs.length > 0 ? [
      '### PROMPT-SPECIFIC REQUIREMENTS (must ALL be present)',
      'The question explicitly asks for the following — every item below MUST appear in your response:',
      ...promptReqs.map(r => `- ${r}`),
      '',
    ] : []),
    ...(evaluationCriteria.length > 0 ? [
      '### EVALUATION CRITERIA (scored — incomplete answers fail)',
      'A correct answer MUST cover ALL of the following concepts:',
      ...evaluationCriteria.map(c => `- ${c.concept}`),
      '',
    ] : []),
    '### FORBIDDEN PATTERNS (automatic rejection)',
    ...forbidden.map(f => `- ${f}`),
    '',
    '### OUTPUT FORMAT',
    format,
    '',
    '### QUALITY GATES',
    ...qualityGates.map(g => `- ${g}`),
    '',
    '### PROMPT TYPE LOCK',
    `This query is classified as: ${promptType.toUpperCase()}`,
    'Do not deviate into a different response mode.',
  ].join('\n')

  return {
    promptType,
    requiredStructure: allRequired,
    forbiddenAntipatterns: forbidden,
    outputFormat: format,
    qualityGates,
    systemPrompt,
    promptRequirements: promptReqs,
    evaluationCriteria,
  }
}
