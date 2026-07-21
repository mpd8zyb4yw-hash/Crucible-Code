# Crucible — GAP CLOSURE PLAN

> Written 2026-07-21 (cont.98) for parallel high-throughput implementation.
> Subordinate to [`DOCTRINE.md`](./DOCTRINE.md). Where this contradicts the doctrine, the
> doctrine wins. Every workstream below is shaped as propose → verify → backtrack, and every
> one names its **deterministic verifier** and its **ground truth**, per the doctrine's
> self-check. If a workstream here cannot name those, it is not ready to build.

---

## 0. The measurement that should reorder everything

From `.crucible/coding-bench-last.json` (14 hard tasks):

| path | n | hidden-test pass | median time | iters |
|---|---|---|---|---|
| `catalog` | 4 | **4/4** | ~30ms | 0 |
| `generated` | 10 | **4/10** | ~280s | 0–7 |

Three conclusions, each of which should change what gets built next:

1. **The headline number is inflated by the catalog.** The four most impressive-sounding
   tasks — WAL crash-recovery KV store, token-bucket rate limiter, topological scheduler,
   regex engine — all pass in ~30ms with **zero iterations**, because they are retrieved from
   `synth/catalog.ts` (4427 lines). The doctrine bans preloaded answers *as a strategy*. A
   catalog hit is not evidence of reasoning, and reporting it in the same total as a generated
   pass hides the real capability. **True generated pass rate is 40%.**

2. **Three failures spent ZERO iterations** (`clampModule`, `leaderboardModule`,
   `multiFileLedger`). They did not fail *search* — they failed *before search*. Whatever
   gates entry into the iterate loop rejected or errored out, so the single most valuable
   mechanism in the system never ran. This is a wiring bug class, not a model class, and it is
   almost certainly the cheapest large win available.

3. **Sample efficiency is catastrophic, and it is the doctrine's stated moat.** 150–480s per
   task, with `sortModule` and `tagSetModule` both landing at ~479,98x ms — suspiciously equal,
   i.e. a timeout cap, not convergence. At ~20s/call the loop affords ~7 proposals per task.
   Search with a beam of 7 is not search. **Everything that multiplies proposals-per-second is
   worth more than anything that improves a single proposal.**

**Priority ordering follows directly:** fix loop entry (W1) → make iteration cheap (W2, W3) →
make each proposal structurally valid by construction (W4) → make feedback maximally
informative (W5) → then, and only then, model-level work (W9, W10).

---

## Workstream index

