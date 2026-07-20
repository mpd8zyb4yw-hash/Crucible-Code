# Crucible — DOCTRINE (the North Star)

> **This file supersedes every older statement of purpose in this repository.**
> Read it before ROADMAP.md, before NEXT_SESSION.md, before writing a single line of code.
> If any other doc, comment, or benchmark contradicts this, THIS wins — and that other
> doc is wrong and should be corrected to match. Last set: 2026-07-11.

---

## The one sentence

> **Correctness comes from the LOOP, not the oracle.**
>
> An unreliable small generator **+** a sound deterministic verifier **+** search
> **=** a system *more reliable than the generator itself.*

This is not a slogan and not a hope. It is a **provable** fact and it is how every system
that does frontier reasoning on modest compute already works: SMT-guided program synthesis,
property-based testing, AlphaProof/AlphaGeometry (a small net proposes, a symbolic engine
verifies, tree search explores), AlphaCode (sample candidates, filter by *execution*). The
generator's error rate stops mattering the moment the system can **detect and reject** its
errors and try again against ground truth.

## Why this is our thesis (the constraint that forged it)

Crucible runs on an **8GB unified-memory Mac with ~2GB of headroom**. The primary model today is
**qwen2.5-1.5b**, run on-device via a local llama-server sidecar (cont.90). It replaced Apple's
on-device Foundation Model as the head because the FM was MEASURED (cont.88/89) to fail the core
job — it could not copy an identifier out of clean evidence (0/3) while qwen2.5-1.5b does it 3/3
AND executes 3/3, at ~40–50 tok/s, ~93ms warm. Crucially qwen1.5b is *SMALLER* than the ~3B FM,
so this was never a "bigger model" move: it is the doctrine's own thesis in action — the FM's
failure was model-specific, not a parameter-count ceiling. The Apple FM is retained only as a
fallback when the sidecar is unavailable. A 7B won't fit; a 14–32B is physically impossible here
(the 27B was tested and rejected: it pinned ~6.6GB of the 8GB box for ZERO accuracy gain over the
1.5B). But the constraint is not "this model is as big as we can go." **The direction of travel is
the opposite of bigger — it is a smaller, reasoning-denser _cognitive core_ (see below).** The
right model for Crucible is not the largest that fits; it is the *smallest* one whose reasoning,
wrapped in the loop, still certifies — because everything it does NOT try to memorize is one less
thing it can be wrong about.

We went to the Moon on a computer with ~4KB of RAM. It worked because the **guidance loop**
did the reasoning: measure state, compute error against ground truth, correct, repeat. The
Apollo Guidance Computer could not "solve" the trajectory in one shot — the *loop* did. That
is exactly our move. We are not short on intelligence because we are short on parameters. We
are intelligent to the exact degree that our **verification-and-search infrastructure** is
good. **Every performance gain must come from better infra, not a bigger model.** Anyone who
frames a Crucible problem as "we need more parameters" has misunderstood the entire project.

## The cognitive core (the model we actually want)

Karpathy's framing, adopted here as foundational: the endpoint is not a large model that knows
everything — it is a **cognitive core**. A very small on-device model (**~1B parameters**, and if
that means training/distilling our own, so be it) that is deliberately **stripped of encyclopedic
knowledge** and instead holds one thing to a very high standard: **reasoning**. It does not try to
remember the capital of a country, an API's exact signature, or a library's option names. It knows
*how to think* and *how to look things up*. Facts live in retrieval (the corpus, the semantic index,
the web via our own tooling); the core's job is to reason over facts it fetches, not to be a lossy
compressed encyclopedia that hallucinates them.

Why this closes the gap rather than widening it:

- **Memorized knowledge in weights is the same failure mode as a preloaded answer, one level down.**
  A weight that "remembers" a fact is a fact we cannot verify at inference time and that goes stale.
  A *retrieved* fact carries provenance and can be checked. Externalizing knowledge turns
  hallucination-shaped errors into lookup-shaped ones — and lookups are verifiable. This is the
  "NOT preloaded answers" rule applied to the model's parameters, not just our critics.
- **Every parameter spent on recall is a parameter not spent on reasoning.** On an 8GB device the
  budget is brutal. A 1B core that spends its capacity on *reasoning depth* — planning, error
  attribution, composing sound primitives, converging on verifier feedback — beats a 3B that spread
  the same capacity across memorizing a trillion tokens it will mostly get subtly wrong. Small +
  sharp + retrieval > big + blurry.
- **It makes the loop the whole game, which is exactly our thesis.** A core that reasons but does not
  claim to *know* has no choice but to formalize, retrieve, propose, and let the verifier certify.
  The cognitive core and "correctness comes from the loop" are the same bet stated at two levels.

**Design consequences (binding going forward):**

1. **Prefer the smallest core that still reasons.** When choosing or training a model, optimize
   reasoning quality per parameter, not knowledge coverage. A ~1B reasoning-dense core (self-trained
   / distilled if needed) is the target; the current ~3B FM is a stepping stone, not the destination.
2. **Treat baked-in factual knowledge as debt, not an asset.** Do not lean on the model "just knowing"
   a fact. If a capability depends on recall, route it through retrieval so the fact is fetched and
   verifiable. A feature that works only because the model memorized something is fragile by
   construction.
3. **Invest disproportionately in reasoning + retrieval infra.** The two levers that matter are (a)
   making the core's reasoning *very* powerful and sample-efficient inside the loop, and (b) making
   "look it up" fast, well-ranked, and trustworthy. These are where effort goes; growing the model is
   not on the menu.
