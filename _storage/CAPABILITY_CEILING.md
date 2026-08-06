# Crucible — The Capability Ceiling (research pass, 2026-07-27)

> Purpose: find the moves that raise BOTH the floor (stop embarrassing failures) and the
> ceiling (do things no cloud assistant can) **inside the doctrine** — small local core,
> zero paid model APIs, correctness from the loop.
>
> Method: diagnose the live code FIRST, then match against 2025–2026 literature. Every item
> below names its landing site in this repo. Nothing here is a template or a special case.

---

## THE ONE FINDING

**Crucible verifies its answers. It does not verify its understanding of the question.**

The entire VGR loop — formalize, propose, verify, backtrack, abstain — runs *downstream of a
routing decision that is itself a single-shot, unverified, un-abstainable regex guess.*

Every "why on earth did it do that" bug in the session log is a **comprehension** failure, not
an answer failure:

| bug | session | what was actually wrong |
|---|---|---|
| "who made you" → AC/DC lyric | pre-cont.111 | routed to web instead of self |
| "what's your IQ" → Madsen Pirie | cont.111 | routed to web instead of self |
| plain brief → screen-capture dump | cont.105 | routed to GUI tools |
| personal-data ask → "inbox is empty", 0 tool calls | cont.104 | routed to prose |
| **"are you made in china" → web search** | **observed** | **routed to web instead of self** |

Five bugs, one shape. Each was closed by adding another arm to an enumeration. The doctrine's
own test — *"where is the deterministic verifier, and what is the ground truth?"* — has **no
answer at the routing layer.** That is the ceiling. Everything below flows from lifting it.

### The observed bug, traced exactly

`"are you made in china"` in `answer/answerEngine.ts`:

```
matchMeta()          → null   // CREATOR has  are\s+you\s+made\s+by\s+\w+   — "by", not "in"
isSelfReferential()  → false  // SELF_REF_RX has  who (made|built|created) you  — not "are you made …"
isQuestionShaped     → true   // starts with "are"
isGenRequest         → false
⇒ groundingEligible  → true   (answerEngine.ts:629, the !isSelfReferential veto does not fire)
⇒ shouldResearch()   → true
⇒ web search on the literal string → pages about goods manufactured in China
```

**The veto at `answerEngine.ts:630` is architecturally correct.** The classifier feeding it is
an enumeration, and enumerations have an infinite tail. The gap between shipping and broken was
**one preposition**: `made by` is in the regex, `made in` is not.

Do not add `made in`. That is the whack-a-mole `DOCTRINE.md` bans.

---

## TIER 1 — raises the floor (comprehension gets a verifier)

### 1. Referent resolution replaces self-pattern enumeration

The question is not *"does this message match a self-pattern?"* (open, semantic, infinite tail).
It is *"what is the **referent** of this predication's subject?"* (closed, grammatical, finite).

- Strip the interrogative frame — `stripInterrogativeFrame()` already exists (`answerEngine.ts:155`)
  and already handles `"do you know who…"`, so `"you"` inside a knowledge frame is correctly
  *not* the topic.
- On the residual clause, if the subject is 2nd-person (`you|your|u|yourself|yours`) and the
  predication is not embedded → **referent = SELF**. Route to the self corpus. Never the web.
- Everything else keeps today's behavior.

This closes `made in`, `made in china`, `assembled in taiwan`, `owned by google`, `trained on
reddit`, `spying on me`, `cheaper than chatgpt`, and the entire unenumerable tail — with **one
rule that is smaller than the regex it deletes.** `SELF_REF_RX` (a 1,100-character regex) becomes
a fallback, not the gate.

**Lands:** `answer/answerEngine.ts` (`isSelfReferential` → `resolveReferent`),
`answer/conversational.ts`. **Bench:** `__abstention_bench.ts` already has the probe harness.

### 2. The self-model becomes a retrieval corpus, not a prose blob

Today `CRUCIBLE_SELF_FACTS` (`answerEngine.ts:316`) is a hand-written paragraph pasted into the
system prompt, and `conversational.ts` holds five more hardcoded answer strings. Crucible has a
rigorous grounding + entailment stack for **the world** (`quoteEntailment.ts`,
`evidenceRelevance.ts`, `acceptGrounding`, cont.111–114) and a **hardcoded paragraph for itself.**
That asymmetry *is* the bug class.

Build `answer/selfModel.ts` emitting **derived, provenanced facts** — computed at boot, not typed
by hand:

