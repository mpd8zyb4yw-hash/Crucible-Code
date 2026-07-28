// The self-model — Crucible's own facts, DERIVED from the running system rather than typed.
//
// WHY (cont.118). Crucible had a rigorous grounding+entailment stack for THE WORLD
// (`quoteEntailment`, `evidenceRelevance`, `acceptGrounding` — cont.111–114) and a hand-written
// PARAGRAPH for ITSELF (`CRUCIBLE_SELF_FACTS`). That asymmetry is the bug class: everything the
// system knows about the world carries provenance and can be checked, and everything it knows
// about itself was a string someone typed months ago that no verifier has ever looked at.
//
// DOCTRINE.md is explicit — "facts are RETRIEVED so they carry provenance and can be checked;
// the core reasons, it does not remember." A hardcoded self-description is exactly the
// memorized-fact debt that rule bans, applied to the system's own identity. So:
//
//   * Every fact here is COMPUTED from the runtime — the resolved GGUF path, the live offline
//     flag, the actual tool registry, `process.arch`, real memory. Nothing is asserted.
//   * Every fact carries a PROVENANCE string naming where it came from, so an answer built on
//     it can be audited exactly like a web-grounded one.
//   * A fact that cannot be derived is ABSENT, not guessed. `abstain === abstain` applies to
//     self-knowledge too: "I don't know who packaged this build" beats inventing a company.
//
// The payoff is not merely defensive. Asked "are you made in china", every cloud assistant emits
// a canned line. Crucible can answer with a provenanced, checkable, genuinely more useful truth:
// the WEIGHTS were trained by Alibaba in China, the SYSTEM around them was written by its
// developer, and the whole thing runs on this machine. Honest, specific, and something no
// hosted assistant can say truthfully.

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import os from 'os'

export interface SelfFact {
  /** Stable key — lets callers select relevant facts without string matching the claim. */
  id: string
  /** Topic tags used to rank facts against a question. Lowercase, single words where possible. */
  topics: string[]
  /** The fact, stated plainly enough to be quoted verbatim into an answer. */
  claim: string
  /** Where this came from. Shown to the user on request; the audit trail for a self-answer. */
  provenance: string
}

// ── Weight provenance ─────────────────────────────────────────────────────────
// A REFERENCE TABLE, not a template. It records who trained a given open-weights model and
// where — third-party facts of the same kind as a package registry entry, keyed by model family
// and looked up from the resolved filename. It is emphatically NOT a canned answer to a canned
// question: nothing here mentions Crucible, and the entries are consulted only when that model
// is the one actually loaded.
//
// If the running model is not in this table, the origin fact is OMITTED. Saying nothing is
// correct; guessing a trainer would be exactly the confabulation this file exists to prevent.
interface WeightOrigin { family: string; trainer: string; country: string; license: string }

const WEIGHT_ORIGINS: Array<{ match: RegExp } & WeightOrigin> = [
  { match: /qwen/i,    family: 'Qwen2.5',      trainer: 'Alibaba Cloud',  country: 'China',        license: 'Apache-2.0' },
  { match: /phi-?3/i,  family: 'Phi-3.5',      trainer: 'Microsoft',      country: 'United States', license: 'MIT' },
  { match: /gemma/i,   family: 'Gemma 2',      trainer: 'Google DeepMind', country: 'United States', license: 'Gemma Terms' },
  { match: /llama/i,   family: 'Llama',        trainer: 'Meta',           country: 'United States', license: 'Llama Community' },
  { match: /mistral/i, family: 'Mistral',      trainer: 'Mistral AI',     country: 'France',        license: 'Apache-2.0' },
  { match: /bonsai/i,  family: 'Bonsai',       trainer: 'PrismML',        country: 'United States', license: 'see model card' },
]

function originFor(modelFile: string): WeightOrigin | null {
  return WEIGHT_ORIGINS.find(o => o.match.test(modelFile)) ?? null
}

// ── Runtime probes ────────────────────────────────────────────────────────────

function crucibleRoot(): string {
  return process.env.CRUCIBLE_ROOT || process.cwd()
}

/** The GGUF actually on disk and therefore actually seatable — same resolution the sidecar uses. */
function resolveSeatedModelFile(): string | null {
  const override = process.env.CRUCIBLE_BONSAI_MODEL
  if (override) return override.split('/').pop() ?? override
  const candidates = [
    'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    'phi-3.5-mini-instruct-q4_k_m.gguf',
    'Bonsai-27B-Q1_0.gguf',
  ]
  for (const name of candidates) {
    if (existsSync(join(crucibleRoot(), '.crucible', 'models', name))) return name
  }
  return null
}