4. **Self-training is on the table when it sharpens reasoning or shrinks the core.** Distilling a
   smaller, more reasoning-dense core — or fine-tuning for loop-shaped behavior (formalize, emit
   structured self-critique, converge on verifier feedback) — is a legitimate and encouraged move.
   Training to memorize more facts is not.

## What we are building toward (the literal success bar)

**Frontier SWE work — reasoning about NOVEL problems whose answers we do not know in
advance — produced entirely within our constraints:**

1. Non-trivial, multi-file changes; real debugging; real refactors.
2. Complex apps with deep backends (auth, data layers, real APIs — not toy CRUD).
3. Finding advanced, non-obvious bugs through real reasoning and testing.
4. Genuinely correct fixes — certified, not plausible-looking.
5. **Zero external paid / rate-limited model API calls.** Local model(s) + Crucible's own
   deterministic tooling do ALL the reasoning. Internet is allowed, but only as a data
   source accessed by our own tooling — never a paid model in the loop.

## What this is NOT (explicitly forbidden framing)

- **NOT preloaded answers.** Hard-coding the fix for a specific failing prompt (e.g. a
  string-splicer that "corrects" one clock-arithmetic phrasing) is **whack-a-mole, not
  reasoning, and is banned as a strategy.** The system must reason about problems it has
  never seen. A verifier that checks a *general property* is doctrine; a critic that patches
  one memorized answer is debt — delete it.
- **NOT "trust the model."** The model is never the source of truth. Its output is a
  *proposal* that is worthless until ground truth certifies it.
- **NOT self-consistency vote-counting as a substitute for verification.** K identical
  samples of the same biased reasoning vote for the same wrong answer. Independent
  *derivation* (model chain-of-thought AND deterministic execution, accept only on
  agreement) is doctrine; majority-vote-and-ship is not.
- **NOT "we need a bigger model."** See above. This framing is out of scope, permanently — and
  the cognitive-core doctrine makes it doubly wrong: the direction is *smaller and reasoning-denser*
  (~1B core + retrieval), not bigger. "We need more parameters" and "we need to memorize more" are
  the same misunderstanding.
- **NOT knowledge baked into weights.** The model must not be relied on to *know* facts (APIs,
  signatures, library options, world facts). Encyclopedic recall in parameters is unverifiable,
  stale-prone, hallucination-shaped debt. Facts are *retrieved* (corpus / index / web via our
  tooling) so they carry provenance and can be checked. The core reasons; it does not remember.

## The architecture doctrine (how every feature must be shaped)

Every capability Crucible gains should be an instance of the same loop:

1. **Formalize "correct" first.** Turn the request into a *mechanically-checkable* spec —
   signatures (from the semantic index), invariants, executable acceptance checks. If we
   cannot state what correct means, we **abstain** — we do not guess. This step *is* the
   reasoning substrate.
2. **Sketch + holes, not free generation.** The system builds the *structure* from sound
   primitives (types, the index, retrieved facts); the model only fills leaves small enough
   that (a) a 3B can plausibly get them and (b) a verifier can check them in isolation.
   Novelty is handled by *composing* sound pieces the system has never combined before.
3. **Propose → verify → backtrack search.** The model proposes candidates; a deterministic
   verifier certifies each against ground truth; a beam of survivors is explored and pruned;
   dead branches backtrack. This is where reasoning about the unknown actually happens.
4. **Maximize information per model call.** The scarce resource is *model calls* (serial ANE,
   ~20s each), NOT parameters. Every rejected candidate must return **rich structured
   feedback** — the exact type error, the failing assertion's actual-vs-expected values, a
   minimized counterexample — so the next proposal converges in a handful of calls, not
   hundreds. **Sample-efficiency is the moat. Optimize it above almost everything else.**
5. **Abstain honestly.** There is no paid model to escalate to. When the loop cannot certify
   a candidate within budget, it returns an honest non-answer. `abstain === abstain`. A loud,
   correct "I could not verify this" beats a confident wrong answer every time.

## The reference implementation

`src/CrucibleEngine/reasoning/` is the canonical embodiment of this doctrine — read it as the
worked example, extend it, and route real traffic through it:

- `types.ts` — the vocabulary (Candidate, Verdict, Proposer, Verifier, TaskSpec, SearchResult).
- `search.ts` — the deterministic propose→verify→backtrack beam engine. **The model never
  touches control flow here.** This file is the reasoner.
- `codeVerifier.ts` — ground truth for code: *executes* candidates against acceptance cases,
  returns high-information feedback. Zero model.
- `codeProposer.ts` — the ONLY place the model lives; turns spec + prior-failure feedback into
  the next guess.
- `solve.ts` — assembles them: `solveCodeTask(spec) → certified solution | honest abstain`.
- `__vgr_bench.ts` (`npm run vgr:bench`) — proves the thesis: single-shot ships a wrong answer;
  the loop rejects it via execution and certifies a correct one; a non-converging proposer
  abstains instead of shipping garbage.

## How to hold yourself to this (every session, no exceptions)

Before building anything, ask: **"Where is the deterministic verifier, and what is the
ground truth?"** If you can't answer, you are about to build oracle-trust or a memorized-answer
patch — stop and reshape it into the loop. When you finish, ask: **"Did this make the system
reason better about problems it has never seen, or did it just paper over one it had?"** Only
the former counts. Everything else is the reason two months produced zero capability gain.
