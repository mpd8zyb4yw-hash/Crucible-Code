# `reasoning/` — Verification-Guided Reasoning (VGR)

> This module is the **reference implementation of [`DOCTRINE.md`](../../../DOCTRINE.md)**.
> Read the doctrine first. In one line: **correctness comes from the loop, not the oracle.**

The on-device model is a weak, fallible **proposal function**. It is never trusted. Correctness
is produced by a deterministic **verifier** and a **search** that explores, prunes, and
backtracks over proposals until ground truth certifies one — or honestly abstains.

```
  TaskSpec ──►  search( proposer , verifier )  ──►  certified solution | honest abstain
                   │           │
                   │           └── ground truth (execution / compiler / property) — NO model
                   └── the only place the model lives; consumes prior-failure feedback
```

## Files

| file | role | model? |
|---|---|---|
| `types.ts` | vocabulary: Candidate, Verdict, Proposer, Verifier, TaskSpec, SearchResult | — |
| `search.ts` | deterministic propose→verify→backtrack **beam engine** (the reasoner) | **never** |
| `codeVerifier.ts` | **executes** candidate code vs acceptance cases → high-info feedback | never |
| `codeProposer.ts` | wraps the on-device FM; turns spec + failures into the next guess | **yes — only here** |
| `solve.ts` | `solveCodeTask()` — public entry assembling the above | via proposer |
| `__vgr_bench.ts` | proof: `npm run vgr:bench` | mock + optional live |

## The two invariants that must never be violated

1. **The model never decides control flow.** Routing, scoring, pruning, backtracking, and
   the accept/abstain decision are all in `search.ts` and are pure/deterministic. If you find
   yourself asking the model "is this good enough?" — stop; write a verifier instead.
2. **Nothing ships uncertified.** `search()` returns `status: 'solved'` **only** when a
   deterministic verifier returned `pass: true`. Otherwise it returns the honest best-effort
   attempt with `solution: null`. No unverified guess ever leaves the loop.

## Extending to a new domain

Add a `Verifier` (the hard part — what is ground truth, and how do you check a *general
property* rather than a memorized answer?) and a `Proposer` (thread prior-failure feedback in).
Then call `search(spec, proposer, verifier, opts)`. The engine is domain-agnostic on purpose.

## The one number to optimize

**Information per model call.** Model calls are the scarce resource (serial ANE, ~20s each),
not parameters. A verifier that returns "case f(3,4)=7, expected 12" converges a weak model in
2–3 calls; one that returns "failed" never converges. Make every rejection maximally teach the
next proposal. See `codeVerifier.ts`'s per-case actual-vs-expected signals for the pattern.
