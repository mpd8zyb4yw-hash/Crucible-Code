# Crucible — DOCTRINE (the North Star)

> **This file supersedes every older statement of purpose in this repository.**
> Read it before ROADMAP.md, before NEXT_SESSION.md, before writing a single line of code.
> If any other doc, comment, or benchmark contradicts this, THIS wins — and that other doc is
> wrong and should be corrected to match.
>
> **Last set: 2026-08-03.** This is a SCOPE CHANGE. It replaces the 2026-07-11 doctrine, whose
> success bar was "frontier SWE work, on-device only, zero external model API calls." The
> post-mortem for that bar is in §2. The loop thesis survives unchanged; the terrain and the
> economics are new. The prior doctrine is in git history (`git show HEAD~1:DOCTRINE.md`).

---

## 0. What Crucible is

**A broadly capable agentic assistant. You ask it anything; it gives you exactly what you asked
for, quickly, at a polished level of quality — and it can go do the work, not just talk about it.**

Research something properly. Read and triage your inbox. Build the spreadsheet. Watch for a thing
and tell you when it happens. Run on your phone and on your computer. Be *painfully* helpful,
because it is genuinely that capable.

It is one assistant with one pipeline, not a suite of features. Breadth comes from adding tools
and verifiers to a shared spine (§5), never from bolting on parallel pipelines.

---

## 1. The one sentence (unchanged — and now the business model)

> **Correctness comes from the LOOP, not the oracle.**
>
> An unreliable generator **+** a sound deterministic verifier **+** search
> **=** a system *more reliable than the generator itself.*

This is a provable fact and it is how every system that does frontier reasoning on modest compute
already works: SMT-guided program synthesis, property-based testing, AlphaProof/AlphaGeometry,
AlphaCode. The generator's error rate stops mattering the moment the system can **detect and
reject** its errors and try again against ground truth.

**What is new in this doctrine: the loop is no longer only a research thesis. It is the unit
economics.** A verified cheap model beats an unverified expensive one, at a small fraction of the
cost per *certified answer*. That single fact is what lets Crucible promise generous free usage,
constant quality, and a real margin at the same time. Everything in §3 follows from it.

---

## 2. Why the scope changed (the honest post-mortem)

The previous bar was frontier software engineering — multi-file changes, real debugging, certified
fixes — produced entirely on-device with zero external model calls.

**Measured 2026-08-02 (`npm run stack:h2h`, held-out witnesses, distillation off): the live stack
scored 2/9, and 0/3 on the hard task.** Both independent implementations tied. That is the honest
product number, and it is not close to the bar.

**The loop was not the problem. The terrain was.** Coding demands that the proposer emit a large,
exactly-correct artifact, and every verification costs a full `tsc` + test cycle. That is the worst
possible shape for this architecture: an enormous search space, low information per model call, and
a proposer that never gets within reach of correct.

**Assistant work inverts every one of those properties:**

| | Coding | Assistant work |
|---|---|---|
| Per-step proposal | A whole correct file | Pick a tool, fill two args, form a query, extract one field |
| Verification cost | `tsc` + test run, seconds | Schema check, parse, reconcile — milliseconds |
| Information per call | Low (pass/fail on a big artifact) | High (each step is small and independently checkable) |
| Reach of a small model | Out of reach | Comfortably in reach |

**This is not a retreat from the doctrine. It is the doctrine finally being applied where it pays.**

**Binding consequence:** do not restart a general-purpose code-synthesis effort. Code *generation*
survives only as a bounded internal capability (`create_tool` writing a new verified tool at
runtime), where the output is small, sandboxed, and mechanically checkable.

---

## 3. The economic doctrine (this replaces "zero external model API calls")

The old rule banned external model APIs outright. That rule is **repealed** — it is what produced
2/9. It is replaced by a harder and more useful discipline: **attack the cost per good answer, not
the cost per call.**

Four levers, in priority order. Work higher on this list before reaching for a bigger model.

1. **Manufacture quality; don't buy it.** Verification + search raises a cheap model to a quality
   an expensive model reaches unaided. This is lever one because it is the only one that
   simultaneously improves quality *and* cost. Every hour of engineering belongs here first.
2. **Make the expensive call rare.** In an agentic run, ~80–90% of model calls are mechanical:
   classify intent, fill tool arguments, extract a field, rerank snippets, decide done/not-done.
   Those go **on-device** (free, unlimited, private). Only *decisive* steps — planning, final
   synthesis — reach a hosted model. The user sees no quality difference, because every
   quality-determining step still gets the good model.
3. **Cache like it's the product.** Retrievals and verified claims are shareable
   (`research/verifiedClaimCache.ts`). The second person to ask a question should cost ~nothing.
4. **Buy cheap capacity, not free capacity.** See §4. Only after levers 1–3 are exhausted does the
   answer involve spending more per call.

**The framing that is now forbidden is not "use a hosted model" — it is "we need a more expensive
model."** Reach for §3.1 before §3.4, every time. "Our answers are bad because our model is cheap"
is almost always "our verifier is weak and our loop is shallow" wearing a disguise.

---

## 4. Compliance is a hard constraint, not a preference

Crucible is intended to be shipped to real users and **monetized**. That makes provider terms a
correctness property, not a footnote.

- **Free tiers are for local, personal, and development use only.** Free tiers commonly restrict to
  evaluation / non-production use, forbid providing access to third parties, and assume one human
  per account. **Pooling free-tier keys across paying end users is out of bounds** — it is both a
  likely terms breach and an operationally fragile design (revoked keys, silent quality collapse).
