# Crucible — GAP CLOSURE ADDENDUM (W17–W49)

> Written 2026-07-21 as a second opinion on [`GAP_CLOSURE.md`](./GAP_CLOSURE.md), for a parallel
> high-throughput implementer. Subordinate to [`DOCTRINE.md`](./DOCTRINE.md); where this
> contradicts the doctrine, the doctrine wins.
>
> **This does not replace W1–W16.** That plan is correct about what it covers, and its top three
> (W1 loop-entry forensics, W2 GBNF, W3 prefix caching) are right. This addendum covers what it
> does **not** cover — and argues that two of the omissions are *soundness* holes, which
> outrank every throughput item including the ones I agree with.
>
> Every workstream states its **deterministic verifier**, its **ground truth**, and its
> **acceptance test**, per the doctrine's self-check. Anything here that cannot name those is
> marked `[SPECULATIVE]` and should not be built until it can.

---

## 0. Three structural blind spots in W1–W16

The existing plan optimizes the loop: make proposals cheaper (W3, W10), more valid (W2, W4,
W6), better-informed (W5, W8), and cheaper to reject (W7). All correct. But it takes three
things as given that are not given.

### Blind spot 1 — the spec is assumed, and it is the actual ground truth

Every workstream is downstream of "the acceptance cases." The doctrine's guarantee —
*unreliable generator + sound verifier + search > the generator* — holds **only if the verifier
encodes the right thing.** If the spec is wrong or underdetermined, the loop converges
*faster* on a *confidently wrong* answer, and every downstream mechanism (W9's training traces,
W13's cache, W15's curriculum) amplifies the error. Search quality is bounded above by spec
quality, and nothing in W1–W16 builds, validates, or measures spec quality.

Note that W1's own reason codes (`no-spec`, `spec-extract-failed`, `no-acceptance-cases`)
predict that a large share of the three zero-iteration failures are *spec acquisition*
failures, not loop failures. W1 will diagnose them; nothing on the list then fixes them.

### Blind spot 2 — verification is assumed sound, and it is currently unfalsified

W7 stage 6 (mutation testing) is the only check on the verifier, and it only asks "are the
tests strong enough." It does not ask the two questions that break certification outright:

- **Is the candidate overfitting the acceptance cases?** A model that sees the tests can
  special-case them. `_suites/*.hidden.ts` and `coding-bench/*.hidden.ts` exist, which is the
  right instinct — but the discipline needs to hold *inside* the iterate loop, not just at
  bench time, and it needs to be asserted rather than assumed.
- **Is verification hermetic and deterministic?** Model-generated code executing with access to
  the clock, the network, the filesystem, and a shared module registry produces *flaky*
  certification. A flaky certify is worse than a failure: it poisons W9's training corpus,
  W13's cache, and W15's curriculum with confidently-labelled garbage, and the corruption is
  silent and permanent.

### Blind spot 3 — throughput is not search

W3 delivers K concurrent proposals. But K samples from one model, one prefix, and one
temperature are **highly correlated** — they fail the same way. Without an explicit diversity
mechanism, a 4× batch buys well under 2× effective search, and the measured win will be
disappointing in a way that looks like "the batching didn't work" rather than "the samples were
duplicates." Diversity is what converts throughput into search, and it is unaddressed.

**Consequence for ordering.** W1 and W2 stay first (they are cheap and they unblock
measurement). But **W30 (hermetic sandbox) and W17 (spec triangulation) should land before
W9/W13/W15**, because those three consume certifications as ground truth and will bake in
whatever the verifier got wrong. Building the flywheel before the verifier is sound is how a
project spends three months getting confidently worse.

---

# Track C — Spec acquisition and ground truth

## W17 — Spec triangulation and ambiguity detection  `[do early]`

**Problem.** A single extracted spec is an unverified oracle. The doctrine bans oracle-trust
everywhere else; the spec is the one place it is currently accepted without challenge.

**Ground truth.** Agreement between independently-derived formalizations.

**Build.**
1. Derive the spec **three independent ways** and require agreement: (a) from the natural-language
   task via the model, (b) from the type signature alone (`deriveInvariant.ts` is the substrate),
   (c) from worked examples in the prompt (`goalExampleOracle.ts` already does example extraction).
2. Where they disagree, you have an **ambiguity**, not an error. Generate a **distinguishing
   input**: an input on which spec A and spec B produce different expected outputs.
3. Ambiguity policy, in order: resolve from context; else resolve by the conservative reading and
   *record the assumption in the artifact* (W16 provenance); else **abstain and ask one question**.
4. Never silently pick one. The doctrine's abstention rule applies to specs, not just answers.

**Verifier.** Distinguishing-input synthesis is deterministic (it is a search for an input where
two executable specs differ; if both are executable, this is decidable by enumeration on small
inputs).