| # | Workstream | Why it matters | Rough size |
|---|---|---|---|
| W1 | Loop-entry forensics + the honest bench | 3 tasks never iterate; bench overstates | S |
| W2 | Grammar-constrained decoding (GBNF) | Kills malformed-output failures outright | M |
| W3 | KV-cache prefix reuse + continuous batching | 10–50× more proposals/sec | M |
| W4 | Type-directed sketch enumeration | Removes the model from most leaves | L |
| W5 | Counterexample minimization (shrinking) | Information per call — the moat | M |
| W6 | AST-level patch algebra | Eliminates text-splice corruption | M |
| W7 | Verifier ladder (cheapest gate first) | 10–100× cheaper rejection | S |
| W8 | Spectrum-based fault localization | Real debugging, not guess-the-line | M |
| W9 | Distillation flywheel (LoRA on certified traces) | Loop-shaped behavior, doctrine-sanctioned | L |
| W10 | Draft-model speculative decoding | 2–3× raw throughput | M |
| W11 | Z3-wasm constraint tier | Deterministic answers where search is hopeless | M |
| W12 | Coverage-guided fuzzing | Finds the non-obvious bugs (success bar #3) | M |
| W13 | Certified-artifact cache w/ re-verification | Amortizes solved work without memorizing | S |
| W14 | Budgeted search (expected information gain) | Spends the scarce resource deliberately | M |
| W15 | Self-play curriculum generation | Training data + benchmark that can't be gamed | L |
| W16 | Provenance ledger on every artifact | Makes "certified" auditable, kills silent fail-open | S |

---

## W1 — Loop-entry forensics and an honest benchmark  `[do this first]`

**Problem.** `clampModule`, `leaderboardModule`, `multiFileLedger` report `iters: 0` and fail.
Zero iterations means the propose→verify→backtrack engine never executed. Separately, the
bench conflates catalog retrieval with synthesis.

**Ground truth.** The iterate loop's own event stream.

**Build.**
1. Emit a structured `loop_entry` event at every early return between task receipt and the
   first proposal — with a *reason code* (`no-spec`, `spec-extract-failed`, `no-acceptance-cases`,
   `compile-precheck-failed`, `budget-exhausted`, `threw`). Bail-without-reason is the single
   most repeated defect in this codebase (see cont.98d: a working retrieval tier looked like a
   policy decision for exactly this reason).
2. Split the bench report into `passedGenerated / totalGenerated` and
   `passedCatalog / totalCatalog`, and make the headline number the **generated** one.
3. Add `iters` distribution and a `timedOut: boolean` derived from the cap, so a 479,98xms
   "pass" is never confused with convergence.

**Acceptance.** Every failing task attributes to a named reason code; no task fails with an
unexplained `iters: 0`; bench prints both rates separately.

**Why first.** It is small, and it converts three silent failures into three diagnosable ones.
It also stops the project from measuring its own progress with a ruler that includes a thumb.

---

## W2 — Grammar-constrained decoding (GBNF)

**Problem.** A 1.5B model emits structurally invalid output at a high rate — unterminated
strings, prose wrapped around JSON, markdown fences, half-written functions. Every such sample
costs a full ~20s call and returns *zero* information.

**Insight.** The llama.cpp server already supports **GBNF grammars** natively. Constrained
decoding makes malformed output *impossible* rather than *unlikely* — the sampler simply cannot
emit a token that violates the grammar. This is a pure infra win requiring no model change, and
it is the highest value-per-line item on this list.

**Build.**
1. A `grammars/` directory: `json_items.gbnf`, `typescript_fn.gbnf`, `patch_ops.gbnf`,
   `structured_critique.gbnf`.
2. Thread a `grammar` parameter through the llama-server client and `fmComplete`/`fmReact`.
3. Start with JSON-shaped calls (item planning, structured critique, tool-call args) where the
   grammar is trivial and the win is immediate; then a restricted TypeScript expression grammar
   for leaf-filling in W4.
4. Delete the downstream regex-repair code paths that exist only to salvage malformed output —
   they become dead weight, and dead salvage code hides real failures.

**Verifier.** Parse rate is the metric: measure malformed-output rate before/after on a fixed
prompt set. Target: **0%** structurally invalid on grammar-constrained calls, by construction.

**Second-order win.** Grammar constraint also *shortens* outputs (no preamble, no apology, no
markdown fence), which directly cuts tokens-per-call and therefore latency.

---

## W3 — KV-cache prefix reuse and continuous batching

**Problem.** Each iteration re-sends the whole spec + retrieved context + failure history and
re-prefills it. Prefill dominates cost for long contexts, and the loop's contexts are long by
design (that's what makes the proposals good).

**Build.**
1. **Prefix caching.** Structure every loop prompt as `[STABLE PREFIX][VOLATILE SUFFIX]` — spec,
   retrieved API facts, and file context are stable across iterations; only the failure feedback
   changes. Use llama-server's slot/prompt-cache reuse so iteration *N+1* prefills only the
   delta. Expect the second and subsequent iterations to cost a small fraction of the first.
2. **Continuous batching.** Run llama-server with `--parallel N` and issue K candidate
   proposals *concurrently* against the same cached prefix instead of serially. On this box K=3–4
   is realistic within the ~2GB headroom.
3. **Reorder prompt construction so the volatile part is always last.** This is a hard
   invariant — a single interpolated timestamp or shuffled retrieval order at the front
   invalidates the entire cache and silently reverts the gain. Add a test that asserts prefix
   stability across two consecutive iterations of the same task.

**Why this is the highest-leverage latency item.** The doctrine says the scarce resource is
model calls. This does not make calls smarter; it makes them *plural*. A beam search with
K=4 concurrent proposals and cheap iterations is a categorically different search than 7 serial
samples with a 480s cap.

**Acceptance.** Median wall-clock per generated task < 60s (from ~280s); iterations-per-task
budget ≥ 20 (from ~7).

---

## W4 — Type-directed sketch enumeration (the doctrine's "sketch + holes", made literal)

**Problem.** The model currently writes whole function bodies. Doctrine §2 says the *system*
builds structure from sound primitives and the model only fills leaves small enough for a
verifier to check in isolation. Today the leaves are too big.

**Build.**
1. **Sketch synthesis from the TS type signature.** Given `(xs: T[], p: (t:T)=>boolean) => T[]`,
   the space of well-typed shapes is small and *enumerable without a model*: filter/map/reduce
   compositions, loop skeletons with a typed accumulator, early-return guards.
2. **Typed-hole enumeration.** For each hole, enumerate candidate expressions from the in-scope
   typed environment (params, locals, imported helpers from the semantic index) up to depth 2–3.
   This is classic type-directed synthesis (Hoogle/Synquid-style) and it is **fully
   deterministic — zero model calls**.
3. **The model becomes a ranker, not a generator.** It orders candidate holes by plausibility;
   the verifier certifies. A wrong ranking costs one extra verification (milliseconds), not a
   wrong answer.
4. Fall back to free generation only when enumeration exhausts without a certified candidate.

**Why this is the deepest structural win.** It moves the majority of leaf decisions out of the
stochastic component entirely. It is also the single strongest argument for the ~1B cognitive
core: a model that only has to *rank* well-typed candidates needs far less capacity than one
that must *emit* correct code.

**Verifier.** Existing `codeVerifier` execution against acceptance cases; enumeration is sound
by typing, so anything it emits at least compiles.

---

## W5 — Counterexample minimization and structured feedback

**Problem.** Doctrine §4: every rejected candidate must return rich structured feedback. A
failing assertion on a 200-element input teaches almost nothing; the same failure shrunk to a
2-element input is nearly a proof of the bug.

**Build.**
1. **Property-based testing with shrinking** (fast-check-style, or a small in-house shrinker to
   avoid the dependency) over generated inputs, not just fixed acceptance cases.
2. **Delta-debugging the counterexample** to a minimal failing input before it enters the
   feedback block.
3. A **typed feedback record** — `{ kind, minimalInput, expected, actual, failingLine,
   typeError?, stackFrame? }` — rendered into the prompt in a fixed, terse format. Never paste
   raw stack traces; they burn tokens and bury the signal.
4. **Feedback deduplication across iterations.** If proposal N+1 fails the *same* minimized
   counterexample as N, the search is stuck: escalate strategy (different sketch, different
   decomposition) instead of resampling. Repeating an identical failure is the strongest
   available signal that more samples will not help.

**Acceptance.** Median iterations-to-certification drops measurably on the generated bench;
"same failure twice" triggers a strategy change rather than another sample.

---

## W6 — AST-level patch algebra

**Problem.** Text-splice edits produce a whole class of failures that have nothing to do with
reasoning: duplicated imports, broken braces, patches applied at the wrong offset, and the
near-neighbour text corruption already seen on the research path.

**Build.**
1. Represent every edit as a typed operation over the TS AST: `InsertBefore(node)`,
   `ReplaceBody(fn)`, `AddImport(spec)`, `RenameSymbol(sym)`, `WrapInTryCatch(stmt)`.
2. The model emits **operations** (grammar-constrained via W2), never raw file text.
3. Apply with the TypeScript compiler API; re-print from the AST. Malformed output becomes
   structurally impossible.
4. **Free win:** a semantic diff of before/after ASTs gives an exact, reviewable statement of
   what changed — which is also the honest provenance record W16 wants.

---

## W7 — The verifier ladder

**Problem.** Every candidate currently pays roughly the same verification cost regardless of
how obviously wrong it is.

**Build.** Gate candidates cheapest-first, rejecting at the earliest possible stage:

| stage | cost | rejects |
|---|---|---|
| 1. grammar/parse | µs | malformed (should be empty after W2) |
| 2. `tsc` type-check (incremental, in-memory) | ms | type-incorrect |
| 3. lint//AST invariants | ms | banned patterns, unused holes |
| 4. acceptance cases | 10s of ms | functionally wrong |
| 5. property tests + shrinking | 100s of ms | edge-case wrong |
| 6. mutation testing | seconds | *tests* too weak to certify |

Stage 6 is the subtle one: it verifies the **verifier**. If a mutant of the certified solution
still passes all tests, the certification was vacuous. That is precisely the "certified, not
plausible-looking" bar (success criterion #4), and nothing currently checks it.

---

## W8 — Spectrum-based fault localization

**Problem.** For debugging tasks (success bar #3), asking a 1.5B "which line is wrong?" is
oracle-trust with extra steps.

**Build.**
1. Instrument execution to record per-statement coverage for passing and failing runs
   (`executionTrace.ts` already exists as a substrate).
2. Rank statements by a standard suspiciousness metric (Ochiai:
   `fail(s) / sqrt(totalFail * (fail(s)+pass(s)))`).
3. Feed the **top-k suspicious statements with their coverage counts** to the proposer instead
   of the whole file. This is deterministic, model-free localization; the model only proposes a
   *fix* for an already-localized fault.
4. Combine with `faultInject.ts` for validation: inject known faults, confirm the localizer
   ranks the injected line top-k. That is a self-verifying capability — the localizer's accuracy
   is itself measurable without human labels.

---

## W9 — The distillation flywheel

**Doctrine check.** §4 of the cognitive-core consequences explicitly sanctions this: distilling
a smaller, reasoning-denser core, or fine-tuning for *loop-shaped behavior*. Training to
memorize facts remains banned. Everything below trains **behavior**, not knowledge.

**Build.**
1. **Log every certified trace** as training data: `(spec, retrieved context, failure feedback
   history) → the proposal that certified`. The system generates this continuously and for free
   as a byproduct of normal operation.
2. Also log **the repair delta**: failing proposal + minimized counterexample → certified
   proposal. This is the highest-value shape, because it teaches convergence-on-feedback, which
   is exactly the behavior the loop needs and the behavior base models are worst at.
3. LoRA fine-tune qwen2.5-1.5b on these traces. Target behaviors, in priority order:
   (a) emit valid structured output first time, (b) *change* the approach when feedback repeats,
   (c) abstain when the spec is unformalizable.
4. **Gate every checkpoint on the bench**, catalog-excluded (W1). Ship a fine-tune only if the
   generated pass rate improves; otherwise discard. Never ship on training loss.

**Long game.** Once the trace corpus is large, this is the concrete path to the ~1B core the
doctrine names as the destination: distill *reasoning behavior* into a smaller model while
facts stay in retrieval.

---

## W10 — Draft-model speculative decoding

**Build.** Run a very small draft model (0.5B) to propose tokens that the 1.5B verifies in
batch. Standard speculative decoding: 2–3× throughput with **identical** output distribution —
it is a pure latency win with no correctness tradeoff.

**Constraint.** Memory. On an 8GB box a 0.5B draft alongside the 1.5B is plausible but must be
measured; if headroom fails, W3's prefix caching delivers more per byte and this is deferred.

---

## W11 — A Z3-wasm constraint tier

**Problem.** Some tasks are *hopeless* for search and *trivial* for a solver: interval/clamp
arithmetic, date/time boundary conditions, invariant checking, scheduling feasibility. Note
`clampModule` is one of the zero-iteration failures.

**Build.**
1. Bundle `z3-solver` (wasm, runs fully offline — no external API, doctrine-clean).
2. A `constraintVerifier` that translates extracted invariants into SMT and *proves* them, or
   returns a concrete counterexample — which feeds W5's feedback record directly.
3. Route arithmetic/boundary-shaped specs here **before** the model path.

**Why it matters.** A counterexample from an SMT solver is ground truth of the strongest kind
available: not "this input failed" but "this input *must* fail, and here is why."

---

## W12 — Coverage-guided fuzzing

**Build.** Mutate inputs, keep those that reach new coverage edges, minimize any crasher. Run
against both the candidate *and* a reference implementation where one exists (differential
testing) — disagreement is a bug with a witness, requiring no oracle at all.

**Why.** Success bar #3 is "finding advanced, non-obvious bugs through real reasoning and
testing." Fuzzing is how that is actually done, and it is 100% deterministic infra.

---

## W13 — Certified-artifact cache with mandatory re-verification

**Doctrine tension, stated honestly.** This looks like the banned "preloaded answer" and must be
built so it is not. The rule: a cached artifact is a **proposal with a strong prior, never an
answer**. It is keyed by a normalized spec hash, and **it is re-verified against the current
task's acceptance cases before use, every time**. If it fails, it is discarded and search
proceeds normally. The cache saves *search*, never *verification*.

This is the principled version of what `catalog.ts` does today. The catalog should be migrated
into this shape and then required to re-verify — at which point catalog hits stop being free
passes on the bench and start being honest.

---

## W14 — Budgeted search by expected information gain

**Build.** Treat model calls as a budget and spend deliberately:
- Estimate each strategy's historical yield (`stageWeightLearner.ts` is the substrate).
- Multi-armed bandit over {enumerate, propose-free, decompose, retrieve-more, escalate-sketch}.
- Stop early and **abstain honestly** when marginal expected gain falls below threshold —
  rather than burning to a 480s timeout, which is what two tasks do today.

**Metric.** Not just pass rate: **pass rate per model call**. That is the doctrine's moat stated
as a number, and nothing currently tracks it.

---

## W15 — Self-play curriculum generation

**Build.**
1. Take certified solutions; apply semantic-preserving and semantic-*breaking* mutations to
   generate new tasks with **known** ground truth.
2. Semantic-breaking mutants become debugging tasks whose correct answer is known by
   construction — an endless, self-labeling debugging benchmark.
3. Difficulty-ladder the generated tasks and use them both as training data (W9) and as a
   benchmark that **cannot be gamed by a catalog**, because the tasks did not exist when the
   catalog was written.

**Why this matters strategically.** It is the answer to "how do we know we are improving at
NOVEL problems?" — the doctrine's central claim, which today's fixed 14-task bench cannot
support.

---

## W16 — Provenance ledger on every artifact

**Build.** Every emitted artifact carries a machine-readable record: which tier produced it
(catalog / enumeration / model+verify / abstain), which verifier stages passed, which evidence
was live vs. cached, and whether anything failed open.

**Why.** This session alone found three silent fail-open paths (rate-limited certification
admitting "Border Collie"; a checkpoint that staged nothing yet reported success; a retrieval
tier that reported "no list exists" when it had been rate-limited). In each case the *output
looked identical* whether the mechanism worked or not. Provenance is what makes "certified" mean
something auditable rather than aspirational — and it is the honest way to surface the
catalog-vs-generated distinction from W1 in the product itself, not just the bench.

---

## Suggested parallelization (two implementers)

Dependencies are real; these two tracks barely touch each other.

**Track A — throughput and structure** (unlocks everything else; do W1 first)
`W1 → W2 → W3 → W7 → W6 → W10`
Mostly infra, few conceptual unknowns, immediately measurable in wall-clock and parse rate.

**Track B — reasoning depth**
`W5 → W8 → W4 → W11 → W12`
Deeper, more design-heavy, benefits from Track A's speed but does not block on it.

**Then, jointly:** `W13 → W14 → W16 → W15 → W9`, since the flywheel needs volume of certified
traces, which needs the speed from Track A and the depth from Track B.

**Merge discipline for two concurrent sessions in one working tree** — learned the hard way this
session: scope checkpoints to the file being written, never `git add -A` (fixed in cont.98b);
each session owns a disjoint file set and states it in `NEXT_SESSION.md`; re-verify ownership
claims with `git log -1 -- <file>` before treating them as blockers, because a stale claim
blocked real work for two turns today.

---

## The three things I would do first, if forced to pick

1. **W1 loop-entry forensics.** Three benchmark tasks never enter the loop. Whatever that bug
   is, it is worth more than any new capability, and it is probably small.
2. **W2 grammar-constrained decoding.** Highest value-per-line on the list. Turns a whole
   failure *class* into an impossibility, with no model change and no correctness tradeoff.
3. **W3 prefix caching + batching.** The moat is sample efficiency; this is the only item that
   changes it by an order of magnitude rather than a percentage.

Everything else compounds on those three.
