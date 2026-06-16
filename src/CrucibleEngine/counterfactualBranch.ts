// Counterfactual branching (Track A2) — after a confident synthesis is produced
// for factual/reasoning/math prompts, a second adversarial synthesiser runs with
// the mandate "assume the top answer is wrong — build the strongest alternative."
// If the adversarial answer is equally plausible, the original was overconfident:
// flag it, emit a debug event, and inject an uncertainty caveat into the final text.
// The (original, adversarial) pair is stored as training signal.

import fs from 'fs'
import path from 'path'

export interface CounterfactualPair {
  ts: number
  query: string
  original: string
  adversarial: string
  conflictScore: number   // 0-1: how different are the two answers
  flagged: boolean        // true if conflict was high enough to caveat
  promptType: string
}

const cfFile = (dir: string) => path.join(dir, '.crucible', 'counterfactuals.json')

// Types that benefit from counterfactual checking
export const CF_TYPES = new Set(['factual', 'reasoning', 'math'])

export function loadCounterfactuals(dir: string): CounterfactualPair[] {
  try { return JSON.parse(fs.readFileSync(cfFile(dir), 'utf8')) } catch { return [] }
}

export function saveCounterfactual(dir: string, pair: CounterfactualPair) {
  const all = loadCounterfactuals(dir)
  all.push(pair)
  fs.mkdirSync(path.dirname(cfFile(dir)), { recursive: true })
  fs.writeFileSync(cfFile(dir), JSON.stringify(all.slice(-200), null, 2))
}

// Measure how different two texts are — simple bag-of-words Jaccard distance
function conflictScore(a: string, b: string): number {
  const words = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3))
  const wa = words(a), wb = words(b)
  const intersection = [...wa].filter(w => wb.has(w)).length
  const union = new Set([...wa, ...wb]).size
  return union ? 1 - (intersection / union) : 0
}

// Run the adversarial synthesiser. Returns null on timeout or error.
export async function runCounterfactual(
  query: string,
  synthesisText: string,
  promptType: string,
  dir: string,
  callModel: (model: any, messages: any[], opts?: any) => Promise<string>,
  adversarialModel: any
): Promise<{ caveat: string | null; pair: CounterfactualPair }> {
  const adversarialPrompt = [
    {
      role: 'system' as const,
      content: 'You are an adversarial analyst. Your job: assume the given answer is wrong or incomplete, then construct the strongest possible alternative answer. Be concrete. Do not dismiss the original — build a genuine competing answer that a knowledgeable person might defend. Write in natural prose.',
    },
    {
      role: 'user' as const,
      content: `Original question: ${query}\n\nThe top answer was:\n${synthesisText.slice(0, 800)}\n\nAssume this answer is wrong or incomplete. What is the strongest alternative answer?`,
    },
  ]

  let adversarial = ''
  try {
    adversarial = await Promise.race([
      callModel(adversarialModel, adversarialPrompt, { timeout: 10000 }),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('cf timeout')), 11000)),
    ])
  } catch {
    // Counterfactual is best-effort — fail silently
    const pair: CounterfactualPair = { ts: Date.now(), query: query.slice(0, 150), original: synthesisText.slice(0, 300), adversarial: '', conflictScore: 0, flagged: false, promptType }
    return { caveat: null, pair }
  }

  const cs = conflictScore(synthesisText, adversarial)
  // High conflict (>0.65) + meaningful adversarial response → flagged
  const flagged = cs > 0.65 && adversarial.length > 80

  const pair: CounterfactualPair = {
    ts: Date.now(),
    query: query.slice(0, 150),
    original: synthesisText.slice(0, 400),
    adversarial: adversarial.slice(0, 400),
    conflictScore: parseFloat(cs.toFixed(3)),
    flagged,
    promptType,
  }

  saveCounterfactual(dir, pair)

  const caveat = flagged
    ? `Note: an independent analysis produced a conflicting answer — confidence in the above is moderate. The alternative view: ${adversarial.slice(0, 200).trim()}${adversarial.length > 200 ? '...' : ''}`
    : null

  return { caveat, pair }
}
