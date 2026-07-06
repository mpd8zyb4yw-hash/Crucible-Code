import { tools } from '../tools'

export interface AgentDraft {
  name: string
  steps: string[]
  toolNames: string[]
  guardrails: string[]
}

/**
 * Real (on-device, zero-network) draft generator: turns a free-text agent
 * description into a concrete workflow skeleton. Deterministic and local —
 * same "no external calls" guarantee as the chat local model.
 */
export function draftAgent(description: string): AgentDraft {
  const desc = description.trim()
  const nameGuess = desc.split(/[.,\n]/)[0].slice(0, 40).trim() || 'Custom agent'
  const relevantTools = tools.filter((t) => desc.toLowerCase().includes(t.name.split('_')[0])).map((t) => t.name)

  return {
    name: nameGuess,
    steps: [
      `Parse the request: "${desc.slice(0, 100)}${desc.length > 100 ? '…' : ''}"`,
      'Plan the minimal sequence of steps that satisfies it',
      relevantTools.length ? `Call tool(s): ${relevantTools.join(', ')}` : 'Reason locally — no matching tool needed',
      'Self-review the result against the original request before returning it',
    ],
    toolNames: relevantTools.length ? relevantTools : ['none'],
    guardrails: ['Runs on-device by default', 'Never escalates to ensemble without explicit confirmation'],
  }
}
