// ============================================================
// CRUCIBLE — Interface Contract Generator
// Produces a deterministic JSON schema lock before Stage 1.
// All parallel models must conform to this contract.
// Prevents cascading hallucinations across tracks.
// ============================================================

import type { PromptType } from '../../modelRegistry'

export interface InterfaceContract {
  promptType: PromptType
  requiredStructure: string[]
  forbiddenAntipatterns: string[]
  outputFormat: string
  qualityGates: string[]
  systemPrompt: string
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
  creative:  'Respond with the creative work directly. No meta-commentary unless asked.',
  factual:   'Lead with the direct answer. Support with concise explanation.',
  general:   'Be direct and concise. Lead with the answer, follow with reasoning.',
}

export function generateContract(
  message: string,
  promptType: PromptType
): InterfaceContract {
  const required  = STRUCTURE_BY_TYPE[promptType]
  const forbidden = FORBIDDEN_BY_TYPE[promptType]
  const format    = FORMAT_BY_TYPE[promptType]

  const qualityGates = [
    `Response must directly address: "${message.slice(0, 120)}${message.length > 120 ? '…' : ''}"`,
    'No content from outside the scope of the question',
    'Minimum substantive length: 3 meaningful sentences or 10 lines of code',
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
    requiredStructure: required,
    forbiddenAntipatterns: forbidden,
    outputFormat: format,
    qualityGates,
    systemPrompt,
  }
}