| fact | derived from |
|---|---|
| model id, param count, quantization | the loaded GGUF path / `modelRegistry.ts` |
| **who trained the weights, and where** | model registry metadata (Qwen2.5 → Alibaba, Hangzhou) |
| who wrote the system | `package.json`, git author |
| network posture | the live strict/offline flag, not a claim |
| host device, RAM ceiling | runtime probe |
| tool inventory | `tools/registry.ts` at runtime |
| current capability + known weaknesses | last bench run in `.crucible/` |

Then answer self-questions **through `answerWithWebGrounding`'s existing entailment path** with
the self corpus as the evidence set. Both failure modes die at once: no web search (wrong corpus)
*and* no confabulated persona (the `unentailedQuotes` / `subjectAbsentFromEvidence` gates already
built for web evidence now apply to self-evidence). A self-fact that is **computed** cannot go
stale and carries provenance — which is `DOCTRINE.md`'s "facts are retrieved, not memorized"
applied to the system's own identity.

**The payoff is a strictly better answer than any frontier assistant gives.** Asked "are you made
in china", every cloud assistant emits a canned corporate line. Crucible can say, grounded and
citable: *"The weights I run — Qwen2.5-1.5B — were trained by Alibaba in China. The system around
them was written by [dev] on this Mac. Nothing you type leaves this machine."* Honest, specific,
provenanced, and impossible for a cloud assistant to say truthfully. **Floor fix and ceiling
raise in the same commit.**

### 3. Paraphrase-entailment: a deterministic verifier for comprehension

The general form of #1. Before committing to an expensive route, the system restates what it
believes was asked, then **checks the restatement entails the original question** — using
`quoteEntailment.ts`, which already exists and is already sound.

- Entails → proceed, high confidence.
- Does not entail → the route is wrong. Re-route, or ask **one** clarifying question.

This gives the routing layer the two things it has never had: a **verifier** and an **abstain
path**. Ground truth for comprehension is cheap and sitting right there — *the user*. A
low-confidence route that asks one question beats a confident wrong route every time; that is
`abstain === abstain` applied to understanding.

**Lands:** new `answer/comprehension.ts`, called from `classifyFacets`'s caller.
Reuses `quoteEntailment.ts` wholesale.

### 4. Retrieval query formulation becomes a VGR search

Today the user's **literal message** is the search query (`retrievalLayer.search(query)`) — which
is precisely how `"are you made in china"` became a web query. This is the one major subsystem
where Crucible does *not* apply its own doctrine.

Make it the loop: **propose k query rewrites → execute → score by evidence sufficiency → backtrack
and re-query.** The reward signal already exists and is already deterministic:
`subjectAbsentFromEvidence` / `figuresAbsentFromEvidence` / `unentailedQuotes` (cont.111–114).
Today they are used only to **reject at the end**; they should be the **objective of a search**.
This is the highest-leverage reuse in the codebase — a whole retrieval-optimization loop from
parts already written and already trusted.

Literature confirms the ceiling: **DeepRetrieval** trained a *3B* query rewriter that beats GPT-4o
and Claude-3.5 on literature-search recall. They needed RL; Crucible does not — it has a
deterministic sufficiency judge, which is a *better* signal than a learned reward.

**Lands:** `retrieval/retrievalLayer.ts` + `answer/groundedAnswer.ts`. **Bench:** `__ground_rank_bench.ts`.

### 5. Retrieval tiers must start with the user's reality, not the web

**Verified:** `answerEngine.ts` imports **zero** world-model modules. `entityGraph.ts`,
`episodicMemory.ts`, `causalMemory.ts`, `worldModelDiff.ts` all exist and are all mounted in
`server.ts` — and the conversation path never reads them. *Crucible has a world model and does
not consult it when it talks to you.*

Correct tier order for any lookup:

```
1. SELF        — the self-model corpus (#2)
2. USER WORLD  — entity graph, episodic memory, files, mail, calendar   ← exists, unwired
3. LOCAL       — corpus + semantic index
4. WEB         — last, and only for genuinely external/volatile facts
```

"Grounded in what the user is asking" mostly means **tier 2**, and tier 2 is currently skipped.
This is the cheapest large win in the document: the modules are written.

**Lands:** `answer/answerEngine.ts` imports, `answer/groundedAnswer.ts`.

---

## TIER 2 — raises the ceiling (exploit being local; cloud assistants structurally cannot)

> The unifying insight: **running on-device grants logit access, hidden-state access, and free
> idle compute.** Every cloud assistant is denied all three. Crucible has never exploited any of
> them. This is the actual asymmetry — not a smaller model apologizing for itself.

### 6. Type-constrained decoding — attacks the #1 measured bottleneck

cont.117 measured: **62.3% of all oracle exits are gate-A typecheck failures. Only 16.7% of
verifications ever execute a line of code.** The dominant cost in the system is generating code
that does not compile.