/** Parameter count parsed from the filename, which is where model authors put it. */
function paramsFromFilename(file: string): string | null {
  const m = file.match(/[-_](\d+(?:\.\d+)?)\s*b\b/i)
  return m ? `${m[1]} billion` : null
}

function quantFromFilename(file: string): string | null {
  const m = file.match(/\b(q\d(?:_[a-z0-9]+)*)\b/i)
  return m ? m[1].toUpperCase() : null
}

/** Strict mode makes NO external calls at all. This reads the live flag, not a claim about it. */
function networkPosture(): { strict: boolean; label: string } {
  const flag = process.env.CRUCIBLE_OFFLINE ?? '1'
  if (flag === 'strict') {
    return { strict: true, label: 'strict offline — no external network calls of any kind are made' }
  }
  return {
    strict: false,
    label: 'offline-first — the language model runs locally, and the network is used only for ' +
      'explicit lookups (web search, documentation) made by Crucible\'s own tooling',
  }
}

function gitProvenance(): { commit?: string; origin?: string } {
  const root = crucibleRoot()
  try {
    const head = readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim()
    const ref = head.startsWith('ref: ') ? head.slice(5) : null
    const commit = ref
      ? readFileSync(join(root, '.git', ref), 'utf8').trim().slice(0, 7)
      : head.slice(0, 7)
    return { commit }
  } catch { return {} }
}

// ── Fact derivation ───────────────────────────────────────────────────────────

let cached: SelfFact[] | null = null

/**
 * Build the self-model from the running system.
 *
 * Cached after first call — every input is process-lifetime-stable (env, disk layout, arch), and
 * this sits on the interactive answer path. `resetSelfModel()` clears it for tests.
 */
