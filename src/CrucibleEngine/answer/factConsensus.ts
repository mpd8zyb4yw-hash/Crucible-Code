// ═══════════════════════════════════════════════════════════════════════════════
// Answer engine — SHORT-FACTUAL self-consistency + honest abstention
// ═══════════════════════════════════════════════════════════════════════════════
//
// Lookups ("capital of X", "who wrote Y", "how tall is Z") were the last single-FM-call path
// with NO verification: one sample, shipped raw. There is no deterministic oracle for a
// parametric fact, but there IS the same corroboration structure the rest of the system uses:
// draw K INDEPENDENT answers, normalize each to its key claim, and require a QUORUM. A fact
// the model actually knows is stable across samples; a confabulation drifts. No quorum →
// the answer ships UNSTAMPED with an explicit unverified note (abstain-shaped honesty), never
// silently confident.
//
// Extra rigor when available: any NON-FM local models installed in the localModels registry
// (ONNX SmolLM2/Gemma via transformers.js) join as genuinely independent voters — a different
// model family shares no confabulation bias with the FM. On a machine with nothing installed
// the registry contributes zero voters and behavior is FM-only (identical everywhere else).
// ═══════════════════════════════════════════════════════════════════════════════

import { fmComplete } from '../agent/fmReact'
import type { Completer } from './wordProblem'
import { getRegistry } from '../localModels/registry'
import { orchestrate } from '../localModels/orchestrator'

export interface FactConsensus {
  /** True when a quorum of independent answers agreed with the draft's key claim. */
  confirmed: boolean
  /** votes-for-draft-claim / total-votes (draft included). */
  agreement: number
  /** Total votes cast (draft + resamples + ensemble models). */
  votes: number
  /** The normalized claim key voted on (telemetry). */
  key: string
  /** ids of non-FM ensemble models that voted, if any. */
  ensembleModels: string[]
}

// ── Claim-key normalization ────────────────────────────────────────────────────────
// A short factual answer's key claim is (in priority order): a number with optional unit,
// else a proper-noun phrase, else the first clause lowercased. Comparison happens on this
// key, so phrasing differences ("Paris." / "The capital is Paris") still agree.

const STOP = new Set(['The', 'A', 'An', 'It', 'Its', 'This', 'That', 'There', 'They', 'He', 'She', 'I', 'Yes', 'No', 'In', 'On', 'As', 'At'])

export function extractClaimKey(text: string, question?: string): string | null {
  const t = (text ?? '').trim()
  if (!t) return null
  // Number (with thousands separators / decimals) — normalize commas away.
  const num = t.match(/-?\d[\d,]*(?:\.\d+)?/)
  if (num) return num[0].replace(/,/g, '')
  // Proper-noun phrase: longest run of Capitalized words that isn't a sentence-starter stopword.
  // Entities the QUESTION already mentions carry no new information (the claim in "the capital
  // of Australia is Canberra" is Canberra, not Australia) — exclude them when possible.
  const q = (question ?? '').toLowerCase()
  const runs = [...t.matchAll(/\b([A-Z][a-zA-Z'’-]+(?:\s+(?:of|the|de|da|von|van|[A-Z][a-zA-Z'’-]+))*)\b/g)]
    .map(m => m[1])
    .map(r => r.split(/\s+/).filter((w, i) => !(i === 0 && STOP.has(w))).join(' '))
    .filter(r => r && !STOP.has(r))
  const fresh = q ? runs.filter(r => !q.includes(r.toLowerCase())) : runs
  const pool = fresh.length ? fresh : runs
  if (pool.length) return pool.sort((a, b) => b.length - a.length)[0].toLowerCase()
  // Fallback: first clause, aggressively normalized.
  const clause = t.split(/[.!?\n]/)[0].toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()
  return clause || null
}

function keysAgree(a: string, b: string): boolean {
  if (a === b) return true
  // Substring containment covers "paris" vs "paris france".
  return a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))
}

// ── Multi-fact (list-shaped) lookups ─────────────────────────────────────────────────
// "Name the three largest…" / "What are the planets…" answers assert a SET of claims; a
// single claim key under-checks them (one right item corroborates while two wrong ones ride
// along). Extract the claim SET (proper nouns + numbers, question entities excluded) and
// require EVERY draft claim to be corroborated by a quorum of resamples.

const LIST_ASK = /\b(list|name)\b|\bwhat are\b|\bwhich (?:\w+ )?are\b/i
const COUNT_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }

