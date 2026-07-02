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
    'brief usage example or call-site demonstration',
  ],
  reasoning: [
    'all given information restated and verified before reasoning begins',
    'explicit step-by-step logical chain from premises to conclusion',
    'alternative interpretations or edge cases considered',
    'evidence or reasoning cited for each claim',
    'clear separation of facts from inferences',
    'final conclusion stated explicitly',
  ],
  math: [
    'problem restated in own words before computing',
    'all variables and knowns identified',
    'step-by-step derivation shown with each step labeled',
    'units and domains stated explicitly',
    'arithmetic verified or sense-checked',
    'final answer clearly labeled with correct units',
  ],
  creative: [
    'clear narrative arc or structural form',
    'consistent voice and tone throughout',
    'concrete sensory details over abstract statements',
    'distinctive choices that avoid generic templates',
  ],
  factual: [
    'direct answer in the first sentence with specific detail (not vague generality)',
    'concrete specifics: dates, numbers, names, magnitudes where relevant',
    'mechanism or reasoning behind the fact — not just the bare fact',
    'uncertainty explicitly stated when present',
    'no hallucinated citations',
  ],
  general: [
    'direct answer to the question asked',
    'substantive depth — concrete examples or specifics, not vague generalities',
    'supporting reasoning or context provided',
    'appropriate scope — addresses what the user actually wants to know',
  ],
}

// Per-type instruction on HOW to think before writing — injected into the contract
// system prompt to activate chain-of-thought reasoning and depth standards.
const REASONING_MODE_BY_TYPE: Record<PromptType, string> = {
  reasoning:
    '### THINK FIRST\n' +
    'Before writing your response: (1) identify ALL given information and constraints, ' +
    '(2) map the logical chain step-by-step, (3) check for hidden assumptions or edge cases, ' +
    '(4) verify your conclusion before presenting it. Show your reasoning chain explicitly — ' +
    'do not jump to conclusions. A wrong answer with visible reasoning is more useful than a right answer with none.',

  math:
    '### THINK FIRST\n' +
    'Before computing: (1) restate what the question is asking in your own words, ' +
    '(2) identify all given values and unknowns, (3) choose the right approach, ' +
    '(4) execute step-by-step showing ALL work, (5) verify your answer with a sanity check. ' +
    'Show the full chain. Label every step. If the numbers feel off, say so.',

  factual:
    '### DEPTH STANDARD\n' +
    'Go beyond surface facts. Provide specific details: dates, names, magnitudes, mechanisms. ' +
    'Address WHY or HOW, not just WHAT. If there are common misconceptions about this topic, correct them. ' +
    'Draw on the full breadth of your knowledge — the user should leave with a richer understanding than a one-line lookup.',

  general:
    '### DEPTH STANDARD\n' +
    'Think about what the user ACTUALLY wants to know (not just the literal words). ' +
    'Be concrete and specific — give examples, numbers, context, implications. ' +
    'Avoid vague generalities. A substantive 3-sentence answer beats a padded paragraph.',

  coding:
    '### CODE QUALITY STANDARD\n' +
    'Before writing: understand the full requirements, consider edge cases, choose the right algorithm. ' +
    'Write correct code first, then idiomatic. Every function should have a clear single purpose. ' +
    'Think about what can go wrong at runtime and handle it.',

  creative:
    '### CREATIVE STANDARD\n' +
    'Commit fully. Make distinctive choices in voice, structure, and imagery. ' +
    'Avoid generic templates and clichéd openings. The work should feel genuinely crafted. ' +
    'Surprise the reader at least once.',
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
    REASONING_MODE_BY_TYPE[promptType],
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