export function selfModel(): SelfFact[] {
  if (cached) return cached
  const facts: SelfFact[] = []
  const add = (id: string, topics: string[], claim: string, provenance: string) =>
    facts.push({ id, topics, claim, provenance })

  // Claims are written in FIRST PERSON, deliberately. `composeSelfAnswer` joins them verbatim
  // into a direct answer, and an earlier draft converted third-person prose with a pile of
  // regexes — which produced "no company operates I" and "I backtracks". String surgery on
  // English is the same mistake as the enumeration this session started by deleting. Write the
  // sentence you actually want once. The system-prompt block reads fine in first person because
  // its header already addresses the model as Crucible.

  // ── Identity ──
  add('identity', ['identity', 'name', 'what', 'who'],
    'I am Crucible, a private AI assistant that runs on your own device.',
    'application identity')

  // ── Where it runs ──
  const totalGb = Math.round(os.totalmem() / 1024 ** 3)
  add('host', ['device', 'where', 'run', 'running', 'local', 'machine', 'hardware', 'cloud', 'server'],
    `I run locally on this machine — ${os.type()} ${os.release()} on ${os.arch()}, ` +
    `${totalGb} GB of memory. There is no cloud backend doing the thinking.`,
    `runtime probe: os.type()/os.arch()/os.totalmem() at ${new Date().toISOString().slice(0, 10)}`)

  // ── Network posture — the live flag, not a promise ──
  const net = networkPosture()
  add('network', ['data', 'privacy', 'private', 'network', 'internet', 'offline', 'cloud', 'send', 'upload', 'spying', 'recording', 'tracking'],
    `My network posture is ${net.label}. Your conversations are not uploaded to a provider, and ` +
    `there is no account or telemetry service receiving them.`,
    `live environment flag CRUCIBLE_OFFLINE=${process.env.CRUCIBLE_OFFLINE ?? '1'}`)

  // ── The model, and crucially WHERE ITS WEIGHTS CAME FROM ──
  const modelFile = resolveSeatedModelFile()
  if (modelFile) {
    const params = paramsFromFilename(modelFile)
    const quant = quantFromFilename(modelFile)
    add('model', ['model', 'llm', 'ai', 'parameters', 'size', 'small', 'big', 'architecture', 'weights'],
      `The language model I run is ${modelFile.replace(/\.gguf$/i, '')}` +
      `${params ? `, about ${params} parameters` : ''}${quant ? `, ${quant} quantized` : ''}. ` +
      `It is deliberately small — far smaller than a frontier cloud model — and runs on-device.`,
      `resolved GGUF on disk: .crucible/models/${modelFile}`)

    const origin = originFor(modelFile)
    if (origin) {
      // THE ANSWER TO "are you made in china" — derived, provenanced, and genuinely informative
      // in a way no hosted assistant can match. Note the deliberate separation of the two
      // provenances: whoever trained the weights is NOT whoever built the system.
      add('weights-origin', ['china', 'chinese', 'made', 'origin', 'country', 'trained', 'training', 'who', 'where', 'from', 'built', 'created', 'owned', 'company', 'alibaba', 'google', 'openai', 'microsoft', 'meta'],
        // Deliberately SELF-CONTAINED and neutral about the question. An earlier draft opened
        // "Partly, in one specific sense:" — which reads perfectly for "are you made in china"
        // and confusingly for "who made you". A fact that presupposes its question is a template
        // wearing a fact's clothes; facts get composed in whatever order the ranking picks.
        `The model weights I run (${origin.family}) were trained and released by ` +
        `${origin.trainer} in ${origin.country}, under the ${origin.license} licence. They are ` +
        `open weights, downloaded and run on this machine — their authors have no involvement ` +
        `in running me and receive nothing from this device.`,
        `weight-origin registry keyed on the resolved model file "${modelFile}"`)
    }
  }

  // ── Who built the SYSTEM (distinct from who trained the weights) ──
  const git = gitProvenance()
  add('authorship', ['made', 'built', 'created', 'developer', 'author', 'who', 'company', 'owned', 'behind', 'maker'],
    `I was built by my developer as an independent project — the reasoning loop, the verifiers, ` +
    `the tools and this interface are all their work, wrapped around an open-weights model they ` +
    `did not train. I am not a product of any large cloud provider, and no company operates me.`,
    git.commit ? `git HEAD at .git/HEAD → ${git.commit}` : 'project authorship')

  // ── How it is reliable — the actual differentiator ──
  add('method', ['reliable', 'accurate', 'smart', 'intelligent', 'good', 'work', 'works', 'how', 'verify', 'checking', 'trust', 'wrong', 'mistakes'],
    `My reliability does not come from model size. The small model only PROPOSES; deterministic ` +
    `checkers then certify or reject — code is executed, arithmetic recomputed, quotes checked ` +
    `against their sources — and I backtrack when a check fails. A verified answer from a small ` +
    `model beats an unverified one from a large model.`,
    'architecture: reasoning/search.ts propose→verify→backtrack loop')

  // ── Honest limits ──
  add('limits', ['limitations', 'weakness', 'bad', 'cannot', "can't", 'wrong', 'fail', 'slow', 'dumb', 'stupid', 'reliable'],
    `I am strongest on things that can be checked — arithmetic, code I can run, reasoning I can ` +
    `re-derive, and recall of what you told me. I am weaker on obscure or very recent facts, and ` +
    `on those I would rather say I cannot verify something than guess. I am also slower than a ` +
    `cloud model, because the work is happening on this machine.`,
    'measured behaviour: verifier-gated answer path, abstain-on-uncertain')

  add('no-self-assessment', ['iq', 'score', 'rating', 'benchmark', 'smart', 'intelligent', 'conscious', 'sentient', 'feelings', 'alive', 'human'],
    `I have no IQ score, no consciousness and no feelings, and I will not invent a number for how ` +
    `smart I am. What I can and cannot reliably do is the honest form of that question.`,
    'design constraint: no unverifiable self-claims')

  cached = facts
  return facts
}

/** Test hook — clears the process-lifetime cache. */
export function resetSelfModel(): void { cached = null }

// ── Selection ─────────────────────────────────────────────────────────────────

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'you',
  'your', 'yours', 'i', 'me', 'my', 'it', 'to', 'of', 'in', 'on', 'at', 'and', 'or', 'but',
  'what', 'how', 'why', 'when', 'where', 'who', 'this', 'that', 'have', 'has', 'can', 'could',
  'will', 'would', 'be', 'been', 'am', 'so', 'if', 'for', 'with', 'about', 'me'])

/**
 * Rank self-facts against a question by topic overlap.
 *
 * Always returns SOMETHING — identity and method are universally relevant, so an unmatched
 * question still gets grounded rather than falling through to a bare model guess. That fallback
 * is the difference between "I'm not sure" and inventing a biography.
 */