- **The commercial product runs on paid tiers with commercial terms.** Levers §3.1–3.3 make this
  affordable; that is their entire purpose.
- **Read the current terms before shipping against any provider.** Terms change. No summary in this
  repo — including this paragraph — is a substitute for the provider's live terms, and no session
  may treat a remembered summary as authoritative.
- **Bring-your-own-key is always a first-class option.** A user's own key runs under the user's own
  terms, costs Crucible nothing, and is the cleanest path to frontier quality for power users.

---

## 5. The spine (how every capability is shaped)

There is **one** pipeline. Every capability is an instance of it:

```
decompose → retrieve → propose → verify → synthesize   (abstain at any step)
```

This is the same shape for "what laptop should I buy," "summarize my inbox this week," and "build me
a budget spreadsheet." The reference implementation of the spine is
`src/CrucibleEngine/research/researchDag.ts`.

**A new capability is a TOOL plus a VERIFIER on the existing spine. It is never a new pipeline.**
If you find yourself writing a second orchestrator, stop — that is how this repo ended up with two
independent code-synthesis stacks that tied at 2/9.

The five obligations of the spine, carried over unchanged:

1. **Formalize "correct" first.** Turn the request into a mechanically-checkable spec. If you cannot
   state what correct means, **abstain** — do not guess. This step *is* the reasoning substrate.
2. **Structure from sound primitives; the model fills leaves.** The system builds the shape; the
   model only fills holes small enough that (a) a small model can plausibly get them and (b) a
   verifier can check them in isolation. Novelty is handled by *composing* sound pieces.
3. **Propose → verify → backtrack.** The model proposes; a deterministic verifier certifies against
   ground truth; survivors are explored, dead branches pruned. The model never touches control flow.
4. **Maximize information per model call.** Every rejection must return rich structured feedback —
   the exact error, actual-vs-expected, a minimized counterexample — so the next proposal converges
   in a handful of calls. Sample-efficiency is the moat.
5. **Abstain honestly.** A loud, correct "I could not verify this" beats a confident wrong answer.
   `abstain === abstain`.

---

## 6. The user-experience non-negotiables

These are product promises. Breaking one is a bug of the highest severity.

1. **Degrade latency, never correctness.** When capacity is tight, the honest move is to take
   longer, queue, or say "still working" — **never** to return a worse answer. This promise is only
   keepable *because* there is a verifier: the verifier holds quality constant so that time becomes
   the thing that flexes. A system without a verifier has no choice but to degrade quality.
2. **One pipeline, never two experiences.** Free and paid may differ in **speed, concurrency, and
   available connectors**. They must **never** differ in whether the answer is correct. There is no
   "cheap mode" that quietly thinks less.
3. **Usage must never feel rationed.** A normal person using Crucible normally should never
   encounter a wall. If they do, the fix is §3.1–3.3, not a lower cap.
4. **Abstain honestly, visibly.** Unverifiable is a first-class outcome with a stated reason. Never
   dress an abstention up as an answer.
5. **Provenance on demand.** Any claim can be traced to its source or its verification. This is what
   makes "painfully helpful" trustworthy rather than merely confident.

---

## 7. What this is NOT (forbidden framings, carried forward)

- **NOT preloaded answers.** Hard-coding the fix for a specific prompt is whack-a-mole, not
  reasoning, and is banned as a strategy. A verifier that checks a *general property* is doctrine; a
  critic that patches one memorized answer is debt — delete it.
- **NOT "trust the model."** Model output is a *proposal*, worthless until ground truth certifies it.
- **NOT self-consistency vote-counting as a substitute for verification.** K samples of the same
  bias vote for the same wrong answer. Independent *derivation* is doctrine; majority-vote-and-ship
  is not.
- **NOT "we need a more expensive model."** See §3. This is the successor to the old "bigger model"
  ban and it binds just as hard.
- **NOT knowledge baked into weights.** Facts are *retrieved* so they carry provenance and can be
  checked. The core reasons; it does not remember.
- **NOT two-tier quality.** See §6.2.
- **NOT a coding agent.** See §2. That bar was measured and abandoned on 2026-08-03.

---

## 8. On-device: what it is FOR now

The on-device model (`localModels/`, qwen2.5-1.5b via llama-server) is no longer the whole brain. It
is load-bearing for three specific jobs, and it is excellent at all three:

1. **The 80–90% of mechanical steps** (§3.2) — free, unlimited, no rate limit, no per-call cost.
2. **The privacy path** — anything touching mail, files, or personal data can be processed without
   leaving the device.
3. **The offline floor** — Crucible still works with no network. The floor must be genuinely good,
   because the floor is a differentiator, not a failure state.

"Smaller and reasoning-denser, with facts in retrieval" remains the right direction for this
component. What is repealed is the claim that it must do *everything*.

---

## 9. How to hold yourself to this (every session, no exceptions)

Before building: **"Where is the deterministic verifier, and what is the ground truth?"** If you
cannot answer, you are about to build oracle-trust — stop and reshape it into the spine.

Before optimising: **"Is this reachable from `server.ts`?"** (`npm run audit:reach`). A benchmark on
an unreachable module measures a sandbox. This rule exists because ~167 commits and every capability
number between 2026-07-19 and 2026-08-02 measured a subsystem no user request could reach.

Before adding a pipeline: **"Why can't this be a tool plus a verifier on the existing spine?"** (§5)

After finishing: **"Did this make the assistant more useful to a real person on a real request?"**
Not "did a benchmark move." The 2026-08-02 lesson is that both live defects found that week were
found by *running the product*, never by a harness.
