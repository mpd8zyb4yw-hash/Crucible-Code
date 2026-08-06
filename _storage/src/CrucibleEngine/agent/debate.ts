// Co-equal debate ensemble — the "council" upgrade over flat fan-out corroboration.
//
// Doctrine (cont.58c): two-plus independently-trained on-device models are PEERS, not a
// primary with backups. Each proposes an answer blind, then each cross-examines the
// others' answers and may revise its own. The verdict is deterministic (consensus.ts):
// oracle arithmetic beats votes, mutual-agreement clusters beat lone voices, and honest
// low confidence is reported when the council stays split. Independent training lineages
// agreeing after adversarial review is real corroboration — far stronger evidence than
// K samples of one model — and a hallucination by one peer gets caught by the other.
//
// The engine is model-agnostic: peers are injected as plain async callables, so the whole
// debate is deterministically testable with scripted models (__debate_bench.ts) and the
// live wiring (Apple FM + GGUF pool incl. MiniCPM) is just a different peer list.

import { type CandidateAnswer, type ConsensusMethod, scoreAnswer, agrees, strengthenCandidates } from './consensus'

export interface DebatePeer {
  modelId: string
  modelLabel: string
  /** system+user in, plain text out — same shape as callLocalModel / fmDirectAnswer. */
  call: (system: string, user: string) => Promise<string>
}

export interface DebateEntry {
  modelId: string
  modelLabel: string
  text: string
  latencyMs: number
  errored: boolean
  /** Rebuttal round only: true when this peer abandoned its round-1 position. */
  changedPosition?: boolean
}

export interface DebateRoundLog {
  kind: 'propose' | 'rebut'
  entries: DebateEntry[]
}

export type DebateAgreement = 'unanimous' | 'majority' | 'contested' | 'solo'

export interface DebateResult {
  text: string
  winnerId: string
  winnerLabel: string
  confidence: number
  contributors: string[]
  method: ConsensusMethod
  agreement: DebateAgreement
  rounds: DebateRoundLog[]
  /** True when cross-examination changed at least one peer's answer — the debate did work. */
  mindsChanged: boolean
  totalLatencyMs: number
}

export interface DebateOpts {
  /** Per-peer-call timeout; a hung model never blocks the council. Default 45s. */
  timeoutMs?: number
  /** Skip the rebuttal round when round-1 proposals already all mutually agree. Default true. */
  earlyExitOnUnanimity?: boolean
  /** Already-computed round-1 answers (e.g. the router's primary call) keyed by modelId —
   *  those peers are not re-asked in the propose round but still participate in rebuttal. */
  seedProposals?: Array<{ modelId: string; modelLabel: string; text: string; latencyMs?: number }>
}

const REBUTTAL_SYSTEM = [
  'You are one voice on a council of independent AI models answering the same question.',
  'You will see your own previous answer and the answers of your peers.',
  'Scrutinize the peer answers for factual errors, bad math, or flawed logic — do not defer to them.',
  'If a peer found a genuine flaw in your answer, fix it. If your answer stands, keep it.',
  'Reply with ONLY your final answer to the original question — no meta-commentary about the debate.',
].join(' ')

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

async function callPeer(peer: DebatePeer, system: string, user: string, timeoutMs: number): Promise<DebateEntry> {
  const t0 = Date.now()
  try {
    const text = (await withTimeout(peer.call(system, user), timeoutMs, peer.modelId)).trim()
    return { modelId: peer.modelId, modelLabel: peer.modelLabel, text, latencyMs: Date.now() - t0, errored: false }
  } catch {
    return { modelId: peer.modelId, modelLabel: peer.modelLabel, text: '', latencyMs: Date.now() - t0, errored: true }
  }
}

function toCandidate(e: DebateEntry): CandidateAnswer {
  const { score, reason } = scoreAnswer(e.text)
  return { modelId: e.modelId, modelLabel: e.modelLabel, text: e.text, confidence: score, reason }
}

/** All pairs mutually agree — the strongest signal the council can emit. */
function allMutuallyAgree(entries: DebateEntry[]): boolean {
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (!agrees(entries[i].text, entries[j].text)) return false
    }
  }
  return true
}