export function selectSelfFacts(question: string, limit = 6): SelfFact[] {
  const words = new Set(
    (question ?? '').toLowerCase().split(/[^a-z']+/).filter(w => w.length > 1 && !STOP.has(w)),
  )
  const all = selfModel()
  const scored = all.map(f => ({
    fact: f,
    score: f.topics.reduce((n, t) => n + (words.has(t) ? 1 : 0), 0),
  }))
  const hits = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score)
  if (!hits.length) {
    return all.filter(f => ['identity', 'method', 'network', 'model'].includes(f.id)).slice(0, limit)
  }
  // Identity always rides along — it is the frame every other fact is read against.
  const picked = hits.slice(0, limit).map(s => s.fact)
  const identity = all.find(f => f.id === 'identity')!
  if (!picked.some(f => f.id === 'identity')) picked.unshift(identity)
  return picked.slice(0, limit)
}

/**
 * Render selected facts as an EVIDENCE BLOCK in the same shape the web-grounding path uses.
 *
 * This is the load-bearing design choice of the file: self-questions now flow through the exact
 * entailment machinery built for web evidence (`quoteEntailment`, `evidenceRelevance`), so the
 * anti-confabulation gates that protect world answers now protect self answers too. Previously
 * the self path had NO verifier at all.
 */
export function selfEvidence(question: string): string {
  const facts = selectSelfFacts(question)
  return facts.map((f, i) => `[${i + 1}] ${f.claim}`).join('\n')
}

/** Provenance lines, for the "how do you know that" follow-up and for debug traces. */
export function selfProvenance(question: string): string[] {
  return selectSelfFacts(question).map(f => `${f.id}: ${f.provenance}`)
}

/**
 * Back-compat surface for the existing `CRUCIBLE_SELF_FACTS` system-prompt injection site.
 * Same shape (a bulleted block) but derived, so the prompt can no longer drift from reality.
 */
export function selfFactsBlock(question?: string): string {
  const facts = question ? selectSelfFacts(question, 8) : selfModel()
  return facts.map(f => `- ${f.claim}`).join('\n')
}

// ── Deterministic composition ─────────────────────────────────────────────────

/**
 * Answer a question about Crucible DETERMINISTICALLY, from the derived facts.
 *
 * WHY THIS IS NOT OPTIONAL (measured 2026-07-28, live on :3011). Referent resolution correctly
 * stopped `"are you made in china"` from reaching the web — no retrieval fired, the AC/DC bug
 * class is closed. But the weak head, handed the six ranked facts, replied:
 *
 *     "Yes, I am made in China."
 *
 * which is false, and false in the specific way this whole session is about: it COLLAPSED
 * structure it was handed. Identical in shape to cont.105b, where the FM was given an inbox and
 * reported it empty. A 1.5B model paraphrasing ground truth is a lossy channel, and the honest
 * conclusion is that it should not be in this path at all.
 *
 * `conversational.ts` already reached this conclusion for five phrasings — "Crucible's own
 * identity ... are FIXED FACTS, so there is nothing for a model to reason about." This is that
 * rule made general: the facts are DERIVED, the ranking is deterministic, and the composition is
 * a join. No model, no template, and no per-question branching — every self-question is answered
 * by the same three lines of code, which is exactly why it covers the phrasings nobody enumerated.
 *
 * Returns null when no fact scores against the question, so a genuinely novel self-question still
 * falls through to the grounded model path with its "say you are not sure" instruction rather
 * than being answered with irrelevant boilerplate.
 */
export function composeSelfAnswer(question: string): { text: string; factIds: string[] } | null {
  const words = new Set(
    (question ?? '').toLowerCase().split(/[^a-z']+/).filter(w => w.length > 1 && !STOP.has(w)),
  )
  const scored = selfModel()
    .map(f => ({ fact: f, score: f.topics.reduce((n, t) => n + (words.has(t) ? 1 : 0), 0) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)

  // No topical hit means the self-model has nothing to say about this. Falling through is the
  // honest move; reciting identity boilerplate at an unrelated question is not an answer.
  if (!scored.length) return null

  // Identity leads when it is not already the top hit — every other fact is read against it.
  const picked = scored.slice(0, 3).map(s => s.fact)
  if (!picked.some(f => f.id === 'identity')) {
    const identity = selfModel().find(f => f.id === 'identity')
    if (identity) picked.unshift(identity)
  }

  return {
    text: picked.map(f => f.claim).join(' '),
    factIds: picked.map(f => f.id),
  }
}