ETH-SRI, PLDI 2025 (`eth-sri/type-constrained-code-generation`): a prefix automaton over the type
system masks logits during sampling so the model **cannot emit an ill-typed token**. Measured
**74.8% reduction in compilation errors** vs 9.0% for syntax-only constraints, plus functional
correctness gains, on models 2B–34B. **The reference implementation targets TypeScript** — which
is Crucible's synthesis target.

This requires logit-level access. Crucible runs its own `llama-server`. **A cloud-API system
cannot do this at all.**

Staged, cheapest first:
- **(a)** llama.cpp already supports **GBNF grammars** natively via the `grammar` parameter —
  syntax-class errors die for approximately zero implementation cost. Do this first.
- **(b)** Scope-aware identifier masking: mask identifiers not in scope, using the semantic index
  Crucible already maintains. The dominant TS error classes are unresolved-name and wrong-arity;
  this captures most of the remaining 62.3% without porting the full automaton.
- **(c)** Full port only if (a)+(b) leave money on the table.

**Expected:** the largest single capability gain available, on the largest measured loss.

### 7. Prompt-lookup (n-gram self-speculative) decoding for the repair loop

Every repair round regenerates a file that is **~90% token-identical** to the candidate just
rejected. N-gram / prompt-lookup speculative decoding drafts from the context itself: **zero
memory overhead** — decisive on an 8GB box where cont.89 measured a hard wired-memory ceiling —
and 2–3× on high-overlap continuations.

The repair loop is the highest-token-overlap workload that exists, and Crucible's is unusually
hot. Wall-clock is not a vanity metric here: faster rounds buy **more search iterations inside the
same budget**, and search depth is the moat.

**Lands:** the `llama-server` sidecar launch flags + `synth/` repair loop.

### 8. Semantic Entropy Probes — cut the self-consistency tax ~5×

`selfConsistency.ts` runs **K=5** samples. That is a 5× model-call tax on the exact resource
`DOCTRINE.md` names as scarce ("*sample-efficiency is the moat, optimize it above almost
everything else*").

**Semantic Entropy Probes** (Oxford/OATML) read a linear probe off **hidden states of a single
generation** and approximate semantic entropy with *"overhead almost zero"*, retaining most of
full sampling-based semantic entropy's hallucination-detection power — versus the 5–10× cost of
computing it properly.

Doctrine check — this is **not** vote-counting-as-verification, which `DOCTRINE.md` explicitly
bans. SEP is a **budget router**, not an oracle: low entropy → skip the K=5 spend; high entropy →
spend it, and spend it on the verifier. That is compute-optimal test-time allocation, measured at
**4× efficiency over naive best-of-N** in the literature. The verifier remains the only thing that
certifies.

Training data is free: the existing benches are labelled. Requires hidden-state access — **again,
only possible because inference is local.**

**Lands:** `answer/selfConsistency.ts`, `confidenceCalibrator.ts` (exists), sidecar.

### 9. Sleep-time compute — the structural unlock for a *personal* assistant

Crucible is a desktop app on a machine that **idles ~23 hours a day**, with an 8GB budget that is
only contended when the user is present. It currently computes **only** when spoken to.

Sleep-time compute — inference performed between interactions — is measured at **~5× reduction in
test-time compute for equal accuracy**, and **2.5× lower cost per query** amortized across related
queries, or **+15% accuracy** at fixed test-time budget.

For Crucible specifically, idle cycles should: resolve today's mail/calendar/file entities into
the entity graph; pre-derive answers to likely follow-ups; pre-warm retrieval for entities the user
touched; run the sufficiency judge over yesterday's answers and queue the gaps.

`ambientWatcher.ts` and `knowledgeGapQueue.ts` **already exist**. They need a scheduler and a
memory-shaping agent — and the 8GB ceiling stops mattering when nothing else is running.

**This is the single largest asymmetry a local assistant has over a cloud one.** A cloud provider
pays for every idle cycle and therefore will never do this for you. Crucible's idle cycles are
free. *It should be smartest at 9am about what it learned at 3am.*

### 10. Property-based verification instead of example tests

cont.117: `!testFile` is only 3.2% of exits — so this is **not** a sample-efficiency play, and the
handoff correctly bans building it for that reason. It is a **correctness-ceiling** play.

PBT validates **invariants** rather than input-output pairs; the literature reports **+23–37%
relative pass@1**. It also directly dissolves cont.117's measured budget sink: `src/index.ts` (the
ungraded self-test) burns **41.8% of all model rounds**, much of it dying on `checkDuplicateExports`.
A self-test's correctness property is *"`npx tsx src/index.ts` exits 0"* — a **property**, not a
module-export contract. Verify it as one and 24+ wasted rounds evaporate.

