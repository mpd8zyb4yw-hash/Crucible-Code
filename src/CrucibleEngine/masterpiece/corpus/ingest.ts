// MASTERPIECE corpus — document ingestion
// Splits documents into semantic chunks, embeds each chunk, stores in SQLite.
// The seed corpus is defined here and loaded on first startup automatically.

import { embed, embeddingDim, ensureEmbedderReady } from './embed.js'
import { stmts, resetCorpusChunks } from './db.js'

const CHUNK_TARGET_TOKENS = 200   // ~200 words per chunk
const CHUNK_OVERLAP_SENTENCES = 2 // sentences shared between adjacent chunks

export interface IngestInput {
  title: string
  domain: string
  source?: string
  confidence?: number
  text: string
}

export async function ingestDocument(doc: IngestInput): Promise<number> {
  const s = stmts()
  const now = Date.now()
  const docResult = s.insertDocument.run(
    doc.title,
    doc.domain,
    doc.source ?? null,
    doc.confidence ?? 1.0,
    now,
  )
  const docId = docResult.lastInsertRowid as number

  const chunks = splitIntoChunks(doc.text)
  for (const chunk of chunks) {
    const embVec = await embed(chunk)
    const embBuf = Buffer.from(embVec.buffer)
    s.insertChunk.run(docId, chunk, doc.domain, doc.confidence ?? 1.0, embBuf, now)
  }
  return docId
}

function splitIntoChunks(text: string): string[] {
  const sentences = text
    .replace(/([.!?])\s+/g, '$1\n')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)

  const chunks: string[] = []
  let buffer: string[] = []
  let tokenCount = 0

  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).length
    if (tokenCount + words > CHUNK_TARGET_TOKENS && buffer.length > 0) {
      chunks.push(buffer.join(' '))
      // Keep overlap
      buffer = buffer.slice(-CHUNK_OVERLAP_SENTENCES)
      tokenCount = buffer.reduce((sum, s) => sum + s.split(/\s+/).length, 0)
    }
    buffer.push(sentence)
    tokenCount += words
  }
  if (buffer.length > 0) chunks.push(buffer.join(' '))
  return chunks
}

// ── Seed corpus ────────────────────────────────────────────────────────────
// Curated cross-domain knowledge units for abductive connection finding.
// Each entry is a condensed but information-dense passage, not a summary.

