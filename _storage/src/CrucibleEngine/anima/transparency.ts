// ANIMA processes signal to extract universal observations. No user data is stored at any layer.
//
// User-facing transparency layer. This is the ONLY place ANIMA is ever made
// explicit to the user. It answers queries like "what does Crucible believe about
// humans" / "show me what you've learned" by returning the Universal Truth Store
// in plain language, sorted by confidence.
//
// PRIVACY INVARIANT: this layer shows only the universal observations and their
// confidence — NEVER the signal, valence, or conversation content that produced
// them. The store has no such data to leak; transparency reflects that.

import * as store from './store.js'
import type { UniversalTruth } from './types.js'

// Detect a "what have you learned about humans?" style query.
const TRANSPARENCY_RE =
  /\b(what (?:have|did) (?:you|crucible) learn(?:ed)? about (?:humans?|people|the human condition)|what (?:do|does) (?:you|crucible) (?:believe|think|know) about (?:humans?|people)|show me what (?:you|crucible)('?ve| have)? learned|what (?:are|have) your (?:observations|beliefs) about (?:humans?|people)|universal truths?|anima)\b/i

export function isTransparencyQuery(prompt: string): boolean {
  return TRANSPARENCY_RE.test(prompt.trim())
}

export interface TransparencyEntry {
  observation: string
  domain: string
  confidence: number
  confidencePct: number
  noveltyScore: number
  confirmingInstances: number
  fragility: string
  firstObserved: string
}

export interface TransparencyReport {
  count: number
  entries: TransparencyEntry[]
  text: string   // ready-to-render plain-language summary
}

export function buildTransparencyReport(includeCandidates = false): TransparencyReport {
  const truths: UniversalTruth[] = store.list(includeCandidates)
  const entries: TransparencyEntry[] = truths.map(t => ({
    observation: t.observation,
    domain: t.domain,
    confidence: t.confidence,
    confidencePct: Math.round(t.confidence * 100),
    noveltyScore: t.noveltyScore,
    confirmingInstances: t.confirmingInstances,
    fragility: t.fragility,
    firstObserved: t.firstObserved,
  }))

  let text: string
  if (entries.length === 0) {
    text = `Crucible hasn't yet formed any confident universal observations about human experience. ANIMA watches every interaction for falsifiable patterns about the human condition, verifies them through a five-gate epistemic pipeline, and only promotes an observation here once real signal raises its confidence above 50%. Nothing has crossed that bar yet.`
  } else {
    const byDomain: Record<string, TransparencyEntry[]> = {}
    for (const e of entries) (byDomain[e.domain] ??= []).push(e)
    const sections = Object.entries(byDomain).map(([domain, es]) => {
      const items = es.map(e =>
        `- ${e.observation} (${e.confidencePct}% confidence, confirmed ${e.confirmingInstances}×)\n  Would be wrong if: ${e.fragility}`
      ).join('\n')
      return `${domain.toUpperCase()}\n${items}`
    })
    text = `Here is what Crucible has come to believe about human experience — each observation discovered from interaction patterns, challenged adversarially, and kept only while real signal supports it. Confidence rises with confirmation and falls with contradiction; anything below 50% stays a private candidate, not shown here.\n\n${sections.join('\n\n')}`
  }

  return { count: entries.length, entries, text }
}