**Acceptance.** On a seeded set of deliberately-ambiguous tasks, the system flags ≥80% as
ambiguous rather than guessing, and every guess it does make appears in the provenance record.

**Size.** M. **Depends on:** nothing. **Unblocks:** the honest interpretation of W1's reason codes.

---

## W18 — Active learning: minimize human queries by optimal experiment design

**Problem.** "Ask the user" is the expensive fallback, so systems avoid it and guess instead.
The fix is not to ask less; it is to ask *the single most informative question*.

**Build.**
1. Maintain the **version space**: the set of candidate specs still consistent with everything
   known (examples, types, stated constraints).
2. Choose the query that maximally **bisects** the version space — the input on which the
   surviving specs disagree most evenly. One well-chosen yes/no halves the space; ten bad ones do
   not.
3. Render as a concrete input/output question ("for `clamp(5, 10, 1)` — lo > hi — should this
   throw, or return 1?"), never an abstract one ("how should edge cases behave?").
4. Cap at 1–2 questions per task; past that, abstain with the ambiguity recorded.

**Why this is strategically large.** It is the difference between an agent that needs a perfect
prompt and one that converges from a vague one. `clampModule` — a zero-iteration failure — is
very likely an ambiguous-boundary task, which makes this directly on the critical path.

**Verifier.** Version-space bisection is deterministic and measurable: log expected vs. realized
version-space reduction per question.

**Acceptance.** Median questions-to-unambiguous-spec ≤ 2 on the ambiguous-task set.

**Size.** M. **Depends on:** W17.

---

## W19 — Metamorphic properties as spec-free ground truth

**Problem.** Many tasks have no reference implementation and hand-written cases are sparse — but
almost every task has **relations that must hold** regardless of the correct answer.

**Build.** A library of metamorphic relations, auto-instantiated by inferred type shape:
- sort: idempotent, permutation-preserving, order-invariant under input shuffle
- parse/serialize: round-trip identity
- filter/map: length monotonicity, commutation with concat
- pure functions: referential transparency across repeated calls (this also catches hidden state)
- numeric: scale/translation equivariance where types permit

**Why it matters.** Metamorphic testing produces ground truth **without an oracle**, which is
exactly the doctrine's requirement. It is also the cheapest possible strengthening of a weak
acceptance suite, and it composes directly with W7 stage 5 and W12's fuzzing.

**Verifier.** The relation itself. **Ground truth.** Algebraic law, not opinion.

**Acceptance.** Every certified artifact passes ≥1 metamorphic relation, or is explicitly marked
`no-applicable-relation` in provenance.

**Size.** S–M. **Depends on:** nothing. **Very high value-per-line — comparable to W2.**

---

## W20 — Held-out acceptance cases inside the loop (anti-overfit certification)

**Problem.** The proposer is shown the acceptance cases so it can satisfy them. That is exactly
the condition under which it will special-case them. `if (n === 5) return 120` passes.

**Build.**
1. Partition acceptance cases into **visible** (in the prompt, drives repair) and **held-out**
   (never in any prompt, ever).
2. Certification requires passing **both**. Passing visible while failing held-out is a
   distinct, named outcome — `overfit` — not a generic failure, and it triggers a strategy change
   (per W5's escalation), not a resample.
3. Assert the split mechanically: a test that greps every constructed prompt for held-out
   literals and fails the build if any leak. Leakage will happen via retrieved context and
   failure-feedback echoes; assume it and test for it.
4. Extend the same discipline to the bench — `*.hidden.ts` already exists; make "the proposer
   never saw this" a machine-checked property rather than a naming convention.

**Acceptance.** Zero held-out literals in any prompt (asserted in CI); `overfit` appears as a
first-class outcome in bench output.

**Size.** S. **This is the highest-value soundness item on either list and it is small.**

---

## W21 — Spec-completeness scoring, and abstention on unformalizable tasks

**Problem.** Some specs cannot be formalized well enough for the loop to be sound. Running the
loop anyway produces a confident wrong answer, which is the single worst output the system can
emit.

**Build.** Score each spec before entering the loop: are there input-space regions no acceptance
case touches? Are error paths specified? Are boundaries (empty, singleton, max, negative, NaN,
unicode) covered? Below threshold, either synthesize cases to fill gaps (W19/W12) or **abstain
with a precise statement of what is underdetermined.**

**Acceptance.** Coverage-of-input-space score recorded per task; no task enters the loop below
threshold without a recorded justification. `coverage-census.ts` is the substrate.

**Size.** M. **Depends on:** W17, W19.

---

# Track D — Search algorithmics (converting throughput into progress)

## W22 — Name the architecture: CEGIS, and adopt its optimizations

**Observation.** The doctrine describes **counterexample-guided inductive synthesis** almost
verbatim without naming it. Naming it is not pedantry — it imports thirty years of known
optimizations and, importantly, known *failure modes*.

**Build.**
1. Make the loop explicitly CEGIS: synthesize from the example set → verify → on failure, add the
   **counterexample** to the example set → resynthesize. The monotonically growing example set is
   what gives CEGIS its convergence property, and it is stronger than free-form "failure history"
   text because it is *executable*.
2. Keep the example set as data, not prose. Feedback prose is lossy and unverifiable; a growing
   set of concrete (input, expected) pairs is neither.
3. Adopt the standard guard: if a counterexample repeats, the synthesizer is not learning from
   it — escalate representation (different sketch/decomposition), do not resample. W5 identifies
   this; CEGIS explains *why* it is the correct trigger.

**Acceptance.** Example set size strictly increases per iteration; a repeated counterexample
provably cannot occur without triggering escalation.

**Size.** M (mostly a restructuring of what exists). **Depends on:** W5.

---

## W23 — Enforced proposal diversity (the item that makes W3 pay off)

**Problem.** K concurrent samples from one prefix at one temperature are correlated. This is the
difference between W3 delivering 4× search and 1.3× search, and it will be misdiagnosed as
batching not working.

**Build.**
1. **Semantic dedup before verification.** Hash the *normalized AST* (W6 gives this free) and
   discard duplicates before paying verification cost. Cheap, immediate.
2. **Behavioral dedup.** Run each candidate on a fixed random probe-input set; cluster by output
   vector. Two textually different programs with identical behavior are one candidate.
3. **Forced structural diversity.** Assign each of the K slots a *different sketch* (W4) or a
   different decomposition strategy, rather than K samples of the same prompt. Diversity by
   construction beats diversity by temperature, which just trades correctness for variance.
4. Measure and report **distinct-behaviors-per-batch**. If that number is near 1, the batch is
   wasted and no amount of extra K helps.

**Acceptance.** Distinct behavioral clusters per batch of K=4 ≥ 2.5 median; report it in bench.

**Size.** M. **Depends on:** W3 for value, W6 for the cheap version.

---

## W24 — Execution-based self-consistency (model-free ranking)

**Problem.** W4 demotes the model to a ranker. Better: demote it out of ranking too, wherever
possible.

**Build.** AlphaCode's key trick, which is deterministic and doctrine-clean:
1. Sample K candidates. Run all of them on a set of **generated probe inputs** (no expected
   outputs needed).
2. Cluster by **behavior** — identical output vector = same cluster.
3. Prefer the **largest cluster**. Independent samples agreeing on behavior is real evidence;
   agreement is much rarer than any single sample being right.
4. Only inside the winning cluster does anything else break ties.

**Why this is underexploited.** It needs no oracle, no expected outputs, no model call for
ranking, and it gets *stronger* as W3 raises K. It is the highest-leverage use of throughput on
either list, and it composes multiplicatively with W23 (diversity makes the clusters meaningful).

**Verifier.** Execution. **Ground truth.** Inter-sample agreement.

**Acceptance.** On the generated bench, largest-cluster selection beats first-sample selection by
a measurable margin at K≥4.

**Size.** S–M. **Depends on:** W3 (for K), W30 (for safe execution). **Recommended top-five.**

---

## W25 — Restarts and portfolio scheduling (the heavy-tail fix)

**Problem.** Two tasks hit the ~480s cap. Program synthesis runtimes are famously **heavy-tailed**:
a run that has gone long is *more* likely to go longer. Continuing is the wrong move; restarting
with different randomization is often dramatically better.

**Build.**
1. **Luby restart schedule** over proposal attempts. Cheap to implement, well-understood, and it
   converts an unbounded tail into a bounded expected time.
2. **Portfolio**: run distinct *strategies* in parallel slots — enumerative (W4), model-free DSL
   (`proposers/dsl.ts`), model-proposal, retrieval-primed (W13) — and take the first certification.
   Different strategies have uncorrelated failure modes; that is the whole point of a portfolio.
3. Kill the timeout cap as a *success* path: a task that hits the cap must report `timeout`, never
   a pass. (W1 asks for this; it belongs here too because restarts change what a cap means.)

**Acceptance.** Tail latency (p90) drops materially; no task reports a pass at the cap value.

**Size.** S–M. **Depends on:** W3. **Unusually high value-per-line.**

---

## W26 — Angelic execution for sketch pruning (model-free, prunes whole subtrees)

**Problem.** W4 enumerates hole-fillings. But most *sketches* are unsatisfiable regardless of how
the holes are filled, and discovering that by enumerating fillings is exponentially wasteful.

**Build.** Run the sketch with each hole replaced by an **angelic oracle** that may return any
value. Ask: does there *exist* an assignment of hole values making all acceptance cases pass?
- If **no** — the sketch is unsatisfiable. Prune the entire subtree without a single model call
  or enumeration step.
- If **yes** — the recorded angelic values become *specifications for the holes*, which is a
  far tighter, far more informative prompt than the original task.

**Verifier.** For small finite domains, decidable by enumeration; for richer domains, discharge to
Z3 (W11) — which is the strongest argument for building W11 early.

**Acceptance.** Measurable reduction in candidates-verified per certification.

**Size.** L. **Depends on:** W4, W11. `enumerative-prove.ts` is the substrate.

---

# Track E — Compositional synthesis (getting past single functions)

## W27 — Interface-first decomposition with independently verified units

**Problem.** `multiFileLedger` is a zero-iteration failure, and it is the shape that matters most
for "rivaling Claude/Codex." Single-function synthesis does not compose into a system, and a
monolithic proposal for a multi-file task is a search over an intractably large space.

**Build.**
1. Decompose the spec into **units with typed interfaces** *before* any implementation. The
   interface is the contract; `contractGate.ts` is the substrate.
2. Synthesize and certify each unit **independently and in parallel**, against unit-level
   acceptance cases derived from the interface.
3. Verify **composition** separately: units that each pass in isolation can still fail together
   (shared state, ordering, resource lifetime). Composition failure is a distinct outcome and
   must be attributed to the *interface*, not to a unit.
4. On composition failure, repair the **interface**, then re-derive unit specs — do not re-search
   the units, whose certifications are still valid against the old contract.

**Why this is the scaling axis.** It turns one intractable search into N tractable ones plus a
small integration search — and N tractable searches parallelize across W3's slots.

**Acceptance.** `multiFileLedger` and at least one new multi-unit task certify end-to-end.

**Size.** L. **Depends on:** W3, W17. **This is the single biggest capability unlock on either list.**

---

## W28 — Program slicing for context minimization

**Problem.** Repair prompts include whole files. Most of it is irrelevant to the failure, and
irrelevant context measurably degrades small-model reasoning while consuming the scarce budget.

**Build.** From the failing assertion, compute the **backward static slice** — only statements
that can affect the failing value. Send the slice, not the file. `executionTrace.ts` supports the
dynamic-slice variant, which is tighter still (only statements that *did* execute on the failing
input).

**Second-order win.** A slice is a *stable prefix* far more often than a whole file is, which
compounds directly with W3's prefix caching.

**Acceptance.** Median repair-prompt tokens drop ≥50% with no drop in repair success rate — and
if repair rate *rises*, that is the "irrelevant context hurts" effect, worth reporting.

**Size.** M. **Depends on:** W8's instrumentation.

---

## W29 — Semantic (not textual) merge for concurrent candidates

**Problem.** With K parallel proposals mutating the same file set, textual merge produces
incoherent hybrids that pass no tests and waste verification.

**Build.** Merge at the **AST operation** level (W6's patch algebra): two operations conflict only
if they touch overlapping AST nodes. Non-overlapping repairs from different candidates can be
**combined**, which is a genuinely new capability — partial credit from multiple failed
candidates. Verify every merge; never assume compositionality.

**Size.** M. **Depends on:** W6, W23. **Note:** this is also the principled fix for the two-implementer
merge problem described at the end of this document.

---

# Track F — Verification soundness (build before the flywheel)

## W30 — Hermetic, resource-bounded, deterministic execution sandbox  `[blocking for W9/W13/W15]`

**Problem.** Verification currently executes model-generated code in-process. Three failure modes,
all silent:
- **Nondeterminism** — `Date.now()`, `Math.random()`, iteration order, locale, timezone. A test
  that passes once and fails once produces a *flaky certification*, which is worse than a failure
  because it is recorded as truth.
- **Contamination** — a candidate that writes to the filesystem, mutates a shared module, or
  monkey-patches a global changes the result of *subsequent* verifications. Certification becomes
  order-dependent.
- **Escape** — model-generated code with unrestricted `fs`/`child_process`/network is an obvious
  hazard, and the doctrine's "0 external API" claim is not even *checkable* if a candidate can
  open a socket.

**Build.**
1. Execute in an isolated worker with a **frozen clock**, **seeded PRNG**, fixed locale/TZ, and no
   network or filesystem access. Determinism is a *precondition* of certification, not a nicety.
2. Hard CPU-time and memory ceilings with real termination (worker + `SIGKILL`), so an infinite
   loop costs a bounded timeout rather than the run.
3. **Run every certification twice** (ideally with different PRNG seeds where the spec permits).
   Differing results ⇒ **not certified**, reported as `nondeterministic`.
4. Assert offline-ness *mechanically* — a candidate attempting network access fails closed and is
   recorded. This turns the doctrine's central claim into a machine-checked property.

**Acceptance.** Re-running the full bench twice produces byte-identical results. Any task that
does not is a bug, and finding those is the point.

**Size.** M. **Depends on:** nothing. **Recommended top-five — everything downstream inherits its
soundness from this.**

---

## W31 — Differential testing against independent implementations

**Build.** Where two implementations exist — catalog artifact vs. generated, enumerated vs.
model-proposed, current vs. previous certified — run both on fuzzed inputs and **compare
outputs**. Disagreement is a bug with a concrete witness and **requires no oracle at all**.

This is also the honest way to make W13's cache pay: the cached artifact is not trusted, it is
used as a **differential reference** against the fresh candidate. That reframing removes the
doctrine tension entirely — the cache stops being an answer and becomes a second opinion.

**Size.** S–M. **Depends on:** W12. **High value, and it repairs W13's stated tension.**

---

## W32 — Verifier self-validation via seeded fault injection

**Problem.** W7 stage 6 checks test strength on the *current* solution. It does not check that the
verification *pipeline* catches known classes of wrongness.

**Build.** `reasoning/faultInject.ts` already exists. Maintain a permanent corpus of **known-bad
artifacts** — off-by-one, wrong comparator, missing null guard, unhandled empty input, integer
overflow, wrong error type — and assert the ladder rejects each, naming the stage that caught it.
Any known-bad artifact that certifies is a **P0 verifier bug**, more urgent than any feature.

**Acceptance.** 100% of the known-bad corpus rejected, with the catching stage recorded. Run in CI.

**Size.** S. **Depends on:** W7. **Cheap, and it is the only thing that will catch a regression in
the verifier itself.**

---

## W33 — Test-suite adequacy gates before certification is permitted

**Build.** Certification requires the acceptance suite to meet minimum adequacy: branch coverage
of the candidate, boundary coverage of each input domain, and W7's mutation score. Below
threshold, **the correct action is to strengthen the suite, not to certify.** "All tests pass" on
a suite of three happy-path cases is not certification, and today it is indistinguishable from
real certification in the output.

**Acceptance.** Every certification records its adequacy metrics; below-threshold certifications
are labelled `weakly-certified` in provenance (W16) and never enter W9's training corpus.

**Size.** M. **Depends on:** W7, W16.

---

## W34 — Resource-complexity verification

**Problem.** "Correct" often includes complexity. A candidate that passes on n=100 by accident of
an O(n³) implementation is wrong for a task specifying O(n log n), and no functional test catches
it.

**Build.** Run certified candidates across a geometric input-size ladder, fit the growth curve,
and compare against the spec's stated complexity. Also detects accidental quadratic blowups
(string concatenation in a loop, repeated `Array.indexOf`) that are invisible at test scale and
fatal in use.

**Verifier.** Curve fitting over measured runtimes — deterministic given W30's sandbox.

**Size.** M. **Depends on:** W30 (meaningless without stable timing).

---

# Track G — Retrieval as the cognitive core's memory

> The doctrine stakes everything on "facts live in retrieval, the core does reasoning." That makes
> retrieval quality a **first-class capability**, but no workstream in W1–W16 addresses it. A 1B
> core with mediocre retrieval is strictly worse than a 3B that memorized — this track is what
> makes the cognitive-core bet pay.

## W35 — Typed API index as ground truth (kills hallucinated signatures)

**Problem.** The dominant "subtly wrong" failure mode for small models on real code is a
**plausible but nonexistent API**: wrong argument order, invented option name, method that does
not exist on that type. No amount of search fixes it if the model keeps proposing it, and it
consumes a full iteration each time.

**Build.**
1. Extract every symbol, signature, and overload from the project's `.d.ts` files and
   `node_modules` types into a queryable index. This is a compile-time fact, not a guess.
2. **Retrieve exact signatures** for every symbol mentioned in the spec, and put them in the
   stable prefix (W3).
3. **Constrain generation to the index.** This is the highest-value composition on either list:
   generate a GBNF grammar (W2) whose identifier terminals are *exactly the in-scope symbols*.
   Hallucinated APIs become **impossible to emit**, not merely unlikely.
4. Extend to arity and argument types where the grammar can express it.

**Acceptance.** Zero unresolved-symbol type errors on grammar-constrained generations, by
construction.

**Size.** M. **Depends on:** W2. **Recommended top-five.**

---

## W36 — tsserver/LSP as an in-loop deterministic oracle

**Problem.** The system re-implements what a language server already does soundly: symbol
resolution, type-at-position, find-references, rename, quick-fixes.

**Build.** Run `tsserver` as a persistent subprocess and query it during synthesis:
- **completions at a hole** — a *type-correct, in-scope* candidate list, computed by the compiler.
  This is W4's typed-hole enumeration for free, and it is authoritative rather than approximated.
- **quick-fixes** for diagnostics — the compiler's own repair suggestions, applied deterministically
  before any model call is spent on the same error.
- **rename/find-refs** — sound multi-file refactors with no model involvement at all.

**Why underexploited.** Persistent tsserver gives incremental type-checking (W7 stage 2) *and*
enumeration (W4) *and* free repairs from one subprocess. Very high leverage per unit of work.

**Size.** M. **Depends on:** nothing. **Recommended top-five.**

---

## W37 — Retrieval quality measurement and staleness revalidation

**Build.**
1. Measure retrieval as its own capability: for a labelled set of tasks, does retrieval surface
   the API/fact actually needed? Report precision@k and recall separately from end-to-end pass
   rate — otherwise a retrieval regression is invisible until it shows up as a mysterious quality
   drop.
2. **Staleness policy** for every persisted fact store. `.crucible/wiki-lists.json` entries carry
   `at` but are never refreshed (carried from cont.98d). Generalize: every cached fact carries
   `{at, ttl, source}`; past ttl it is revalidated or marked `stale` in provenance. A stale fact
   presented as current is the same failure class as a hallucination, with better manners.
3. **Negative caching with a shorter ttl** — remembering "no list exists" is exactly how the
   rate-limit fail-open in cont.98d became invisible. Never cache a negative derived from an error.

**Size.** S–M. **Depends on:** W16 for the provenance surface.

---

# Track H — Decoding-level wins (doctrine-legal, no bigger model)

## W38 — Contrastive decoding against the draft model

**Insight.** If W10 loads a 0.5B draft alongside the 1.5B, that draft has a second use that costs
nothing extra. **Contrastive decoding** samples from the *difference* of the two logit
distributions — amplifying what the larger model knows that the smaller does not, and suppressing
the generic, high-frequency continuations that cause small-model degeneration.

**Why underexploited.** Published gains on reasoning and code are meaningful, it requires **no
training**, and the second model is already resident for W10. Highest quality-per-byte item
available under an 8GB ceiling.

**Verifier.** Bench pass rate, catalog-excluded, with W30 determinism. **Risk:** interacts with
grammar constraint (W2) — apply the grammar mask *after* the contrast, and test the combination
explicitly rather than assuming it composes.

**Size.** M. **Depends on:** W10. `[SPECULATIVE until measured on this box]`

---

## W39 — Banned-token and degeneration control

**Build.** Cheap, immediate, complements W2's grammar (which enforces *structure*, not *content*):
- Ban placeholder tokens outright at the sampler: `TODO`, `FIXME`, `...`, `throw new Error("not
  implemented")`, `// implementation goes here`. A 1.5B emits these constantly and each one costs a
  full call for zero information.
- Ban `any` in generated type positions where the signature is known (W35).
- Per-task repetition penalty tuned against degenerate loops.

**Acceptance.** Placeholder-emission rate → 0 by construction.

**Size.** S. **Depends on:** W2's plumbing. **Trivial, do it alongside W2.**

---

## W40 — Constrained *sketch* decoding, not just constrained syntax

**Build.** Extend W2 beyond "valid JSON/TypeScript" to grammars that encode the *solution shape*:
a grammar admitting only a `reduce` over a typed accumulator, or only a two-pointer loop, or only
a guard-clause cascade. Assign different sketch-grammars to different parallel slots (W23) and you
get **structural diversity enforced by the sampler** — diversity by construction, at zero sampling
cost.

This is the natural convergence point of W2, W4, and W23, and it is where grammar-constrained
decoding stops being a formatting fix and becomes a search-space controller.

**Size.** M. **Depends on:** W2, W4, W23.

---

## W41 — KV-cache quantization and headroom budgeting

**Build.** Quantize the KV cache (q8/q4) to buy context length and parallel slots within the ~2GB
headroom. Measure the quality delta on the bench; adopt only if pass rate holds. Maintain an
explicit **memory budget ledger** — model weights, KV per slot, draft model, tsserver, Node heap —
because W3 (`--parallel N`), W10 (draft), and W36 (tsserver) all draw on the same 2GB and will
collide silently, appearing as swap-induced slowness rather than as a resource conflict.

**Size.** S. **Depends on:** W3. **Do this before W10, or W10's memory measurement is meaningless.**

---

# Track I — Measurement (you cannot close a gap you cannot measure)

## W42 — A real eval harness, offline, with contamination control

**Problem.** 14 tasks cannot support the claim "rivals Claude/Codex." At n=14 the 95% CI on a 40%
pass rate is roughly ±26 points — most observed "improvements" will be noise, and the project will
chase them.

**Build.**
1. Vendor offline, doctrine-clean benchmarks: HumanEval+/MBPP+-style function synthesis, plus a
   local repo-scale set built from this repository's own git history (real bug-fix commits, with
   the actual fix as ground truth — a free, uncontaminated, genuinely repo-scale SWE-bench).
2. **Contamination control**: any task with a `catalog.ts` or `skills/_learned/` hit is reported
   separately and excluded from the headline. Extend W1's split to *every* retrieval tier, not just
   the catalog — `skills/_learned/` is the same phenomenon one level down and will otherwise
   quietly re-inflate the number after W1 deflates it.
3. Report **confidence intervals**, not point estimates. A change that moves 40%→45% on n=14 has
   not been shown to do anything.

**Size.** M. **Depends on:** W1.

---

## W43 — Efficiency metrics as first-class, and a CI tripwire

**Build.** Track and gate on, per task: **pass rate per model call**, tokens per certification,
wall-clock to first certification, candidates verified per certification, and
distinct-behaviors-per-batch (W23). The doctrine's moat is sample efficiency; it is currently
unmeasured, so it cannot be optimized or defended.

Gate merges on it: a change that raises pass rate while tripling calls per certification is a
**regression** under the doctrine, and today would be recorded as an improvement.

**Size.** S. **Depends on:** W1, W42.

---

## W44 — Failure taxonomy and automatic root-cause clustering

**Build.** Every failure records a structured record `{stage, reason, minimized-counterexample,
sketch, spec-hash}`. Cluster automatically; report the top clusters weekly. **The largest cluster
is the next workstream** — this replaces judgment-based prioritization (including this document's)
with measurement, which is the only way to stay correctly ordered as the system changes.

**Size.** S. **Depends on:** W1, W5. **Compounding: it makes every future prioritization decision cheaper.**

---

# Track J — Repo-scale agentics (what "rivaling Codex" actually requires)

## W45 — Git-native candidate management

**Build.** Every candidate is a commit on a scratch branch; every verification runs in a `git
worktree` (already in use here, so the machinery is proven). This gives free rollback, free
diffing, parallel isolated verification without contamination (composes with W30), and
`git bisect` over a candidate sequence to find which change broke a previously-passing test.

**Size.** M. **Depends on:** W30.

---

## W46 — Real project integration: build, test, and run the actual repo

**Build.** Beyond synthesizing functions: run the project's real test suite, real build, real
linter; parse their output into W5's typed feedback records. A task is not done because a
synthesized function passes — it is done when **the repository's own gates pass**. This is the
concrete difference between a function synthesizer and a coding agent.

**Size.** M. **Depends on:** W5, W30.

---

## W47 — Durable, resumable long-horizon task graph

**Build.** Persist the full search state — task graph, per-node candidate sets, example sets,
budgets — so a run survives a crash, a restart, or a machine sleep, and resumes rather than
restarting. On an 8GB laptop running a 480s-per-task loop, this is the difference between
"can run overnight" and "must be babysat."

Note the direct precedent in this repository: the agent loop's `initialMessages`/`onCheckpoint`
resume path exists for exactly this reason and is proven.

**Size.** M. **Depends on:** W14.

---

# Track K — Compounding

## W48 — The regression museum

**Build.** Every bug ever found — by fuzzing, by a user, by mutation testing, by a failed
certification — becomes a **permanent test case**, tagged with its root cause. The suite only
grows. This is the cheapest compounding asset available and it directly counteracts W9's and
W15's tendency to drift.

**Size.** S. **Do it immediately; its value is proportional to how early it starts.**

---

## W49 — Curriculum from *failures*, not just from successes

**Refinement of W15.** W15 generates tasks by mutating **certified solutions**, which samples the
distribution the system has already mastered — the classic self-play collapse. Generate instead
from the **failure taxonomy** (W44): take the largest failure clusters and synthesize task
variants targeting them, difficulty-laddered. Train and evaluate on where the system is weak, not
where it is strong.

**Size.** M. **Depends on:** W15, W44.

---

# Risk register — where this plan can fool itself

1. **W9 (LoRA) trained on traces certified by an unsound verifier bakes in the verifier's blind
   spots, permanently and invisibly.** Gate the training corpus on W20 (held-out passed), W30
   (deterministic), and W33 (adequate suite). Never train on `weakly-certified` traces. **Do not
   start W9 before W30 and W20 land.**
2. **W13's cache is only doctrine-legal if re-verification is unconditional.** The failure mode is
   an optimization added later — "skip re-verification when the spec hash matches exactly" — which
   silently converts it into the banned preloaded answer. Write the re-verification as
   non-bypassable and test that it cannot be skipped. W31 (use the cache as a differential
   reference) is the stronger framing.
3. **W15 self-play collapses toward what the system already does.** W49 is the mitigation.
4. **`skills/_learned/` is the same catalog problem one level down.** W1 splits catalog from
   generated; if `_learned` is not also split, the honest number will quietly re-inflate.
5. **W3 without W23 will look like a failure.** Batching without diversity yields far less than
   K×, and the postmortem will blame the wrong component. Build the
   distinct-behaviors-per-batch metric *with* W3, not after it.
6. **Every "the model should judge X" is an oracle-trust regression.** Audit each new component
   for whether it smuggles the model into a position where nothing verifies it. This document's
   W17/W18 are the two most at risk and are written to abstain rather than guess.
7. **n=14 means most measured improvements are noise.** Until W42, treat every bench delta under
   ~15 points as unproven, including favorable ones.

---

# Revised "first five," given the above

The existing plan's top three are right about *throughput*. These are the five I would land first,
and two of them are soundness items that the existing list does not contain at all:

1. **W1 — loop-entry forensics** (unchanged; three silent failures become three diagnosable ones).
2. **W30 — hermetic deterministic sandbox.** Everything downstream inherits its soundness from
   here, and the acceptance test — run the bench twice, get identical results — will almost
   certainly expose real bugs on day one.
3. **W20 — held-out acceptance cases.** Small, and it is the difference between "certified" and
   "passed the tests it was shown." Directly serves success criterion #4.
4. **W2 + W39 + W35 — grammar-constrained decoding, banned placeholders, and index-constrained
   identifiers.** W2 is correctly identified as highest value-per-line; W35 composed with it makes
   hallucinated APIs *unrepresentable*, which is a strictly stronger result than making malformed
   syntax unrepresentable.
5. **W24 + W23 — behavioral clustering and enforced diversity.** These convert W3's throughput into
   actual search. Land them with W3, not after it.

**W19 (metamorphic relations)** is the honorable mention: S-sized, no dependencies, and it
strengthens every weak acceptance suite in the system at once.

**Track ordering for two implementers** (dependencies are real; these barely touch):

- **Implementer A — soundness and structure:** `W30 → W20 → W32 → W33 → W35 → W36 → W27`
- **Implementer B — search and throughput:** `W1 → W2+W39 → W3+W23 → W24 → W25 → W28`
- **Then jointly:** `W17 → W19 → W22 → W42 → W43 → W44` before any of `W9 / W13 / W15`.

---

# Merge protocol for two implementers in one tree

Extending the discipline already learned this session (scoped checkpoints, disjoint ownership in
`NEXT_SESSION.md`, re-verify ownership with `git log -1 -- <file>`):

1. **Freeze interfaces first.** Before parallel work starts, land the *type signatures* both
   tracks depend on (the verifier-ladder result type, the feedback record, the provenance record)
   in one commit that both branches build on. Interface churn is what actually causes merge pain;
   file ownership only causes textual conflicts, which are the easy kind.
2. **Ownership is per-file and declared, but staleness is assumed.** A claim older than the last
   commit touching that file is void. Prefer *new files* over edits to shared ones — every
   workstream above is written to be addable as a new module plus one wiring line.
3. **The bench is the merge gate, and it must run in under five minutes**, catalog-excluded, with
   W30 determinism. A gate that is slow or flaky will be skipped under time pressure, which is
   precisely when it matters.
4. **Semantic conflict detection** (W29): two tracks can edit disjoint files and still break each
   other — W3 adding `--parallel 4` and W10 loading a draft model both consume the same 2GB
   headroom, conflict in no file, and fail as unexplained slowness. The memory ledger (W41) is the
   guard.
5. **One integration commit per workstream, never a rolling merge.** Each lands with its bench
   delta recorded in the change log, so a regression can be attributed to a specific workstream
   rather than to a week of interleaved work.

---

# Calibration note

I will not restate a single percentage for "distance to rivaling Claude/Codex" — a scalar hides
that the components are at very different maturities and moving at different rates. Split it:

- **Single-function synthesis with a good spec:** genuinely close. W2/W3/W4/W23/W24 are
  percentage-to-multiple improvements on a working mechanism.
- **Verification soundness:** unproven rather than weak. The mechanisms exist; what is missing is
  evidence they cannot be fooled (W30/W20/W32). This could resolve quickly, and until it does,
  every other number is provisional — including the 40% generated pass rate.
- **Spec acquisition from vague human intent:** the largest untouched gap, and the one where
  Claude/Codex are strongest. W17/W18 are the entry point, and no amount of loop throughput
  substitutes for it.
- **Repo-scale multi-file work:** barely started (W27/W45/W46). This is the gap that most
  determines whether the comparison to Codex is meaningful at all, because it is the shape of
  nearly all real work.

The encouraging read stands, though, and W1's finding sharpens it: the top bottlenecks look like
**infrastructure and soundness**, not model ceilings. That is exactly what the doctrine predicts,
and it is the good case — infrastructure is the thing an 8GB box is allowed to fix.