const SEED_CORPUS: IngestInput[] = [
  {
    title: 'Information Theory Fundamentals',
    domain: 'information-theory',
    confidence: 1.0,
    text: `Shannon entropy H(X) = -Σ p(x) log₂ p(x) measures the average surprise in a random variable. High entropy means high uncertainty; low entropy means predictability. Channel capacity C = max I(X;Y) is the maximum rate at which information can be reliably transmitted. The noisy channel coding theorem states that as long as the information rate R < C, arbitrarily low error rates are achievable with appropriate encoding. Redundancy is the difference between channel capacity and actual information rate — it is the cost of reliability. Data compression exploits statistical structure to eliminate redundancy; lossless compression approaches the entropy limit. Mutual information I(X;Y) = H(X) - H(X|Y) quantifies how much knowing Y reduces uncertainty about X. Kolmogorov complexity is the length of the shortest program that produces a string — incompressible strings are algorithmically random. Rate-distortion theory formalises the trade-off between compression ratio and reconstruction fidelity.`,
  },
  {
    title: 'Evolutionary Biology — Selection and Adaptation',
    domain: 'evolutionary-biology',
    confidence: 1.0,
    text: `Natural selection acts on heritable variation in fitness-relevant traits. Fitness is reproductive success relative to alternatives — not "strength" in isolation. Drift (random sampling error) dominates when population sizes are small; selection dominates in large populations. The fitness landscape metaphor represents trait combinations as terrain — peaks are local optima, valleys require fitness cost to traverse. Punctuated equilibrium argues that speciation occurs rapidly after long stasis, contradicting strict gradualism. Exaptation: features evolved for one function later co-opted for another (e.g., feathers for insulation, later for flight). Evolvability — the capacity of a system to generate heritable phenotypic variation — is itself subject to selection. Gene regulatory networks, not just coding sequences, determine organismal complexity. Horizontal gene transfer in prokaryotes violates the tree-of-life metaphor; the web-of-life is more accurate. Niche construction: organisms modify their environments, which then feed back on their own selection pressures.`,
  },
  {
    title: 'Thermodynamics and Statistical Mechanics',
    domain: 'thermodynamics',
    confidence: 1.0,
    text: `The first law: energy is conserved. The second law: entropy of an isolated system does not decrease — processes are irreversible. Boltzmann's S = k_B ln Ω connects macro thermodynamics to microscopic state counts. Free energy F = U - TS is minimised at equilibrium for constant-temperature systems; reactions proceed spontaneously in the direction of decreasing free energy. Dissipative structures (Prigogine) arise far from equilibrium — they consume energy to maintain order. Living systems are thermodynamically open: they export entropy to the environment while locally maintaining or increasing order. Maxwell's demon thought experiment: an intelligent agent sorting molecules would require information, and erasing that information (Landauer's principle) costs exactly the thermodynamic work the demon appeared to recover. Fluctuation theorems quantify transient violations of the second law at small scales. Heat death: the ultimate equilibrium state of a closed universe with maximum entropy and no available work.`,
  },
  {
    title: 'Cognitive Science — Predictive Processing',
    domain: 'cognitive-science',
    confidence: 1.0,
    text: `The predictive brain hypothesis (Helmholtz, updated by Friston) holds that the brain is a generative model constantly predicting sensory input and minimising prediction error. Perception is active inference: the brain weighs predictions against incoming signals, updating beliefs to minimise surprise. Attention is precision-weighting — assigning higher confidence to particular prediction errors. Action is also inference: proprioceptive predictions are fulfilled by moving the body to create the predicted sensory state. The free energy principle formalises this: biological systems resist entropy by minimising their variational free energy, a bound on surprise. Bayesian brain: beliefs are probability distributions, not point estimates. Prior beliefs are shaped by development, learning, and culture. Predictive processing accounts for hallucination (priors overriding weak sensory evidence), perception (sensory evidence correcting priors), and top-down attention. Hierarchical predictive coding: higher cortical regions predict lower-level activations; mismatches propagate upward.`,
  },
  {
    title: 'Complex Systems — Emergence and Self-Organisation',
    domain: 'complex-systems',
    confidence: 1.0,
    text: `Emergence: macro-level properties that cannot be predicted from micro-level rules alone. Strong emergence (ontological): macro properties genuinely cannot be reduced. Weak emergence (epistemological): in principle reducible but computationally intractable. Self-organisation: spontaneous order arising from local interactions without central coordination. Examples: ant colony foraging, market price formation, neural synchrony, convection cells. Critical points: at phase transitions, systems exhibit scale-free fluctuations (power laws), long-range correlations, and maximal sensitivity to perturbations. Self-organised criticality (Bak): certain dynamical systems evolve to critical points without external tuning. Attractor landscapes: the set of stable states a system gravitates toward. Resilience: the capacity of a system to absorb perturbation and reorganise while undergoing change. Feedback loops (positive: amplifying, negative: stabilising) are the mechanism of both self-organisation and homeostasis.`,
  },
  {
    title: 'Game Theory — Strategic Interaction',
    domain: 'game-theory',
    confidence: 1.0,
    text: `Nash equilibrium: a strategy profile where no player benefits by unilaterally deviating. In many real games, Nash equilibria are neither efficient nor unique. The prisoner's dilemma shows that individual rationality produces collective irrationality — both defect though mutual cooperation yields higher payoffs. Repeated games enable cooperation: shadow of the future incentivises defection deterrence (tit-for-tat). Mechanism design (reverse game theory): design rules of a game to produce desired equilibria. Evolutionary game theory: strategies with higher payoffs replicate; equilibrium selection occurs via selection dynamics, not reasoning. Signalling games model costly signals that credibly communicate private information (the handicap principle in biology). Schelling points: salient solutions people converge on without communication. Correlated equilibrium is more general than Nash — a mediator recommends strategies, players comply because deviation is individually irrational.`,
  },
  {
    title: 'Philosophy of Science — Epistemology and Falsifiability',
    domain: 'philosophy-of-science',
    confidence: 1.0,
    text: `Popper: scientific claims must be falsifiable — testable, in principle, by observations that could prove them wrong. Unfalsifiable claims (metaphysics, pseudoscience) may be meaningful but are not scientific. The Duhem-Quine thesis: no hypothesis is tested in isolation; auxiliary assumptions are always present. Failed predictions implicate the whole system, not just the target hypothesis — this is the problem of underdetermination. Bayesian epistemology: rational belief revision is probability updating via Bayes' theorem. Prior probability × likelihood of evidence ∝ posterior probability. Lakatos: scientific progress occurs in research programmes with a hard core (unfalsifiable) protected by a belt of auxiliary hypotheses that can be modified. Kuhn: science proceeds through normal science (puzzle-solving within a paradigm) punctuated by revolutions (paradigm shifts). Explanatory coherence and simplicity (Occam's razor) are epistemic virtues beyond strict empirical adequacy.`,
  },
  {
    title: 'Network Science — Topology and Dynamics',
    domain: 'network-science',
    confidence: 1.0,
    text: `Scale-free networks have degree distributions following power laws — most nodes have few connections, a few hubs have many. Small-world networks combine high clustering with short average path lengths (Watts-Strogatz). Percolation theory: above a critical threshold of random link removal, a giant connected component survives; below it, the network fragments. Robustness to random failures but vulnerability to targeted hub attacks is a signature of scale-free networks. Spreading processes (disease, information, innovation) follow network topology — hubs accelerate propagation. Community structure: dense intra-community links, sparse inter-community links. Motifs: recurring structural patterns that appear more than in random networks with the same degree sequence. Network cascades: failures propagate through dependency links, creating systemic risk. Multiplexity: real systems are often multi-layer networks where different types of links coexist.`,
  },
  {
    title: 'Economics — Mechanism and Institutions',
    domain: 'economics',
    confidence: 1.0,
    text: `Markets aggregate dispersed private information through prices — Hayek's price system as a knowledge distribution mechanism. Externalities: costs or benefits not captured in market prices lead to under- or over-provision (commons tragedies, pollution). Public goods: non-excludable, non-rivalrous — markets under-provide without intervention. Information asymmetry: adverse selection (hidden information before a contract), moral hazard (hidden action after). Coase theorem: in the absence of transaction costs, initial property right assignment is irrelevant to efficient outcomes — parties will bargain to efficiency. Bounded rationality: agents use heuristics and satisfice rather than optimising. Coordination failures: multiple equilibria exist; which is reached depends on expectations (self-fulfilling prophecies, bank runs). Institutional economics: durable rules, norms, and organisations that constrain and enable collective action. Path dependence: historical accidents lock in suboptimal standards (QWERTY, VHS).`,
  },
  {
    title: 'Computer Science — Computation and Complexity',
    domain: 'computer-science',
    confidence: 1.0,
    text: `Turing completeness: a system that can simulate any Turing machine. Church-Turing thesis: all effectively computable functions are Turing-computable. Computability limits: the halting problem is undecidable — no program can always determine if an arbitrary program halts. Rice's theorem: all non-trivial semantic properties of programs are undecidable. Complexity classes: P (deterministic polynomial), NP (nondeterministic polynomial), the P=NP question. NP-complete problems: every NP problem reduces to them — solving one efficiently solves all. Space-time trade-offs: algorithms can often exchange memory for speed or vice versa. Randomised algorithms: use randomness to simplify or speed up computation; probabilistically correct. Cryptographic assumptions: most modern security relies on problems believed to be hard (factoring, discrete log) but not proven so. Gödel's incompleteness: any sufficiently powerful consistent formal system contains true statements it cannot prove.`,
  },
]