function classifyAgreement(contributors: string[], voters: number): DebateAgreement {
  if (voters <= 1) return 'solo'
  if (contributors.length === voters) return 'unanimous'
  if (contributors.length * 2 > voters) return 'majority'
  return 'contested'
}

/**
 * Run a full council debate: blind proposals → cross-examination/revision → deterministic
 * verdict. Degrades honestly: one live peer → its answer marked 'solo' with uncapped-but-
 * unboosted confidence; zero live peers → null (caller falls back).
 */
export async function runDebate(
  peers: DebatePeer[],
  system: string,
  user: string,
  opts: DebateOpts = {},
): Promise<DebateResult | null> {
  const timeoutMs = opts.timeoutMs ?? 45_000
  const earlyExit = opts.earlyExitOnUnanimity !== false
  const t0 = Date.now()
  const rounds: DebateRoundLog[] = []

  // Round 1 — blind proposals in parallel. No peer sees another's answer yet. Seeded
  // answers (already computed by the caller) slot in without a second inference call.
  const seeds = new Map((opts.seedProposals ?? []).map(s => [s.modelId, s]))
  const proposals = await Promise.all(peers.map(p => {
    const seed = seeds.get(p.modelId)
    if (seed && seed.text.trim()) {
      return Promise.resolve<DebateEntry>({
        modelId: p.modelId, modelLabel: p.modelLabel, text: seed.text.trim(),
        latencyMs: seed.latencyMs ?? 0, errored: false,
      })
    }
    return callPeer(p, system, user, timeoutMs)
  }))
  rounds.push({ kind: 'propose', entries: proposals })
  const live = proposals.filter(e => !e.errored && e.text.length > 0)
  if (live.length === 0) return null

  if (live.length === 1) {
    const only = toCandidate(live[0])
    return {
      text: only.text, winnerId: only.modelId, winnerLabel: only.modelLabel,
      confidence: only.confidence, contributors: [only.modelId], method: 'single-model',
      agreement: 'solo', rounds, mindsChanged: false, totalLatencyMs: Date.now() - t0,
    }
  }

  // Early exit — unanimous blind agreement needs no cross-examination; the verdict below
  // still runs the oracle pass, so a shared arithmetic slip is corrected regardless.
  let finalEntries = live
  if (!(earlyExit && allMutuallyAgree(live))) {
    // Round 2 — cross-examination. Each live peer sees the OTHERS' proposals and revises.
    const byId = new Map(peers.map(p => [p.modelId, p]))
    const rebuttals = await Promise.all(live.map(async own => {
      const peer = byId.get(own.modelId)!
      const others = live.filter(e => e.modelId !== own.modelId)
        .map((e, i) => `Peer ${i + 1} answered:\n${e.text}`).join('\n\n')
      const prompt = [
        `Original question:\n${user}`,
        `Your previous answer:\n${own.text}`,
        others,
        'Give your final answer to the original question.',
      ].join('\n\n')
      const entry = await callPeer(peer, REBUTTAL_SYSTEM, prompt, timeoutMs)
      // An errored/empty rebuttal must not erase a good proposal — the peer's round-1
      // position stands.
      if (entry.errored || !entry.text) return { ...own, changedPosition: false }
      return { ...entry, changedPosition: !agrees(own.text, entry.text) }
    }))
    rounds.push({ kind: 'rebut', entries: rebuttals })
    finalEntries = rebuttals
  }

  // Verdict — deterministic, shared with the flat-corroboration path.
  const verdict = strengthenCandidates(finalEntries.map(toCandidate))
  const winner = finalEntries.find(e => e.modelId === verdict.winnerId) ?? finalEntries[0]
  return {
    text: verdict.text,
    winnerId: verdict.winnerId,
    winnerLabel: winner.modelLabel,
    confidence: verdict.confidence,
    contributors: verdict.contributors,
    method: verdict.method,
    agreement: classifyAgreement(verdict.contributors, finalEntries.length),
    rounds,
    mindsChanged: finalEntries.some(e => e.changedPosition === true),
    totalLatencyMs: Date.now() - t0,
  }
}
