# Parallel Handoff — Benchmark Overhaul (2026-07-06)

Two independent workstreams, **no file overlap** — safe to run concurrently.
Repo root: `~/crucible-local/crucible-local`. Server on :3001. Mint an authed JWT
from `.env.local` (`JWT_SECRET`, `VITE_GROQ_API_KEY`) per the `crucible-local-auth-testing`
convention. Commit each fix (feedback: always commit, never leave a bare diff).

**Shared channel:** coordinate through `PARALLEL_SYNC.md` (append-only log, committed
to GitHub `origin/crucible-northstar-sessions`). `git pull --rebase` before claiming
work, append a claim/landed entry, `git push` so the other model sees it.

Context: `npm run convo:coherence` was just added. It drives real multi-turn chats
and LLM-judges context/consistency/coherence — the axes the old keyword bench
(`__convo_bench.ts`) is blind to. Baseline scorecard: `.crucible/convo-coherence-scorecard.json`
= **4/6 coherent**. The two RED convos are confirmed real bugs (transcripts inspected).

---

## Track A — OTHER MODEL: fix the two multi-turn amnesia bugs
Owned files: the offline brain (`src/CrucibleEngine/agent/*` — `solveNonCodeTurn`,
`fmReact`, the response cache / triage guards from the cont.37 multi-turn fix).
Does NOT touch `__convo_coherence_bench.ts` or `coding-benchmarks.ts`.

Reproduce: `CONVO_IDS=math-chain,entity-switch npm run convo:coherence`

1. **math-chain (avg 0)** — "3 boxes × 12" (36) → "give away 10" (26) → "split between 2"
   (should be 13). Turn 3 regurgitates turn 2's answer VERBATIM instead of dividing.
   Smells like a stale/cached templated response short-circuiting fresh reasoning.
   Suspect the cache/triage guards touched in cont.37.
2. **entity-switch (avg 50)** — "Who wrote 1984?"→Orwell, then "one other book by that
   author" → "Could you clarify what you'd like me to book?". Back-reference resolution
   collapsed (parsed "book" as a verb; lost the Orwell referent from history).

Done = both convos green, other 4 convos NOT regressed, committed. See spawn task
`task_b2fd98db` and the `crucible-coherence-bench` memory.

---

## Track B — ME (this session): frontier-SWE-adjacent coding tasks
Owned file: `src/CrucibleEngine/coding-benchmarks.ts` (+ its `TASKS` array / scaffold +
audit). Does NOT touch the offline brain.

Current coding bench = self-contained single-module generation only. Add harder tasks
closer to real SWE work:
- multi-file changes (touch 2+ existing files with a scaffold, not one greenfield module)
- bug-fix-in-existing-repo (scaffold a repo with a planted bug + failing hidden test;
  agent must locate and fix, not author from scratch)
- keep the existing HARD-gate rigor (compiles + hidden suite) and the
  catalog-vs-generated path split (never conflate proven-skill match with real gen).

Done = new tasks fire green/red honestly under `npm run smoke:code`, committed.

---

## After BOTH tracks land
Only then compute a parity % — backed by (a) coding bench incl. SWE tasks and
(b) coherence bench, both green. Do NOT quote a % before that; the whole point of
this overhaul was that the prior numbers were untrustworthy.