let _seeded = false

export async function ensureSeedCorpus(): Promise<void> {
  if (_seeded) return
  const s = stmts()

  // Settle the embedder, then re-seed if the stored vectors are a different
  // dimension than the current scheme (e.g. after the char-hash → feature-hash
  // upgrade). Without this, stale-dimension chunks are silently skipped by every
  // query (query.ts drops dimension-mismatched rows) and the corpus reads empty.
  await ensureEmbedderReady()
  const expectedBytes = embeddingDim() * 4
  const sample = s.getSampleChunkEmbedding.get() as { embedding: Buffer | null } | undefined
  if (sample?.embedding && sample.embedding.byteLength !== expectedBytes) {
    console.log(`[MASTERPIECE] Embedding scheme changed (${sample.embedding.byteLength / 4}d → ${embeddingDim()}d) — re-seeding corpus`)
    resetCorpusChunks()
  }

  const row = s.getChunkCount.get() as { count: number }
  if (row.count > 0) {
    _seeded = true
    return
  }
  console.log('[MASTERPIECE] Seeding corpus with', SEED_CORPUS.length, 'documents...')
  for (const doc of SEED_CORPUS) {
    await ingestDocument(doc)
  }
  console.log('[MASTERPIECE] Corpus seed complete.')
  _seeded = true
}