/** How many items the question asks for, when it states a count ("the three largest…"). */
export function askedCount(question: string): number | null {
  const m = /\b(two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\s+(?:largest|biggest|smallest|longest|shortest|tallest|highest|lowest|most|first|best|main|primary|\w+est)\b/i.exec(question)
  if (!m) return null
  const w = m[1].toLowerCase()
  return COUNT_WORDS[w] ?? (Number(w) >= 2 && Number(w) <= 20 ? Number(w) : null)
}

export function isListQuestion(question: string): boolean {
  return LIST_ASK.test(question ?? '') || askedCount(question ?? '') !== null
}

/** All distinct claim keys in a text (proper nouns + standalone numbers), question-excluded. */
export function extractClaimSet(text: string, question: string): string[] {
  const t = (text ?? '').trim()
  if (!t) return []
  const q = (question ?? '').toLowerCase()
  const out = new Set<string>()
  for (const m of t.matchAll(/\b([A-Z][a-zA-Z'’-]+(?:\s+(?:of|the|de|da|von|van|[A-Z][a-zA-Z'’-]+))*)\b/g)) {
    const r = m[1].split(/\s+/).filter((w, i) => !(i === 0 && STOP.has(w))).join(' ')
    if (r && !STOP.has(r) && !q.includes(r.toLowerCase())) out.add(r.toLowerCase())
  }
  return [...out]
}

const RESAMPLE_SYSTEM =
  'Answer the factual question directly and concisely in one sentence. State only the answer — no preamble. If you are not sure, say "unsure".'

/**
 * Corroborate a drafted short-factual answer with K independent resamples (+ any installed
 * ensemble models). Never throws; returns null when the draft has no extractable claim or
 * fewer than 2 total votes materialized (nothing to corroborate against → caller leaves the
 * draft as-is, unstamped).
 */
export async function corroborateFact(
  message: string,
  draft: string,
  opts: { samples?: number; complete?: Completer; timeoutMs?: number } = {},
): Promise<FactConsensus | null> {
  const listShaped = isListQuestion(message)
  const key = extractClaimKey(draft, message)
  if (!key && !listShaped) return null
  const complete = opts.complete ?? fmComplete
  const resamples = Math.max(2, (opts.samples ?? 3) - 1)

  const texts: string[] = []
  const ensembleModels: string[] = []

  // Independent FM resamples (higher temperature → decorrelated confabulations).
  const fmRuns = await Promise.all(Array.from({ length: resamples }, async () => {
    try {
      return await complete(
        [{ role: 'system', content: RESAMPLE_SYSTEM }, { role: 'user', content: message }],
        { temperature: 0.7 },
      )
    } catch { return '' }
  }))
  for (const r of fmRuns) if (r?.trim()) texts.push(r)

  // Ensemble voters: every installed non-FM local model (zero on an uninstalled machine).
  try {
    const registry = getRegistry().filter(m => m.info.family !== 'apple-fm')
    if (registry.length) {
      const outs = await orchestrate(
        { modelIds: registry.map(m => m.info.id), mode: 'all', reason: 'fact-consensus ensemble voters' },
        `${RESAMPLE_SYSTEM}\n\nQuestion: ${message}`,
        { registry, timeoutMs: opts.timeoutMs ?? 15000 },
      )
      for (const o of outs) {
        if (o.ok && o.text.trim()) { texts.push(o.text); ensembleModels.push(o.modelId) }
      }
    }
  } catch { /* ensemble is best-effort; FM-only consensus still stands */ }

  // List-shaped: EVERY claim the draft asserts must be corroborated by a quorum of resample
  // sets, and the claim count must match an explicitly asked count.
  if (listShaped) {
    const claims = extractClaimSet(draft, message)
    if (!claims.length) return null
    const sets = texts.map(t => extractClaimSet(t, message)).filter(s => s.length)
    const votes = sets.length + 1
    if (votes < 2) return null
    const quorum = Math.max(1, Math.floor(sets.length / 2) + 1)
    const corroborated = claims.filter(c => sets.filter(s => s.some(k => keysAgree(k, c))).length >= quorum)
    const want = askedCount(message)
    const confirmed = corroborated.length === claims.length && (want === null || claims.length === want)
    return { confirmed, agreement: corroborated.length / claims.length, votes, key: claims.join(', '), ensembleModels }
  }

  const voteKeys = texts.map(t => extractClaimKey(t, message)).filter((k): k is string => !!k && !/^unsure$/.test(k))
  const votes = voteKeys.length + 1 // + the draft itself
  if (votes < 2) return null

  const agreeing = 1 + voteKeys.filter(k => keysAgree(k, key!)).length
  const quorum = Math.max(2, Math.floor(votes / 2) + 1)
  return { confirmed: agreeing >= quorum, agreement: agreeing / votes, votes, key: key!, ensembleModels }
}

/** The explicit unverified note appended when corroboration fails (honesty over confidence). */
export const UNVERIFIED_NOTE =
  '\n\n*Note: independent checks did not agree on this answer — treat it as unverified.*'