**Lands:** `synth/oracle.ts`, `reasoning/contractVerify.ts` (18 contract families already exist).

### 11. Agentic widgets — retrieval over tools, and widgets that act

Two distinct problems in `tools/registry.ts` (44+ flat tools, 1,712 lines):

- **Tool retrieval, not tool enumeration.** Putting 44 tools in a weak model's prompt *is* the
  cont.105 screen-dump bug — `localFmPlan({desktopIntent})` patched one symptom. Retrieve the ~5
  relevant tools per turn. Same principle as #4: the tool list is a retrieval problem.
- **Declarative generative UI.** The agent emits a **typed UI spec**; the frontend renders it; and
  critically the widget **calls back into the agent**. cont.103's standing rule already says a
  surface showing a result must let you *open and act on it* — a declarative spec is how that
  becomes general instead of per-widget. `A2UI` (Google) and `Open-JSON-UI` are the emerging specs;
  static generative UI (agent picks from hand-built components) is the safe first tier and fits
  Crucible's verification posture, since a closed component set is checkable.

**Lands:** `tools/registry.ts`, `agent/planner.ts`, `src/MissionWidgets.tsx`.

### 12. ACE-style experience playbook (pairs with #9)

Agentic Context Engineering: Generator → Reflector → Curator, with the playbook kept as
**context, not weights**, updated by **deltas** rather than rewrites (delta-updates are what avoid
context collapse — the failure mode where a rewrite erases hard-won specifics).

Crucible has `autoImprove.ts` + `improvementDaemon.ts` + RSI gating. The novel piece is the
**delta-curated playbook** as a first-class retrieval corpus, populated during sleep-time (#9) from
verified traces. Doctrine-safe because only **verifier-certified** trajectories are admitted — the
loop stays the source of truth.

---

## RANKING

| # | move | effort | floor | ceiling | why now |
|---|---|---|---|---|---|
| 1 | Referent resolution | S | ●●● | ○ | deletes a bug class; smaller than the code it replaces |
| 2 | Self-model corpus | S–M | ●●● | ●● | answer no cloud assistant can give truthfully |
| 5 | Wire the world model | S | ●●● | ●● | already written, simply unread |
| 6a | GBNF grammar decode | S | ●● | ●● | llama.cpp supports it today; attacks the 62.3% |
| 4 | Retrieval-as-search | M | ●●● | ●● | sufficiency judge already built (cont.111–114) |
| 3 | Paraphrase entailment | M | ●●● | ● | the general verifier for comprehension |
| 7 | Prompt-lookup decode | S | ○ | ●● | free 2–3× on repair; zero memory |
| 6b | Scope-aware masking | M–L | ●● | ●●● | the big one on the biggest measured loss |
| 9 | Sleep-time compute | M–L | ● | ●●● | the largest local-only asymmetry |
| 8 | Semantic entropy probe | M | ● | ●● | ~5× on the stated moat |
| 11 | Tool retrieval + widgets | M | ●● | ●● | agentic-colleague surface |
| 10 | Property-based oracle | M | ● | ●● | kills the 41.8% budget sink |
| 12 | ACE playbook | L | ○ | ●● | needs #9 first |

**Suggested first commit: 1 + 2 + 5.** Small, doctrine-pure, closes the observed bug *and* its
whole family, and turns the most embarrassing failure mode into a genuine differentiator.

---

## SOURCES

- Type-Constrained Code Generation with Language Models — arXiv 2504.09246 (PLDI 2025);
  code: `github.com/eth-sri/type-constrained-code-generation`
- Semantic Entropy Probes — arXiv 2406.15927; Semantic entropy — *Nature* 630 (2024)
- Sleep-time Compute: Beyond Inference Scaling at Test-time — arXiv 2504.13171
- Scaling LLM Test-Time Compute Optimally… — arXiv 2408.03314
- T1: Tool-integrated Verification for Test-time Compute Scaling in SLMs — arXiv 2504.04718
- DeepRetrieval / Search-R1 / Search-o1 — RL-based agentic search (arXiv 2503.09516 et al.)
- Agentic Context Engineering — arXiv 2510.04618
- Property-Generated Solver / PBT for LLM codegen — arXiv 2506.18315
- SHERLOC (structured diagnostic localization) — arXiv 2606.24820; SWE-Exp — arXiv 2507.23361
- Sufficient Context / KnowGuard (ICLR 2026) — evidence-sufficiency judging & abstention
- Zep/Graphiti bitemporal knowledge-graph agent memory; LoCoMo benchmark
- llama.cpp `docs/speculative.md` — n-gram / draft-model speculative decoding
